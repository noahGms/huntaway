import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../sync.dart';
import 'agent_screen.dart';
import 'common.dart';
import 'new_agent_sheet.dart';

/// Home screen (PRD §13.1): what needs attention, across all machines.
class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

/// Matches an agent against a search query (project, summary, kind, machine).
bool agentMatches(Agent a, String query, {String? machineName}) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  return [a.project, a.workspaceLabel ?? '', a.summary, a.displayName, machineName ?? '', a.attention.label]
      .any((field) => field.toLowerCase().contains(q));
}

void openAgent(BuildContext context, Agent agent) => Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AgentScreen(machineId: agent.machineId, agentId: agent.id),
    ));

class _InboxScreenState extends State<InboxScreen> {
  final _search = TextEditingController();
  bool _searching = false;
  bool _showIdle = false;

  /// Machine filter (null = all machines).
  String? _machine;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final model = AppScope.of(context);
    if (_machine != null && model.connection(_machine!) == null) _machine = null;
    final agents = model.agents
        .where((a) => _machine == null || a.machineId == _machine)
        .where((a) => agentMatches(a, _search.text, machineName: model.connection(a.machineId)?.machine.name))
        .toList();
    List<Agent> having(Set<AttentionStatus> s) => agents.where((a) => s.contains(a.attention.status)).toList();
    final blocked = having({AttentionStatus.blocked});
    final working = having({AttentionStatus.working});
    final done = having({AttentionStatus.done});
    final idle = having({AttentionStatus.idle, AttentionStatus.unknown});
    final connecting = model.connections.any((c) => c.status == ConnectionStatus.connecting);
    String? machineOf(Agent a) => model.multiMachine && _machine == null ? model.connection(a.machineId)?.machine.name : null;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: _searching
            ? TextField(
                controller: _search,
                autofocus: true,
                decoration: const InputDecoration(hintText: 'Projet, tâche, machine…'),
                onChanged: (_) => setState(() {}),
              )
            : const Row(children: [
                HuntawayLogo(size: 30, tile: false),
                SizedBox(width: 8),
                Text('Huntaway', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 22)),
              ]),
        actions: [
          if (connecting && !_searching)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          IconButton(
            tooltip: _searching ? 'Fermer la recherche' : 'Rechercher',
            icon: Icon(_searching ? Icons.close : Icons.search),
            onPressed: () => setState(() {
              _searching = !_searching;
              if (!_searching) _search.clear();
            }),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => model.reconnectAll(),
        child: ListView(
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            if (model.multiMachine)
              _MachineFilter(
                connections: model.connections,
                selected: _machine,
                onSelected: (id) => setState(() => _machine = id),
              ),
            OfflineBanner(model.connections),
            if (agents.isEmpty)
              _EmptyInbox(query: _search.text)
            else if (blocked.isEmpty)
              const _AllClear(),
            if (blocked.isNotEmpty) ...[
              _SectionHeader('Besoin de toi', blocked.length, color: HuntawayColors.blocked),
              for (final a in blocked)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: BlockedCard(a, machine: machineOf(a)),
                ),
            ],
            if (working.isNotEmpty) ...[
              _SectionHeader('En cours', working.length),
              _Group([for (final a in working) AgentRow(a, machine: machineOf(a))]),
            ],
            if (done.isNotEmpty) ...[
              _SectionHeader('Terminé', done.length),
              _Group([for (final a in done) AgentRow(a, machine: machineOf(a))]),
            ],
            if (idle.isNotEmpty) ...[
              _SectionHeader('Inactifs', idle.length,
                  expanded: _showIdle, onTap: () => setState(() => _showIdle = !_showIdle)),
              if (_showIdle || _search.text.isNotEmpty)
                _Group([for (final a in idle) AgentRow(a, machine: machineOf(a))]),
            ],
          ],
        ),
      ),
    );
  }
}

class _MachineFilter extends StatelessWidget {
  const _MachineFilter({required this.connections, required this.selected, required this.onSelected});
  final List<MachineConnection> connections;
  final String? selected;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context) {
    Widget chip(String label, String? id, {ConnectionStatus? status}) {
      final on = selected == id;
      return Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          selected: on,
          showCheckmark: false,
          onSelected: (_) => onSelected(id),
          avatar: status == null
              ? null
              : Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: status == ConnectionStatus.online ? HuntawayColors.done : HuntawayColors.faint,
                  ),
                ),
          label: Text(label),
          labelStyle: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: on ? HuntawayColors.onAccent : HuntawayColors.text,
          ),
          selectedColor: HuntawayColors.accent,
          backgroundColor: HuntawayColors.surface,
          side: BorderSide(color: on ? HuntawayColors.accent : HuntawayColors.border),
          shape: const StadiumBorder(),
        ),
      );
    }

    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        children: [
          chip('Toutes', null),
          for (final c in connections) chip(c.machine.name, c.machine.machineId, status: c.status),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title, this.count, {this.color, this.expanded, this.onTap});
  final String title;
  final int count;
  final Color? color;
  final bool? expanded;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = color ?? HuntawayColors.muted;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
        child: Row(children: [
          Text(title.toUpperCase(),
              style: TextStyle(color: c, fontWeight: FontWeight.w600, fontSize: 12, letterSpacing: 0.8)),
          const SizedBox(width: 8),
          Text('$count', style: TextStyle(color: c.withValues(alpha: 0.7), fontSize: 12, fontWeight: FontWeight.w500)),
          if (expanded != null) ...[
            const Spacer(),
            Icon(expanded! ? Icons.expand_less : Icons.expand_more, size: 18, color: HuntawayColors.muted),
          ],
        ]),
      ),
    );
  }
}

