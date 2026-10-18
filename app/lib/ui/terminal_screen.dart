import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../models.dart';
import '../sync.dart';
import 'common.dart';

/// Read-only terminal (PRD §13.5): last lines of the pane with their colors,
/// rendered by a terminal emulator and refreshed every 2 seconds.
class TerminalScreen extends StatefulWidget {
  const TerminalScreen({super.key, required this.connection, required this.agent});
  final MachineConnection connection;
  final Agent agent;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  String _text = '';
  String _ansi = '';
  String? _error;
  final _terminal = Terminal(maxLines: 2000);
  bool _paused = false;
  Timer? _timer;
  final _input = TextEditingController();

  Future<void> _send({String? text, List<String> keys = const []}) async {
    try {
      await widget.connection.client.input(widget.agent.id, text: text, keys: keys);
      await Future.delayed(const Duration(milliseconds: 300));
      await _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _paused ? null : _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _input.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final r = await widget.connection.client.screen(widget.agent.id, lines: 300, ansi: true);
      if (!mounted) return;
      final ansi = r['ansi'] as String? ?? r['text'] as String? ?? '';
      if (ansi != _ansi) {
        // Repaint the whole screen: clear, home, then the colored snapshot.
        _terminal.write('\x1b[2J\x1b[3J\x1b[H${ansi.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')}');
      }
      setState(() {
        _text = r['text'] as String? ?? '';
        _ansi = ansi;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Terminal · ${widget.agent.displayName}'),
        actions: [
          IconButton(
            tooltip: _paused ? 'Resume' : 'Pause',
            icon: Icon(_paused ? Icons.play_arrow : Icons.pause),
            onPressed: () => setState(() => _paused = !_paused),
          ),
          IconButton(
            tooltip: 'Copy',
            icon: const Icon(Icons.copy),
            onPressed: () {
              Clipboard.setData(ClipboardData(text: _text));
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
            },
          ),
        ],
      ),
      body: Column(children: [
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Text(_error!, style: const TextStyle(color: HuntawayColors.error)),
          ),
        Expanded(
          child: TerminalView(
            _terminal,
            readOnly: true,
            autofocus: false,
            padding: const EdgeInsets.all(8),
            textStyle: const TerminalStyle(fontSize: 11.5),
            backgroundOpacity: 1,
          ),
        ),
        if (widget.connection.machine.can('agents.input')) _rawInput(),
      ]),
    );
  }

  /// Advanced raw input (PRD §14): text and keys sent as is to the pane.
  Widget _rawInput() {
    const keys = {'Enter': 'enter', 'Esc': 'esc', '↑': 'up', '↓': 'down', 'Tab': 'tab', 'Ctrl+C': 'ctrl+c'};
    return SafeArea(
      top: false,
      child: Container(
        color: HuntawayColors.surface,
        padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              for (final MapEntry(:key, :value) in keys.entries)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ActionChip(label: Text(key), onPressed: () => _send(keys: [value])),
                ),
            ]),
          ),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _input,
                style: const TextStyle(fontFamily: monoFont),
                decoration: const InputDecoration(hintText: 'Raw input (text + Enter)'),
                onSubmitted: (t) {
                  _send(text: t, keys: ['enter']);
                  _input.clear();
                },
              ),
            ),
            IconButton(
              icon: const Icon(Icons.keyboard_return),
              tooltip: 'Send with Enter',
              onPressed: () {
                _send(text: _input.text, keys: ['enter']);
                _input.clear();
              },
            ),
          ]),
        ]),
      ),
    );
  }
}
