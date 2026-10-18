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

  /// Last error, shown until the next attempt.
  String? _error;

  /// QR code that just failed: the camera keeps seeing it, don't retry it
  /// (and pile up errors) until the user asks.
  String? _rejected;

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
      _error = null;
      _status = 'Connecting to the machine…';
    });
    try {
      final payload = PairingPayload.parse(raw);
      setState(() => _status = 'Pairing with ${payload.machineName}…');
      final machine = await pair(payload, _deviceName);
      if (!mounted) return;
      await AppScope.of(context).addMachine(machine);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${machine.name} added')));
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = null;
        _rejected = raw;
        _error = errorMessage(e);
      });
    }
  }

  Future<void> _paste() async {
    final controller = TextEditingController();
    final raw = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Enter manually'),
        content: TextField(
          controller: controller,
          maxLines: 5,
          decoration: const InputDecoration(hintText: 'Paste the JSON printed by `huntawayd pair`'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Pair')),
        ],
      ),
    );
    if (raw != null && raw.trim().isNotEmpty) await _pair(raw);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add a machine')),
      body: Column(children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 4, 20, 12),
          child: Text(
            'On the machine, run `huntawayd pair`, then scan the QR code. '
            'The phone must be able to reach the machine (Tailscale or local network).',
            style: TextStyle(color: HuntawayColors.muted),
          ),
        ),
        if (_error != null)
          Container(
            margin: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            padding: const EdgeInsets.only(left: 12),
            decoration: BoxDecoration(
              color: HuntawayColors.error.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(children: [
              Expanded(child: Text(_error!, style: const TextStyle(color: HuntawayColors.error, fontSize: 13))),
              if (_rejected != null)
                TextButton(
                  onPressed: () {
                    final raw = _rejected!;
                    setState(() => _rejected = null);
                    _pair(raw);
                  },
                  child: const Text('Try again'),
                ),
            ]),
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
                    if (raw != null && raw != _rejected) _pair(raw);
                  },
                  errorBuilder: (context, error) => Container(
                    color: HuntawayColors.surface,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.all(24),
                    child: const Text(
                      'Camera unavailable. Enter the code manually.',
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
              label: const Text('Enter manually'),
            ),
          ),
        ),
      ]),
    );
  }
}
