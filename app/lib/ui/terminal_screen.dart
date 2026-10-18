import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';

import '../models.dart';
import '../sync.dart';
import 'common.dart';

/// Terminal (PRD §13.5): the pane with its colors, rendered by a terminal
/// emulator and streamed by the bridge over a WebSocket. Closed while paused
/// or in the background.
class TerminalScreen extends StatefulWidget {
  const TerminalScreen({super.key, required this.connection, required this.agent});
  final MachineConnection connection;
  final Agent agent;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> with WidgetsBindingObserver {
  String _text = '';
  String _ansi = '';
  String? _error;
  final _terminal = Terminal(maxLines: 2000);
  bool _paused = false;
  bool _background = false;
  final _input = TextEditingController();
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  Timer? _retry;
  int _attempt = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _open();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _close();
    _input.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _background = state != AppLifecycleState.resumed;
    _background ? _close() : _open();
  }

  bool get _live => !_paused && !_background && mounted;

  void _open() {
    if (!_live || _channel != null) return;
    _retry?.cancel();
    final channel = IOWebSocketChannel.connect(
      widget.connection.client.terminalUri(widget.agent.id),
      pingInterval: const Duration(seconds: 15),
      connectTimeout: const Duration(seconds: 8),
    );
    _channel = channel;
    _subscription = channel.stream.listen(
      (raw) => _onMessage(jsonDecode(raw as String) as Map<String, dynamic>),
      onError: (Object e) => _onClosed(e.toString()),
      onDone: () => _onClosed(null),
      cancelOnError: true,
    );
  }

  void _close() {
    _retry?.cancel();
    _subscription?.cancel();
    _subscription = null;
    _channel?.sink.close();
    _channel = null;
  }

  void _onMessage(Map<String, dynamic> m) {
    if (!mounted) return;
    _attempt = 0;
    switch (m['type']) {
      case 'screen':
        final ansi = m['ansi'] as String? ?? m['text'] as String? ?? '';
        if (ansi != _ansi) {
          // Repaint the whole screen: clear, home, then the colored snapshot.
          _terminal.write('\x1b[2J\x1b[3J\x1b[H${ansi.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')}');
        }
        setState(() {
          _text = m['text'] as String? ?? '';
          _ansi = ansi;
          _error = null;
        });
      case 'error':
        setState(() => _error = m['message'] as String? ?? 'Terminal error');
    }
  }

  /// Socket gone: reconnect with a backoff while the screen is live.
  void _onClosed(String? error) {
    _subscription = null;
    _channel = null;
    if (!_live) return;
    if (error != null) setState(() => _error = 'Connection lost, retrying…');
    final delay = Duration(seconds: min(30, 1 << min(_attempt++, 4)));
    _retry = Timer(delay, _open);
  }

  Future<void> _send({String? text, List<String> keys = const []}) async {
    final channel = _channel;
    if (channel != null) {
      channel.sink.add(jsonEncode({'text': ?text, 'keys': keys}));
      return;
    }
    try {
      await widget.connection.client.input(widget.agent.id, text: text, keys: keys);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  void _togglePause() {
    setState(() => _paused = !_paused);
    _paused ? _close() : _open();
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
            onPressed: _togglePause,
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
