// Data model mirroring the huntawayd API (snake_case JSON). Unknown fields and
// event types are ignored so newer bridges stay compatible (PRD §10.7).

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Platform secure storage (Keystore / Keychain). On macOS (dev builds), the
/// legacy keychain works without a signed keychain-sharing entitlement.
const secureStorage = FlutterSecureStorage(mOptions: MacOsOptions(usesDataProtectionKeychain: false));

/// A paired machine, persisted on the phone.
class PairedMachine {
  PairedMachine({
    required this.machineId,
    required this.name,
    required this.addresses,
    required this.token,
    required this.deviceId,
    required this.fingerprint,
    this.permissions = const [],
  });

  final String machineId;
  String name;

  /// Tried in order; refreshed from the bridge when it advertises new ones.
  List<String> addresses;
  final String token;
  final String deviceId;
  final String fingerprint;
  final List<String> permissions;

  bool can(String permission) => permissions.contains(permission);

  factory PairedMachine.fromJson(Map<String, dynamic> j) => PairedMachine(
        machineId: j['machine_id'] as String,
        name: j['name'] as String,
        addresses: (j['addresses'] as List).cast<String>(),
        token: j['token'] as String,
        deviceId: j['device_id'] as String,
        fingerprint: j['fingerprint'] as String,
        permissions: ((j['permissions'] as List?) ?? const []).cast<String>(),
      );

  Map<String, dynamic> toJson() => {
        'machine_id': machineId,
        'name': name,
        'addresses': addresses,
        'token': token,
        'device_id': deviceId,
        'fingerprint': fingerprint,
        'permissions': permissions,
      };
}

/// Mobile-facing agent state (PRD §11).
enum AttentionStatus { blocked, working, done, idle, unknown }

class Attention {
  const Attention(this.status, this.reason);
  final AttentionStatus status;

  /// For blocked: approval, question, plan, explicit_question, prompt.
  final String? reason;

  factory Attention.fromJson(Map<String, dynamic> j) => Attention(
        AttentionStatus.values.firstWhere(
          (s) => s.name == j['status'],
          orElse: () => AttentionStatus.unknown,
        ),
        j['reason'] as String?,
      );

  /// Inbox order: blocked first (PRD §11).
  int get priority => switch (status) {
        AttentionStatus.blocked => 0,
        AttentionStatus.working => 1,
        AttentionStatus.done => 2,
        AttentionStatus.idle => 3,
        AttentionStatus.unknown => 4,
      };

  String get label => switch (status) {
        AttentionStatus.blocked => switch (reason) {
            'approval' => 'Approval',
            'question' => 'Question',
            'plan' => 'Plan to review',
            'explicit_question' => 'Question',
            _ => 'Waiting',
          },
        AttentionStatus.working => 'Working',
        AttentionStatus.done => 'Done',
        AttentionStatus.idle => 'Idle',
        AttentionStatus.unknown => 'Unknown',
      };
}

class ScreenOption {
  ScreenOption(this.number, this.label, this.detail, this.selected, this.numbered);
  final int number;
  final String label;
  final String? detail;
  final bool selected;
  final bool numbered;

  factory ScreenOption.fromJson(Map<String, dynamic> j) => ScreenOption(
        j['number'] as int,
        j['label'] as String,
        j['detail'] as String?,
        (j['selected'] as bool?) ?? false,
        (j['numbered'] as bool?) ?? true,
      );
}

class QuestionOption {
  QuestionOption(this.label, this.description);
  final String label;
  final String? description;
}

class Question {
  Question(this.question, this.header, this.options, this.multiSelect);
  final String question;
  final String? header;
  final List<QuestionOption> options;
  final bool multiSelect;

  factory Question.fromJson(Map<String, dynamic> j) => Question(
        j['question'] as String? ?? '',
        j['header'] as String?,
        [
          for (final o in (j['options'] as List? ?? const []))
            QuestionOption(o['label'] as String? ?? '', o['description'] as String?)
        ],
        (j['multi_select'] as bool?) ?? false,
      );
}

class PendingTool {
  PendingTool(this.name, this.summary, this.input);
  final String name;
  final String summary;
  final Map<String, dynamic> input;
}

/// What a blocked agent is waiting for.
class Interaction {
  Interaction(this.reason, this.tool, this.questions, this.options, {this.id});

  /// Identifies this prompt; sent back with the answer. Null on older bridges.
  final String? id;
  final String reason;
  final PendingTool? tool;
  final List<Question> questions;
  final List<ScreenOption> options;

  /// On-screen option accepting a typed answer (Claude: "Type something.").
  ScreenOption? get freeTextOption {
    for (final o in options) {
      if (o.label.toLowerCase().startsWith('type something')) return o;
    }
    return null;
  }

  /// Tells two prompts apart, even on bridges without [id].
  String get key =>
      id ?? [reason, tool?.summary, questions.firstOrNull?.question, ...options.map((o) => o.label)].join('\u0000');

