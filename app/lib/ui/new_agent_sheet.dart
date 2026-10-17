import 'package:flutter/material.dart';

import '../models.dart';
import '../sync.dart';
import 'agent_screen.dart';
import 'common.dart';

/// Starts a new agent in a project (PRD §13.7).
Future<void> showNewAgentSheet(BuildContext context, MachineConnection c, Workspace workspace, String project) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: HuntawayColors.surface,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _NewAgentForm(connection: c, workspace: workspace, project: project),
    ),
  );
}

class _NewAgentForm extends StatefulWidget {
  const _NewAgentForm({required this.connection, required this.workspace, required this.project});
  final MachineConnection connection;
  final Workspace workspace;
  final String project;

  @override
  State<_NewAgentForm> createState() => _NewAgentFormState();
}

class _NewAgentFormState extends State<_NewAgentForm> {
  final _prompt = TextEditingController();
  String _kind = 'claude';
  bool _busy = false;

  Future<void> _launch() async {
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    try {
      final (id, promptSent) = await widget.connection.client.createAgent(
        session: widget.workspace.session,
        workspaceId: widget.workspace.id,
        kind: _kind,
        prompt: _prompt.text.trim(),
      );
      navigator.pop();
      navigator.push(MaterialPageRoute(
        builder: (_) => AgentScreen(machineId: widget.connection.machine.machineId, agentId: id),
      ));
      if (!promptSent && _prompt.text.trim().isNotEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text("L'agent attend une réponse au démarrage : réponds-lui puis renvoie ta consigne."),
        ));
      }
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        showError(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Nouvel agent', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text('${widget.project} · ${widget.connection.machine.name}',
              style: const TextStyle(color: HuntawayColors.muted)),
          const SizedBox(height: 16),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'claude', label: Text('Claude')),
              ButtonSegment(value: 'codex', label: Text('Codex')),
            ],
            selected: {_kind},
            onSelectionChanged: (v) => setState(() => _kind = v.first),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _prompt,
            minLines: 3,
            maxLines: 8,
            autofocus: true,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(hintText: 'Consigne initiale…'),
          ),
          const SizedBox(height: 16),
          FilledButton(
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _busy ? null : _launch,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text("Lancer l'agent"),
          ),
        ]),
      ),
    );
  }
}
