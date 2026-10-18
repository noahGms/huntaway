// End-to-end run of the real app against a running huntawayd (macOS desktop).
//
//   flutter test integration_test/live_test.dart -d macos \
//     --dart-define=PAIRING='<json from huntawayd pair --json>' \
//     --dart-define=AGENT_PROJECT=spike-project \
//     --dart-define=SHOTS=/tmp/huntaway-shots
//
// Pairs through the manual-entry dialog, opens the agent, sends a message
// that needs an approval, approves it from the card, and saves screenshots.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:huntaway/main.dart';
import 'package:huntaway/notifications.dart';
import 'package:huntaway/sync.dart';

const pairing = String.fromEnvironment('PAIRING');
const project = String.fromEnvironment('AGENT_PROJECT', defaultValue: 'spike-project');
const shots = String.fromEnvironment('SHOTS', defaultValue: '/tmp/huntaway-shots');
const marker = String.fromEnvironment('MARKER', defaultValue: 'live');
// Optional: restart the daemon to test reconnection (PRD §17).
const huntawayd = String.fromEnvironment('HUNTAWAYD');
const huntawayHome = String.fromEnvironment('HUNTAWAY_HOME');

final _boundary = GlobalKey();

/// In-memory storage: the test must not touch (or prompt for) the keychain.
class MemoryStorage extends FlutterSecureStorage {
  MemoryStorage();
  final _values = <String, String>{};

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      value == null ? _values.remove(key) : _values[key] = value;
}

Future<void> shot(WidgetTester tester, String name) async {
  await tester.pump(const Duration(milliseconds: 300));
  final boundary = _boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: 2);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  await Directory(shots).create(recursive: true);
  await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
}

/// Pumps real frames until [finder] matches (network calls need real time).
Future<void> waitFor(WidgetTester tester, Finder finder, {Duration timeout = const Duration(seconds: 40)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 200));
    if (finder.evaluate().isNotEmpty) return;
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
  await shot(tester, 'echec');
  throw TestFailure('Not found after $timeout: $finder');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('pair, open agent, send, approve', (tester) async {
    expect(pairing, isNotEmpty, reason: '--dart-define=PAIRING manquant');
    Notifier.instance.askPermission = false;
    final model = AppModel(storage: MemoryStorage());
    await model.load();
    await tester.pumpWidget(RepaintBoundary(key: _boundary, child: HuntawayApp(model: model)));
    await shot(tester, '01-accueil');

    // Pairing through the manual entry dialog.
    await tester.tap(find.text('Add a machine'));
    await waitFor(tester, find.text('Enter manually'));
    await tester.pump(const Duration(seconds: 2));
    await shot(tester, '01b-appairage');
    await tester.tap(find.text('Enter manually'));
    await tester.pump(const Duration(seconds: 1));
    await shot(tester, '01c-apres-tap');
    await waitFor(tester, find.byType(AlertDialog));
    await tester.enterText(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), pairing);
    await tester.tap(find.text('Pair'));

    // Inbox with the test agent.
    await waitFor(tester, find.textContaining(project));
    await tester.pump(const Duration(seconds: 1));
    await shot(tester, '02-inbox');

    await tester.ensureVisible(find.textContaining(project).first);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.textContaining(project).first);
    await waitFor(tester, find.byType(TextField));
    await tester.pump(const Duration(seconds: 2));
    await shot(tester, '03-conversation');

    // Send a message that requires an approval.
    await tester.enterText(find.byType(TextField),
        'Create the file $marker.txt with exactly this Bash command: echo $marker > $marker.txt');
    await tester.pump(const Duration(milliseconds: 500));
    final send = find.ancestor(of: find.byIcon(Icons.arrow_upward_rounded), matching: find.byType(IconButton));
    for (var i = 0; i < 5; i++) {
      if (tester.widget<IconButton>(send).onPressed != null) {
        await tester.tap(send);
      }
      await tester.pump(const Duration(seconds: 2));
      final field = tester.widget<TextField>(find.byType(TextField));
      if (field.controller!.text.isEmpty) break; // sent
    }
    await waitFor(tester, find.text('Approve'), timeout: const Duration(seconds: 60));
    await tester.pump(const Duration(seconds: 1));
    await shot(tester, '04-approval');

    await tester.tap(find.text('Approve'));
    await waitFor(tester, find.textContaining('$marker.txt').at(1), timeout: const Duration(seconds: 60));
    await tester.pump(const Duration(seconds: 4));
    await shot(tester, '05-after-approval');

    // Terminal view (colored screen through xterm).
    await tester.tap(find.byIcon(Icons.terminal_rounded));
    await tester.pump(const Duration(seconds: 4));
    await shot(tester, '05b-terminal');
    await tester.pageBack();
    await tester.pump(const Duration(seconds: 1));

    if (huntawayd.isNotEmpty) {
      // Back to the inbox, then restart the daemon under the app's feet.
      await tester.pageBack();
      await waitFor(tester, find.text('Huntaway'));
      await Process.run('pkill', ['-f', 'huntawayd run']);
      await waitFor(tester, find.textContaining('Offline'), timeout: const Duration(seconds: 30));
      await shot(tester, '06-offline');
      await Process.start(huntawayd, ['run'],
          environment: {'HUNTAWAY_HOME': huntawayHome}, mode: ProcessStartMode.detached);
      // New epoch: the app must reconnect and reload by itself.
      final end = DateTime.now().add(const Duration(seconds: 60));
      while (find.textContaining('Offline').evaluate().isNotEmpty && DateTime.now().isBefore(end)) {
        await tester.pump(const Duration(milliseconds: 300));
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
      expect(find.textContaining('Offline'), findsNothing);
      await waitFor(tester, find.textContaining(project));
      await shot(tester, '07-reconnected');
    }

    for (final c in [...model.connections]) {
      await model.removeMachine(c.machine.machineId);
    }
  });
}
