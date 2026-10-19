import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../models.dart';
import '../turns.dart';
import 'common.dart';

export '../turns.dart';

class MessageBubble extends StatelessWidget {
  const MessageBubble(this.item, {super.key, required this.agentName, this.showHeader = true});
  final TimelineItem item;
  final String agentName;

  /// Agent name and time above a reply; off for follow-up replies.
  final bool showHeader;

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
          if (showHeader) ...[
            Row(children: [
              Text(agentName,
                  style: const TextStyle(color: HuntawayColors.muted, fontSize: 12, fontWeight: FontWeight.w600)),
              const SizedBox(width: 6),
              Text(clock(item.timestamp), style: const TextStyle(color: HuntawayColors.faint, fontSize: 11)),
            ]),
            const SizedBox(height: 4),
          ],
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
  'agent' => Icons.smart_toy_outlined,
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
  'agent' => 'Agent',
  'plan' => 'Plan',
  _ => call.name,
};

/// The agent's work during a turn, folded into one row; tap to expand.
/// While the agent works on it, the row stays open and shows what it
/// does now.
class WorkTile extends StatefulWidget {
  const WorkTile(this.entry, {super.key});
  final WorkEntry entry;

  @override
  State<WorkTile> createState() => _WorkTileState();
}

class _WorkTileState extends State<WorkTile> {
  /// Set by a tap; otherwise open while live.
  bool? _open;
  Timer? _clock;

  @override
  void initState() {
    super.initState();
    _syncClock();
  }

  @override
  void didUpdateWidget(WorkTile old) {
    super.didUpdateWidget(old);
    // The turn ended: fold it again.
    if (old.entry.live && !widget.entry.live) _open = null;
    _syncClock();
  }

  /// Ticks the elapsed time while live; only this row rebuilds.
  void _syncClock() {
    if (widget.entry.live && widget.entry.startedAt != null) {
      _clock ??= Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    } else {
      _clock?.cancel();
      _clock = null;
    }
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.entry;
    final open = _open ?? e.live;
    final results = {
      for (final r in e.items.where((i) => i.type == 'tool_result')) r.data['tool_use_id']: r,
    };
    final rows = [
      for (final item in e.items)
        switch (item.type) {
          'tool_call' => _callRow(context, item, results[item.data['tool_use_id']]),
          'thinking' => ThinkingTile(item, key: ValueKey('t${item.n}')),
          'assistant_message' => Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: MarkdownBody(
                data: item.text,
                selectable: true,
                styleSheet: markdownStyle(context).copyWith(
                  p: const TextStyle(fontSize: 13.5, height: 1.4, color: HuntawayColors.muted),
                  listBullet: const TextStyle(fontSize: 13.5, height: 1.4, color: HuntawayColors.muted),
                ),
              ),
            ),
          _ => null,
        },
    ].nonNulls.toList();
    final elapsed = e.startedAt == null ? null : DateTime.now().difference(e.startedAt!);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: e.live ? HuntawayColors.working.withValues(alpha: 0.06) : HuntawayColors.surface,
        border: Border.all(color: e.live ? HuntawayColors.working.withValues(alpha: 0.22) : HuntawayColors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: rows.isEmpty ? null : () => setState(() => _open = !open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  if (e.live)
                    const SizedBox(
                      width: 13,
                      height: 13,
                      child: CircularProgressIndicator(strokeWidth: 1.8, color: HuntawayColors.working),
                    )
                  else
                    Icon(_toolIcon(e.calls.isEmpty ? '' : e.calls.last.kind), size: 15, color: HuntawayColors.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      e.live ? '${e.currentAction}…' : e.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: e.live ? HuntawayColors.text : HuntawayColors.muted, fontSize: 13),
                    ),
                  ),
                  if (e.live && elapsed != null && !elapsed.isNegative)
                    Padding(
                      padding: const EdgeInsets.only(left: 6, right: 4),
                      child: Text(formatDuration(elapsed),
                          style: const TextStyle(
                              color: HuntawayColors.muted, fontSize: 12, fontFeatures: [FontFeature.tabularFigures()])),
                    ),
                  if (e.rejected > 0) _pill('denied', HuntawayColors.blocked),
                  if (e.errors > 0) _pill('${e.errors} ✗', HuntawayColors.error),
                  if (rows.isNotEmpty)
                    Icon(open ? Icons.expand_less : Icons.expand_more, size: 18, color: HuntawayColors.muted),
                ],
              ),
            ),
          ),
          if (open && rows.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows),
            ),
        ],
      ),
    );
  }

  Widget _callRow(BuildContext context, TimelineItem call, TimelineItem? r) {
    final change = call.change;
    return InkWell(
      onTap: change != null ? () => showDiff(context, change) : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(_toolIcon(call.kind), size: 14, color: HuntawayColors.muted),
            const SizedBox(width: 8),
            SizedBox(
              width: 70,
              child: Text(_toolVerb(call), style: const TextStyle(fontSize: 12.5, color: HuntawayColors.muted)),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(call.summary, style: const TextStyle(fontSize: 12.5, fontFamily: monoFont)),
                  if (r != null && (r.rejected || r.isError))
                    Text(
                      r.rejected ? 'Denied' : r.summary,
                      style: TextStyle(fontSize: 12, color: r.rejected ? HuntawayColors.blocked : HuntawayColors.error),
                    ),
                ],
              ),
            ),
            if (change != null) const Icon(Icons.difference_outlined, size: 15, color: HuntawayColors.accent),
          ],
        ),
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

