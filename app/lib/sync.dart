import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'cache.dart';
import 'models.dart';

enum ConnectionStatus { connecting, online, offline }

/// Loaded part of one conversation. Notifies on its own, so a new item only
/// rebuilds the screen showing it.
class TimelineState extends ChangeNotifier {
  final List<TimelineItem> items = [];

  /// Older items exist before [items].
  bool hasMore = true;

  /// Latest page in flight.
  bool loading = false;
  bool loadingOlder = false;
  bool loaded = false;

  /// Items may have been missed (resync): refresh before showing.
  bool stale = false;
  String? error;
  String? olderError;

  /// Bumped on every change, to memoize what is derived from [items].
  int version = 0;

  /// Bumped by [reset]: requests started before are dropped.
  int generation = 0;

  void merge(Iterable<TimelineItem> incoming) {
    final known = items.map((i) => i.n).toSet();
    items.addAll(incoming.where((i) => !known.contains(i.n)));
    items.sort((a, b) => a.n.compareTo(b.n));
    version++;
  }

  /// Merges the latest page, keeping older pages already loaded.
  void mergeLatest(List<TimelineItem> page, bool pageHasMore) {
    if (items.isNotEmpty && page.isNotEmpty && pageHasMore && page.first.n > items.last.n + 1) {
      // Missed more than a page: what we hold no longer joins up.
      items.clear();
    }
    final oldFirst = items.isEmpty ? null : items.first.n;
    merge(page);
    if (oldFirst == null || (page.isNotEmpty && page.first.n <= oldFirst)) hasMore = pageHasMore;
  }

  /// The agent restarted in its pane (`/clear`, new process): numbering
  /// starts over, so the old conversation goes.
  void reset() {
    items.clear();
    hasMore = true;
    loaded = false;
    loading = false;
    loadingOlder = false;
    stale = false;
    error = null;
    olderError = null;
    generation++;
    changed();
  }

  void changed() {
    version++;
    notifyListeners();
  }
}

/// Live connection to one machine (PRD §16–§17): loads the state, then
/// follows the event stream from the last known sequence number. The bridge
/// replays what was missed; when it can't (new epoch, expired events), it
/// asks for a resync and the state is reloaded.
class MachineConnection extends ChangeNotifier {
  MachineConnection(this.machine,
      {required this.onNotification, this.onMachineChanged, this.cache, BridgeClient? client})
      : client = client ?? BridgeClient(machine);

  final PairedMachine machine;
  final TimelineCache? cache;
  final BridgeClient client;
  final void Function(AgentNotification) onNotification;

  /// Name or addresses changed: persist the machine.
  final VoidCallback? onMachineChanged;

  ConnectionStatus status = ConnectionStatus.connecting;
  String? lastError;
  DateTime? lastSyncAt;

  /// huntawayd version, from the last state or machine info.
  String? bridgeVersion;

  /// Version huntawayd announced it restarts into (self-update).
  String? restartingTo;
  final Map<String, Agent> agents = {};
  final List<Workspace> workspaces = [];
  final Map<String, TimelineState> timelines = {};

  String? _epoch;
  int _seq = 0;

  /// Last sequence number when the stream said hello: events up to it are
  /// replayed ones.
  int _helloSeq = 0;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  bool _disposed = false;
  int _attempt = 0;
  Timer? _retry;
  Completer<void>? _closed;
  bool _reconnectNow = false;
  final List<Completer<void>> _settled = [];

  /// Events received while the state reloads, applied after it.
  List<Map<String, dynamic>>? _buffer;
  Future<void>? _resyncing;

  /// Agents whose timeline is on screen, with how many screens show it.
  final Map<String, int> _watched = {};

  /// Agent id → key of the prompt already answered from this phone.
  final Map<String, String> _answered = {};

  static const pingInterval = Duration(seconds: 15);

  void start() => _loop();

  /// Reconnects now (app resumed, pull to refresh). [force] also drops a
  /// connection that looks online: after a network change or a long sleep
  /// the socket may be dead without knowing it.
  void reconnect({bool force = false}) {
    if (status == ConnectionStatus.online && !force) return;
    _retry?.cancel();
    _attempt = 0;
    _reconnectNow = true;
    final closed = _closed;
    if (closed != null && !closed.isCompleted) closed.complete();
  }

