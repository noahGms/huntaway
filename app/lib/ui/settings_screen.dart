import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../keepalive.dart';
import '../notifications.dart';
import '../sync.dart';
import 'common.dart';
import '../updater.dart';
import 'pairing_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _notifier = Notifier.instance;

  Future<void> _showMetrics(MachineConnection c) async {
    Map<String, dynamic>? m;
    Object? error;
    try {
      m = await c.client.metrics();
    } catch (e) {
      error = e;
    }
    if (!mounted) return;
    String secs(dynamic v) => v == null ? '—' : '${(v as num).round()} s';
    final rate = m?['remote_unblock_rate'] as num?;
    final notifs = (m?['notifications'] as Map?) ?? const {};
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Stats · ${c.machine.name}'),
        content: error != null
            ? Text(error.toString())
            : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Up ${((m!['uptime_secs'] as num) / 3600).toStringAsFixed(1)} h', style: const TextStyle(color: HuntawayColors.muted)),
                const SizedBox(height: 10),
                Text('Blocks: ${m['blocked_episodes']}'),
                Text('Unblocked from Huntaway: ${m['resolved_from_huntaway']}${rate != null ? ' (${(rate * 100).round()}%)' : ''}'),
                Text('Median time to unblock: ${secs((m['time_to_unblock_secs'] as Map)['median'])}'),
                Text('From Huntaway: ${secs((m['time_to_unblock_from_huntaway_secs'] as Map)['median'])}'),
                const SizedBox(height: 10),
                Text('Notifications: ${notifs.entries.map((e) => '${e.key} ${e.value}').join(' · ')}'),
              ]),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
      ),
    );
  }

  Future<void> _checkForUpdates() async {
    final updater = Updater.instance;
    final info = await updater.check(force: true);
    if (!mounted || updater.error != null) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(info == null ? 'Huntaway is up to date' : 'Version ${info.version} is available'),
    ));
  }

  Future<void> _choosePush() async {
    final distributors = await _notifier.distributors();
    if (!mounted) return;
    if (distributors.isEmpty) {
      showDialog(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('No distributor'),
          content: const Text(
            'Notifications while Huntaway is closed go through UnifiedPush. '
            'Install the ntfy app (F-Droid or Play Store), then come back here.',
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
        ),
      );
      return;
    }
    final chosen = distributors.length == 1
        ? distributors.first
        : await showDialog<String>(
            context: context,
            builder: (context) => SimpleDialog(
              title: const Text('Distributor'),
              children: [
                for (final d in distributors)
                  SimpleDialogOption(onPressed: () => Navigator.pop(context, d), child: Text(d)),
              ],
            ),
          );
    if (chosen == null) return;
    await _notifier.useDistributor(chosen);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final model = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(children: [
        const _Header('Machines'),
        for (final c in model.connections) ...[
          ListTile(
            leading: Icon(Icons.computer,
                color: c.status == ConnectionStatus.online ? HuntawayColors.done : HuntawayColors.faint),
            title: Text(c.machine.name),
            subtitle: Text(
              [
                switch (c.status) {
                  ConnectionStatus.online => 'online',
                  ConnectionStatus.connecting => 'connecting…',
                  ConnectionStatus.offline => 'offline${c.lastError != null ? ' · ${c.lastError}' : ''}',
                },
                c.client.address ?? c.machine.addresses.first,
                if (c.bridgeVersion != null) 'huntawayd ${c.bridgeVersion}',
              ].join(' · '),
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
            ),
            onTap: () => _showMetrics(c),
            trailing: IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Forget this machine',
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (context) => AlertDialog(
                    title: Text('Forget ${c.machine.name}?'),
                    content: const Text(
                        'This phone deletes its credentials. To revoke the token on the machine: `huntawayd devices revoke`.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
                      FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Forget')),
                    ],
                  ),
                );
                if (ok == true) await model.removeMachine(c.machine.machineId);
              },
            ),
          ),
          _DaemonUpdateTile(c, key: ValueKey('update-${c.machine.machineId}')),
        ],
        ListTile(
          leading: const Icon(Icons.add),
          title: const Text('Add a machine'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PairingScreen())),
        ),
        const _Header('Notifications'),
        if (_notifier.pushSupported)
          ListTile(
            leading: const Icon(Icons.notifications_active_outlined),
            title: const Text('Notifications when closed'),
            subtitle: Text(
              _notifier.distributor == null
                  ? 'Off: pick a UnifiedPush distributor (ntfy)'
                  : 'Via ${_notifier.distributor}${_notifier.endpoint == null ? ' · pending' : ' · active'}',
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
            ),
            trailing: _notifier.distributor == null
                ? null
                : TextButton(
                    onPressed: () async {
                      await _notifier.disablePush();
                      if (mounted) setState(() {});
                    },
                    child: const Text('Turn off'),
                  ),
            onTap: _choosePush,
          )
        else
          const ListTile(
            leading: Icon(Icons.notifications_outlined),
            title: Text('Notifications while the app is open'),
            subtitle: Text('Push while closed on iOS will come with the Huntaway relay.',
                style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          ),
        if (BackgroundLink.instance.supported && _notifier.distributor == null)
          SwitchListTile(
            secondary: const Icon(Icons.sync),
            title: const Text('Stay connected in the background'),
            subtitle: const Text(
                'Without ntfy: a persistent notification keeps Huntaway connected (uses a little battery)',
                style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
            value: BackgroundLink.instance.enabled,
            onChanged: (v) async {
              await BackgroundLink.instance.setEnabled(v);
              if (mounted) setState(() {});
            },
          ),
        SwitchListTile(
          secondary: const Icon(Icons.lock_outline),
          title: const Text('Hide content on the lock screen'),
          subtitle: const Text('Shows only "Huntaway" while the phone is locked',
              style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          value: _notifier.hideOnLockScreen,
          onChanged: (v) async {
            await _notifier.setHideOnLockScreen(v);
            if (mounted) setState(() {});
          },
        ),
        const _Header('About'),
        ListenableBuilder(
          listenable: Updater.instance,
          builder: (context, _) {
            final updater = Updater.instance;
            return Column(children: [
              ListTile(
                leading: const HuntawayLogo(size: 36),
                title: Text(updater.version == null ? 'Huntaway' : 'Huntaway ${updater.version}'),
                subtitle: const Text('Drive your Herdr agents from your phone.',
                    style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
              ),
              if (updater.supported)
                ListTile(
                  leading: const Icon(Icons.system_update_outlined),
                  title: const Text('Check for updates'),
                  subtitle: Text(
                    updater.checking
                        ? 'Checking…'
                        : updater.progress != null
                            ? 'Downloading… ${(updater.progress! * 100).round()}%'
                            : updater.available != null
                                ? 'Version ${updater.available!.version} available'
                                : updater.error ?? 'Version ${updater.version ?? '?'} (build ${updater.build})',
                    style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
                  ),
                  trailing: updater.available != null && updater.progress == null
                      ? TextButton(onPressed: updater.downloadAndInstall, child: const Text('Update'))
                      : null,
                  onTap: updater.checking || updater.progress != null ? null : _checkForUpdates,
                ),
            ]);
          },
        ),
      ]),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.title);
  final String title;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
        child: Text(title.toUpperCase(),
            style: const TextStyle(color: HuntawayColors.muted, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.8)),
      );
}

