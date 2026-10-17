import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'models.dart';

/// Last items of each conversation, kept on the phone so an agent screen
/// opens instantly (and offline) before the bridge answers.
class TimelineCache {
  TimelineCache({Future<Directory> Function()? directory}) : _directory = directory ?? getApplicationSupportDirectory;

  static const keep = 200;
  final Future<Directory> Function() _directory;
  final _pending = <String, Timer>{};

  Future<File> _file(String machineId, String agentId) async {
    final dir = Directory('${(await _directory()).path}/timelines');
    await dir.create(recursive: true);
    final name = base64Url.encode(utf8.encode('$machineId/$agentId')).replaceAll('=', '');
    return File('${dir.path}/$name.json');
  }

  /// Cached items, empty when absent or written for another agent instance.
  Future<List<TimelineItem>> read(String machineId, String agentId, String instanceId) async {
    try {
      final file = await _file(machineId, agentId);
      if (!await file.exists()) return [];
      final j = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      if (j['instance_id'] != instanceId) return [];
      return [for (final i in j['items'] as List) TimelineItem.fromJson((i as Map).cast<String, dynamic>())];
    } catch (_) {
      return [];
    }
  }

  /// Writes the last [keep] items, at most every 2 seconds per agent.
  void schedule(String machineId, String agentId, String instanceId, List<TimelineItem> items) {
    final key = '$machineId/$agentId';
    _pending[key]?.cancel();
    final snapshot = items.length > keep ? items.sublist(items.length - keep) : List.of(items);
    _pending[key] = Timer(const Duration(seconds: 2), () async {
      _pending.remove(key);
      try {
        final file = await _file(machineId, agentId);
        await file.writeAsString(jsonEncode({
          'instance_id': instanceId,
          'items': [for (final i in snapshot) i.data],
        }));
      } catch (_) {}
    });
  }

  Future<void> remove(String machineId) async {
    try {
      final dir = Directory('${(await _directory()).path}/timelines');
      if (!await dir.exists()) return;
      final prefix = base64Url.encode(utf8.encode('$machineId/')).replaceAll('=', '');
      // base64 of a shared prefix is only stable on whole 3-byte groups.
      final stable = prefix.substring(0, prefix.length - prefix.length % 4);
      await for (final f in dir.list()) {
        if (f.uri.pathSegments.last.startsWith(stable)) await f.delete();
      }
    } catch (_) {}
  }
}
