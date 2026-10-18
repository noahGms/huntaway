import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../models.dart';
import '../sync.dart';
import 'common.dart';
import 'terminal_screen.dart';
import 'timeline.dart';

/// Screen of the agent currently open, so notifications for it can be skipped.
String? openAgentKey;

/// Agent screen (PRD §13.2): conversation + activity, approval card, composer.
class AgentScreen extends StatefulWidget {
  const AgentScreen({super.key, required this.machineId, required this.agentId});
  final String machineId;
  final String agentId;

  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends State<AgentScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _sending = false;
  Timer? _giveUp;
  bool _waitedLongEnough = false;
  MachineConnection? _connection;

  /// Entries of the timeline, rebuilt only when it changes.
  List<Entry> _entries = const [];
  int _entriesVersion = -1;
  int _entriesGeneration = -1;

  String get _key => '${widget.machineId}/${widget.agentId}';

  @override
  void initState() {
    super.initState();
    openAgentKey = _key;
    _scroll.addListener(_maybeLoadOlder);
    // A just-created agent shows up a moment after the request returns.
    _giveUp = Timer(const Duration(seconds: 20), () => mounted ? setState(() => _waitedLongEnough = true) : null);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _connection = AppScope.read(context).connection(widget.machineId)?..watch(widget.agentId);
      _connection?.loadTimeline(widget.agentId);
    });
  }

  @override
  void dispose() {
    if (openAgentKey == _key) openAgentKey = null;
    _connection?.unwatch(widget.agentId);
    _giveUp?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _maybeLoadOlder() {
    // The list is reversed: the top of the conversation is the scroll end.
    if (_scroll.position.pixels < _scroll.position.maxScrollExtent - 400) return;
    final c = AppScope.read(context).connection(widget.machineId);
    // After a failure, only the "Load earlier" button retries: scrolling
    // must not fire a request per pixel while offline.
    if (c == null || c.timeline(widget.agentId).olderError != null) return;
    c.loadOlder(widget.agentId);
  }

  List<Entry> _entriesOf(TimelineState t) {
    if (t.version != _entriesVersion || t.generation != _entriesGeneration) {
      _entries = buildEntries(t.items).reversed.toList();
      _entriesVersion = t.version;
      _entriesGeneration = t.generation;
    }
    return _entries;
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _sending = true);
    try {
      await action();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _submit(MachineConnection c, Agent agent) async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    final pending = agent.interaction != null && agent.interaction!.reason != 'explicit_question';
    final freeText = agent.interaction?.reason == 'question' ? agent.interaction!.freeTextOption : null;
    await _run(() async {
      if (freeText != null) {
        // Typed answer to a structured question.
        if (!await c.answer(agent, number: freeText.number, text: text)) return;
      } else if (pending) {
        // Typing during an approval = reject and explain (PRD §13.3).
        if (!await c.answer(agent, text: text)) return;
      } else {
        await c.client.sendMessage(agent.id, text);
      }
      _input.clear();
    });
  }

  /// Esc. While the agent waits on a prompt, Esc denies it: the bridge
  /// refuses unless the user confirms.
  Future<void> _interrupt(MachineConnection c, Agent agent) async {
    await _run(() async {
      try {
        await c.client.interrupt(agent.id);
      } on BridgeException catch (e) {
        if (e.code != 'agent_blocked' || !mounted) rethrow;
        final force = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('The agent is waiting for an answer'),
            content: const Text('Interrupting now denies its pending request.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
              FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Interrupt anyway')),
            ],
          ),
        );
        if (force == true) await c.client.interrupt(agent.id, force: true);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // Listens to this machine and this timeline only, not to every event of
    // every machine.
    final model = AppScope.read(context);
    final c = model.connection(widget.machineId);
    if (c == null) return _missing(waiting: false);
    final timeline = c.timeline(widget.agentId);
    return ListenableBuilder(
      listenable: Listenable.merge([c, timeline]),
      builder: (context, _) {
        final agent = c.agents[widget.agentId];
        if (agent == null) return _missing(waiting: !_waitedLongEnough);
        return _screen(model, c, agent, timeline);
      },
    );
  }

  Widget _missing({required bool waiting}) => Scaffold(
        appBar: AppBar(),
        body: Center(
          child: waiting
              ? const CircularProgressIndicator()
              : const Text('This agent no longer exists', style: TextStyle(color: HuntawayColors.muted)),
        ),
      );

  Widget _screen(AppModel model, MachineConnection c, Agent agent, TimelineState timeline) {
    final entries = _entriesOf(timeline);
    final canWrite = c.machine.can('agents.message');
    final pending = agent.interaction != null && agent.interaction!.reason != 'explicit_question';
    final answered = c.answered(agent);
    final blocked = agent.attention.status == AttentionStatus.blocked;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(children: [
          AgentAvatar(agent.kind, size: 32),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(agentTitle(agent),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
              const SizedBox(height: 1),
              Row(children: [
                StatusDot(agent.attention, size: 6),
                Flexible(
                  child: Text(
                    '${agent.attention.label} · ${agentSubtitle(agent, machine: model.multiMachine ? c.machine.name : null, withKind: false)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: HuntawayColors.muted),
                  ),
                ),
              ]),
            ]),
          ),
        ]),
        actions: [
          if (c.machine.can('terminal.read'))
            IconButton(
              tooltip: 'Terminal',
              icon: const Icon(Icons.terminal_rounded),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => TerminalScreen(connection: c, agent: agent),
              )),
            ),
          // Esc would deny a pending prompt: use the card instead.
          if (c.machine.can('agents.interrupt') && !blocked)
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'stop') _interrupt(c, agent);
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'stop', child: Text('Interrupt (Esc)')),
              ],
            ),
        ],
      ),
      body: Column(children: [
        if (c.status != ConnectionStatus.online) OfflineBanner([c]),
        if (!agent.hasTranscript)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: HuntawayColors.surface, borderRadius: BorderRadius.circular(12)),
            child: Text(
              agent.warnings.contains('missing_herdr_integration')
                  ? 'Conversation unavailable: run `herdr integration install claude` on the machine, then restart the agent. The terminal still works.'
                  : 'No structured conversation for this agent: use the terminal.',
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 13),
            ),
          ),
        if (timeline.error != null && timeline.items.isNotEmpty)
          _ErrorLine('Could not refresh: ${timeline.error}', onRetry: () => c.loadTimeline(agent.id, refresh: true)),
        Expanded(
          child: timeline.items.isEmpty && timeline.error != null && !timeline.loading
              ? _LoadError(timeline.error!, onRetry: () => c.loadTimeline(agent.id, refresh: true))
              : timeline.loading && timeline.items.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.builder(
                      controller: _scroll,
                      reverse: true,
                      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                      itemCount: entries.length + 1,
                      itemBuilder: (context, i) {
                        if (i == entries.length) return _top(c, agent, timeline);
                        return Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: switch (entries[i]) {
                            MessageEntry(:final item, :final continued) =>
                              MessageBubble(item, agentName: agent.displayName, showHeader: !continued),
                            ActivityEntry e => ActivityTile(e),
                            QuestionEntry(:final item) => QuestionTile(item),
                            NoticeEntry e => NoticeTile(e),
                          },
                        );
                      },
                    ),
        ),
        if (agent.attention.status == AttentionStatus.working) _LiveLine(agent: agent, timeline: timeline),
        if (pending && c.machine.can('agents.approve'))
          InteractionCard(
            agent: agent,
            busy: _sending || answered,
            onChoose: (n) => _run(() => c.answer(agent, number: n)),
            onDeny: () => _run(() => c.answer(agent)),
          ),
        if (canWrite)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    minLines: 1,
                    maxLines: 6,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      hintText: !pending
                          ? 'Message ${agent.displayName}…'
                          : agent.interaction?.freeTextOption != null
                              ? 'Type an answer…'
                              : 'Deny and explain…',
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                const SizedBox(width: 8),
                if (agent.attention.status == AttentionStatus.working && _input.text.isEmpty)
                  IconButton.filled(
                    style: IconButton.styleFrom(
                      backgroundColor: HuntawayColors.error,
                      foregroundColor: Colors.white,
                      fixedSize: const Size(44, 44),
                    ),
                    tooltip: 'Stop',
                    onPressed: _sending || !c.machine.can('agents.interrupt') ? null : () => _interrupt(c, agent),
                    icon: const Icon(Icons.stop_rounded),
                  )
                else
                  IconButton.filled(
                    style: IconButton.styleFrom(
                      fixedSize: const Size(44, 44),
                      disabledBackgroundColor: HuntawayColors.surfaceHigh,
                    ),
                    tooltip: pending ? 'Deny and explain' : 'Send',
                    onPressed: _sending || (pending && answered) || _input.text.trim().isEmpty
                        ? null
                        : () => _submit(c, agent),
                    icon: _sending
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.arrow_upward_rounded),
                  ),
              ]),
            ),
          ),
      ]),
    );
  }

  /// Top of the conversation: older pages, their errors, or its start.
  Widget _top(MachineConnection c, Agent agent, TimelineState t) {
    const muted = TextStyle(color: HuntawayColors.muted, fontSize: 12);
    final Widget child;
    if (t.loadingOlder) {
      child = const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2));
    } else if (t.olderError != null) {
      child = Column(children: [
        Text(t.olderError!, style: const TextStyle(color: HuntawayColors.error, fontSize: 12), textAlign: TextAlign.center),
        TextButton(onPressed: () => c.loadOlder(agent.id), child: const Text('Retry')),
      ]);
    } else if (t.hasMore && t.loaded) {
      child = TextButton(onPressed: () => c.loadOlder(agent.id), child: const Text('Load earlier messages'));
    } else {
      child = Text(t.hasMore ? '' : 'Start of the conversation', style: muted);
    }
    return Padding(padding: const EdgeInsets.all(8), child: Center(child: child));
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError(this.error, {required this.onRetry});
  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('Could not load the conversation', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(error, textAlign: TextAlign.center, style: const TextStyle(color: HuntawayColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
          ]),
        ),
      );
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.text, {required this.onRetry});
  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
        padding: const EdgeInsets.only(left: 12),
        decoration: BoxDecoration(
          color: HuntawayColors.error.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(children: [
          Expanded(
            child: Text(text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: HuntawayColors.error, fontSize: 12.5)),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ]),
      );
}

