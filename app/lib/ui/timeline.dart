import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../models.dart';
import 'common.dart';

/// A row of the conversation: one message, or several technical events
/// condensed into one line (PRD §13.2, §77).
sealed class Entry {}

class MessageEntry extends Entry {
  MessageEntry(this.item);
  final TimelineItem item;
}

class ActivityEntry extends Entry {
  ActivityEntry(this.items);
  final List<TimelineItem> items;

  List<TimelineItem> get calls =>
      items.where((i) => i.type == 'tool_call').toList();

  /// "3 reads · 2 edits · npm test" style summary.
  String get summary {
    final calls = this.calls;
    int count(String kind) => calls.where((c) => c.kind == kind).length;
    final parts = <String>[];
    void add(int n, String one, String many) {
      if (n == 1) parts.add(one);
      if (n > 1) parts.add('$n $many');
    }

    add(count('file_read'), '1 read', 'reads');
    add(count('search'), '1 search', 'searches');
    add(count('file_modified'), '1 edit', 'edits');
    final commands = calls.where((c) => c.kind == 'command').toList();
    if (commands.length == 1) {
      parts.add(commands.first.summary);
    } else {
      add(commands.length, '', 'commands');
    }
    add(count('web'), '1 web search', 'web searches');
    add(count('subagent'), '1 subagent', 'subagents');
    add(count('plan'), 'plan', 'plans');
    add(count('other'), '1 tool', 'tools');
    final todos = items.where((i) => i.type == 'todos_updated').toList();
    if (todos.isNotEmpty) {
      final list = (todos.last.data['todos'] as List?) ?? const [];
      final done = list
          .where((t) => (t as Map)['status'] == 'completed')
          .length;
      parts.add('tasks $done/${list.length}');
    }
    return parts.isEmpty ? 'Activity' : parts.join(' · ');
  }

  int get errors => items
      .where((i) => i.type == 'tool_result' && i.isError && !i.rejected)
      .length;
  int get rejected =>
      items.where((i) => i.type == 'tool_result' && i.rejected).length;
}

class QuestionEntry extends Entry {
  QuestionEntry(this.item);
  final TimelineItem item;
}

class NoticeEntry extends Entry {
  NoticeEntry(this.text, {this.summary = false});
  final String text;
  final bool summary;
}

/// Groups timeline items into conversation entries. Sub-agent chatter is
/// folded into activity; turn ends are not shown.
List<Entry> buildEntries(List<TimelineItem> items) {
  final entries = <Entry>[];
  List<TimelineItem>? activity;
  void flush() {
    if (activity != null && activity!.any((i) => i.type != 'tool_result')) {
      entries.add(ActivityEntry(activity!));
    }
    activity = null;
  }

  for (final item in items) {
    switch (item.type) {
      case 'user_message':
        flush();
        entries.add(MessageEntry(item));
      case 'assistant_message' when !item.sidechain:
        flush();
        entries.add(MessageEntry(item));
      case 'tool_call' when item.kind == 'question':
        flush();
        entries.add(QuestionEntry(item));
      case 'question_asked':
        break; // Rendered through the matching tool call.
      case 'tool_call' || 'tool_result' || 'todos_updated':
        if (item.sidechain) break;
        (activity ??= []).add(item);
      case 'notice':
        flush();
        entries.add(NoticeEntry(item.text));
      case 'away_summary':
        flush();
        entries.add(NoticeEntry(item.text, summary: true));
      default:
        break; // turn_ended, sub-agent messages, unknown types.
    }
  }
  flush();
  return entries;
}

class MessageBubble extends StatelessWidget {
  const MessageBubble(this.item, {super.key, required this.agentName});
  final TimelineItem item;
  final String agentName;

  void _copy(BuildContext context) {
    Clipboard.setData(ClipboardData(text: item.text));
    HapticFeedback.selectionClick();
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Message copied')));
  }

