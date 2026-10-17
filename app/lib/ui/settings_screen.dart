import 'package:flutter/material.dart';

import '../keepalive.dart';
import '../notifications.dart';
import '../sync.dart';
import 'common.dart';
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
        title: Text('Statistiques · ${c.machine.name}'),
        content: error != null
            ? Text(error.toString())
            : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Depuis ${((m!['uptime_secs'] as num) / 3600).toStringAsFixed(1)} h', style: const TextStyle(color: HuntawayColors.muted)),
                const SizedBox(height: 10),
                Text('Blocages : ${m['blocked_episodes']}'),
                Text('Débloqués depuis Huntaway : ${m['resolved_from_huntaway']}${rate != null ? ' (${(rate * 100).round()} %)' : ''}'),
                Text('Délai médian de déblocage : ${secs((m['time_to_unblock_secs'] as Map)['median'])}'),
                Text('Depuis Huntaway : ${secs((m['time_to_unblock_from_huntaway_secs'] as Map)['median'])}'),
                const SizedBox(height: 10),
                Text('Notifications : ${notifs.entries.map((e) => '${e.key} ${e.value}').join(' · ')}'),
              ]),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
      ),
    );
  }

  Future<void> _choosePush() async {
    final distributors = await _notifier.distributors();
    if (!mounted) return;
    if (distributors.isEmpty) {
      showDialog(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Aucun distributeur'),
          content: const Text(
            'Les notifications quand Huntaway est fermée passent par UnifiedPush. '
            "Installe l'app ntfy (F-Droid ou Play Store), puis reviens ici.",
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
              title: const Text('Distributeur'),
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
      appBar: AppBar(title: const Text('Réglages')),
      body: ListView(children: [
        const _Header('Machines'),
        for (final c in model.connections)
          ListTile(
            leading: Icon(Icons.computer,
                color: c.status == ConnectionStatus.online ? HuntawayColors.done : HuntawayColors.faint),
            title: Text(c.machine.name),
            subtitle: Text(
              [
                switch (c.status) {
                  ConnectionStatus.online => 'en ligne',
                  ConnectionStatus.connecting => 'connexion…',
                  ConnectionStatus.offline => 'hors ligne${c.lastError != null ? ' · ${c.lastError}' : ''}',
                },
                c.client.address ?? c.machine.addresses.first,
              ].join(' · '),
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
            ),
            onTap: () => _showMetrics(c),
            trailing: IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Oublier cette machine',
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (context) => AlertDialog(
                    title: Text('Oublier ${c.machine.name} ?'),
                    content: const Text(
                        'Le téléphone supprime ses accès. Pour révoquer le token côté machine : `huntawayd devices revoke`.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
                      FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Oublier')),
                    ],
                  ),
                );
                if (ok == true) await model.removeMachine(c.machine.machineId);
              },
            ),
          ),
        ListTile(
          leading: const Icon(Icons.add),
          title: const Text('Ajouter une machine'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PairingScreen())),
        ),
        const _Header('Notifications'),
        if (_notifier.pushSupported)
          ListTile(
            leading: const Icon(Icons.notifications_active_outlined),
            title: const Text('Notifications app fermée'),
            subtitle: Text(
              _notifier.distributor == null
                  ? 'Désactivées : choisis un distributeur UnifiedPush (ntfy)'
                  : 'Via ${_notifier.distributor}${_notifier.endpoint == null ? ' · en attente' : ' · actives'}',
              style: const TextStyle(color: HuntawayColors.muted, fontSize: 12.5),
            ),
            trailing: _notifier.distributor == null
                ? null
                : TextButton(
                    onPressed: () async {
                      await _notifier.disablePush();
                      if (mounted) setState(() {});
                    },
                    child: const Text('Couper'),
                  ),
            onTap: _choosePush,
          )
        else
          const ListTile(
            leading: Icon(Icons.notifications_outlined),
            title: Text('Notifications quand l’app est ouverte'),
            subtitle: Text('Le push app fermée sur iOS arrivera avec le relais Huntaway.',
                style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          ),
        if (BackgroundLink.instance.supported && _notifier.distributor == null)
          SwitchListTile(
            secondary: const Icon(Icons.sync),
            title: const Text('Maintenir la connexion en arrière-plan'),
            subtitle: const Text(
                'Sans ntfy : une notification permanente garde Huntaway connecté (consomme un peu de batterie)',
                style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
            value: BackgroundLink.instance.enabled,
            onChanged: (v) async {
              await BackgroundLink.instance.setEnabled(v);
              if (mounted) setState(() {});
            },
          ),
        SwitchListTile(
          secondary: const Icon(Icons.lock_outline),
          title: const Text("Masquer le contenu sur l'écran verrouillé"),
          subtitle: const Text('Affiche seulement « Huntaway » tant que le téléphone est verrouillé',
              style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
          value: _notifier.hideOnLockScreen,
          onChanged: (v) async {
            await _notifier.setHideOnLockScreen(v);
            if (mounted) setState(() {});
          },
        ),
        const _Header('À propos'),
        const ListTile(
          leading: HuntawayLogo(size: 36),
          title: Text('Huntaway 0.1'),
          subtitle: Text('Pilote tes agents Herdr depuis ton téléphone.',
              style: TextStyle(color: HuntawayColors.muted, fontSize: 12.5)),
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
