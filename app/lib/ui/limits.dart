import 'package:flutter/material.dart';

import '../models.dart';
import '../sync.dart';
import 'common.dart';

Color limitColor(double percent) => percent >= 90
    ? HuntawayColors.error
    : percent >= 70
        ? HuntawayColors.blocked
        : HuntawayColors.muted;

String percentLabel(double percent) => '${percent.round()}%';

String _kindLabel(String kind) => switch (kind) {
      'claude' => 'Claude Code',
      'codex' => 'Codex',
      _ => kind.isEmpty ? kind : kind[0].toUpperCase() + kind.substring(1),
    };

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// `resets in 1h 40m`, or the day and time beyond a day.
String? resetLabel(DateTime? resetsAt, DateTime now) {
  if (resetsAt == null) return null;
  final secs = resetsAt.difference(now).inSeconds.clamp(0, 1 << 31);
  if (secs < 3600) return 'resets in ${(secs / 60).round().clamp(1, 60)}m';
  if (secs < 86400) {
    final h = secs ~/ 3600;
    final m = ((secs % 3600) / 60).round();
    return 'resets in ${h}h${m > 0 ? ' ${m}m' : ''}';
  }
  final t = resetsAt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return 'resets ${_weekdays[t.weekday - 1]} ${two(t.hour)}:${two(t.minute)}';
}

String _ago(DateTime t, DateTime now) {
  final s = now.difference(t).inSeconds;
  if (s < 60) return 'now';
  if (s < 3600) return '${s ~/ 60}m ago';
  if (s < 86400) return '${s ~/ 3600}h ago';
  return '${s ~/ 86400}d ago';
}

/// Plan limits per machine above the inbox: peak use per provider, details
/// on tap.
class LimitsBar extends StatelessWidget {
  const LimitsBar({super.key, required this.connections});
  final List<MachineConnection> connections;

  @override
  Widget build(BuildContext context) {
    final known = connections.where((c) => (c.limits?.shown ?? const []).isNotEmpty).toList();
    if (known.isEmpty) return const SizedBox.shrink();
    final now = DateTime.now();
    return SizedBox(
      height: 40,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        children: [
          for (final c in known)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: () => showLimitsSheet(context, known),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: HuntawayColors.surface,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: HuntawayColors.border),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (known.length > 1) ...[
                      Text(c.machine.name, style: const TextStyle(fontSize: 12, color: HuntawayColors.muted)),
                      const SizedBox(width: 8),
                    ],
                    for (final p in c.limits!.shown) ...[
                      AgentAvatar(p.kind, size: 18),
                      const SizedBox(width: 4),
                      Builder(builder: (_) {
                        final peak = p.peak(now);
                        return Text(
                          peak == null ? '—' : percentLabel(peak.usedPercent),
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: peak == null ? HuntawayColors.faint : limitColor(peak.usedPercent),
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        );
                      }),
                      const SizedBox(width: 8),
                    ],
                  ]),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

Future<void> showLimitsSheet(BuildContext context, List<MachineConnection> connections) => showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) {
        final now = DateTime.now();
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.75),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              children: [
                const Text('Plan limits', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                for (final c in connections) ...[
                  const SizedBox(height: 16),
                  if (connections.length > 1)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(c.machine.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    ),
                  for (final p in c.limits?.shown ?? const <ProviderLimits>[]) _ProviderLimits(p, now),
                ],
              ],
            ),
          ),
        );
      },
    );

class _ProviderLimits extends StatelessWidget {
  const _ProviderLimits(this.p, this.now);
  final ProviderLimits p;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final updated = p.updatedAt == null ? null : _ago(p.updatedAt!, now);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          AgentAvatar(p.kind, size: 22),
          const SizedBox(width: 8),
          Text(_kindLabel(p.kind), style: const TextStyle(fontWeight: FontWeight.w600)),
          if (p.plan != null) Text(' · ${p.plan}', style: const TextStyle(color: HuntawayColors.faint)),
          const Spacer(),
          if (updated != null)
            Text(p.source == 'session' ? 'last used $updated' : updated,
                style: const TextStyle(fontSize: 12, color: HuntawayColors.faint)),
        ]),
        const SizedBox(height: 8),
        for (final w in p.liveWindows(now))
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text(w.label, style: const TextStyle(fontSize: 13, color: HuntawayColors.muted)),
                const Spacer(),
                Text(percentLabel(w.usedPercent),
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: limitColor(w.usedPercent))),
                if (resetLabel(w.resetsAt, now) case final reset?)
                  Text(' · $reset', style: const TextStyle(fontSize: 12, color: HuntawayColors.faint)),
              ]),
              const SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(
                  value: (w.usedPercent / 100).clamp(0.02, 1.0),
                  minHeight: 5,
                  backgroundColor: HuntawayColors.surfaceHigh,
                  color: w.usedPercent >= 70 ? limitColor(w.usedPercent) : HuntawayColors.working,
                ),
              ),
            ]),
          ),
        if (p.error != null) Text(p.error!, style: const TextStyle(fontSize: 12, color: HuntawayColors.blocked)),
      ]),
    );
  }
}