  @override
  Widget build(BuildContext context) {
    if (item.type == 'user_message') {
      return Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          child: GestureDetector(
            onLongPress: () => _copy(context),
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 8),
              decoration: BoxDecoration(
                color: HuntawayColors.user,
                border: Border.all(color: const Color(0xFF3A3731)),
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(18),
                  topRight: Radius.circular(18),
                  bottomLeft: Radius.circular(18),
                  bottomRight: Radius.circular(5),
                ),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                SelectableText(item.text, style: const TextStyle(fontSize: 15, height: 1.4)),
                const SizedBox(height: 2),
                Text(clock(item.timestamp), style: const TextStyle(fontSize: 10.5, color: HuntawayColors.muted)),
              ]),
            ),
          ),
        ),
      );
    }
    // Agent replies: full width, rendered as Markdown.
    return GestureDetector(
      onLongPress: () => _copy(context),
      child: Padding(
        padding: const EdgeInsets.only(right: 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(agentName,
                style: const TextStyle(color: HuntawayColors.muted, fontSize: 12, fontWeight: FontWeight.w600)),
            const SizedBox(width: 6),
            Text(clock(item.timestamp), style: const TextStyle(color: HuntawayColors.faint, fontSize: 11)),
          ]),
          const SizedBox(height: 4),
          MarkdownBody(
            data: item.text,
            selectable: true,
            styleSheet: markdownStyle(context),
          ),
        ]),
      ),
    );
  }
}

MarkdownStyleSheet markdownStyle(BuildContext context) {
  const body = TextStyle(fontSize: 15, height: 1.45, color: HuntawayColors.text);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: body,
    listBullet: body,
    strong: const TextStyle(fontWeight: FontWeight.w600),
    h1: body.copyWith(fontSize: 19, fontWeight: FontWeight.w700),
    h2: body.copyWith(fontSize: 17, fontWeight: FontWeight.w700),
    h3: body.copyWith(fontSize: 15.5, fontWeight: FontWeight.w600),
    a: const TextStyle(color: HuntawayColors.blocked, decoration: TextDecoration.underline),
    code: mono.copyWith(fontSize: 13, backgroundColor: HuntawayColors.surfaceHigh),
    codeblockDecoration: BoxDecoration(
      color: HuntawayColors.surface,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: HuntawayColors.border),
    ),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: const BoxDecoration(
      border: Border(left: BorderSide(color: HuntawayColors.border, width: 3)),
    ),
    blockquotePadding: const EdgeInsets.only(left: 12),
    tableBorder: TableBorder.all(color: HuntawayColors.border),
    tableHead: const TextStyle(fontWeight: FontWeight.w600),
    tableBody: body.copyWith(fontSize: 13.5),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: HuntawayColors.border)),
    ),
  );
}

IconData _toolIcon(String kind) => switch (kind) {
  'file_read' => Icons.description_outlined,
  'search' => Icons.search,
  'file_modified' => Icons.edit_outlined,
  'command' => Icons.play_arrow_rounded,
  'web' => Icons.public,
  'subagent' => Icons.account_tree_outlined,
  'plan' => Icons.checklist,
  'todo' => Icons.checklist,
  _ => Icons.build_outlined,
};

String _toolVerb(TimelineItem call) => switch (call.kind) {
  'file_read' => 'Read',
  'search' => 'Searched',
  'file_modified' => 'Edited',
  'command' => 'Ran',
  'web' => 'Web',
  'subagent' => 'Subagent',
  'plan' => 'Plan',
  _ => call.name,
};

/// Condensed activity line; tap to expand the detail.
class ActivityTile extends StatefulWidget {
  const ActivityTile(this.entry, {super.key});
  final ActivityEntry entry;

  @override
  State<ActivityTile> createState() => _ActivityTileState();
}

