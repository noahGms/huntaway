import 'package:flutter/material.dart';

import 'keepalive.dart';
import 'models.dart';
import 'notifications.dart';
import 'sync.dart';
import 'ui/agent_screen.dart';
import 'ui/common.dart';
import 'ui/inbox_screen.dart';
import 'ui/pairing_screen.dart';
import 'ui/settings_screen.dart';
import 'updater.dart';

final navigatorKey = GlobalKey<NavigatorState>();

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  final notifier = Notifier.instance;
  await notifier.init();
  await notifier.initPush();
  // Started by UnifiedPush to deliver a push in the background: no UI.
  if (args.contains('--unifiedpush-bg')) return;

  await BackgroundLink.instance.load();
  final model = AppModel();
  await model.load();
  runApp(HuntawayApp(model: model));
}

class HuntawayApp extends StatefulWidget {
  const HuntawayApp({super.key, required this.model});
  final AppModel model;

  @override
  State<HuntawayApp> createState() => _HuntawayAppState();
}

class _HuntawayAppState extends State<HuntawayApp> with WidgetsBindingObserver {
  final _notifier = Notifier.instance;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _notifier.onOpen = _openAgent;
    _notifier.onEndpoint = _sendEndpoint;
    _notifier.coveredByStream =
        (machineId) => _foreground && widget.model.connection(machineId)?.status == ConnectionStatus.online;
    widget.model.addListener(_onModel);
    widget.model.notifications.listen(_onNotification);
    _notifier.launchPayload().then((payload) {
      final parts = (payload ?? '').split('|');
      if (parts.length == 2) _openAgent(parts[0], parts[1]);
    });
    if (widget.model.connections.isNotEmpty) _notifier.requestPermission();
    Updater.instance.check();
  }

  int _machineCount = 0;
  DateTime? _pausedAt;

  bool get _foreground => WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;

  /// Live notifications from the WebSocket.
  void _onNotification(AgentNotification n) {
    // The agent on screen needs no alert, but only while the screen is
    // actually visible (not in the background or behind the lock screen).
    if (_foreground && openAgentKey == '${n.machineId}/${n.agentId}') return;
    // Replayed after a reconnection: push already delivered it.
    if (n.replayed && _notifier.endpoint != null) return;
    _notifier.show(n);
  }

  void _onModel() {
    // A newly paired machine needs the current push endpoint.
    final count = widget.model.connections.length;
    if (count > _machineCount && _notifier.endpoint != null) _sendEndpoint(_notifier.endpoint);
    _machineCount = count;
  }

  void _sendEndpoint(String? endpoint) {
    for (final c in widget.model.connections) {
      c.client.registerPush(endpoint).catchError((_) {});
    }
  }

  void _openAgent(String machineId, String agentId) {
    // A forgotten machine may still have a notification around.
    if (widget.model.connection(machineId) == null) return;
    if (openAgentKey == '$machineId/$agentId') return;
    // Replace any agent screen already open instead of stacking them.
    navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => AgentScreen(machineId: machineId, agentId: agentId)),
      (route) => route.isFirst,
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // After a while in the background the socket may have died silently
      // (network change, sleep): don't trust it. A glance at the
      // notification shade only reconnects what is offline.
      final away = _pausedAt != null && DateTime.now().difference(_pausedAt!) > const Duration(seconds: 5);
      _pausedAt = null;
      widget.model.reconnectAll(force: away);
      BackgroundLink.instance.stop();
      Updater.instance.resumed();
    } else if (state == AppLifecycleState.paused) {
      _pausedAt ??= DateTime.now();
      // No push distributor: keep the WebSocket alive in the background.
      if (_notifier.distributor == null) BackgroundLink.instance.start();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.model.removeListener(_onModel);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      model: widget.model,
      child: MaterialApp(
        title: 'Huntaway',
        navigatorKey: navigatorKey,
        debugShowCheckedModeBanner: false,
        theme: huntawayTheme(),
        home: const HomeShell(),
      ),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final model = AppScope.of(context);
    if (model.connections.isEmpty) return const WelcomeScreen();
    final blocked = model.agents.where((a) => a.attention.priority == 0).length;
    return Scaffold(
      body: IndexedStack(index: _tab, children: const [
        InboxScreen(),
        ProjectsScreen(),
        SettingsScreen(),
      ]),
      bottomNavigationBar: Column(mainAxisSize: MainAxisSize.min, children: [
        const UpdateBanner(),
        NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: [
            NavigationDestination(
              icon: Badge(isLabelVisible: blocked > 0, label: Text('$blocked'), child: const Icon(Icons.inbox_outlined)),
              selectedIcon: Badge(isLabelVisible: blocked > 0, label: Text('$blocked'), child: const Icon(Icons.inbox)),
              label: 'Inbox',
            ),
            const NavigationDestination(icon: Icon(Icons.dns_outlined), selectedIcon: Icon(Icons.dns), label: 'Machines'),
            const NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: 'Settings'),
          ],
        ),
      ]),
    );
  }
}

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Spacer(flex: 2),
            const HuntawayLogo(size: 72),
            const SizedBox(height: 24),
            const Text('Huntaway', style: TextStyle(fontSize: 36, fontWeight: FontWeight.w700, letterSpacing: -0.5)),
            const SizedBox(height: 8),
            const Text(
              'Follow your Herdr agents, answer them and unblock them from your phone.',
              style: TextStyle(fontSize: 16.5, color: HuntawayColors.muted, height: 1.45),
            ),
            const SizedBox(height: 32),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: HuntawayColors.surface,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: HuntawayColors.border),
              ),
              child: const Column(children: [
                _Step('1', 'Install and start huntawayd on your machine.'),
                _Step('2', 'Run huntawayd pair to show a QR code.', code: 'huntawayd pair'),
                _Step('3', 'Scan it with this phone.', last: true),
              ]),
            ),
            const Spacer(flex: 3),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                onPressed: () async {
                  final paired = await Navigator.of(context)
                      .push<bool>(MaterialPageRoute(builder: (_) => const PairingScreen()));
                  if (paired == true) Notifier.instance.requestPermission();
                },
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Add a machine'),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step(this.n, this.text, {this.code, this.last = false});
  final String n;
  final String text;

  /// Part of [text] shown as a command.
  final String? code;
  final bool last;

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(fontSize: 15, height: 1.4, color: HuntawayColors.text);
    final parts = code == null ? [text] : text.split(code!);
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: HuntawayColors.blocked.withValues(alpha: 0.6)),
          ),
          child: Text(n, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: HuntawayColors.blocked)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Text.rich(TextSpan(style: style, children: [
              TextSpan(text: parts.first),
              if (code != null) ...[
                TextSpan(text: code, style: mono.copyWith(fontSize: 13.5, color: HuntawayColors.accent)),
                TextSpan(text: parts.last),
              ],
            ])),
          ),
        ),
      ]),
    );
  }
}

