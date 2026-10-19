// Groups a timeline into turns, like the Claude and Codex apps: the user's
// message, the agent's work folded into one row, its final reply, then the
// files it changed.

import 'models.dart';

/// A row of the conversation.
sealed class Entry {
  /// Stable across rebuilds, so a row keeps its state (expanded…).
  String get id;
}

class MessageEntry extends Entry {
  MessageEntry(this.item, {this.continued = false});
  final TimelineItem item;

  /// Follows another reply of the agent: no need to repeat its name.
  final bool continued;

  @override
  String get id => 'm${item.n}';
}

/// The agent's work during a turn: tool calls, thinking and the replies it
/// wrote between them, folded into one row.
class WorkEntry extends Entry {
  WorkEntry(this.turn, this.items, {this.duration, this.startedAt, this.live = false});

  /// Number of the turn's first item (-1 before any).
  final int turn;
  final List<TimelineItem> items;

  /// First timestamp of the turn, for the live elapsed time.
  final DateTime? startedAt;

  /// From the turn end, else from the timestamps of the turn.
  final Duration? duration;

  /// The agent is working on this turn now.
  final bool live;

  List<TimelineItem> get calls => items.where((i) => i.type == 'tool_call').toList();

  /// "Worked 1m 40s · 6 files read · 2 commands · 2 files changed".
  String get summary {
    final calls = this.calls;
    int count(String kind) => calls.where((c) => c.kind == kind).length;
    final parts = <String>[
      if (duration != null && duration! >= const Duration(seconds: 1)) 'Worked ${formatDuration(duration!)}' else 'Worked',
    ];
    void add(int n, String one, String many) {
      if (n == 1) parts.add(one);
      if (n > 1) parts.add('$n $many');
    }

    add(count('file_read'), '1 file read', 'files read');
    add(count('search'), '1 search', 'searches');
    add(count('command'), '1 command', 'commands');
    add(changedFiles(calls).length, '1 file changed', 'files changed');
    add(count('web'), '1 web search', 'web searches');
    add(count('subagent'), '1 subagent', 'subagents');
    add(count('agent'), '1 agent', 'agents');
    add(count('plan'), '1 plan', 'plans');
    add(count('other'), '1 tool', 'tools');
    final todos = items.where((i) => i.type == 'todos_updated').toList();
    if (todos.isNotEmpty) {
      final list = (todos.last.data['todos'] as List?) ?? const [];
      final done = list.where((t) => (t as Map)['status'] == 'completed').length;
      parts.add('tasks $done/${list.length}');
    }
    // Only reasoning: "Thought 12s".
    if (parts.length == 1 && items.any((i) => i.type == 'thinking')) return parts.first.replaceFirst('Worked', 'Thought');
    return parts.join(' · ');
  }

  /// What the agent does now: its last tool call, or thinking.
  String get currentAction {
    for (final item in items.reversed) {
      if (item.type == 'tool_call') {
        final s = item.summary;
        return switch (item.kind) {
          'file_read' => 'Reading $s',
          'search' => 'Searching $s',
          'file_modified' => 'Editing $s',
          'command' => 'Running $s',
          'subagent' => 'Subagent: $s',
          'agent' => item.agent?.start == true
              ? 'Starting ${item.agent?.name ?? 'an agent'}'
              : 'Prompting ${item.agent?.name ?? 'an agent'}',
          'web' => 'Searching the web: $s',
          _ => '${item.name} $s'.trim(),
        };
      }
      if (item.type == 'assistant_message') return 'Writing';
      if (item.type == 'thinking') break;
    }
    return 'Thinking';
  }

  int get errors => items.where((i) => i.type == 'tool_result' && i.isError && !i.rejected).length;
  int get rejected => items.where((i) => i.type == 'tool_result' && i.rejected).length;

  @override
  String get id => 'w$turn';
}

/// The files a turn changed, after its reply.
class ChangesEntry extends Entry {
  ChangesEntry(this.turn, this.files);
  final int turn;
  final List<FileStat> files;

  @override
  String get id => 'c$turn';

  int get added => files.fold(0, (n, f) => n + f.added);
  int get removed => files.fold(0, (n, f) => n + f.removed);
}

/// A tool call that started or prompted another Herdr agent.
class AgentLaunchEntry extends Entry {
  AgentLaunchEntry(this.call);
  final TimelineItem call;

  @override
  String get id => 'a${call.n}';
}

/// A structured question, with its answer once given.
class QuestionEntry extends Entry {
  QuestionEntry(this.item, {this.result});
  final TimelineItem item;
  final TimelineItem? result;

  @override
  String get id => 'q${item.n}';
}

class NoticeEntry extends Entry {
  NoticeEntry(this.n, this.text, {this.summary = false});
  final int n;
  final String text;
  final bool summary;

  @override
  String get id => 'n$n';
}