/// The agent's reasoning, folded: "Thinking", tap to read it.
class ThinkingTile extends StatefulWidget {
  const ThinkingTile(this.item, {super.key});
  final TimelineItem item;

  @override
  State<ThinkingTile> createState() => _ThinkingTileState();
}

class _ThinkingTileState extends State<ThinkingTile> {
  bool open = false;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: () => setState(() => open = !open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.psychology_outlined, size: 14, color: HuntawayColors.muted),
              const SizedBox(width: 8),
              const Text('Thinking', style: TextStyle(fontSize: 12.5, color: HuntawayColors.muted)),
              Icon(open ? Icons.expand_less : Icons.expand_more, size: 16, color: HuntawayColors.faint),
            ]),
            if (open)
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 4, 0, 4),
                child: SelectableText(
                  widget.item.text,
                  style: const TextStyle(
                      fontSize: 13, height: 1.4, color: HuntawayColors.muted, fontStyle: FontStyle.italic),
                ),
              ),
          ]),
        ),
      );
}

/// "3 files changed +42 −7" after a turn; tap to list the files, then a
/// file to see its diff.
class ChangesTile extends StatefulWidget {
  const ChangesTile(this.entry, {super.key});
  final ChangesEntry entry;

  @override
  State<ChangesTile> createState() => _ChangesTileState();
}

class _ChangesTileState extends State<ChangesTile> {
  bool open = false;

  static Widget _counts(int added, int removed) => Text.rich(TextSpan(children: [
        TextSpan(text: '+$added', style: const TextStyle(color: HuntawayColors.done)),
        const TextSpan(text: ' '),
        TextSpan(text: '−$removed', style: const TextStyle(color: HuntawayColors.error)),
      ]), style: const TextStyle(fontSize: 12.5, fontFamily: monoFont));

  @override
  Widget build(BuildContext context) {
    final e = widget.entry;
    final n = e.files.length;
    final single = n == 1 && e.files.first.changes.isNotEmpty;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: HuntawayColors.surface,
        border: Border.all(color: HuntawayColors.border),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(children: [
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: single ? () => showChanges(context, e.files.first.changes) : () => setState(() => open = !open),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(children: [
              const Icon(Icons.difference_outlined, size: 15, color: HuntawayColors.muted),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  single ? e.files.first.path.split('/').last : '$n file${n == 1 ? '' : 's'} changed',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: HuntawayColors.text, fontSize: 13),
                ),
              ),
              _counts(e.added, e.removed),
              const SizedBox(width: 4),
              Icon(single ? Icons.chevron_right : (open ? Icons.expand_less : Icons.expand_more),
                  size: 18, color: HuntawayColors.muted),
            ]),
          ),
        ),
        if (open && !single)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Column(children: [
              for (final f in e.files)
                InkWell(
                  onTap: f.changes.isEmpty ? null : () => showChanges(context, f.changes),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(children: [
                      Expanded(
                        child: Text(f.path.split('/').last,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12.5, fontFamily: monoFont)),
                      ),
                      if (f.changes.isNotEmpty) _counts(f.added, f.removed),
                    ]),
                  ),
                ),
            ]),
          ),
      ]),
    );
  }
}

/// A structured question of the agent, inline, with its answer.
class QuestionTile extends StatelessWidget {
  const QuestionTile(this.entry, {super.key});
  final QuestionEntry entry;

  @override
  Widget build(BuildContext context) {
    final r = entry.result;
    final answer = r == null
        ? null
        : r.rejected
            ? 'Declined'
            : r.summary.isEmpty
                ? 'Answered'
                : r.summary;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: HuntawayColors.blocked.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Icon(Icons.help_outline, size: 16, color: HuntawayColors.blocked),
          const SizedBox(width: 8),
          Expanded(child: Text(entry.item.summary, style: const TextStyle(fontSize: 14))),
        ]),
        if (answer != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 6, 0, 0),
            child: Text(answer,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 13, color: r!.rejected || r.isError ? HuntawayColors.muted : HuntawayColors.text)),
          ),
      ]),
    );
  }
}