class _ActivityTileState extends State<ActivityTile> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final e = widget.entry;
    final results = {
      for (final r in e.items.where((i) => i.type == 'tool_result'))
        r.data['tool_use_id']: r,
    };
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: HuntawayColors.surface,
        border: Border.all(color: HuntawayColors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => open = !open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Icon(_toolIcon(e.calls.isEmpty ? '' : e.calls.last.kind), size: 15, color: HuntawayColors.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      e.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: HuntawayColors.muted,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  if (e.rejected > 0) _pill('denied', HuntawayColors.blocked),
                  if (e.errors > 0) _pill('${e.errors} ✗', HuntawayColors.error),
                  Icon(
                    open ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: HuntawayColors.muted,
                  ),
                ],
              ),
            ),
          ),
          if (open)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Column(
                children: [
                  for (final call in e.calls)
                    InkWell(
                      onTap: call.data['change'] is Map
                          ? () => showDiff(
                              context,
                              (call.data['change'] as Map)
                                  .cast<String, dynamic>(),
                            )
                          : null,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(
                              _toolIcon(call.kind),
                              size: 14,
                              color: HuntawayColors.muted,
                            ),
                            const SizedBox(width: 8),
                            SizedBox(
                              width: 70,
                              child: Text(
                                _toolVerb(call),
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  color: HuntawayColors.muted,
                                ),
                              ),
                            ),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    call.summary,
                                    style: const TextStyle(
                                      fontSize: 12.5,
                                      fontFamily: monoFont,
                                    ),
                                  ),
                                  if (results[call.data['tool_use_id']]
                                      case final r?)
                                    if (r.rejected || r.isError)
                                      Text(
                                        r.rejected ? 'Denied' : r.summary,
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: r.rejected
                                              ? HuntawayColors.blocked
                                              : HuntawayColors.error,
                                        ),
                                      ),
                                ],
                              ),
                            ),
                            if (call.data['change'] is Map)
                              const Icon(
                                Icons.difference_outlined,
                                size: 15,
                                color: HuntawayColors.accent,
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _pill(String text, Color color) => Container(
    margin: const EdgeInsets.only(right: 6),
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.15),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(text, style: TextStyle(color: color, fontSize: 11)),
  );
}

class QuestionTile extends StatelessWidget {
  const QuestionTile(this.item, {super.key});
  final TimelineItem item;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.symmetric(vertical: 2),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: HuntawayColors.blocked.withValues(alpha: 0.08),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        const Icon(Icons.help_outline, size: 16, color: HuntawayColors.blocked),
        const SizedBox(width: 8),
        Expanded(
          child: Text(item.summary, style: const TextStyle(fontSize: 14)),
        ),
      ],
    ),
  );
}

class NoticeTile extends StatelessWidget {
  const NoticeTile(this.entry, {super.key});
  final NoticeEntry entry;

  @override
  Widget build(BuildContext context) {
    if (entry.summary) {
      return Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: HuntawayColors.surface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Summary',
              style: TextStyle(
                color: HuntawayColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              entry.text,
              style: const TextStyle(fontSize: 14, height: 1.35),
            ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Center(
        child: Text(
          entry.text,
          style: const TextStyle(color: HuntawayColors.muted, fontSize: 12),
        ),
      ),
    );
  }
}

/// Diff preview of an edit (PRD §13.6): removed lines in red, added in green.
void showDiff(BuildContext context, Map<String, dynamic> change) {
  final path = change['path'] as String? ?? '';
  final old = change['old'] as String?;
  final added = change['new'] as String? ?? '';
  final truncated = (change['truncated'] as bool?) ?? false;
  Widget line(String text, Color? bg, String sign) => Container(
    width: double.infinity,
    color: bg,
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
    child: Text(
      '$sign $text',
      style: const TextStyle(
        fontFamily: monoFont,
        fontSize: 12,
        height: 1.3,
      ),
    ),
  );
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: HuntawayColors.surface,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.95,
      builder: (context, scroll) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Row(
              children: [
                const Icon(
                  Icons.edit_outlined,
                  size: 18,
                  color: HuntawayColors.muted,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    path.split('/').last,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                    ),
                  ),
                ),
                Text(
                  old == null ? 'File written' : 'Edit',
                  style: const TextStyle(
                    color: HuntawayColors.muted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              path,
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 11.5),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: ListView(
              controller: scroll,
              children: [
                if (old != null)
                  for (final l in old.split('\n'))
                    line(l, HuntawayColors.error.withValues(alpha: 0.14), '-'),
                for (final l in added.split('\n'))
                  line(
                    l,
                    old == null
                        ? null
                        : HuntawayColors.working.withValues(alpha: 0.14),
                    old == null ? ' ' : '+',
                  ),
                if (truncated)
                  const Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                      'Preview truncated',
                      style: TextStyle(color: HuntawayColors.muted, fontSize: 12),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
