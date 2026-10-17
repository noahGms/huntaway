import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'cache.dart';
import 'models.dart';

enum ConnectionStatus { connecting, online, offline }

class TimelineState {
  final List<TimelineItem> items = [];
  bool hasMore = true;
  bool loading = false;
  bool loaded = false;
  String? error;

  void merge(Iterable<TimelineItem> incoming) {
    final known = items.map((i) => i.n).toSet();
    items.addAll(incoming.where((i) => !known.contains(i.n)));
    items.sort((a, b) => a.n.compareTo(b.n));
  }
}

/// Live connection to one machine (PRD §16–§17): loads the state, then
/// follows the event stream from the last known sequence number. A new
/// bridge epoch means the daemon restarted: reload everything.
class MachineConnection extends ChangeNotifier {
  MachineConnection(this.machine, {required this.onNotification, this.cache}) : client = BridgeClient(machine);

  final PairedMachine machine;
  final TimelineCache? cache;
  final BridgeClient client;
  final void Function(AgentNotification) onNotification;

  ConnectionStatus status = ConnectionStatus.connecting;
  String? lastError;
  DateTime? lastSyncAt;
  final Map<String, Agent> agents = {};
  final List<Workspace> workspaces = [];
  final Map<String, TimelineState> timelines = {};

  String? _epoch;
  int _seq = 0;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  bool _disposed = false;
  int _attempt = 0;
  Timer? _retry;
  Completer<void>? _closed;

  void start() => _loop();

  /// Reconnects now (app resumed, pull to refresh).
  void reconnect() {
    _retry?.cancel();
    if (status == ConnectionStatus.online) return;
    _attempt = 0;
    _closed?.complete();
  }

  Future<void> _loop() async {
    while (!_disposed) {
      try {
        _setStatus(ConnectionStatus.connecting);
        await client.resolveAddress();
        await _loadState();
        await _openStream();
        _attempt = 0;
      } catch (e) {
        lastError = e.toString();
      }
      if (_disposed) return;
      _setStatus(ConnectionStatus.offline);
      final delay = Duration(seconds: min(30, 1 << min(_attempt++, 5)));
      _closed = Completer<void>();
      _retry = Timer(delay, () {
        if (!(_closed?.isCompleted ?? true)) _closed!.complete();
      });
      await _closed!.future;
    }
  }

  Future<void> _loadState() async {
    final s = await client.state();
    final machineInfo = s['machine'] as Map;
    _epoch = machineInfo['epoch'] as String;
    _seq = s['seq'] as int;
    final name = machineInfo['machine_name'] as String?;
    if (name != null) machine.name = name;
    agents
      ..clear()
      ..addEntries([
        for (final a in s['agents'] as List)
          MapEntry((a as Map)['id'] as String, Agent.fromJson(machine.machineId, a.cast<String, dynamic>()))
      ]);
    workspaces
      ..clear()
      ..addAll([
        for (final w in (s['workspaces'] as List?) ?? const [])
          Workspace(w['session'] as String, w['workspace_id'] as String, w['label'] as String?)
      ]);
    timelines.removeWhere((id, _) => !agents.containsKey(id));
    // Items may have been missed while offline: reload open timelines.
    for (final id in timelines.keys.toList()) {
      unawaited(loadTimeline(id, refresh: true));
    }
    lastSyncAt = DateTime.now();
    notifyListeners();
  }

  Future<void> _openStream() async {
    final channel = WebSocketChannel.connect(client.streamUri(since: _seq, epoch: _epoch));
    _channel = channel;
    await channel.ready.timeout(const Duration(seconds: 8));
    final done = Completer<void>();
    _subscription = channel.stream.listen(
      (raw) => _handle(jsonDecode(raw as String) as Map<String, dynamic>),
      onError: (_) => done.isCompleted ? null : done.complete(),
      onDone: () => done.isCompleted ? null : done.complete(),
      cancelOnError: true,
    );
    final closed = _closed = Completer<void>();
    await Future.any([done.future, closed.future]);
    await _subscription?.cancel();
    await channel.sink.close();
    _channel = null;
  }

  void _handle(Map<String, dynamic> e) {
    final type = e['type'] as String?;
    if (type == 'hello') {
      if (e['resync_required'] == true) {
        // Epoch changed or events expired: reload, then keep the stream.
        _loadState().catchError((_) {});
      }
      _setStatus(ConnectionStatus.online);
      return;
    }
    final seq = e['seq'] as int? ?? 0;
    if (seq <= _seq) return;
    _seq = seq;
    final agentId = e['agent_id'] as String?;
    final data = (e['data'] as Map?)?.cast<String, dynamic>() ?? const {};
    switch (type) {
      case 'agent.updated':
        agents[agentId!] = Agent.fromJson(machine.machineId, data);
      case 'agent.removed':
        agents.remove(agentId);
        timelines.remove(agentId);
      case 'agent.item':
        final timeline = timelines[agentId];
        if (timeline != null && timeline.loaded) {
          timeline.merge([TimelineItem.fromJson(data)]);
          _saveTimeline(agentId!);
        }
      case 'notification':
        onNotification(AgentNotification(
          machine.machineId,
          data['agent_id'] as String? ?? agentId ?? '',
          data['kind'] as String? ?? '',
          data['title'] as String? ?? '',
          data['body'] as String? ?? '',
        ));
      default:
        return; // Unknown events are ignored.
    }
    lastSyncAt = DateTime.now();
    notifyListeners();
  }