/// "● Running npm test… 0:42" above the composer while the agent works.
class _LiveLine extends StatefulWidget {
  const _LiveLine({required this.agent, required this.timeline});
  final Agent agent;
  final TimelineState timeline;

  @override
  State<_LiveLine> createState() => _LiveLineState();
}

class _LiveLineState extends State<_LiveLine> {
  Timer? _clock;

  @override
  void initState() {
    super.initState();
    // Refresh the relative time; only this line rebuilds.
    _clock = Timer.periodic(const Duration(seconds: 15), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    TimelineItem? lastCall;
    for (final item in widget.timeline.items.reversed) {
      if (item.type == 'tool_call' && !item.sidechain) {
        lastCall = item;
        break;
      }
      if (item.isMessage) break;
    }
    final what = switch (lastCall?.kind) {
      null => 'Thinking',
      'file_read' => 'Reading ${lastCall!.summary}',
      'search' => 'Searching ${lastCall!.summary}',
      'file_modified' => 'Editing ${lastCall!.summary}',
      'command' => 'Running ${lastCall!.summary}',
      'subagent' => 'Subagent: ${lastCall!.summary}',
      _ => '${lastCall!.name} ${lastCall.summary}',
    };
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 2, 12, 4),
      padding: const EdgeInsets.fromLTRB(6, 7, 12, 7),
      decoration: BoxDecoration(
        color: HuntawayColors.working.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: HuntawayColors.working.withValues(alpha: 0.18)),
      ),
      child: Row(children: [
        StatusDot(agent.attention, size: 7),
        const SizedBox(width: 4),
        Expanded(
          child: Text('$what…',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: HuntawayColors.text, fontSize: 13.5)),
        ),
        Text(relativeTime(agent.lastActivityAt), style: const TextStyle(color: HuntawayColors.muted, fontSize: 12)),
      ]),
    );
  }
}