  /// Pull to refresh: reloads the state when online, otherwise reconnects
  /// and waits for the attempt to end.
  Future<void> refresh() async {
    if (status == ConnectionStatus.online) {
      try {
        await _resync();
      } catch (_) {}
      return;
    }
    final settled = Completer<void>();
    _settled.add(settled);
    reconnect();
    await settled.future.timeout(const Duration(seconds: 12), onTimeout: () {});
  }

  void _settle() {
    for (final c in _settled) {
      if (!c.isCompleted) c.complete();
    }
    _settled.clear();
  }

  Future<void> _loop() async {
    while (!_disposed) {
      DateTime? openedAt;
      try {
        _setStatus(ConnectionStatus.connecting);
        await client.resolveAddress();
        // First connection: show the agents without waiting for the stream.
        if (_epoch == null) await _loadState();
        openedAt = DateTime.now();
        await _openStream();
      } catch (e) {
        lastError = e.toString();
      }
      if (_disposed) return;
      // Only a connection that held for a while resets the backoff, so a
      // socket dying right away doesn't retry every second.
      if (openedAt != null && DateTime.now().difference(openedAt) > const Duration(seconds: 30)) _attempt = 0;
      if (_reconnectNow) {
        _reconnectNow = false;
        continue;
      }
      _setStatus(ConnectionStatus.offline);
      _settle();
      final delay = Duration(seconds: min(30, 1 << min(_attempt++, 5)));
      final wake = _closed = Completer<void>();
      _retry = Timer(delay, () {
        if (!wake.isCompleted) wake.complete();
      });
      await wake.future;
      _reconnectNow = false;
    }
  }

  Future<void> _loadState() async {
    final s = await client.state();
    final machineInfo = s['machine'] as Map;
    _epoch = machineInfo['epoch'] as String;
    _seq = s['seq'] as int;
    bridgeVersion = machineInfo['bridge_version'] as String? ?? bridgeVersion;
    if (_setName(machineInfo['machine_name'] as String?)) onMachineChanged?.call();
    final previous = Map.of(agents);
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
    // Items may have been missed: refresh the timelines on screen now, the
    // others when they are opened again.
    for (final MapEntry(key: id, value: t) in timelines.entries) {
      final before = previous[id];
      if (before != null && before.instanceId != agents[id]!.instanceId) {
        t.reset();
      } else {
        t.stale = true;
      }
      if (_watched.containsKey(id)) unawaited(loadTimeline(id));
    }
    lastSyncAt = DateTime.now();
    notifyListeners();
  }

  /// Reloads the state while the stream keeps running; events received in
  /// the meantime are applied afterwards.
  Future<void> _resync() => _resyncing ??= () async {
        _buffer = [];
        try {
          await _loadState();
        } catch (e) {
          lastError = e.toString();
          // Start over: reconnect, then load the state before the stream.
          _epoch = null;
          reconnect(force: true);
          rethrow;
        } finally {
          final pending = _buffer ?? const [];
          _buffer = null;
          _resyncing = null;
          for (final e in pending) {
            _apply(e);
          }
        }
      }();

  /// Picks up a new machine name, the addresses the bridge listens on now
  /// (the Tailscale or LAN IP may have changed since pairing), its version
  /// and the permissions of this phone (granted after pairing).
  Future<void> _refreshMachine() async {
    try {
      final m = await client.machineInfo();
      final info = (m['machine'] as Map?) ?? const {};
      final version = info['bridge_version'] as String?;
      final notify = version != null && version != bridgeVersion;
      if (version != null) bridgeVersion = version;
      var changed = _setName(info['machine_name'] as String?);
      final permissions = ((m['device'] as Map?)?['permissions'] as List?)?.whereType<String>().toList();
      if (permissions != null && !listEquals(permissions, machine.permissions)) {
        machine.permissions = permissions;
        changed = true;
      }
      final raw = m['addresses'] ?? info['addresses'];
      if (raw is List) {
        final fresh = raw.whereType<String>().where((a) => a.isNotEmpty).toList();
        final current = client.address;
        final next = [?current, ...fresh.where((a) => a != current)];
        if (fresh.isNotEmpty && !listEquals(next, machine.addresses)) {
          machine.addresses = next;
          changed = true;
        }
      }
      if (changed) onMachineChanged?.call();
      if (changed || notify) notifyListeners();
    } catch (_) {
      // Older bridges or a blip: keep what we have.
    }
  }