/// A tool call that started or prompted another Herdr agent: who, what it
/// was asked, and how that agent is doing now.
class AgentLaunchCard extends StatelessWidget {
  const AgentLaunchCard(this.call, {super.key, this.child, this.onOpen});
  final TimelineItem call;

  /// The agent it started, when still live.
  final Agent? child;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final launch = call.agent ?? AgentLaunch();
    final child = this.child;
    final kind = launch.kind ?? child?.kind ?? '';
    final name = launch.name ?? child?.name ?? (kind.isEmpty ? 'Agent' : kind[0].toUpperCase() + kind.substring(1));
    final blocked = child?.attention.status == AttentionStatus.blocked;
    final prompt = launch.prompt?.trim();
    return Material(
      color: HuntawayColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: blocked ? HuntawayColors.blocked.withValues(alpha: 0.55) : HuntawayColors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              AgentAvatar(kind, size: 24),
              const SizedBox(width: 8),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                  Text(launch.start ? 'Agent started' : 'Agent prompted',
                      style: const TextStyle(color: HuntawayColors.muted, fontSize: 11.5)),
                ]),
              ),
              if (child != null)
                AttentionBadge(child.attention, compact: true)
              else
                const Text('Not running', style: TextStyle(color: HuntawayColors.faint, fontSize: 12)),
              if (onOpen != null) const Icon(Icons.chevron_right, size: 18, color: HuntawayColors.muted),
            ]),
            if (prompt != null && prompt.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(prompt,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, height: 1.35, color: HuntawayColors.text)),
            ],
            if (blocked) ...[
              const SizedBox(height: 6),
              Text(
                switch (child!.interaction?.reason) {
                  'approval' => 'Waiting for your approval${child.interaction?.tool == null ? '' : ': ${child.interaction!.tool!.name}'}',
                  'question' || 'explicit_question' => 'Has a question for you',
                  'plan' => 'Waiting for you to review a plan',
                  _ => 'Waiting for your answer',
                },
                style: const TextStyle(color: HuntawayColors.blocked, fontSize: 12.5, fontWeight: FontWeight.w600),
              ),
            ] else if (child != null && child.summary.isNotEmpty && child.summary != prompt) ...[
              const SizedBox(height: 4),
              Text(child.summary,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: HuntawayColors.muted, fontSize: 12)),
            ],
          ]),
        ),
      ),
    );
  }
}

/// A message sent from Huntaway that the transcript does not show yet.
class QueuedBubble extends StatelessWidget {
  const QueuedBubble(this.message, {super.key, required this.waiting});
  final QueuedMessage message;

  /// The agent is busy: the message goes in when it is free.
  final bool waiting;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          child: Opacity(
            opacity: 0.75,
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
                Text(message.text, style: const TextStyle(fontSize: 15, height: 1.4)),
                const SizedBox(height: 4),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(waiting ? Icons.schedule : Icons.arrow_upward_rounded, size: 12, color: HuntawayColors.muted),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      waiting ? 'Waiting — will be sent when the agent is free' : 'Sending…',
                      style: const TextStyle(fontSize: 10.5, color: HuntawayColors.muted),
                    ),
                  ),
                ]),
              ]),
            ),
          ),
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
void showDiff(BuildContext context, Map<String, dynamic> change) => showChanges(context, [change]);

/// Diff preview of one or more edits of the same file, oldest first.
void showChanges(BuildContext context, List<Map<String, dynamic>> changes) {
  if (changes.isEmpty) return;
  final path = changes.last['path'] as String? ?? '';
  final wholeFile = changes.length == 1 && changes.first['old'] == null;
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
  List<Widget> diff(Map<String, dynamic> change) {
    final old = change['old'] as String?;
    final added = change['new'] as String? ?? '';
    return [
      if (old != null)
        for (final l in old.split('\n'))
          line(l, HuntawayColors.error.withValues(alpha: 0.14), '-'),
      for (final l in added.split('\n'))
        line(
          l,
          old == null ? null : HuntawayColors.working.withValues(alpha: 0.14),
          old == null ? ' ' : '+',
        ),
      if ((change['truncated'] as bool?) ?? false)
        const Padding(
          padding: EdgeInsets.all(12),
          child: Text(
            'Preview truncated',
            style: TextStyle(color: HuntawayColors.muted, fontSize: 12),
          ),
        ),
    ];
  }
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
                  wholeFile ? 'File written' : changes.length > 1 ? '${changes.length} edits' : 'Edit',
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
                for (var i = 0; i < changes.length; i++) ...[
                  if (i > 0) const Divider(height: 17),
                  ...diff(changes[i]),
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
