import 'package:flutter/material.dart';
// Fixtures shared with screenshots_test.dart.
import 'package:flutter_test/flutter_test.dart';
import 'package:huntaway/models.dart';
import 'package:huntaway/sync.dart';
import 'package:huntaway/ui/agent_screen.dart';
import 'package:huntaway/ui/common.dart';
import 'package:huntaway/ui/inbox_screen.dart';

Map<String, dynamic> agentJson(String id, Map<String, dynamic> attention,
        {Map<String, dynamic>? interaction, String summary = 'Refactor auth'}) =>
    {
      'id': id,
      'session': 'default',
      'pane_id': id.split(':').skip(1).join(':'),
      'project': 'mobile-player',
      'tab_label': id.split(':')[1].substring(1),
      'kind': 'claude',
      'herdr_status': attention['status'] == 'blocked' ? 'blocked' : 'idle',
      'attention': attention,
      'summary': summary,
      'last_activity_at': DateTime.now().subtract(const Duration(minutes: 4)).toIso8601String(),
      'interaction': interaction,
      'has_transcript': true,
      'item_count': 6,
      'warnings': [],
    };

TimelineItem item(int n, String type, [Map<String, dynamic> extra = const {}]) =>
    TimelineItem.fromJson({'n': n, 'type': type, 'timestamp': '2026-10-07T20:00:00Z', ...extra});

(AppModel, MachineConnection) fixture() {
  final machine = PairedMachine(
    machineId: 'm1',
    name: 'MacBook Air',
    addresses: ['127.0.0.1:1'],
    token: 't',
    deviceId: 'd1',
    fingerprint: 'sha256:x',
    permissions: ['agents.read', 'agents.message', 'agents.approve', 'agents.interrupt', 'terminal.read'],
  );
  final c = MachineConnection(machine, onNotification: (_) {})..status = ConnectionStatus.online;
  c.agents['default:w1:p1'] = Agent.fromJson(
    'm1',
    agentJson('default:w1:p1', {'status': 'blocked', 'reason': 'approval'}, interaction: {
      'reason': 'approval',
      'tool': {'name': 'Bash', 'summary': 'npm run migrate', 'input': {'command': 'npm run migrate'}},
      'questions': [],
      'options': [
        {'number': 1, 'label': 'Yes', 'selected': true, 'numbered': true},
        {'number': 2, 'label': "Yes, and don't ask again for npm", 'selected': false, 'numbered': true},
        {'number': 3, 'label': 'No', 'selected': false, 'numbered': true},
      ],
    }),
  );
  c.agents['default:w2:p1'] = Agent.fromJson('m1', agentJson('default:w2:p1', {'status': 'working'}, summary: 'Tests offline'));
  c.agents['default:w3:p1'] = Agent.fromJson('m1', agentJson('default:w3:p1', {'status': 'done'}, summary: '184 tests passed'));
  final t = c.timeline('default:w1:p1')
    ..loaded = true
    ..hasMore = false;
  t.merge([
    item(0, 'user_message', {'text': 'Refactor authentication and add tests.'}),
    item(1, 'assistant_message', {
      'text': 'I will start by looking at the current session system:\n\n'
          '- tokens are read from `localStorage`\n'
          '- **no test** covers renewal',
    }),
    item(2, 'tool_call', {'kind': 'file_read', 'summary': 'src/auth/session.ts', 'tool_use_id': 'a'}),
    item(3, 'tool_call', {
      'kind': 'file_modified',
      'summary': 'src/auth/session.ts',
      'tool_use_id': 'b',
      'change': {'path': '/repo/src/auth/session.ts', 'old': 'const token = localStorage.get()', 'new': 'const token = await secureStorage.get()', 'truncated': false},
    }),
    item(4, 'tool_call', {'kind': 'command', 'summary': 'npm run migrate', 'tool_use_id': 'c'}),
  ]);
  final model = AppModel()..addConnectionForTest(c);
  return (model, c);
}

Widget host(AppModel model, Widget child) =>
    AppScope(model: model, child: MaterialApp(debugShowCheckedModeBanner: false, theme: huntawayTheme(), home: child));

