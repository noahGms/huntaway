import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// When each agent's conversation was last on screen on this phone: a turn
/// that ended after that is unread.
class SeenStore {
  SeenStore({Future<Directory> Function()? directory}) : _directory = directory ?? getApplicationSupportDirectory;

  /// Agents remembered; the oldest views are forgotten past this.
  static const keep = 300;
  final Future<Directory> Function() _directory;
  final _seen = <String, DateTime>{};
  Future<void> _writing = Future.value();

  DateTime? operator [](String key) => _seen[key];

  Future<File> get _file async => File('${(await _directory()).path}/seen.json');

  Future<void> load() async {
    try {
      final file = await _file;
      if (!await file.exists()) return;
      final j = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      for (final e in j.entries) {
        final t = DateTime.tryParse(e.value as String? ?? '');
        if (t != null) _seen[e.key] = t;
      }
    } catch (_) {}
  }

  /// Records [at] for [key]; false when it was already known.
  bool mark(String key, DateTime at) {
    if (_seen[key] == at) return false;
    // Re-inserted last: the first keys are the oldest views.
    _seen.remove(key);
    _seen[key] = at;
    while (_seen.length > keep) {
      _seen.remove(_seen.keys.first);
    }
    // One write at a time, in order.
    final snapshot = jsonEncode({for (final e in _seen.entries) e.key: e.value.toIso8601String()});
    _writing = _writing.then((_) async {
      try {
        await (await _file).writeAsString(snapshot);
      } catch (_) {}
    });
    return true;
  }
}