/// Rows grouped in one rounded block, separated by hairlines.
class _Group extends StatelessWidget {
  const _Group(this.children);
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Card(
          clipBehavior: Clip.antiAlias,
          child: Column(children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) const Divider(indent: 50),
              children[i],
            ],
          ]),
        ),
      );
}

class _AllClear extends StatelessWidget {
  const _AllClear();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.fromLTRB(20, 14, 20, 0),
        child: Row(children: [
          Icon(Icons.check_circle_outline, size: 18, color: HuntawayColors.done),
          SizedBox(width: 8),
          Text('Aucun agent ne t’attend', style: TextStyle(color: HuntawayColors.muted, fontSize: 14)),
        ]),
      );
}

class _EmptyInbox extends StatelessWidget {
  const _EmptyInbox({required this.query});
  final String query;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(32, 80, 32, 32),
        child: Column(children: [
          const HuntawayLogo(size: 56),
          const SizedBox(height: 18),
          Text(
            query.isNotEmpty ? 'Aucun agent ne correspond à « $query »' : 'Aucun agent pour le moment',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
          if (query.isEmpty) ...[
            const SizedBox(height: 6),
            const Text(
              'Lance Claude ou Codex dans Herdr sur une machine appairée : il apparaîtra ici.',
              textAlign: TextAlign.center,
              style: TextStyle(color: HuntawayColors.muted, height: 1.4),
            ),
          ],
        ]),
      );
}

/// One line per agent: status, what it does, where, when.
class AgentRow extends StatelessWidget {
  const AgentRow(this.agent, {super.key, this.machine});
  final Agent agent;
  final String? machine;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => openAgent(context, agent),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 11, 14, 11),
        child: Row(children: [
          AgentAvatar(agent.kind, size: 28),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(agentTitle(agent),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14.5)),
              const SizedBox(height: 2),
              Text(agentSubtitle(agent, machine: machine),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
              if (agent.warnings.contains('missing_herdr_integration'))
                const Padding(
                  padding: EdgeInsets.only(top: 3),
                  child: Text('Intégration Herdr manquante',
                      style: TextStyle(color: HuntawayColors.blocked, fontSize: 12)),
                ),
            ]),
          ),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(relativeTime(agent.lastActivityAt),
                style: const TextStyle(color: HuntawayColors.muted, fontSize: 12, fontFeatures: [FontFeature.tabularFigures()])),
            const SizedBox(height: 4),
            StatusDot(agent.attention, size: 7),
          ]),
        ]),
      ),
    );
  }
}

/// A blocked agent with what it asks and, for approvals, one-tap answers.
class BlockedCard extends StatefulWidget {
  const BlockedCard(this.agent, {super.key, this.machine});
  final Agent agent;
  final String? machine;

  @override
  State<BlockedCard> createState() => _BlockedCardState();
}

class _BlockedCardState extends State<BlockedCard> {
  bool _busy = false;