/// "Update available" strip above the tab bar, with the download progress.
class UpdateBanner extends StatelessWidget {
  const UpdateBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final updater = Updater.instance;
    return ListenableBuilder(
      listenable: updater,
      builder: (context, _) {
        final info = updater.available;
        if (info == null || (updater.dismissed && updater.progress == null)) return const SizedBox.shrink();
        final progress = updater.progress;
        return Container(
          margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
          padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
          decoration: BoxDecoration(
            color: HuntawayColors.surfaceHigh,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: HuntawayColors.border),
          ),
          child: Row(children: [
            const Icon(Icons.system_update_outlined, size: 18, color: HuntawayColors.accent),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(
                  progress != null
                      ? 'Downloading ${info.version}… ${(progress * 100).round()}%'
                      : updater.error ?? 'Update available (${info.version})',
                  style: TextStyle(
                      fontSize: 13.5, color: updater.error != null ? HuntawayColors.error : HuntawayColors.text),
                ),
                if (progress != null) ...[
                  const SizedBox(height: 4),
                  LinearProgressIndicator(value: progress == 0 ? null : progress, minHeight: 2),
                ],
              ]),
            ),
            if (progress == null) ...[
              TextButton(
                onPressed: updater.dismiss,
                child: const Text('Later', style: TextStyle(color: HuntawayColors.muted)),
              ),
              TextButton(onPressed: updater.downloadAndInstall, child: const Text('Update')),
            ],
          ]),
        );
      },
    );
  }
}
