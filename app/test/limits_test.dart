import 'package:flutter_test/flutter_test.dart';
import 'package:huntaway/models.dart';
import 'package:huntaway/ui/limits.dart';

void main() {
  final now = DateTime.fromMillisecondsSinceEpoch(1800000000 * 1000);
  int at(Duration d) => now.add(d).millisecondsSinceEpoch ~/ 1000;

  test('parses plan limits and reads past resets as 0 %', () {
    final limits = MachineLimits.fromJson({
      'providers': [
        {
          'kind': 'claude',
          'plan': 'max',
          'windows': [
            {'id': 'five_hour', 'label': '5h', 'used_percent': 80.0, 'window_minutes': 300, 'resets_at': at(const Duration(seconds: -1))},
            {'id': 'week', 'label': 'Week', 'used_percent': 49, 'window_minutes': 10080, 'resets_at': at(const Duration(hours: 5))},
          ],
          'updated_at': at(Duration.zero),
          'source': 'api',
          'error': null,
        },
        {'kind': 'codex', 'plan': null, 'windows': [], 'updated_at': null, 'source': 'session', 'error': null},
      ],
    });
    expect(limits.shown.map((p) => p.kind), ['claude']);
    final claude = limits.providers.first;
    expect(claude.liveWindows(now).map((w) => w.usedPercent), [0, 49]);
    expect(claude.peak(now)?.id, 'week');
  });

  test('reset labels and colors', () {
    expect(resetLabel(null, now), isNull);
    expect(resetLabel(now.add(const Duration(seconds: 30)), now), 'resets in 1m');
    expect(resetLabel(now.add(const Duration(minutes: 100)), now), 'resets in 1h 40m');
    expect(resetLabel(now.add(const Duration(days: 3)), now), matches(RegExp(r'^resets \w{3} \d\d:\d\d$')));
    expect(percentLabel(48.6), '49%');
  });
}
