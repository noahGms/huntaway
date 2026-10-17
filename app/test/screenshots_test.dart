// Renders the main screens to PNG for visual review:
//   HUNTAWAY_SCREENSHOTS=1 flutter test test/screenshots_test.dart --update-goldens
// Images land in test/screenshots/. Skipped otherwise: font rendering differs
// between machines, so the images are not compared in CI.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:huntaway/main.dart';
import 'package:huntaway/ui/agent_screen.dart';
import 'package:huntaway/ui/inbox_screen.dart';
import 'package:huntaway/ui/settings_screen.dart';

import 'widgets_test.dart' show fixture, host;

Future<void> loadFonts() async {
  final dir = '${Platform.environment['FLUTTER_ROOT'] ?? '${Platform.environment['HOME']}/development/flutter'}'
      '/bin/cache/artifacts/material_fonts';
  final roboto = FontLoader('Roboto');
  for (final w in ['Regular', 'Medium', 'Bold']) {
    roboto.addFont(File('$dir/Roboto-$w.ttf').readAsBytes().then((b) => ByteData.view(b.buffer)));
  }
  await roboto.load();
  final icons = FontLoader('MaterialIcons')
    ..addFont(File('$dir/MaterialIcons-Regular.otf').readAsBytes().then((b) => ByteData.view(b.buffer)));
  await icons.load();
  final plex = FontLoader('Plex');
  for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    plex.addFont(File('assets/fonts/IBMPlexSans-$w.ttf').readAsBytes().then((b) => ByteData.view(b.buffer)));
  }
  await plex.load();
  final jb = FontLoader('JetBrainsMono');
  for (final w in ['Regular', 'Medium']) {
    jb.addFont(File('assets/fonts/JetBrainsMono-$w.ttf').readAsBytes().then((b) => ByteData.view(b.buffer)));
  }
  await jb.load();
}

void main() {
  setUpAll(loadFonts);

  Future<void> shoot(WidgetTester tester, Widget screen, String name) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    final (model, c) = fixture();
    c.timeline('default:w2:p1').loaded = true;
    await tester.pumpWidget(host(model, screen));
    await tester.pump(const Duration(milliseconds: 500));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('screenshots/$name.png'));
    await tester.pumpWidget(const SizedBox());
    tester.view.reset();
  }

  final skip = Platform.environment['HUNTAWAY_SCREENSHOTS'] == null;
  testWidgets('inbox', (t) => shoot(t, const InboxScreen(), 'inbox'), skip: skip);
  testWidgets('agent', (t) => shoot(t, const AgentScreen(machineId: 'm1', agentId: 'default:w1:p1'), 'agent'),
      skip: skip);
  testWidgets('agent-working', (t) => shoot(t, const AgentScreen(machineId: 'm1', agentId: 'default:w2:p1'), 'agent-working'),
      skip: skip);
  testWidgets('home', (t) => shoot(t, const HomeShell(), 'home'), skip: skip);
  testWidgets('projects', (t) => shoot(t, const ProjectsScreen(), 'projects'), skip: skip);
  testWidgets('settings', (t) => shoot(t, const SettingsScreen(), 'settings'), skip: skip);
  testWidgets('welcome', (t) => shoot(t, const WelcomeScreen(), 'welcome'), skip: skip);
}
