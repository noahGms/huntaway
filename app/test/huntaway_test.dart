import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'dart:io';

import 'package:huntaway/api.dart';
import 'package:huntaway/cache.dart';
import 'package:huntaway/models.dart';
import 'package:huntaway/nesting.dart';
import 'package:huntaway/sync.dart';
import 'package:huntaway/turns.dart';
import 'package:huntaway/updater.dart';

TimelineItem item(int n, String type, [Map<String, dynamic> extra = const {}]) =>
    TimelineItem.fromJson({'n': n, 'type': type, 'timestamp': '2026-10-07T20:00:00Z', ...extra});

void main() {
  group('buildTurns', () {
    TimelineItem at(int n, String type, String time, [Map<String, dynamic> extra = const {}]) =>
        TimelineItem.fromJson({'n': n, 'type': type, 'timestamp': '2026-10-07T20:$time', ...extra});

    test('folds the work of a turn and keeps its last reply visible', () {
      final entries = buildTurns([
        at(0, 'user_message', '00:00Z', {'text': 'Refactor auth'}),
        at(1, 'thinking', '00:02Z', {'text': 'Look at the session first'}),
        at(2, 'tool_call', '00:05Z', {'kind': 'file_read', 'summary': 'a.ts', 'tool_use_id': 't1'}),
        at(3, 'tool_result', '00:06Z', {'tool_use_id': 't1'}),
        at(4, 'assistant_message', '00:10Z', {'text': 'Now the edit.'}),
        at(5, 'tool_call', '00:20Z', {
          'kind': 'file_modified',
          'summary': 'a.ts',
          'tool_use_id': 't2',
          'change': {'path': '/r/a.ts', 'old': 'x', 'new': 'y\nz', 'truncated': false},
        }),
        at(6, 'tool_call', '00:30Z', {
          'kind': 'file_modified',
          'summary': 'a.ts',
          'tool_use_id': 't3',
          'change': {'path': '/r/a.ts', 'old': null, 'new': 'w', 'truncated': false},
        }),
        at(7, 'tool_call', '00:40Z', {'kind': 'command', 'summary': 'npm test', 'tool_use_id': 't4'}),
        at(8, 'tool_result', '00:50Z', {'tool_use_id': 't4', 'is_error': true, 'summary': 'FAIL'}),
        at(9, 'assistant_message', '01:00Z', {'text': 'Done.'}),
        at(10, 'assistant_message', '01:01Z', {'text': 'Anything else?'}),
        at(11, 'turn_ended', '01:40Z', {'duration_ms': 100000}),
        at(12, 'some_future_type', '01:41Z'),
      ]);
      expect(entries.map((e) => e.runtimeType.toString()).toList(),
          ['MessageEntry', 'WorkEntry', 'MessageEntry', 'MessageEntry', 'ChangesEntry']);
      final work = entries[1] as WorkEntry;
      expect(work.summary, 'Worked 1m 40s · 1 file read · 1 command · 1 file changed');
      expect(work.errors, 1);
      // The intermediate reply and the thinking are folded in the work.
      expect(work.items.map((i) => i.type), containsAll(['thinking', 'assistant_message']));
      expect((entries[2] as MessageEntry).item.text, 'Done.');
      expect((entries[3] as MessageEntry).continued, isTrue);
      final changes = entries[4] as ChangesEntry;
      expect(changes.files.single.path, '/r/a.ts');
      expect((changes.added, changes.removed), (3, 1));
      expect(changes.files.single.changes.length, 2);
    });

    test('takes the duration from the timestamps without a turn end', () {
      final entries = buildTurns([
        at(0, 'user_message', '00:00Z', {'text': 'Go'}),
        at(1, 'tool_call', '00:42Z', {'kind': 'search', 'summary': 'auth', 'tool_use_id': 't1'}),
        at(2, 'assistant_message', '00:45Z', {'text': 'Found it.'}),
      ]);
      expect((entries[1] as WorkEntry).summary, 'Worked 45s · 1 search');
    });

    test('a live turn keeps everything in an open work row showing the current action', () {
      final entries = buildTurns([
        at(0, 'user_message', '00:00Z', {'text': 'Done before'}),
        at(1, 'assistant_message', '00:01Z', {'text': 'Ok.'}),
        at(2, 'user_message', '00:10Z', {'text': 'Run the tests'}),
        at(3, 'assistant_message', '00:11Z', {'text': 'Running them.'}),
        at(4, 'tool_call', '00:12Z', {'kind': 'command', 'summary': 'npm test', 'tool_use_id': 't1'}),
      ], live: true);
      expect(entries.map((e) => e.runtimeType.toString()).toList(),
          ['MessageEntry', 'MessageEntry', 'MessageEntry', 'WorkEntry']);
      final work = entries.last as WorkEntry;
      expect(work.live, isTrue);
      expect(work.currentAction, 'Running npm test');
      expect(work.items.length, 2);
      // Nothing yet: the row shows thinking.
      final empty = buildTurns([at(0, 'user_message', '00:00Z', {'text': 'Hi'})], live: true);
      expect((empty.last as WorkEntry).currentAction, 'Thinking');
      expect(buildTurns(const [], live: true).single, isA<WorkEntry>());
    });

    test('shows agent launches and answered questions in the turn, skips sub-agents', () {
      final entries = buildTurns([
        at(0, 'user_message', '00:00Z', {'text': 'Split the work'}),
        at(1, 'tool_call', '00:01Z', {
          'kind': 'agent',
          'summary': 'herdr agent start docs',
          'tool_use_id': 't1',
          'agent': {'name': 'docs', 'pane_id': 'w1:p3', 'kind': 'codex', 'prompt': 'Write the docs', 'start': true},
        }),
        at(2, 'tool_call', '00:02Z', {'kind': 'question', 'summary': 'Which storage?', 'tool_use_id': 'q1'}),
        at(3, 'question_asked', '00:02Z', {'tool_use_id': 'q1'}),
        at(4, 'tool_result', '00:03Z', {'tool_use_id': 'q1', 'summary': 'Secure storage'}),
        at(5, 'thinking', '00:04Z', {'text': 'sub', 'sidechain': true}),
        at(6, 'tool_call', '00:05Z', {'kind': 'command', 'summary': 'ls', 'sidechain': true, 'tool_use_id': 's1'}),
        at(7, 'tool_call', '00:06Z', {'kind': 'brand_new_kind', 'summary': 'x', 'tool_use_id': 't2'}),
        at(8, 'notice', '00:07Z', {'text': 'Interrupted by user'}),
      ]);
      expect(entries.map((e) => e.runtimeType.toString()).toList(),
          ['MessageEntry', 'WorkEntry', 'AgentLaunchEntry', 'QuestionEntry', 'NoticeEntry']);
      final work = entries[1] as WorkEntry;
      expect(work.summary, 'Worked 7s · 1 agent · 1 tool');
      expect(work.items.any((i) => i.sidechain), isFalse);
      expect((entries[2] as AgentLaunchEntry).call.agent!.name, 'docs');
      expect((entries[3] as QuestionEntry).result!.summary, 'Secure storage');
    });

    test('shows a proposed plan with its review', () {
      final entries = buildTurns([
        at(0, 'user_message', '00:00Z', {'text': 'Plan the fix'}),
        at(1, 'tool_call', '00:01Z', {'kind': 'file_read', 'summary': 'a.rs', 'tool_use_id': 'r1'}),
        at(2, 'tool_call', '00:02Z', {'kind': 'plan', 'name': 'ExitPlanMode', 'summary': 'Plan proposed', 'tool_use_id': 'p1', 'plan': '# Fix\n1. Patch'}),
        at(3, 'tool_result', '00:03Z', {'tool_use_id': 'p1', 'summary': 'User has approved your plan.'}),
      ]);
      expect(entries.map((e) => e.runtimeType.toString()).toList(), ['MessageEntry', 'WorkEntry', 'PlanEntry']);
      final plan = entries[2] as PlanEntry;
      expect(plan.call.plan, '# Fix\n1. Patch');
      expect(plan.result!.rejected, isFalse);
    });

    test('flags rejected tools', () {
      final entries = buildTurns([
        item(0, 'tool_call', {'kind': 'command', 'summary': 'rm x', 'tool_use_id': 't1'}),
        item(1, 'tool_result', {'tool_use_id': 't1', 'is_error': true, 'rejected': true}),
        item(2, 'assistant_message', {'text': 'chatter', 'sidechain': true}),
      ]);
      final work = entries.single as WorkEntry;
      expect(work.rejected, 1);
      expect(work.errors, 0);
    });

    test('row ids stay stable as items arrive', () {
      final first = buildTurns([item(0, 'user_message'), item(1, 'tool_call', {'kind': 'search'})], live: true);
      final next = buildTurns(
          [item(0, 'user_message'), item(1, 'tool_call', {'kind': 'search'}), item(2, 'tool_call', {'kind': 'web'})],
          live: true);
      expect(first.map((e) => e.id), next.map((e) => e.id));
    });
  });

  group('nesting', () {
    Agent agent(String id, String status, {String? parent, List<String> children = const [], String? name}) =>
        Agent.fromJson('m1', {
          'id': id,
          'pane_id': id.split(':').skip(1).join(':'),
          'attention': {'status': status},
          'parent_id': ?parent,
          'children': children,
          'name': ?name,
        });

    test('puts children under their live parent and bubbles the most urgent status', () {
      final roots = nestAgents([
        agent('d:w1:p1', 'working', children: ['d:w1:p2', 'd:w1:p3']),
        agent('d:w1:p2', 'blocked', parent: 'd:w1:p1'),
        agent('d:w1:p3', 'done', parent: 'd:w1:p1'),
        agent('d:w2:p1', 'idle', parent: 'd:gone'),
      ]);
      expect(roots.map((n) => n.agent.id), ['d:w1:p1', 'd:w2:p1']);
      final parent = roots.first;
      expect(parent.children.map((n) => n.agent.id), ['d:w1:p2', 'd:w1:p3']);
      expect(parent.descendants, 2);
      expect(parent.urgent.status, AttentionStatus.blocked);
      expect(parent.childNeedsAttention, isTrue);
      expect(roots.last.childNeedsAttention, isFalse);
    });

    test('nests grandchildren and leaves loops at the top', () {
      final roots = nestAgents([
        agent('d:a', 'idle'),
        agent('d:b', 'idle', parent: 'd:a'),
        agent('d:c', 'blocked', parent: 'd:b'),
        agent('d:x', 'idle', parent: 'd:y'),
        agent('d:y', 'idle', parent: 'd:x'),
      ]);
      expect(roots.map((n) => n.agent.id), ['d:a', 'd:x', 'd:y']);
      expect(roots.first.descendants, 2);
      expect(roots.first.urgent.status, AttentionStatus.blocked);
    });

    test('finds the agent a launch started: pane first, then name', () {
      final parent = agent('d:w1:p1', 'working', children: ['d:w1:p2', 'd:w1:p3']);
      final byPane = agent('d:w1:p2', 'working', parent: 'd:w1:p1', name: 'other');
      final byName = agent('d:w1:p3', 'blocked', parent: 'd:w1:p1', name: 'docs');
      final all = [parent, byPane, byName];
      expect(launchedAgent(parent, AgentLaunch(paneId: 'w1:p2', name: 'docs'), all), byPane);
      expect(launchedAgent(parent, AgentLaunch(name: 'docs'), all), byName);
      expect(launchedAgent(parent, AgentLaunch(name: 'nobody'), all), isNull);
    });
  });

  test('Agent.fromJson reads the bridge view', () {
    final agent = Agent.fromJson('m1', {
      'id': 'default:w1:p2',
      'session': 'default',
      'pane_id': 'w1:p2',
      'project': 'api',
      'kind': 'claude',
      'herdr_status': 'blocked',
      'attention': {'status': 'blocked', 'reason': 'approval'},
      'summary': 'Refactor',
      'last_activity_at': '2026-10-07T20:00:00Z',
      'interaction': {
        'reason': 'approval',
        'tool': {'name': 'Bash', 'summary': 'npm test', 'input': {'command': 'npm test'}},
        'questions': [],
        'options': [
          {'number': 1, 'label': 'Yes', 'selected': true, 'numbered': true},
          {'number': 2, 'label': 'No', 'selected': false, 'numbered': true},
        ],
      },
      'has_transcript': true,
      'item_count': 12,
      'warnings': [],
      'unknown_field': 42,
    });
    expect(agent.key, 'm1/default:w1:p2');
    expect(agent.attention.status, AttentionStatus.blocked);
    expect(agent.attention.label, 'Approval');
    expect(agent.interaction!.tool!.input['command'], 'npm test');
    expect(agent.interaction!.options.last.label, 'No');
    expect(agent.displayName, 'Claude');
    // Fields of newer bridges default when missing.
    expect(agent.parentId, isNull);
    expect(agent.children, isEmpty);
    expect(agent.queued, isEmpty);
  });

  test('Agent.fromJson reads parent, children and queued messages', () {
    final agent = Agent.fromJson('m1', {
      'id': 'default:w1:p2',
      'attention': {'status': 'working'},
      'name': 'docs',
      'parent_id': 'default:w1:p1',
      'children': ['default:w1:p3'],
      'queued': [
        {'text': 'And the tests', 'at': 1791403200},
      ],
    });
    expect(agent.name, 'docs');
    expect(agent.parentId, 'default:w1:p1');
    expect(agent.children, ['default:w1:p3']);
    expect(agent.queued.single.text, 'And the tests');
    expect(agent.queued.single.at.millisecondsSinceEpoch, 1791403200000);
  });

  group('pairing', () {
    late SimpleKeyPair keyPair;
    late List<int> publicKey;
    late String fingerprint;

    setUp(() async {
      keyPair = await Ed25519().newKeyPair();
      publicKey = (await keyPair.extractPublicKey()).bytes;
      final digest = await Sha256().hash(publicKey);
      fingerprint = 'sha256:${base64Url.encode(digest.bytes).replaceAll('=', '')}';
    });

    /// Fake bridge answering /v1/pair like huntawayd.
    MockClient bridge({String machineId = 'm1', SimpleKeyPair? signer}) => MockClient((request) async {
          if (request.url.host == 'down') throw http.ClientException('unreachable');
          final body = jsonDecode(request.body) as Map;
          final message = utf8.encode('huntaway-pair-v1|${body['nonce']}|$machineId|d1');
          final signature = await Ed25519().sign(message, keyPair: signer ?? keyPair);
          return http.Response(
            jsonEncode({
              'device_id': 'd1',
              'token': 'tok',
              'permissions': ['agents.read'],
              'machine_id': machineId,
              'machine_name': 'MacBook',
              'public_key': base64.encode(publicKey),
              'signature': base64.encode(signature.bytes),
            }),
            200,
          );
        });

    PairingPayload payload(String fp) => PairingPayload.parse(jsonEncode({
          'v': 1,
          'machine_id': 'm1',
          'machine_name': 'MacBook',
          'addresses': ['down:7420', 'up:7420'],
          'pairing_code': 'code',
          'fingerprint': fp,
        }));

    test('accepts a bridge holding the QR key and keeps the working address first', () async {
      final machine = await pair(payload(fingerprint), 'Pixel', client: bridge());
      expect(machine.token, 'tok');
      expect(machine.addresses.first, 'up:7420');
      expect(machine.can('agents.read'), isTrue);
    });

    test('rejects a fingerprint mismatch', () async {
      expect(
        pair(payload('sha256:other'), 'Pixel', client: bridge()),
        throwsA(isA<BridgeException>().having((e) => e.code, 'code', 'fingerprint_mismatch')),
      );
    });

    test('rejects a bad signature', () async {
      final impostor = await Ed25519().newKeyPair();
      expect(
        pair(payload(fingerprint), 'Pixel', client: bridge(signer: impostor)),
        throwsA(isA<BridgeException>().having((e) => e.code, 'code', 'bad_signature')),
      );
    });

    test('rejects non Huntaway QR codes', () {
      expect(() => PairingPayload.parse('https://example.com'), throwsA(isA<BridgeException>()));
    });
  });

  test('timeline cache round-trips and ignores another agent instance', () async {
    final dir = await Directory.systemTemp.createTemp('huntaway-cache');
    final cache = TimelineCache(directory: () async => dir);
    final items = [for (var n = 0; n < 250; n++) item(n, 'user_message', {'text': 'm$n'})];
    cache.schedule('m1', 'default:w1:p1', 'inst-a', items);
    await Future<void>.delayed(const Duration(milliseconds: 2300));
    final back = await cache.read('m1', 'default:w1:p1', 'inst-a');
    expect(back.length, TimelineCache.keep);
    expect(back.first.n, 50);
    expect(back.last.text, 'm249');
    expect(await cache.read('m1', 'default:w1:p1', 'inst-b'), isEmpty);
    await cache.remove('m1');
    expect(await cache.read('m1', 'default:w1:p1', 'inst-a'), isEmpty);
    await dir.delete(recursive: true);
  });

  group('timeline state', () {
    test('a refresh keeps older pages and live items', () {
      final t = TimelineState();
      t.mergeLatest([for (var n = 100; n < 220; n++) item(n, 'user_message')], true);
      expect(t.hasMore, isTrue);
      t.merge([for (var n = 0; n < 100; n++) item(n, 'user_message')]);
      t.hasMore = false;
      t.merge([item(220, 'assistant_message')]); // live item
      t.mergeLatest([for (var n = 101; n < 221; n++) item(n, 'user_message')], true);
      expect(t.items.length, 221);
      expect(t.items.first.n, 0);
      expect(t.hasMore, isFalse);
    });

    test('a page that no longer joins up replaces what was held', () {
      final t = TimelineState()..mergeLatest([for (var n = 0; n < 10; n++) item(n, 'user_message')], false);
      t.mergeLatest([for (var n = 500; n < 620; n++) item(n, 'user_message')], true);
      expect(t.items.first.n, 500);
      expect(t.hasMore, isTrue);
    });

    test('reset drops the conversation of the previous instance', () {
      final t = TimelineState()
        ..mergeLatest([item(0, 'user_message')], false)
        ..loaded = true;
      final generation = t.generation;
      t.reset();
      expect(t.items, isEmpty);
      expect(t.loaded, isFalse);
      expect(t.generation, generation + 1);
    });
  });

  group('answers', () {
    final machine = PairedMachine(
      machineId: 'm1',
      name: 'Mac',
      addresses: ['bridge:7420'],
      token: 't',
      deviceId: 'd1',
      fingerprint: 'sha256:x',
    );
    Agent blocked({String? id}) => Agent.fromJson('m1', {
          'id': 'a1',
          'attention': {'status': 'blocked', 'reason': 'approval'},
          'interaction': {
            'id': ?id,
            'reason': 'approval',
            'tool': {'name': 'Bash', 'summary': 'rm -rf build', 'input': {}},
            'questions': [],
            'options': [
              {'number': 1, 'label': 'Yes'},
              {'number': 2, 'label': 'No'},
            ],
          },
        });

    test('send the interaction id and ignore a second tap on the same prompt', () async {
      final bodies = <Map>[];
      final client = BridgeClient(machine, client: MockClient((r) async {
        if (r.url.path == '/healthz') return http.Response('{"ok":true}', 200);
        bodies.add(jsonDecode(r.body) as Map);
        return http.Response('{"ok":true}', 200);
      }));
      final c = MachineConnection(machine, onNotification: (_) {}, client: client);
      final agent = blocked(id: 'i-1');
      expect(await c.answer(agent, number: 1), isTrue);
      expect(c.answered(agent), isTrue);
      expect(await c.answer(agent, number: 1), isFalse);
      expect(bodies, [
        {'number': 1, 'interaction_id': 'i-1'}
      ]);
      // The next prompt can be answered.
      expect(c.answered(blocked(id: 'i-2')), isFalse);
      c.dispose();
    });

    test('a changed prompt is reported and can be answered again', () async {
      final client = BridgeClient(machine, client: MockClient((r) async {
        if (r.url.path == '/healthz') return http.Response('{"ok":true}', 200);
        if (r.method == 'GET') return http.Response('{}', 404);
        return http.Response(
            '{"error":{"code":"interaction_changed","message":"the agent is now asking something else"}}', 409);
      }));
      final c = MachineConnection(machine, onNotification: (_) {}, client: client);
      final agent = blocked();
      await expectLater(c.answer(agent),
          throwsA(isA<BridgeException>().having((e) => e.code, 'code', 'interaction_changed')));
      expect(c.answered(agent), isFalse);
      c.dispose();
    });
  });

  group('stream item filter', () {
    late HttpServer server;
    late List<Uri> streams;
    late List<Map> messages;
    late List<String> timelineRequests;
    late WebSocket? socket;
    late MachineConnection c;

    Future<void> until(bool Function() done) async {
      for (var i = 0; i < 200 && !done(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(done(), isTrue);
    }

    void event(int seq, String type, String agentId, Map<String, dynamic> data) =>
        socket!.add(jsonEncode({'seq': seq, 'type': type, 'agent_id': agentId, 'data': data}));

    setUp(() async {
      streams = [];
      messages = [];
      timelineRequests = [];
      socket = null;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((r) async {
        void json(Object body) => r.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(body))
          ..close();
        switch (r.uri.path) {
          case '/healthz':
            json({'ok': true});
          case '/v1/state':
            json({
              'machine': {'epoch': 'e1', 'machine_name': 'Mac'},
              'seq': 1,
              'agents': [
                {'id': 'a1', 'attention': {'status': 'working'}},
                {'id': 'a2', 'attention': {'status': 'idle'}},
              ],
            });
          case '/v1/agents/a1/timeline':
            timelineRequests.add(r.uri.query);
            json({
              'items': [
                for (var n = 0; n < (timelineRequests.length == 1 ? 3 : 6); n++)
                  {'n': n, 'type': 'assistant_message', 'timestamp': '2026-10-07T20:00:00Z', 'text': '$n'}
              ],
              'has_more': false,
            });
          case '/v1/stream':
            streams.add(r.uri);
            final ws = socket = await WebSocketTransformer.upgrade(r);
            ws.add(jsonEncode({'type': 'hello', 'epoch': 'e1', 'seq': 1, 'resync_required': false}));
            ws.listen((m) => messages.add(jsonDecode(m as String) as Map));
          default:
            r.response
              ..statusCode = 404
              ..close();
        }
      });
      final machine = PairedMachine(
        machineId: 'm1',
        name: 'Mac',
        addresses: ['127.0.0.1:${server.port}'],
        token: 't',
        deviceId: 'd1',
        fingerprint: 'sha256:x',
      );
      c = MachineConnection(machine, onNotification: (_) {})..start();
      await until(() => c.status == ConnectionStatus.online);
    });

    tearDown(() async {
      c.dispose();
      await socket?.close();
      await server.close(force: true);
    });

    test('streams no items until a timeline is open', () {
      expect(streams.single.queryParameters['items'], '');
    });

    test('follows the open timelines live', () async {
      c.watch('a1');
      await until(() => messages.length == 1);
      expect(messages.last, {
        'type': 'items',
        'agent_ids': ['a1']
      });
      // A second screen on the same agent changes nothing.
      c.watch('a1');
      c.unwatch('a1');
      c.watch('a2');
      await until(() => messages.length == 2);
      expect((messages.last['agent_ids'] as List).toSet(), {'a1', 'a2'});
      c.unwatch('a1');
      await until(() => messages.length == 3);
      expect(messages.last['agent_ids'], ['a2']);
      expect(c.watched, {'a2'});
    });

    test('reconnects with the open timelines', () async {
      c.watch('a1');
      c.reconnect(force: true);
      await until(() => streams.length == 2 && c.status == ConnectionStatus.online);
      expect(streams.last.queryParameters['items'], 'a1');
    });

    test('a closed timeline reloads when opened again', () async {
      c.watch('a1');
      await c.loadTimeline('a1');
      c.unwatch('a1');
      expect(c.timeline('a1').stale, isTrue);
      c.watch('a1');
      await c.loadTimeline('a1');
      expect(timelineRequests, hasLength(2));
      expect(c.timeline('a1').items.map((i) => i.n), [0, 1, 2, 3, 4, 5]);
    });

    test('a hole before a live item reloads the latest page', () async {
      c.watch('a1');
      await c.loadTimeline('a1');
      event(2, 'agent.item', 'a1', {'n': 3, 'type': 'assistant_message', 'timestamp': '2026-10-07T20:00:00Z'});
      await until(() => c.timeline('a1').items.length == 4);
      expect(timelineRequests, hasLength(1));
      event(3, 'agent.item', 'a1', {'n': 5, 'type': 'assistant_message', 'timestamp': '2026-10-07T20:00:00Z'});
      await until(() => timelineRequests.length == 2 && !c.timeline('a1').loading);
      expect(c.timeline('a1').items.map((i) => i.n), [0, 1, 2, 3, 4, 5]);
    });
  });

  test('update manifest parses the release android.json', () {
    final info = UpdateInfo.parse({
      'version': '1.2.3',
      'version_code': 10203,
      'url': 'https://github.com/noahGms/huntaway/releases/download/v1.2.3/huntaway-android-arm64.apk',
      'sha256': 'ABCDEF',
    });
    expect(info.versionCode, 10203);
    expect(info.sha256, 'abcdef');
  });
}