  bool _setName(String? name) {
    if (name == null || name.isEmpty || name == machine.name) return false;
    machine.name = name;
    return true;
  }

  Future<void> _openStream() async {
    final channel = IOWebSocketChannel.connect(
      // Only the items of the timelines on screen: the others refresh when
      // they are opened again.
      client.streamUri(since: _seq, epoch: _epoch, items: _watched.keys),
      // The bridge pings every 20 s; our pings detect a dead socket (network
      // change, sleep) instead of staying "online" for minutes.
      pingInterval: pingInterval,
      connectTimeout: const Duration(seconds: 8),
    );
    _channel = channel;
    try {
      await channel.ready.timeout(const Duration(seconds: 8));
      final done = Completer<void>();
      final closed = _closed = Completer<void>();
      _subscription = channel.stream.listen(
        (raw) => _handle(jsonDecode(raw as String) as Map<String, dynamic>),
        onError: (_) => done.isCompleted ? null : done.complete(),
        onDone: () => done.isCompleted ? null : done.complete(),
        cancelOnError: true,
      );
      await Future.any([done.future, closed.future]);
    } finally {
      await _subscription?.cancel();
      _subscription = null;
      unawaited(channel.sink.close().timeout(const Duration(seconds: 2), onTimeout: () {}).catchError((_) {}));
      _channel = null;
    }
  }

  void _handle(Map<String, dynamic> e) {
    if (e['type'] == 'hello') {
      _helloSeq = e['seq'] as int? ?? 0;
      lastError = null;
      _reconnectNow = false;
      _setStatus(ConnectionStatus.online);
      _settle();
      if (e['resync_required'] == true) unawaited(_resync().catchError((_) {}));
      unawaited(_refreshMachine());
      return;
    }
    final buffer = _buffer;
    if (buffer != null) {
      buffer.add(e);
      return;
    }
    _apply(e);
  }

  void _apply(Map<String, dynamic> e) {
    final type = e['type'] as String?;
    final seq = e['seq'] as int? ?? 0;
    if (seq <= _seq) return;
    _seq = seq;
    lastSyncAt = DateTime.now();
    final agentId = e['agent_id'] as String?;
    final data = (e['data'] as Map?)?.cast<String, dynamic>() ?? const {};
    switch (type) {
      case 'agent.updated':
        final agent = Agent.fromJson(machine.machineId, data);
        final before = agents[agent.id];
        agents[agent.id] = agent;
        if (before != null && before.instanceId != agent.instanceId) _resetTimeline(agent.id);
        notifyListeners();
      case 'agent.removed':
        agents.remove(agentId);
        timelines.remove(agentId);
        _answered.remove(agentId);
        notifyListeners();
      case 'agent.item':
        final timeline = timelines[agentId];
        if (timeline != null && timeline.loaded) {
          final item = TimelineItem.fromJson(data);
          // A hole before it: items went by while the stream skipped this
          // agent (subscribed after the page was read).
          final gap = timeline.items.isNotEmpty && item.n > timeline.items.last.n + 1;
          timeline.merge([item]);
          timeline.changed();
          _saveTimeline(agentId!);
          if (gap) {
            timeline.stale = true;
            if (_watched.containsKey(agentId)) unawaited(loadTimeline(agentId));
          }
        }
      case 'notification':
        final interactionId = data['interaction_id'] as String?;
        final kind = data['kind'] as String? ?? '';
        final title = data['title'] as String? ?? '';
        onNotification(AgentNotification(
          machine.machineId,
          data['agent_id'] as String? ?? agentId ?? '',
          kind,
          title.isEmpty ? AgentNotification.defaultTitle(kind) : title,
          data['body'] as String? ?? '',
          interactionId: interactionId == null || interactionId.isEmpty ? null : interactionId,
          replayed: seq <= _helloSeq,
        ));
      case 'daemon.restarting':
        // Self-update: the stream drops and comes back on the new version.
        restartingTo = data['to'] as String?;
        notifyListeners();
      default:
        return; // Unknown events are ignored.
    }
  }

