import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'dart:io';

import 'package:huntaway/api.dart';
import 'package:huntaway/cache.dart';
import 'package:huntaway/models.dart';
import 'package:huntaway/ui/timeline.dart';

TimelineItem item(int n, String type, [Map<String, dynamic> extra = const {}]) =>
    TimelineItem.fromJson({'n': n, 'type': type, 'timestamp': '2026-10-07T20:00:00Z', ...extra});

void main() {
  group('buildEntries', () {
    test('groups activity between messages and hides turn ends', () {
      final entries = buildEntries([
        item(0, 'user_message', {'text': 'Refactor auth'}),
        item(1, 'tool_call', {'kind': 'file_read', 'summary': 'a.ts', 'tool_use_id': 't1'}),
        item(2, 'tool_result', {'tool_use_id': 't1'}),
        item(3, 'tool_call', {'kind': 'file_read', 'summary': 'b.ts', 'tool_use_id': 't2'}),
        item(4, 'tool_call', {'kind': 'file_modified', 'summary': 'a.ts', 'tool_use_id': 't3'}),
        item(5, 'tool_call', {'kind': 'command', 'summary': 'npm test', 'tool_use_id': 't4'}),
        item(6, 'tool_result', {'tool_use_id': 't4', 'is_error': true, 'summary': 'FAIL'}),
        item(7, 'assistant_message', {'text': 'Fini.'}),
        item(8, 'turn_ended'),
        item(9, 'some_future_type'),
      ]);
      expect(entries.length, 3);
      expect(entries[0], isA<MessageEntry>());
      final activity = entries[1] as ActivityEntry;
      expect(activity.summary, '2 reads · 1 edit · npm test');
      expect(activity.errors, 1);
      expect(entries[2], isA<MessageEntry>());
    });

    test('flags rejected tools and folds sub-agents', () {
      final entries = buildEntries([
        item(0, 'tool_call', {'kind': 'command', 'summary': 'rm x', 'tool_use_id': 't1'}),
        item(1, 'tool_result', {'tool_use_id': 't1', 'is_error': true, 'rejected': true}),
        item(2, 'assistant_message', {'text': 'chatter', 'sidechain': true}),
        item(3, 'notice', {'text': 'Interrupted by user'}),
      ]);
      expect(entries.length, 2);
      final activity = entries[0] as ActivityEntry;
      expect(activity.rejected, 1);
      expect(activity.errors, 0);
      expect(entries[1], isA<NoticeEntry>());
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
}
