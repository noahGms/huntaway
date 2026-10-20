import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../sync.dart';

/// Palette taken from the logo: ink ground, cream for actions, the dog's tan
/// reserved for "an agent needs you".
class HuntawayColors {
  static const background = Color(0xFF101216);
  static const surface = Color(0xFF171A1F);
  static const surfaceHigh = Color(0xFF20242B);
  static const border = Color(0xFF292E36);
  static const text = Color(0xFFECE8E1);
  static const muted = Color(0xFF8F949C);
  static const faint = Color(0xFF5E636B);

  /// Primary actions (filled buttons, send).
  static const accent = Color(0xFFF3E6D3);
  static const onAccent = Color(0xFF14171C);

  /// Brand tan: blocked agents, approval cards, the inbox badge.
  static const blocked = Color(0xFFE39B4B);
  static const working = Color(0xFF6AA6F8);
  static const done = Color(0xFF4CC38A);
  static const error = Color(0xFFF0605D);

  /// User message bubble.
  static const user = Color(0xFF2B2A27);
}

const monoFont = 'JetBrainsMono';
const mono = TextStyle(fontFamily: monoFont, fontSize: 12.5, height: 1.4);

ThemeData huntawayTheme() {
  final base = ThemeData(
    brightness: Brightness.dark,
    useMaterial3: true,
    fontFamily: 'Plex',
    colorScheme: const ColorScheme.dark(
      primary: HuntawayColors.accent,
      onPrimary: HuntawayColors.onAccent,
      secondary: HuntawayColors.blocked,
      surface: HuntawayColors.surface,
      onSurface: HuntawayColors.text,
      surfaceContainerHighest: HuntawayColors.surfaceHigh,
      outline: HuntawayColors.border,
      error: HuntawayColors.error,
    ),
    scaffoldBackgroundColor: HuntawayColors.background,
    splashFactory: InkSparkle.splashFactory,
  );
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(12));
  const buttonPadding = EdgeInsets.symmetric(horizontal: 18, vertical: 13);
  const buttonText = TextStyle(fontFamily: 'Plex', fontWeight: FontWeight.w600, fontSize: 15);
  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: HuntawayColors.background,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(fontFamily: 'Plex', fontSize: 20, fontWeight: FontWeight.w600, color: HuntawayColors.text),
    ),
    cardTheme: CardThemeData(
      color: HuntawayColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: HuntawayColors.border),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: HuntawayColors.accent,
        foregroundColor: HuntawayColors.onAccent,
        disabledBackgroundColor: HuntawayColors.surfaceHigh,
        padding: buttonPadding,
        textStyle: buttonText,
        shape: shape,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: HuntawayColors.text,
        side: const BorderSide(color: HuntawayColors.border),
        padding: buttonPadding,
        textStyle: buttonText,
        shape: shape,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: HuntawayColors.accent, textStyle: buttonText, shape: shape),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(foregroundColor: HuntawayColors.text),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: HuntawayColors.background,
      surfaceTintColor: Colors.transparent,
      indicatorColor: HuntawayColors.surfaceHigh,
      height: 64,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(
            fontFamily: 'Plex',
            fontSize: 12,
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w500,
            color: s.contains(WidgetState.selected) ? HuntawayColors.text : HuntawayColors.muted,
          )),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(
            size: 22,
            color: s.contains(WidgetState.selected) ? HuntawayColors.text : HuntawayColors.muted,
          )),
    ),
    badgeTheme: const BadgeThemeData(backgroundColor: HuntawayColors.blocked, textColor: HuntawayColors.onAccent),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: HuntawayColors.surfaceHigh,
      hintStyle: const TextStyle(color: HuntawayColors.muted),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(22),
        borderSide: const BorderSide(color: HuntawayColors.border),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? HuntawayColors.onAccent : HuntawayColors.muted),
      trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? HuntawayColors.accent : HuntawayColors.surfaceHigh),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: HuntawayColors.surfaceHigh,
      contentTextStyle: const TextStyle(fontFamily: 'Plex', color: HuntawayColors.text),
      behavior: SnackBarBehavior.floating,
      shape: shape,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: HuntawayColors.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: HuntawayColors.surfaceHigh,
      surfaceTintColor: Colors.transparent,
      shape: shape,
    ),
    dividerTheme: const DividerThemeData(color: HuntawayColors.border, space: 1),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: HuntawayColors.accent),
  );
}