const _installCommand = 'curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh';

enum _UpdatePhase { idle, installing, restarting, done, failed }

/// "Update huntawayd to X" under a machine when a newer release exists.
/// Without the `daemon.update` permission, shows the command to run on the
/// machine instead. The daemon restarts in place: the connection drops,
/// and the update is done once it comes back on the new version.
class _DaemonUpdateTile extends StatefulWidget {
  const _DaemonUpdateTile(this.connection, {super.key});
  final MachineConnection connection;

  @override
  State<_DaemonUpdateTile> createState() => _DaemonUpdateTileState();
}

class _DaemonUpdateTileState extends State<_DaemonUpdateTile> {
  static const _restartTimeout = Duration(minutes: 2);

  /// `GET /v1/daemon/update`; null until checked (or on older daemons).
  Map<String, dynamic>? _check;
  bool _checking = false;
  _UpdatePhase _phase = _UpdatePhase.idle;
  String? _target;
  String? _error;
  Timer? _poll;
  DateTime? _restartedAt;

  MachineConnection get _c => widget.connection;

  @override
  void initState() {
    super.initState();
    _c.addListener(_onConnection);
    _fetch();
  }

  @override
  void dispose() {
    _c.removeListener(_onConnection);
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _fetch() async {
    if (_checking || _c.status != ConnectionStatus.online) return;
    _checking = true;
    try {
      final check = await _c.client.daemonUpdate();
      if (mounted) setState(() => _check = check);
    } catch (_) {
      // Older daemon or no network: show nothing.
    } finally {
      _checking = false;
    }
  }

  void _onConnection() {
    if (!mounted) return;
    if (_check == null && _phase == _UpdatePhase.idle) _fetch();
    if (_phase == _UpdatePhase.restarting &&
        _c.status == ConnectionStatus.online &&
        _target != null &&
        _c.bridgeVersion == _target) {
      _poll?.cancel();
      setState(() {
        _phase = _UpdatePhase.done;
        _check = {..._check ?? const {}, 'current': _target, 'available': false};
      });
    }
  }

  Future<void> _update() async {
    final latest = _check?['latest'] as String?;
    setState(() {
      _phase = _UpdatePhase.installing;
      _target = latest;
      _error = null;
    });
    try {
      final to = await _c.client.updateDaemon();
      if (to.isNotEmpty) _target = to;
    } on BridgeException catch (e) {
      if (e.code == 'up_to_date') {
        if (!mounted) return;
        setState(() => _phase = _UpdatePhase.idle);
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('huntawayd is already up to date')));
        _check = null;
        unawaited(_fetch());
        return;
      }
      // The answer may be lost as the daemon restarts: wait for it anyway.
      if (e.code != 'network' && e.code != 'timeout') {
        if (mounted) {
          setState(() {
            _phase = _UpdatePhase.failed;
            _error = errorMessage(e);
          });
        }
        return;
      }
    }
    if (!mounted) return;
    setState(() => _phase = _UpdatePhase.restarting);
    _restartedAt = DateTime.now();
    // Reconnect quickly instead of waiting for the backoff.
    _poll = Timer.periodic(const Duration(seconds: 3), (_) {
      if (DateTime.now().difference(_restartedAt!) > _restartTimeout) {
        _poll?.cancel();
        if (mounted) {
          setState(() {
            _phase = _UpdatePhase.failed;
            _error = 'huntawayd did not come back on ${_target ?? 'the new version'}. Check the machine.';
          });
        }
        return;
      }
      _c.reconnect();
      _onConnection();
    });
  }

  @override
  Widget build(BuildContext context) {
    const muted = TextStyle(color: HuntawayColors.muted, fontSize: 12.5);
    final check = _check;
    switch (_phase) {
      case _UpdatePhase.installing || _UpdatePhase.restarting:
        return ListTile(
          contentPadding: const EdgeInsets.only(left: 32, right: 16),
          leading: const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
          title: Text(_phase == _UpdatePhase.installing
              ? 'Installing huntawayd ${_target ?? ''}…'
              : 'Restarting huntawayd…'),
          subtitle: Text(
              _phase == _UpdatePhase.installing
                  ? 'Downloading the release on the machine'
                  : 'Waiting for the machine to come back on ${_target ?? 'the new version'}',
              style: muted),
        );
      case _UpdatePhase.done:
        return ListTile(
          contentPadding: const EdgeInsets.only(left: 32, right: 16),
          leading: const Icon(Icons.check_circle_outline, color: HuntawayColors.done),
          title: Text('huntawayd ${_c.bridgeVersion ?? _target ?? ''} is running'),
        );
      case _UpdatePhase.failed:
        return ListTile(
          contentPadding: const EdgeInsets.only(left: 32, right: 16),
          leading: const Icon(Icons.error_outline, color: HuntawayColors.error),
          title: const Text('Update failed'),
          subtitle: Text(_error ?? '', style: const TextStyle(color: HuntawayColors.error, fontSize: 12.5)),
          trailing: TextButton(onPressed: _update, child: const Text('Retry')),
        );
      case _UpdatePhase.idle:
        break;
    }
    if (check == null || check['available'] != true) return const SizedBox.shrink();
    final latest = check['latest'] as String? ?? '';
    final current = check['current'] as String? ?? _c.bridgeVersion ?? '?';
    if (!_c.machine.can('daemon.update')) {
      return ListTile(
        contentPadding: const EdgeInsets.only(left: 32, right: 4),
        title: Text('huntawayd $latest is available'),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Installed: $current. Run on the machine:', style: muted),
          const SizedBox(height: 4),
          SelectableText(_installCommand, style: mono.copyWith(fontSize: 11.5)),
        ]),
        trailing: IconButton(
          tooltip: 'Copy the command',
          icon: const Icon(Icons.copy_rounded, size: 18),
          onPressed: () {
            Clipboard.setData(const ClipboardData(text: _installCommand));
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Command copied')));
          },
        ),
      );
    }
    return ListTile(
      contentPadding: const EdgeInsets.only(left: 32, right: 16),
      leading: const Icon(Icons.system_update_outlined, color: HuntawayColors.accent),
      title: Text('Update huntawayd to $latest'),
      subtitle: Text('Installed: $current · the machine reconnects after a restart', style: muted),
      onTap: _c.status == ConnectionStatus.online ? _update : null,
    );
  }
}
