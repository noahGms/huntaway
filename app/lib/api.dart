import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;

import 'models.dart';

class BridgeException implements Exception {
  BridgeException(this.code, this.message, [this.status]);
  final String code;
  final String message;
  final int? status;

  @override
  String toString() => message;
}

const _timeout = Duration(seconds: 8);

Uri _uri(String address, String path, [Map<String, String>? query]) {
  final base = Uri.parse('http://$address');
  return base.replace(path: path, queryParameters: query);
}

Never _throwFrom(http.Response r) {
  try {
    final err = (jsonDecode(r.body) as Map)['error'] as Map;
    throw BridgeException(err['code'] as String, err['message'] as String, r.statusCode);
  } on BridgeException {
    rethrow;
  } catch (_) {
    throw BridgeException('http_${r.statusCode}', 'Error ${r.statusCode}', r.statusCode);
  }
}

/// REST client for one paired machine. Tries each advertised address and
/// sticks to the first one that answers (Tailscale IP, MagicDNS, LAN…).
class BridgeClient {
  BridgeClient(this.machine, {http.Client? client}) : _http = client ?? http.Client();

  final PairedMachine machine;
  final http.Client _http;
  String? _address;

  String? get address => _address;

  Map<String, String> get _headers => {
        'authorization': 'Bearer ${machine.token}',
        'content-type': 'application/json',
      };

  /// Finds a reachable address (healthz), preferring the last one that worked.
  Future<String> resolveAddress() async {
    final candidates = [
      ?_address,
      ...machine.addresses.where((a) => a != _address),
    ];
    for (final address in candidates) {
      try {
        final r = await _http.get(_uri(address, '/healthz')).timeout(const Duration(seconds: 3));
        if (r.statusCode == 200) return _address = address;
      } catch (_) {}
    }
    _address = null;
    throw BridgeException('unreachable', 'Machine unreachable');
  }

  Future<dynamic> _send(String method, String path,
      {Map<String, dynamic>? body, Map<String, String>? query, Duration postTimeout = const Duration(seconds: 20)}) async {
    final address = _address ?? await resolveAddress();
    final uri = _uri(address, path, query);
    late http.Response r;
    try {
      r = switch (method) {
        'GET' => await _http.get(uri, headers: _headers).timeout(_timeout),
        _ => await _http
            .post(uri, headers: _headers, body: jsonEncode(body ?? const {}))
            .timeout(postTimeout),
      };
    } on TimeoutException {
      _address = null;
      throw BridgeException('timeout', 'The machine is not responding');
    } catch (e) {
      _address = null;
      throw BridgeException('network', 'Cannot connect');
    }
    if (r.statusCode >= 400) _throwFrom(r);
    return jsonDecode(utf8.decode(r.bodyBytes));
  }

  Future<Map<String, dynamic>> state() async =>
      (await _send('GET', '/v1/state') as Map).cast<String, dynamic>();

  /// Machine info, including the addresses it listens on (newer bridges).
  Future<Map<String, dynamic>> machineInfo() async =>
      (await _send('GET', '/v1/machine') as Map).cast<String, dynamic>();

  Future<Agent> agent(String agentId) async =>
      Agent.fromJson(machine.machineId, (await _send('GET', '/v1/agents/$agentId') as Map).cast<String, dynamic>());

  Future<(List<TimelineItem>, bool)> timeline(String agentId, {int? before, int limit = 100}) async {
    final r = await _send('GET', '/v1/agents/$agentId/timeline', query: {
      'limit': '$limit',
      if (before != null) 'before': '$before',
    }) as Map;
    final items = [
      for (final i in r['items'] as List) TimelineItem.fromJson((i as Map).cast<String, dynamic>())
    ];
    return (items, (r['has_more'] as bool?) ?? false);
  }

  Future<void> sendMessage(String agentId, String text) =>
      _send('POST', '/v1/agents/$agentId/messages', body: {'text': text});

  /// Sends Esc. The bridge refuses with `agent_blocked` while the agent
  /// waits on a prompt (Esc would deny it), unless [force].
  Future<void> interrupt(String agentId, {bool force = false}) =>
      _send('POST', '/v1/agents/$agentId/interrupt', body: {if (force) 'force': true});

  /// Picks an on-screen option; [text] answers a free-text option. With
  /// [interactionId], the bridge refuses (`interaction_changed`) if the agent
  /// now shows another prompt.
  Future<void> choose(String agentId, int number, {String? text, String? interactionId}) =>
      _send('POST', '/v1/agents/$agentId/choice',
          body: {'number': number, 'text': ?text, 'interaction_id': ?interactionId});

  Future<void> deny(String agentId, String? text, {String? interactionId}) =>
      _send('POST', '/v1/agents/$agentId/deny', body: {'text': text, 'interaction_id': ?interactionId});

  /// Raw input to the pane (permission `agents.input`).
  Future<void> input(String agentId, {String? text, List<String> keys = const []}) =>
      _send('POST', '/v1/agents/$agentId/input', body: {'text': ?text, 'keys': keys});

  Future<Map<String, dynamic>> screen(String agentId, {int? lines, bool ansi = false}) async =>
      (await _send('GET', '/v1/agents/$agentId/screen',
              query: {if (lines != null) 'lines': '$lines', if (ansi) 'ansi': '1'})
              as Map)
          .cast<String, dynamic>();