  void _setStatus(ConnectionStatus s) {
    if (status == s) return;
    status = s;
    notifyListeners();
  }

  // -------------------------------------------------------------- answers

  /// Whether the prompt [agent] shows was already answered from this phone.
  bool answered(Agent agent) {
    final i = agent.interaction;
    return i != null && _answered[agent.id] == i.key;
  }

  /// Answers the prompt [agent] shows: picks option [number], or denies
  /// when null. The prompt then stays marked as answered (buttons off)
  /// until the agent moves on, so a second tap can't land on the next one.
  /// Returns false when it was already answered.
  Future<bool> answer(Agent agent, {int? number, String? text}) async {
    final i = agent.interaction;
    if (i == null || answered(agent)) return false;
    final key = i.key;
    _answered[agent.id] = key;
    notifyListeners();
    try {
      if (number != null) {
        await client.choose(agent.id, number, text: text, interactionId: i.id);
      } else {
        await client.deny(agent.id, text, interactionId: i.id);
      }
    } catch (e) {
      _answered.remove(agent.id);
      notifyListeners();
      if (e is BridgeException && e.code == 'interaction_changed') unawaited(refreshAgent(agent.id));
      rethrow;
    }
    // The keys may not have landed: allow another try if nothing moved.
    Timer(const Duration(seconds: 20), () {
      if (!_disposed && _answered[agent.id] == key) {
        _answered.remove(agent.id);
        notifyListeners();
      }
    });
    return true;
  }

  /// Fetches one agent now, without waiting for the stream.
  Future<void> refreshAgent(String agentId) async {
    try {
      final agent = await client.agent(agentId);
      if (_disposed) return;
      agents[agentId] = agent;
      notifyListeners();
    } catch (_) {}
  }

  // ------------------------------------------------------------- timeline

  TimelineState timeline(String agentId) => timelines.putIfAbsent(agentId, TimelineState.new);

  /// Agents whose items the stream sends.
  @visibleForTesting
  Set<String> get watched => _watched.keys.toSet();

  /// A screen shows this timeline: stream its items and keep it fresh after
  /// a resync. Call before [loadTimeline] so no item falls in between.
  void watch(String agentId) {
    final n = _watched[agentId] = (_watched[agentId] ?? 0) + 1;
    if (n == 1) _sendItemFilter();
  }

  void unwatch(String agentId) {
    final n = (_watched[agentId] ?? 1) - 1;
    if (n > 0) {
      _watched[agentId] = n;
      return;
    }
    if (_watched.remove(agentId) == null) return;
    // Its items stop coming: reload the latest page when opened again.
    timelines[agentId]?.stale = true;
    _sendItemFilter();
  }

  /// Tells the open stream which agents' items to send. Older bridges
  /// ignore it and keep sending everything.
  void _sendItemFilter() {
    try {
      _channel?.sink.add(jsonEncode({'type': 'items', 'agent_ids': _watched.keys.toList()}));
    } catch (_) {
      // Closing: the next stream opens with the current filter.
    }
  }

  void _resetTimeline(String agentId) {
    final t = timelines[agentId];
    if (t == null) return;
    t.reset();
    if (_watched.containsKey(agentId)) unawaited(loadTimeline(agentId));
  }

  void _saveTimeline(String agentId) {
    final agent = agents[agentId];
    final t = timelines[agentId];
    if (cache == null || agent == null || t == null) return;
    cache!.schedule(machine.machineId, agentId, agent.instanceId, t.items);
  }