void main() {
  testWidgets('Inbox puts blocked agents first with their pending command', (tester) async {
    final (model, _) = fixture();
    await tester.pumpWidget(host(model, const InboxScreen()));
    expect(find.text('NEEDS YOU'), findsOneWidget);
    expect(find.text('WORKING'), findsOneWidget);
    expect(find.text('DONE'), findsOneWidget);
    expect(find.text('Wants to use Bash'), findsOneWidget);
    expect(find.text('npm run migrate'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
    final blockedY = tester.getTopLeft(find.text('NEEDS YOU')).dy;
    final doneY = tester.getTopLeft(find.text('DONE')).dy;
    expect(blockedY, lessThan(doneY));
  });

  testWidgets('Agent screen shows the turn, its folded work and the approval card', (tester) async {
    final (model, _) = fixture();
    await tester.pumpWidget(host(model, const AgentScreen(machineId: 'm1', agentId: 'default:w1:p1')));
    await tester.pump();
    expect(find.text('Refactor authentication and add tests.'), findsOneWidget);
    expect(find.text('Worked · 1 file read · 1 command · 1 file changed'), findsOneWidget);
    // The files changed by the turn, after it.
    expect(find.text('session.ts'), findsOneWidget);
    expect(find.text('Claude asks for permission'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
    expect(find.text('Deny'), findsOneWidget);
    expect(find.text("Yes, and don't ask again for npm"), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Deny and explain…'), findsOneWidget);
    // Expanding the work lists each tool call.
    await tester.tap(find.text('Worked · 1 file read · 1 command · 1 file changed'));
    await tester.pump();
    expect(find.text('Edited'), findsOneWidget);
    // Tapping the modified file opens its diff.
    await tester.tap(find.text('Edited'));
    await tester.pump(const Duration(milliseconds: 600)); // status dots pulse forever
    expect(find.text('session.ts'), findsNWidgets(2));
    expect(find.text('- const token = localStorage.get()'), findsOneWidget);
    expect(find.text('+ const token = await secureStorage.get()'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Working agent shows the live work row and a stop button', (tester) async {
    final (model, c) = fixture();
    c.timeline('default:w2:p1')
      ..loaded = true
      ..merge([item(0, 'tool_call', {'kind': 'command', 'summary': 'npm test', 'tool_use_id': 'x'})]);
    await tester.pumpWidget(host(model, const AgentScreen(machineId: 'm1', agentId: 'default:w2:p1')));
    await tester.pump();
    expect(find.text('Running npm test…'), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Inbox search filters agents', (tester) async {
    final (model, _) = fixture();
    await tester.pumpWidget(host(model, const InboxScreen()));
    await tester.tap(find.byIcon(Icons.search));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'offline');
    await tester.pump();
    expect(find.text('WORKING'), findsOneWidget);
    expect(find.text('NEEDS YOU'), findsNothing);
    await tester.enterText(find.byType(TextField), 'zzz');
    await tester.pump();
    expect(find.textContaining('No agent matches'), findsOneWidget);
  });

  testWidgets('Queued messages show at the end until the transcript has them', (tester) async {
    final (model, c) = fixture();
    c.timeline('default:w2:p1').loaded = true;
    c.agents['default:w2:p1'] = Agent.fromJson('m1', {
      ...agentJson('default:w2:p1', {'status': 'working'}),
      'queued': [
        {'id': 'q1', 'text': 'Also update the README', 'at': 1791403200, 'state': 'waiting'},
        {'id': 'q2', 'text': 'And the changelog', 'at': 1791403200, 'state': 'sent'},
      ],
    });
    await tester.pumpWidget(host(model, const AgentScreen(machineId: 'm1', agentId: 'default:w2:p1')));
    await tester.pump();
    expect(find.text('Also update the README'), findsOneWidget);
    expect(find.textContaining('Queued · sent when the agent finishes'), findsOneWidget);
    expect(find.text('Sent · read after its current step'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Child agents nest under their parent, with a launch card and a breadcrumb', (tester) async {
    final (model, c) = fixture();
    c.agents['default:w2:p1'] = Agent.fromJson('m1', {
      ...agentJson('default:w2:p1', {'status': 'working'}, summary: 'Tests offline'),
      'children': ['default:w2:p2'],
    });
    c.agents['default:w2:p2'] = Agent.fromJson('m1', {
      ...agentJson('default:w2:p2', {'status': 'blocked', 'reason': 'approval'}, summary: 'Write the docs'),
      'name': 'docs',
      'parent_id': 'default:w2:p1',
    });
    c.timeline('default:w2:p1')
      ..loaded = true
      ..merge([
        item(0, 'user_message', {'text': 'Split the work'}),
        item(1, 'tool_call', {
          'kind': 'agent',
          'summary': 'herdr agent start docs',
          'tool_use_id': 'x',
          'agent': {'name': 'docs', 'pane_id': 'w2:p2', 'kind': 'codex', 'prompt': 'Write the docs', 'start': true},
        }),
        item(2, 'turn_ended'),
      ]);
    c.timeline('default:w2:p2').loaded = true;
    await tester.pumpWidget(host(model, const InboxScreen()));
    // The parent goes to "Needs you" with its blocked child under it.
    expect(find.text('WORKING'), findsNothing);
    expect(find.text('1 agent'), findsOneWidget);
    final parentY = tester.getTopLeft(find.text('Tests offline')).dy;
    final childY = tester.getTopLeft(find.text('Write the docs')).dy;
    expect(parentY, lessThan(childY));
    // Indented under it.
    expect(tester.getTopLeft(find.byType(BlockedCard).last).dx,
        greaterThan(tester.getTopLeft(find.ancestor(of: find.text('Tests offline'), matching: find.byType(Card))).dx));

    await tester.tap(find.text('Tests offline'));
    await tester.pump(const Duration(milliseconds: 600)); // status dots pulse forever
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Agent started'), findsOneWidget);
    expect(find.text('Waiting for your approval: Bash'), findsNothing);
    expect(find.text('Waiting for your answer'), findsOneWidget);
    await tester.tap(find.text('Agent started'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('  ›  '), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