Color attentionColor(Attention a) => switch (a.status) {
      AttentionStatus.blocked when a.askedYou => HuntawayColors.done,
      AttentionStatus.blocked => HuntawayColors.blocked,
      AttentionStatus.working => HuntawayColors.working,
      AttentionStatus.done => HuntawayColors.done,
      _ => HuntawayColors.faint,
    };

/// Status dot; pulses while the agent works or waits.
class StatusDot extends StatefulWidget {
  const StatusDot(this.attention, {super.key, this.size = 8});
  final Attention attention;
  final double size;

  @override
  State<StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<StatusDot> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));

  bool get _live =>
      widget.attention.status == AttentionStatus.working || widget.attention.needsYou;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(StatusDot old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final reduce = WidgetsBinding.instance.platformDispatcher.accessibilityFeatures.disableAnimations;
    if (_live && !reduce) {
      if (!_pulse.isAnimating) _pulse.repeat();
    } else {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = attentionColor(widget.attention);
    final s = widget.size;
    return SizedBox(
      width: s * 2.2,
      height: s * 2.2,
      child: AnimatedBuilder(
        animation: _pulse,
        builder: (context, _) => Stack(alignment: Alignment.center, children: [
          if (_pulse.isAnimating)
            Container(
              width: s * (1 + 1.2 * _pulse.value),
              height: s * (1 + 1.2 * _pulse.value),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.35 * (1 - _pulse.value)),
              ),
            ),
          Container(width: s, height: s, decoration: BoxDecoration(shape: BoxShape.circle, color: color)),
        ]),
      ),
    );
  }
}

class AttentionBadge extends StatelessWidget {
  const AttentionBadge(this.attention, {super.key, this.compact = false});
  final Attention attention;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final color = attentionColor(attention);
    return Container(
      padding: EdgeInsets.fromLTRB(compact ? 2 : 4, 2, compact ? 8 : 10, 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        StatusDot(attention, size: 6),
        Text(attention.label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class AgentAvatar extends StatelessWidget {
  const AgentAvatar(this.kind, {super.key, this.size = 36});
  final String kind;
  final double size;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (kind) {
      'claude' => (Icons.auto_awesome, const Color(0xFFD97757)),
      'codex' => (Icons.blur_on, const Color(0xFFC9CDD3)),
      'shell' => (Icons.terminal, HuntawayColors.muted),
      _ => (Icons.smart_toy_outlined, HuntawayColors.muted),
    };
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: HuntawayColors.surfaceHigh,
        borderRadius: BorderRadius.circular(size * 0.3),
        border: Border.all(color: HuntawayColors.border),
      ),
      child: Icon(icon, color: color, size: size * 0.5),
    );
  }
}

/// What the agent is doing, used as its title: Herdr gives agents no name.
String agentTitle(Agent a) {
  final i = a.interaction;
  if (i != null && i.questions.isNotEmpty) return i.questions.first.question;
  if (a.summary.isNotEmpty) return a.summary;
  return '${a.displayName} · no task';
}

/// "Claude · apii · tab 2 · MacBook Air"
String agentSubtitle(Agent a, {String? machine, bool withKind = true}) {
  final tab = a.tabLabel;
  return [
    if (withKind) a.displayName,
    a.workspaceLabel?.isNotEmpty == true ? a.workspaceLabel! : a.project,
    if (tab != null && tab.isNotEmpty) int.tryParse(tab) != null ? 'tab $tab' : tab,
    ?machine,
  ].join(' · ');
}

/// The Huntaway mark: a chevron driving three dots (docs/logo/huntaway.svg).
class HuntawayLogo extends StatelessWidget {
  const HuntawayLogo({super.key, this.size = 48, this.tile = true});
  final double size;