  void _setStatus(ConnectionStatus s) {
    if (status == s) return;
    status = s;
    notifyListeners();
  }

  // ------------------------------------------------------------- timeline

  TimelineState timeline(String agentId) => timelines.putIfAbsent(agentId, TimelineState.new);

  void _saveTimeline(String agentId) {
    final agent = agents[agentId];
    final t = timelines[agentId];
    if (cache == null || agent == null || t == null) return;
    cache!.schedule(machine.machineId, agentId, agent.instanceId, t.items);
  }

  Future<void> loadTimeline(String agentId, {bool refresh = false}) async {
    final t = timeline(agentId);
    if (t.loading || (t.loaded && !refresh)) return;
    t.loading = true;
    notifyListeners();
    // Show the cached conversation while the bridge answers.
    final agent = agents[agentId];
    if (!t.loaded && t.items.isEmpty && cache != null && agent != null) {
      t.merge(await cache!.read(machine.machineId, agentId, agent.instanceId));
      notifyListeners();
    }
    try {
      final (items, hasMore) = await client.timeline(agentId, limit: 120);
      if (refresh || !t.loaded) t.items.clear();
      t.merge(items);
      if (!t.loaded || refresh) t.hasMore = hasMore;
      t.loaded = true;
      t.error = null;
      _saveTimeline(agentId);
    } catch (e) {
      t.error = e.toString();
    } finally {
      t.loading = false;
      notifyListeners();
    }
  }

  Future<void> loadOlder(String agentId) async {
    final t = timeline(agentId);
    if (t.loading || !t.hasMore || t.items.isEmpty) return;
    t.loading = true;
    notifyListeners();
    try {
      final (items, hasMore) = await client.timeline(agentId, before: t.items.first.n, limit: 120);
      t.merge(items);
      t.hasMore = hasMore;
    } catch (e) {
      t.error = e.toString();
    } finally {
      t.loading = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _closed?.isCompleted == false ? _closed!.complete() : null;
    _subscription?.cancel();
    _channel?.sink.close();
    client.close();
    super.dispose();
  }
}

/// All paired machines, persisted in the platform secure storage.
class AppModel extends ChangeNotifier {
  AppModel({FlutterSecureStorage? storage}) : _storage = storage ?? secureStorage;

  static const _key = 'huntaway.machines.v1';
  final FlutterSecureStorage _storage;
  final _cache = TimelineCache();
  final List<MachineConnection> connections = [];
  final _notifications = StreamController<AgentNotification>.broadcast();
  bool loaded = false;

  Stream<AgentNotification> get notifications => _notifications.stream;

  Future<void> load() async {
    final raw = await _storage.read(key: _key);
    if (raw != null) {
      for (final m in jsonDecode(raw) as List) {
        _add(PairedMachine.fromJson((m as Map).cast<String, dynamic>()));
      }
    }
    loaded = true;
    notifyListeners();
  }

  Future<void> _save() => _storage.write(
        key: _key,
        value: jsonEncode([for (final c in connections) c.machine.toJson()]),
      );

  void _add(PairedMachine machine) {
    final connection = MachineConnection(machine, onNotification: _notifications.add, cache: _cache)
      ..addListener(notifyListeners)
      ..start();
    connections.add(connection);
  }

  /// Adds a connection without persisting or starting it (widget tests).
  @visibleForTesting
  void addConnectionForTest(MachineConnection connection) {
    connections.add(connection..addListener(notifyListeners));
    notifyListeners();
  }

  Future<void> addMachine(PairedMachine machine) async {
    await removeMachine(machine.machineId, save: false);
    _add(machine);
    await _save();
    notifyListeners();
  }

  Future<void> removeMachine(String machineId, {bool save = true}) async {
    final existing = connections.where((c) => c.machine.machineId == machineId).toList();
    for (final c in existing) {
      connections.remove(c);
      c.dispose();
    }
    if (save) await _cache.remove(machineId);
    if (save) {
      await _save();
      notifyListeners();
    }
  }

  void reconnectAll() {
    for (final c in connections) {
      c.reconnect();
    }
  }

  MachineConnection? connection(String machineId) {
    for (final c in connections) {
      if (c.machine.machineId == machineId) return c;
    }
    return null;
  }

  /// Every agent of every machine, blocked first, then most recent activity.
  List<Agent> get agents {
    final all = [for (final c in connections) ...c.agents.values];
    all.sort((a, b) {
      final p = a.attention.priority.compareTo(b.attention.priority);
      if (p != 0) return p;
      final at = a.lastActivityAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final bt = b.lastActivityAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return bt.compareTo(at);
    });
    return all;
  }

  bool get multiMachine => connections.length > 1;

  @override
  void dispose() {
    for (final c in connections) {
      c.dispose();
    }
    _notifications.close();
    super.dispose();
  }
}