  factory Interaction.fromJson(Map<String, dynamic> j) {
    final tool = j['tool'] as Map<String, dynamic>?;
    final id = j['id'] as String?;
    return Interaction(
      id: id == null || id.isEmpty ? null : id,
      j['reason'] as String? ?? 'prompt',
      tool == null
          ? null
          : PendingTool(
              tool['name'] as String? ?? '',
              tool['summary'] as String? ?? '',
              (tool['input'] as Map?)?.cast<String, dynamic>() ?? const {},
            ),
      [for (final q in (j['questions'] as List? ?? const [])) Question.fromJson(q)],
      [for (final o in (j['options'] as List? ?? const [])) ScreenOption.fromJson(o)],
    );
  }
}

class Agent {
  Agent({
    required this.machineId,
    required this.id,
    this.instanceId = '',
    required this.session,
    required this.paneId,
    required this.workspaceId,
    required this.project,
    required this.kind,
    required this.workspaceLabel,
    this.tabLabel,
    required this.herdrStatus,
    required this.attention,
    required this.summary,
    required this.lastActivityAt,
    required this.interaction,
    required this.hasTranscript,
    required this.itemCount,
    required this.warnings,
  });

  final String machineId;
  final String id;
  final String instanceId;
  final String session;
  final String paneId;
  final String workspaceId;
  final String project;
  final String kind;
  final String? workspaceLabel;

  /// Herdr tab label: a number unless the tab was renamed.
  final String? tabLabel;
  final String herdrStatus;
  final Attention attention;
  final String summary;
  final DateTime? lastActivityAt;
  final Interaction? interaction;
  final bool hasTranscript;
  final int itemCount;
  final List<String> warnings;

  /// Unique across machines.
  String get key => '$machineId/$id';

  String get displayName =>
      kind.isEmpty ? 'Agent' : kind[0].toUpperCase() + kind.substring(1);

  factory Agent.fromJson(String machineId, Map<String, dynamic> j) => Agent(
        machineId: machineId,
        id: j['id'] as String,
        instanceId: j['instance_id'] as String? ?? '',
        session: j['session'] as String? ?? 'default',
        paneId: j['pane_id'] as String? ?? '',
        workspaceId: j['workspace_id'] as String? ?? '',
        project: j['project'] as String? ?? '',
        kind: j['kind'] as String? ?? 'agent',
        workspaceLabel: j['workspace_label'] as String?,
        tabLabel: j['tab_label'] as String?,
        herdrStatus: j['herdr_status'] as String? ?? 'unknown',
        attention: Attention.fromJson((j['attention'] as Map).cast<String, dynamic>()),
        summary: j['summary'] as String? ?? '',
        lastActivityAt: DateTime.tryParse(j['last_activity_at'] as String? ?? ''),
        interaction: j['interaction'] == null
            ? null
            : Interaction.fromJson((j['interaction'] as Map).cast<String, dynamic>()),
        hasTranscript: (j['has_transcript'] as bool?) ?? false,
        itemCount: (j['item_count'] as int?) ?? 0,
        warnings: ((j['warnings'] as List?) ?? const []).cast<String>(),
      );
}

/// One conversation/activity entry. Kept as a map: the set of types grows.
class TimelineItem {
  TimelineItem(this.n, this.type, this.data);
  final int n;
  final String type;
  final Map<String, dynamic> data;

  factory TimelineItem.fromJson(Map<String, dynamic> j) =>
      TimelineItem(j['n'] as int, j['type'] as String? ?? 'unknown', j);

  String get text => data['text'] as String? ?? '';
  String get summary => data['summary'] as String? ?? '';
  String get kind => data['kind'] as String? ?? 'other';
  String get name => data['name'] as String? ?? '';
  bool get sidechain => (data['sidechain'] as bool?) ?? false;
  bool get isError => (data['is_error'] as bool?) ?? false;
  bool get rejected => (data['rejected'] as bool?) ?? false;
  DateTime? get timestamp => DateTime.tryParse(data['timestamp'] as String? ?? '');

  bool get isMessage => type == 'user_message' || type == 'assistant_message';
  bool get isActivity => type == 'tool_call' || type == 'tool_result' || type == 'todos_updated';
}

/// A Herdr workspace (project), possibly without agents.
class Workspace {
  Workspace(this.session, this.id, this.label);
  final String session;
  final String id;
  final String? label;
}

/// Notification pushed by the bridge (PRD §12).
class AgentNotification {
  AgentNotification(this.machineId, this.agentId, this.kind, this.title, this.body,
      {this.interactionId, this.replayed = false});
  final String machineId;
  final String agentId;
  final String kind;
  final String title;
  final String body;

  /// Prompt a `blocked` notification is about (newer bridges).
  final String? interactionId;

  /// Replayed after a reconnection: push may already have shown it.
  final bool replayed;

  /// Title for payloads that carry none (the bridge may send only the kind).
  static String defaultTitle(String kind) => switch (kind) {
        'blocked' => 'An agent needs you',
        'done' => 'An agent is done',
        'error' => 'An agent hit an error',
        _ => 'Huntaway',
      };
}
