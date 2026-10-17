import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api.dart';
import 'common.dart';

/// Pairing (PRD §8.3): scan the QR printed by `huntawayd pair`, or paste it.
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key});

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _scanner = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _busy = false;
  String? _status;

  @override
  void dispose() {
    _scanner.dispose();
    super.dispose();
  }

  String get _deviceName => 'Huntaway ${switch (Platform.operatingSystem) {
        'android' => 'Android',
        'ios' => 'iOS',
        'macos' => 'macOS',
        final os => os,
      }}';

  Future<void> _pair(String raw) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = 'Connexion à la machine…';
    });
    try {
      final payload = PairingPayload.parse(raw);
      setState(() => _status = 'Appairage avec ${payload.machineName}…');
      final machine = await pair(payload, _deviceName);
      if (!mounted) return;
      await AppScope.of(context).addMachine(machine);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${machine.name} ajoutée')));
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = null;
      });
      showError(context, e);
    }
  }

  Future<void> _paste() async {
    final controller = TextEditingController();
    final raw = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Saisie manuelle'),
        content: TextField(
          controller: controller,
          maxLines: 5,
          decoration: const InputDecoration(hintText: 'Colle le JSON affiché par `huntawayd pair`'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annuler')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Appairer')),
        ],
      ),
    );
    if (raw != null && raw.trim().isNotEmpty) await _pair(raw);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Ajouter une machine')),
      body: Column(children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 4, 20, 12),
          child: Text(
            'Sur la machine, lance `huntawayd pair` puis scanne le QR code. '
            'Le téléphone doit pouvoir joindre la machine (Tailscale ou réseau local).',
            style: TextStyle(color: HuntawayColors.muted),
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(20),
              child: Stack(fit: StackFit.expand, children: [
                MobileScanner(
                  controller: _scanner,
                  onDetect: (capture) {
                    final raw = capture.barcodes.firstOrNull?.rawValue;
                    if (raw != null) _pair(raw);
                  },
                  errorBuilder: (context, error) => Container(
                    color: HuntawayColors.surface,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.all(24),
                    child: const Text(
                      'Caméra indisponible. Utilise la saisie manuelle.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: HuntawayColors.muted),
                    ),
                  ),
                ),
                if (_busy)
                  Container(
                    color: Colors.black54,
                    alignment: Alignment.center,
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      const CircularProgressIndicator(),
                      const SizedBox(height: 12),
                      Text(_status ?? ''),
                    ]),
                  ),
              ]),
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: OutlinedButton.icon(
              onPressed: _busy ? null : _paste,
              icon: const Icon(Icons.content_paste),
              label: const Text('Saisie manuelle'),
            ),
          ),
        ),
      ]),
    );
  }
}
