// Agents started by other agents, shown under their parent.

import 'models.dart';

/// An agent and the live agents it started.
class AgentNode {
  AgentNode(this.agent);
  final Agent agent;
  final List<AgentNode> children = [];

  /// Agents under this one, at any depth.
  int get descendants => children.fold(0, (n, c) => n + 1 + c.descendants);

  /// The most urgent status of this agent and the agents under it: a
  /// blocked child makes its parent show as needing you.
  Attention get urgent {
    var best = agent.attention;
    for (final c in children) {
      final a = c.urgent;
      if (a.priority < best.priority) best = a;
    }
    return best;
  }

  /// An agent under this one waits on a prompt.
  bool get childNeedsAttention => children.any((c) => c.agent.attention.needsYou || c.childNeedsAttention);
}

/// Nests [agents] under their parent when the parent is in the list too
/// (same machine). Keeps the order of [agents] at every level; a parent
/// chain that loops leaves its agents at the top.
List<AgentNode> nestAgents(List<Agent> agents) {
  final nodes = {for (final a in agents) a.key: AgentNode(a)};
  String? parentKey(Agent a) {
    final p = a.parentId;
    if (p == null || p.isEmpty) return null;
    final key = '${a.machineId}/$p';
    return key != a.key && nodes.containsKey(key) ? key : null;
  }

  bool loops(Agent a) {
    final seen = {a.key};
    for (var k = parentKey(a); k != null; k = parentKey(nodes[k]!.agent)) {
      if (!seen.add(k)) return true;
    }
    return false;
  }

  final roots = <AgentNode>[];
  for (final a in agents) {
    final node = nodes[a.key]!;
    final parent = parentKey(a);
    if (parent == null || loops(a)) {
      roots.add(node);
    } else {
      nodes[parent]!.children.add(node);
    }
  }
  return roots;
}

/// The agent [launch] started or prompted: among the agents [parent]
/// started, the one in its pane, else the one with its name; then the same
/// among the other agents of its Herdr session (a prompted agent may not
/// be a child).
Agent? launchedAgent(Agent parent, AgentLaunch launch, Iterable<Agent> agents) {
  Agent? find(Iterable<Agent> candidates) {
    final pane = launch.paneId;
    if (pane != null && pane.isNotEmpty) {
      for (final a in candidates) {
        if (a.paneId == pane) return a;
      }
    }
    final name = launch.name;
    if (name != null && name.isNotEmpty) {
      for (final a in candidates) {
        if (a.name == name) return a;
      }
    }
    return null;
  }

  final others = agents.where((a) => a.id != parent.id && a.machineId == parent.machineId);
  return find(others.where((a) => parent.children.contains(a.id) || a.parentId == parent.id)) ??
      find(others.where((a) => a.session == parent.session));
}