  /// Draws the ink rounded tile behind the mark, as on the app icon.
  final bool tile;

  @override
  Widget build(BuildContext context) {
    final mark = CustomPaint(size: Size.square(size), painter: _LogoPainter(inset: tile ? 0.18 : 0));
    if (!tile) return mark;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: const Color(0xFF14171C),
        borderRadius: BorderRadius.circular(size * 0.24),
        border: Border.all(color: HuntawayColors.border),
      ),
      child: mark,
    );
  }
}

class _LogoPainter extends CustomPainter {
  _LogoPainter({required this.inset});
  final double inset;

  static const tan = Color(0xFFE39B4B);
  static const cream = Color(0xFFF3E6D3);

  @override
  void paint(Canvas canvas, Size size) {
    // Glyph bounds in the 1024 source grid: x 210..820, y 320..704.
    final avail = size.width * (1 - 2 * inset);
    final k = avail / 610;
    canvas.translate(size.width / 2 - 515 * k, size.height / 2 - 512 * k);
    canvas.scale(k);
    final chevron = Path()
      ..moveTo(250, 360)
      ..lineTo(402, 512)
      ..lineTo(250, 664);
    canvas.drawPath(
      chevron,
      Paint()
        ..color = tan
        ..style = PaintingStyle.stroke
        ..strokeWidth = 80
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
    for (final (x, a) in [(540.0, 0.3), (660.0, 0.6), (780.0, 1.0)]) {
      canvas.drawCircle(Offset(x, 512), 40, Paint()..color = cream.withValues(alpha: a));
    }
  }

  @override
  bool shouldRepaint(_LogoPainter old) => old.inset != inset;
}

String relativeTime(DateTime? t) {
  if (t == null) return '';
  final d = DateTime.now().difference(t);
  if (d.inSeconds < 60) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes}m';
  if (d.inHours < 24) return '${d.inHours}h';
  return '${d.inDays}d';
}

/// "just now", "4m ago"…
String relativeAgo(DateTime? t) {
  final r = relativeTime(t);
  return r.isEmpty || r == 'just now' ? r : '$r ago';
}

String clock(DateTime? t) {
  if (t == null) return '';
  final l = t.toLocal();
  return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
}

/// Banner listing machines that are not reachable right now.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner(this.connections, {super.key});
  final List<MachineConnection> connections;

  @override
  Widget build(BuildContext context) {
    final offline = connections.where((c) => c.status == ConnectionStatus.offline).toList();
    if (offline.isEmpty) return const SizedBox.shrink();
    final names = offline.map((c) => c.machine.name).join(', ');
    final since = offline.map((c) => c.lastSyncAt).whereType<DateTime>().fold<DateTime?>(
        null, (a, b) => a == null || b.isBefore(a) ? b : a);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: HuntawayColors.error.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        'Offline: $names${since != null ? ' · last update ${relativeAgo(since)}' : ''}',
        style: const TextStyle(color: HuntawayColors.error, fontSize: 13),
      ),
    );
  }
}

/// Exposes the [AppModel] to the widget tree.
class AppScope extends InheritedNotifier<AppModel> {
  const AppScope({super.key, required AppModel model, required super.child}) : super(notifier: model);

  static AppModel of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  /// The model without rebuilding when it changes (callbacks, or widgets
  /// listening to a narrower notifier).
  static AppModel read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

String errorMessage(Object error) => switch (error) {
      BridgeException(code: 'interaction_changed') => 'The agent is now asking something else',
      BridgeException(code: 'agent_blocked') => 'The agent is waiting for an answer',
      _ => error.toString(),
    };

void showError(BuildContext context, Object error) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    content: Text(errorMessage(error)),
    backgroundColor: HuntawayColors.error,
    behavior: SnackBarBehavior.floating,
  ));
}