/// Approval / question / dialog card (PRD §13.3–§13.4).
class InteractionCard extends StatelessWidget {
  const InteractionCard({
    super.key,
    required this.agent,
    required this.busy,
    required this.onChoose,
    required this.onDeny,
  });

  final Agent agent;
  final bool busy;
  final void Function(int number) onChoose;
  final VoidCallback onDeny;

  @override
  Widget build(BuildContext context) {
    final i = agent.interaction!;
    final title = switch (i.reason) {
      'approval' => '${agent.displayName} asks for permission',
      'question' => '${agent.displayName} has a question',
      'plan' => '${agent.displayName} proposes a plan',
      _ => '${agent.displayName} is waiting for an answer',
    };
    final command = i.tool == null
        ? null
        : (i.tool!.input['command'] as String?) ?? (i.tool!.input['file_path'] as String?) ?? i.tool!.summary;
    // Structured question options map to on-screen numbers 1..n.
    final question = i.questions.isNotEmpty ? i.questions.first : null;
    final options = i.options;

    // Many options plus the keyboard would overflow: cap the card and let
    // it scroll.
    final media = MediaQuery.of(context);
    final maxHeight = (media.size.height - media.viewInsets.bottom - media.padding.vertical) * 0.5;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      constraints: BoxConstraints(maxHeight: maxHeight < 160 ? 160 : maxHeight),
      decoration: BoxDecoration(
        color: HuntawayColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: HuntawayColors.blocked.withValues(alpha: 0.55)),
        boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 18, offset: Offset(0, -2))],
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
        child: _content(i, title, command, question, options),
      ),
    );
  }

  Widget _content(Interaction i, String title, String? command, Question? question, List<ScreenOption> options) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          StatusDot(agent.attention, size: 7),
          const SizedBox(width: 4),
          Expanded(
            child: Text(title,
                style: const TextStyle(color: HuntawayColors.blocked, fontWeight: FontWeight.w600, fontSize: 13.5)),
          ),
          if (i.tool != null && question == null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: HuntawayColors.surfaceHigh,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(i.tool!.name, style: mono.copyWith(fontSize: 11.5, color: HuntawayColors.muted)),
            ),
        ]),
        if (question != null) ...[
          const SizedBox(height: 8),
          Text(question.question, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w500, height: 1.35)),
        ] else if (command != null) ...[
          const SizedBox(height: 10),
          Container(
            constraints: const BoxConstraints(maxHeight: 160),
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: HuntawayColors.background, borderRadius: BorderRadius.circular(10)),
            child: SingleChildScrollView(child: SelectableText(command, style: mono.copyWith(fontSize: 13))),
          ),
        ],
        const SizedBox(height: 12),
        if (options.isEmpty)
          const Text('Reading the on-screen options…', style: TextStyle(color: HuntawayColors.muted, fontSize: 13))
        else if (i.reason == 'approval')
          _ApprovalButtons(options: options, busy: busy, onChoose: onChoose, onDeny: onDeny)
        else
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final o in options.where((o) => o != i.freeTextOption))
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft),
                  onPressed: busy
                      ? null
                      : () {
                          HapticFeedback.selectionClick();
                          onChoose(o.number);
                        },
                  child: Row(children: [
                    Text('${o.number}', style: mono.copyWith(color: HuntawayColors.muted)),
                    const SizedBox(width: 12),
                    Expanded(child: Text(o.label, maxLines: 2, overflow: TextOverflow.ellipsis)),
                  ]),
                ),
              ),
            if (i.freeTextOption != null)
              const Text('Or type an answer below.',
                  style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          ]),
      ]);
  }
}

class _ApprovalButtons extends StatelessWidget {
  const _ApprovalButtons({required this.options, required this.busy, required this.onChoose, required this.onDeny});
  final List<ScreenOption> options;
  final bool busy;
  final void Function(int) onChoose;
  final VoidCallback onDeny;

  @override
  Widget build(BuildContext context) {
    // Claude Code: 1 = Yes, last = No, the ones in between are variants.
    final yes = options.first;
    final no = options.length > 1 ? options.last : null;
    final extra = options.length > 2 ? options.sublist(1, options.length - 1) : const <ScreenOption>[];
    void choose(int n) {
      HapticFeedback.mediumImpact();
      onChoose(n);
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(
          child: OutlinedButton(
            onPressed: busy ? null : (no != null ? () => choose(no.number) : onDeny),
            child: const Text('Deny'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton(
            onPressed: busy ? null : () => choose(yes.number),
            child: const Text('Approve'),
          ),
        ),
      ]),
      for (final o in extra)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: HuntawayColors.muted,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            ),
            onPressed: busy ? null : () => choose(o.number),
            child: Text(o.label, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500)),
          ),
        ),
    ]);
  }
}