  /// Loads the latest page, or refreshes it when [refresh] or stale. Older
  /// pages already loaded are kept, and so are live items received while
  /// the request runs.
  Future<void> loadTimeline(String agentId, {bool refresh = false}) async {
    final t = timeline(agentId);
    if (t.loading || (t.loaded && !t.stale && !refresh)) return;
    final generation = t.generation;
    t.loading = true;
    t.error = null;
    t.changed();
    // Show the cached conversation while the bridge answers.
    final agent = agents[agentId];
    if (!t.loaded && t.items.isEmpty && cache != null && agent != null) {
      final cached = await cache!.read(machine.machineId, agentId, agent.instanceId);
      if (generation != t.generation) return;
      t.merge(cached);
      t.changed();
    }
    try {
      final (items, hasMore) = await client.timeline(agentId, limit: 120);
      if (generation != t.generation) return;
      t.mergeLatest(items, hasMore);
      t.loaded = true;
      t.stale = false;
      _saveTimeline(agentId);
    } catch (e) {
      if (generation == t.generation) t.error = e.toString();
    } finally {
      if (generation == t.generation) {
        t.loading = false;
        t.changed();
      }
    }
  }

  Future<void> loadOlder(String agentId) async {
    final t = timeline(agentId);
    if (t.loadingOlder || !t.loaded || !t.hasMore || t.items.isEmpty) return;
    final generation = t.generation;
    t.loadingOlder = true;
    t.olderError = null;
    t.changed();
    try {
      final (items, hasMore) = await client.timeline(agentId, before: t.items.first.n, limit: 120);
      if (generation != t.generation) return;
      t.merge(items);
      t.hasMore = hasMore;
    } catch (e) {
      if (generation == t.generation) t.olderError = e.toString();
    } finally {
      if (generation == t.generation) {
        t.loadingOlder = false;
        t.changed();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _closed?.isCompleted == false ? _closed!.complete() : null;
    _settle();
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
    _changed();
  }

  Future<void> _save() => _storage.write(
        key: _key,
        value: jsonEncode([for (final c in connections) c.machine.toJson()]),
      );

  void _add(PairedMachine machine) {
    final connection = MachineConnection(
      machine,
      onNotification: _notifications.add,
      onMachineChanged: () => unawaited(_save().catchError((_) {})),
      cache: _cache,
    )
      ..addListener(_changed)
      ..start();
    connections.add(connection);
  }

  List<Agent>? _sorted;

  void _changed() {
    _sorted = null;
    notifyListeners();
  }

  /// Adds a connection without persisting or starting it (widget tests).
  @visibleForTesting
  void addConnectionForTest(MachineConnection connection) {
    connections.add(connection..addListener(_changed));
    _changed();
  }

  Future<void> addMachine(PairedMachine machine) async {
    await removeMachine(machine.machineId, save: false);
    _add(machine);
    await _save();
    _changed();
  }

  Future<void> removeMachine(String machineId, {bool save = true}) async {
    final existing = connections.where((c) => c.machine.machineId == machineId).toList();
    for (final c in existing) {
      connections.remove(c);
      // Forgotten for good: stop the bridge from pushing to this phone.
      if (save) {
        try {
          await c.client.registerPush(null).timeout(const Duration(seconds: 4));
        } catch (_) {}
      }
      c.removeListener(_changed);
      c.dispose();
    }
    if (save) {
      await _cache.remove(machineId);
      await _save();
      _changed();
    }
  }

  void reconnectAll({bool force = false}) {
    for (final c in connections) {
      c.reconnect(force: force);
    }
  }

  Future<void> refresh() => Future.wait([for (final c in connections) c.refresh()]);

  MachineConnection? connection(String machineId) {
    for (final c in connections) {
      if (c.machine.machineId == machineId) return c;
    }
    return null;
  }

  /// Every agent of every machine, blocked first, then most recent activity.
  List<Agent> get agents => _sorted ??= () {
        final all = [for (final c in connections) ...c.agents.values];
        all.sort((a, b) {
          final p = a.attention.priority.compareTo(b.attention.priority);
          if (p != 0) return p;
          final at = a.lastActivityAt ?? DateTime.fromMillisecondsSinceEpoch(0);
          final bt = b.lastActivityAt ?? DateTime.fromMillisecondsSinceEpoch(0);
          return bt.compareTo(at);
        });
        return List<Agent>.unmodifiable(all);
      }();

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
