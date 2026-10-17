import 'package:flutter/material.dart';

import 'keepalive.dart';
import 'notifications.dart';
import 'sync.dart';
import 'ui/agent_screen.dart';
import 'ui/common.dart';
import 'ui/inbox_screen.dart';
import 'ui/pairing_screen.dart';
import 'ui/settings_screen.dart';

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
    widget.model.addListener(_onModel);
    // Live notifications from the WebSocket, except for the agent on screen.
    widget.model.notifications.listen((n) {
      if (openAgentKey != '${n.machineId}/${n.agentId}') _notifier.show(n);
    });
    _notifier.launchPayload().then((payload) {
      final parts = (payload ?? '').split('|');
      if (parts.length == 2) _openAgent(parts[0], parts[1]);
    });
    if (widget.model.connections.isNotEmpty) _notifier.requestPermission();
  }

  int _machineCount = 0;

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
    navigatorKey.currentState?.push(MaterialPageRoute(
      builder: (_) => AgentScreen(machineId: machineId, agentId: agentId),
    ));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      widget.model.reconnectAll();
      BackgroundLink.instance.stop();
    } else if (state == AppLifecycleState.paused && _notifier.distributor == null) {
      // No push distributor: keep the WebSocket alive in the background.
      BackgroundLink.instance.start();
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
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(
            icon: Badge(isLabelVisible: blocked > 0, label: Text('$blocked'), child: const Icon(Icons.inbox_outlined)),
            selectedIcon: Badge(isLabelVisible: blocked > 0, label: Text('$blocked'), child: const Icon(Icons.inbox)),
            label: 'Inbox',
          ),
          const NavigationDestination(icon: Icon(Icons.dns_outlined), selectedIcon: Icon(Icons.dns), label: 'Machines'),
          const NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: 'Réglages'),
        ],
      ),
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
              'Suis tes agents Herdr, réponds-leur et débloque-les depuis ton téléphone.',
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
                _Step('1', 'Installe et lance huntawayd sur ta machine.'),
                _Step('2', 'Lance huntawayd pair : un QR code s’affiche.', code: 'huntawayd pair'),
                _Step('3', 'Scanne-le avec ce téléphone.', last: true),
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
                label: const Text('Ajouter une machine'),
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