  Future<void> _choose(MachineConnection c, int? number) async {
    setState(() => _busy = true);
    HapticFeedback.mediumImpact();
    try {
      if (number == null) {
        await c.client.deny(widget.agent.id, null);
      } else {
        await c.client.choose(widget.agent.id, number);
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    final c = AppScope.of(context).connection(agent.machineId);
    final i = agent.interaction;
    final approval = i != null && i.reason == 'approval' && i.options.isNotEmpty;
    final canAnswer = approval && c != null && c.machine.can('agents.approve') && c.status == ConnectionStatus.online;
    final command = i?.tool == null
        ? null
        : (i!.tool!.input['command'] as String?) ?? (i.tool!.input['file_path'] as String?) ?? i.tool!.summary;
    final (String heading, String? body) = switch (i) {
      Interaction(reason: 'approval', :final tool?) => ('Veut utiliser ${tool.name}', null),
      Interaction(:final questions) when questions.isNotEmpty => ('Question', questions.first.question),
      Interaction(reason: 'plan') => ('Plan à valider', agent.summary),
      _ => ('Attend ta réponse', agent.summary.isEmpty ? null : agent.summary),
    };

    return Material(
      color: HuntawayColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: HuntawayColors.blocked.withValues(alpha: 0.45)),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => openAgent(context, agent),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              AgentAvatar(agent.kind, size: 22),
              const SizedBox(width: 8),
              Expanded(
                child: Text(agentSubtitle(agent, machine: widget.machine),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
              ),
              Text(relativeTime(agent.lastActivityAt),
                  style: const TextStyle(color: HuntawayColors.muted, fontSize: 12)),
            ]),
            const SizedBox(height: 10),
            Text(heading,
                style: const TextStyle(color: HuntawayColors.blocked, fontSize: 13, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            if (command != null && approval)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: HuntawayColors.background,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(command, maxLines: 3, overflow: TextOverflow.ellipsis, style: mono),
              )
            else if (body != null)
              Text(body,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500, height: 1.35)),
            const SizedBox(height: 12),
            if (canAnswer)
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 10)),
                    onPressed: _busy
                        ? null
                        : () => _choose(c, i.options.length > 1 ? i.options.last.number : null),
                    child: const Text('Refuser'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 10)),
                    onPressed: _busy ? null : () => _choose(c, i.options.first.number),
                    child: const Text('Approuver'),
                  ),
                ),
              ])
            else
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonalIcon(
                  style: FilledButton.styleFrom(
                    backgroundColor: HuntawayColors.surfaceHigh,
                    foregroundColor: HuntawayColors.text,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  ),
                  onPressed: () => openAgent(context, agent),
                  icon: const Icon(Icons.reply_rounded, size: 18),
                  label: const Text('Répondre'),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

/// Machines → projects → agents (second tab), with agent creation.
class ProjectsScreen extends StatelessWidget {
  const ProjectsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final model = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Machines')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          for (final c in model.connections) ...[
            _MachineHeader(c),
            for (final entry in _byProject(c).entries) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 8, 4),
                child: Row(children: [
                  const Icon(Icons.folder_outlined, size: 16, color: HuntawayColors.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  ),
                  if (c.machine.can('agents.create') && c.status == ConnectionStatus.online)
                    TextButton.icon(
                      onPressed: () => showNewAgentSheet(context, c, entry.value.$1, entry.key),
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('Agent', style: TextStyle(fontSize: 13)),
                    ),
                ]),
              ),
              if (entry.value.$2.isEmpty)
                const Padding(
                  padding: EdgeInsets.fromLTRB(44, 0, 20, 8),
                  child: Text('Aucun agent', style: TextStyle(color: HuntawayColors.muted, fontSize: 13)),
                )
              else
                _Group([for (final agent in entry.value.$2) AgentRow(agent)]),
            ],
          ],
        ],
      ),
    );
  }

  /// Project name → (workspace, its agents), including projects without
  /// agents. Grouped by workspace id, named by label.
  Map<String, (Workspace, List<Agent>)> _byProject(MachineConnection c) {
    final byId = <String, (Workspace, List<Agent>)>{};
    for (final w in c.workspaces) {
      byId['${w.session}/${w.id}'] = (w, []);
    }
    for (final a in c.agents.values) {
      byId
          .putIfAbsent('${a.session}/${a.workspaceId}',
              () => (Workspace(a.session, a.workspaceId, a.workspaceLabel ?? a.project), []))
          .$2
          .add(a);
    }
    final named = <String, (Workspace, List<Agent>)>{};
    for (final (w, agents) in byId.values) {
      agents.sort((a, b) => a.attention.priority.compareTo(b.attention.priority));
      var name = w.label ?? (agents.isNotEmpty ? agents.first.project : w.id);
      if (named.containsKey(name)) name = '$name (${w.id})';
      named[name] = (w, agents);
    }
    return Map.fromEntries(named.entries.toList()..sort((a, b) => a.key.compareTo(b.key)));
  }
}

class _MachineHeader extends StatelessWidget {
  const _MachineHeader(this.c);
  final MachineConnection c;

  @override
  Widget build(BuildContext context) {
    final online = c.status == ConnectionStatus.online;
    final agents = c.agents.values;
    final waiting = agents.where((a) => a.attention.status == AttentionStatus.blocked).length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Row(children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: HuntawayColors.surfaceHigh,
            borderRadius: BorderRadius.circular(10),
          ),
          child: const Icon(Icons.laptop_mac, size: 20, color: HuntawayColors.text),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(c.machine.name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
            Row(children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: online ? HuntawayColors.done : HuntawayColors.faint,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                [
                  switch (c.status) {
                    ConnectionStatus.online => 'En ligne',
                    ConnectionStatus.connecting => 'Connexion…',
                    ConnectionStatus.offline => 'Hors ligne',
                  },
                  '${agents.length} agent${agents.length > 1 ? 's' : ''}',
                  if (waiting > 0) '$waiting en attente',
                ].join(' · '),
                style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }
}