  /// Starts a new agent in a project (permission `agents.create`).
  /// Returns the new agent id and whether the prompt was sent.
  Future<(String, bool)> createAgent(
      {required String session, required String workspaceId, required String kind, required String prompt}) async {
    final r = await _send('POST', '/v1/agents',
        body: {'session': session, 'workspace_id': workspaceId, 'kind': kind, 'prompt': prompt}) as Map;
    return (r['agent_id'] as String, (r['prompt_sent'] as bool?) ?? false);
  }

  /// Latest huntawayd release: `current`, `latest`, `available`.
  Future<Map<String, dynamic>> daemonUpdate() async =>
      (await _send('GET', '/v1/daemon/update') as Map).cast<String, dynamic>();

  /// Installs the latest huntawayd (permission `daemon.update`), which then
  /// restarts in place: the connection drops and comes back. Refused with
  /// `up_to_date` when there is nothing to install. Returns the new version.
  Future<String> updateDaemon() async {
    // Downloads the release before answering.
    final r = await _send('POST', '/v1/daemon/update', postTimeout: const Duration(minutes: 3)) as Map;
    return r['to'] as String? ?? '';
  }

  /// Usage metrics of this machine (PRD §22).
  Future<Map<String, dynamic>> metrics() async => (await _send('GET', '/v1/metrics') as Map).cast<String, dynamic>();

  Future<void> registerPush(String? endpoint) =>
      _send('POST', '/v1/push', body: {'endpoint': endpoint});

  /// WebSocket URL of the live terminal of an agent.
  Uri terminalUri(String agentId) {
    final address = _address ?? machine.addresses.first;
    return Uri.parse('ws://$address/v1/agents/$agentId/terminal').replace(queryParameters: {'token': machine.token});
  }

  /// WebSocket URL for the event stream. [items] limits `agent.item` events
  /// to these agents (empty = none, null = all); older bridges send all.
  Uri streamUri({int? since, String? epoch, Iterable<String>? items}) {
    final address = _address ?? machine.addresses.first;
    return Uri.parse('ws://$address/v1/stream').replace(queryParameters: {
      'token': machine.token,
      if (since != null && epoch != null) 'since': '$since',
      if (since != null && epoch != null) 'epoch': epoch,
      if (items != null) 'items': items.join(','),
    });
  }

  void close() => _http.close();
}

/// Content of the pairing QR code printed by `huntawayd pair`.
class PairingPayload {
  PairingPayload(this.machineId, this.machineName, this.addresses, this.code, this.fingerprint);
  final String machineId;
  final String machineName;
  final List<String> addresses;
  final String code;
  final String fingerprint;

  static PairingPayload parse(String raw) {
    final Map<String, dynamic> j;
    try {
      j = (jsonDecode(raw.trim()) as Map).cast<String, dynamic>();
    } catch (_) {
      throw BridgeException('invalid_qr', 'Not a Huntaway QR code');
    }
    if (j['v'] != 1 || j['pairing_code'] == null) {
      throw BridgeException('invalid_qr', 'Unsupported Huntaway QR code');
    }
    return PairingPayload(
      j['machine_id'] as String,
      j['machine_name'] as String? ?? 'Machine',
      (j['addresses'] as List).cast<String>(),
      j['pairing_code'] as String,
      j['fingerprint'] as String,
    );
  }
}

String _b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Pairs with a bridge: redeems the one-time code, then checks that the
/// answering bridge owns the key whose fingerprint is in the QR code.
Future<PairedMachine> pair(PairingPayload payload, String deviceName, {http.Client? client}) async {
  final httpClient = client ?? http.Client();
  final random = Random.secure();
  final nonce = _b64url(List<int>.generate(24, (_) => random.nextInt(256)));
  BridgeException? lastError;
  for (final address in payload.addresses) {
    http.Response r;
    try {
      r = await httpClient
          .post(_uri(address, '/v1/pair'),
              headers: {'content-type': 'application/json'},
              body: jsonEncode({'code': payload.code, 'device_name': deviceName, 'nonce': nonce}))
          .timeout(const Duration(seconds: 6));
    } catch (_) {
      lastError = BridgeException('unreachable', 'Unreachable: $address');
      continue;
    }
    if (r.statusCode >= 400) _throwFrom(r);
    final j = (jsonDecode(utf8.decode(r.bodyBytes)) as Map).cast<String, dynamic>();

    final publicKey = base64.decode(j['public_key'] as String);
    final digest = await Sha256().hash(publicKey);
    if ('sha256:${_b64url(digest.bytes)}' != payload.fingerprint) {
      throw BridgeException('fingerprint_mismatch', 'The machine fingerprint does not match the QR code');
    }
    final message = utf8.encode('huntaway-pair-v1|$nonce|${j['machine_id']}|${j['device_id']}');
    final valid = await Ed25519().verify(
      message,
      signature: Signature(
        base64.decode(j['signature'] as String),
        publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
      ),
    );
    if (!valid || j['machine_id'] != payload.machineId) {
      throw BridgeException('bad_signature', 'Invalid machine signature');
    }
    // Put the address that worked first.
    final addresses = [address, ...payload.addresses.where((a) => a != address)];
    return PairedMachine(
      machineId: payload.machineId,
      name: j['machine_name'] as String? ?? payload.machineName,
      addresses: addresses,
      token: j['token'] as String,
      deviceId: j['device_id'] as String,
      fingerprint: payload.fingerprint,
      permissions: ((j['permissions'] as List?) ?? const []).cast<String>(),
    );
  }
  throw lastError ?? BridgeException('unreachable', 'No reachable address');
}
