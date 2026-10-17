import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
  Timer? _clock;
  final _openedAt = DateTime.now();

  String get _key => '${widget.machineId}/${widget.agentId}';

  @override
  void initState() {
    super.initState();
    openAgentKey = _key;
    _scroll.addListener(_maybeLoadOlder);
    // Refresh relative times in the live status line.
    _clock = Timer.periodic(const Duration(seconds: 15), (_) => mounted ? setState(() {}) : null);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).connection(widget.machineId)?.loadTimeline(widget.agentId);
    });
  }

  @override
  void dispose() {
    if (openAgentKey == _key) openAgentKey = null;
    _clock?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _maybeLoadOlder() {
    // The list is reversed: the top of the conversation is the scroll end.
    if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) {
      AppScope.of(context).connection(widget.machineId)?.loadOlder(widget.agentId);
    }
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
        await c.client.choose(agent.id, freeText.number, text: text);
      } else if (pending) {
        // Typing during an approval = reject and explain (PRD §13.3).
        await c.client.deny(agent.id, text);
      } else {
        await c.client.sendMessage(agent.id, text);
      }
      _input.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final model = AppScope.of(context);
    final c = model.connection(widget.machineId);
    final agent = c?.agents[widget.agentId];
    if (c == null || agent == null) {
      // A just-created agent shows up a moment after the request returns.
      final waiting = DateTime.now().difference(_openedAt) < const Duration(seconds: 20);
      if (waiting) Future.delayed(const Duration(seconds: 1), () => mounted ? setState(() {}) : null);
      return Scaffold(
        appBar: AppBar(),
        body: Center(
          child: waiting
              ? const CircularProgressIndicator()
              : const Text("Cet agent n'existe plus", style: TextStyle(color: HuntawayColors.muted)),
        ),
      );
    }
    final timeline = c.timeline(agent.id);
    final entries = buildEntries(timeline.items).reversed.toList();
    final canWrite = c.machine.can('agents.message');
    final pending = agent.interaction != null && agent.interaction!.reason != 'explicit_question';

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
          if (c.machine.can('agents.interrupt'))
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'stop') _run(() => c.client.interrupt(agent.id));
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'stop', child: Text('Interrompre (Échap)')),
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
                  ? "Conversation indisponible : lance `herdr integration install claude` sur la machine puis redémarre l'agent. Le terminal reste accessible."
                  : "Pas de conversation structurée pour cet agent : utilise le terminal.",
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 13),
            ),
          ),
        Expanded(
          child: timeline.loading && timeline.items.isEmpty
              ? const Center(child: CircularProgressIndicator())
              : ListView.builder(
                  controller: _scroll,
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                  itemCount: entries.length + 1,
                  itemBuilder: (context, i) {
                    if (i == entries.length) {
                      return Padding(
                        padding: const EdgeInsets.all(12),
                        child: Center(
                          child: timeline.loading
                              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                              : Text(timeline.hasMore ? '' : 'Début de la conversation',
                                  style: const TextStyle(color: HuntawayColors.muted, fontSize: 12)),
                        ),
                      );
                    }
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      child: switch (entries[i]) {
                        MessageEntry(:final item) => MessageBubble(item, agentName: agent.displayName),
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
            busy: _sending,
            onChoose: (n) => _run(() => c.client.choose(agent.id, n)),
            onDeny: () => _run(() => c.client.deny(agent.id, null)),
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
                              ? 'Répondre librement…'
                              : 'Refuser et expliquer…',
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
                    tooltip: 'Interrompre',
                    onPressed: _sending ? null : () => _run(() => c.client.interrupt(agent.id)),
                    icon: const Icon(Icons.stop_rounded),
                  )
                else
                  IconButton.filled(
                    style: IconButton.styleFrom(
                      fixedSize: const Size(44, 44),
                      disabledBackgroundColor: HuntawayColors.surfaceHigh,
                    ),
                    tooltip: pending ? 'Refuser et expliquer' : 'Envoyer',
                    onPressed: _sending || _input.text.trim().isEmpty ? null : () => _submit(c, agent),
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
}

/// "● Exécute npm test… 0:42" above the composer while the agent works.
class _LiveLine extends StatelessWidget {
  const _LiveLine({required this.agent, required this.timeline});
  final Agent agent;
  final TimelineState timeline;

  @override
  Widget build(BuildContext context) {
    TimelineItem? lastCall;
    for (final item in timeline.items.reversed) {
      if (item.type == 'tool_call' && !item.sidechain) {
        lastCall = item;
        break;
      }
      if (item.isMessage) break;
    }
    final what = switch (lastCall?.kind) {
      null => 'Réfléchit',
      'file_read' => 'Lit ${lastCall!.summary}',
      'search' => 'Cherche ${lastCall!.summary}',
      'file_modified' => 'Modifie ${lastCall!.summary}',
      'command' => 'Exécute ${lastCall!.summary}',
      'subagent' => 'Sous-agent : ${lastCall!.summary}',
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
      'approval' => '${agent.displayName} demande une autorisation',
      'question' => '${agent.displayName} te pose une question',
      'plan' => '${agent.displayName} propose un plan',
      _ => '${agent.displayName} attend une réponse',
    };
    final command = i.tool == null
        ? null
        : (i.tool!.input['command'] as String?) ?? (i.tool!.input['file_path'] as String?) ?? i.tool!.summary;
    // Structured question options map to on-screen numbers 1..n.
    final question = i.questions.isNotEmpty ? i.questions.first : null;
    final options = i.options;

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      decoration: BoxDecoration(
        color: HuntawayColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: HuntawayColors.blocked.withValues(alpha: 0.55)),
        boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 18, offset: Offset(0, -2))],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
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
          const Text("Lecture des options à l'écran…", style: TextStyle(color: HuntawayColors.muted, fontSize: 13))
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
              const Text('Ou réponds librement ci-dessous.',
                  style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          ]),
      ]),
    );
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
            child: const Text('Refuser'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton(
            onPressed: busy ? null : () => choose(yes.number),
            child: const Text('Approuver'),
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