/// Lines added and removed in one file during a turn.
class FileStat {
  FileStat(this.path);
  final String path;
  int added = 0;
  int removed = 0;

  /// Changes with a diff preview, oldest first.
  final List<Map<String, dynamic>> changes = [];
}

int _lines(String? s) => s == null || s.isEmpty ? 0 : '\n'.allMatches(s.trimRight()).length + 1;

/// Files changed by [calls], in the order first touched.
List<FileStat> changedFiles(Iterable<TimelineItem> calls) {
  final files = <String, FileStat>{};
  for (final c in calls) {
    if (c.type != 'tool_call' || c.kind != 'file_modified') continue;
    final change = c.change;
    final path = change?['path'] as String? ?? c.summary;
    if (path.isEmpty) continue;
    final f = files.putIfAbsent(path, () => FileStat(path));
    if (change != null) {
      f.added += _lines(change['new'] as String?);
      f.removed += _lines(change['old'] as String?);
      f.changes.add(change);
    }
  }
  return files.values.toList();
}

/// "42s", "1m 40s", "2h 5m".
String formatDuration(Duration d) {
  if (d.inHours > 0) return '${d.inHours}h ${d.inMinutes.remainder(60)}m';
  if (d.inMinutes > 0) return '${d.inMinutes}m ${d.inSeconds.remainder(60)}s';
  return '${d.inSeconds}s';
}

/// Groups timeline items into turns. A turn starts at each user message;
/// its tool calls, thinking and intermediate replies fold into one
/// [WorkEntry], its last replies stay visible after it. With [live], the
/// agent works on the last turn: everything it did so far stays in the
/// work row, which shows even before the first item. Sub-agent items and
/// turn ends are not shown.
List<Entry> buildTurns(List<TimelineItem> items, {bool live = false}) {
  final turns = <List<TimelineItem>>[];
  for (final item in items) {
    if (item.type == 'user_message' || turns.isEmpty) turns.add([]);
    turns.last.add(item);
  }
  if (live && turns.isEmpty) turns.add([]);
  final entries = <Entry>[];
  for (var t = 0; t < turns.length; t++) {
    _turn(entries, turns[t], live: live && t == turns.length - 1);
  }
  return entries;
}

void _turn(List<Entry> entries, List<TimelineItem> turn, {required bool live}) {
  final number = turn.isEmpty ? -1 : turn.first.n;
  final results = {
    for (final r in turn.where((i) => i.type == 'tool_result')) r.data['tool_use_id']: r,
  };
  final work = <TimelineItem>[];
  final shown = <Entry>[];
  final notices = <Entry>[];
  final replies = <TimelineItem>[];
  TimelineItem? end;
  for (final item in turn) {
    if (item.sidechain) continue;
    switch (item.type) {
      case 'user_message':
        entries.add(MessageEntry(item));
      case 'assistant_message':
        replies.add(item);
      case 'tool_call' when item.kind == 'question':
        shown.add(QuestionEntry(item, result: results[item.data['tool_use_id']]));
      case 'tool_call' when item.kind == 'agent':
        work.addAll(replies);
        replies.clear();
        work.add(item);
        shown.add(AgentLaunchEntry(item));
      case 'tool_call' || 'tool_result' || 'todos_updated' || 'thinking':
        // Replies before more work were intermediate.
        work.addAll(replies);
        replies.clear();
        work.add(item);
      case 'notice':
        notices.add(NoticeEntry(item.n, item.text));
      case 'away_summary':
        notices.add(NoticeEntry(item.n, item.text, summary: true));
      case 'turn_ended':
        end = item;
      default:
        break; // question_asked (shown through its tool call), unknown types.
    }
  }
  if (live) {
    work.addAll(replies);
    replies.clear();
  }
  if (live || work.any((i) => i.type != 'tool_result')) {
    final startedAt = turn.map((i) => i.timestamp).whereType<DateTime>().firstOrNull;
    entries.add(WorkEntry(number, work, duration: _duration(turn, end), startedAt: startedAt, live: live));
  }
  entries.addAll(shown);
  TimelineItem? last;
  for (final r in replies) {
    final (a, b) = (last?.timestamp, r.timestamp);
    final continued = last != null && (a == null || b == null || b.difference(a) < const Duration(minutes: 10));
    entries.add(MessageEntry(r, continued: continued));
    last = r;
  }
  if (!live) {
    final files = changedFiles(work);
    if (files.isNotEmpty) entries.add(ChangesEntry(number, files));
  }
  entries.addAll(notices);
}

Duration? _duration(List<TimelineItem> turn, TimelineItem? end) {
  final ms = end?.data['duration_ms'];
  if (ms is num) return Duration(milliseconds: ms.toInt());
  final times = turn.map((i) => i.timestamp).whereType<DateTime>();
  if (times.isEmpty) return null;
  final first = times.first;
  final last = times.last;
  return last.isAfter(first) ? last.difference(first) : null;
}
