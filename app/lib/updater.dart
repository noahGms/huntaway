import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'models.dart';

/// Latest Android release, as described by `android.json` in its assets.
class UpdateInfo {
  UpdateInfo(this.version, this.versionCode, this.url, this.sha256);
  final String version;
  final int versionCode;
  final String url;
  final String sha256;

  static UpdateInfo parse(Map<String, dynamic> j) => UpdateInfo(
        j['version'] as String,
        (j['version_code'] as num).toInt(),
        j['url'] as String,
        (j['sha256'] as String).toLowerCase(),
      );
}

/// Self-update without a store (Android): checks the latest GitHub release
/// at launch and at most every 6 hours, downloads the APK into app storage,
/// verifies its SHA-256, then opens the system installer.
class Updater extends ChangeNotifier {
  Updater._();
  static final instance = Updater._();

  static const manifestUrl = 'https://github.com/noahGms/huntaway/releases/latest/download/android.json';
  static const _channel = MethodChannel('app.huntaway/update');
  static const _checkedKey = 'huntaway.update.checked_at';
  static const _dismissedKey = 'huntaway.update.dismissed';
  static const interval = Duration(hours: 6);

  bool get supported => !kIsWeb && Platform.isAndroid;

  /// Installed version, e.g. "0.1.1", and build number (Android versionCode).
  String? version;
  int build = 0;
  String? _dir;

  UpdateInfo? available;
  bool checking = false;

  /// Download progress (0..1), null when not downloading.
  double? progress;
  String? error;

  /// The user said "Later" to [available].
  bool dismissed = false;

  /// Downloaded and verified, waiting for the "install unknown apps" grant.
  String? _pendingInstall;

  Future<void> init() async {
    if (!supported || version != null) return;
    try {
      final info = (await _channel.invokeMapMethod<String, dynamic>('info'))!;
      version = info['version'] as String;
      build = (info['build'] as num).toInt();
      _dir = info['dir'] as String;
      notifyListeners();
    } catch (_) {}
  }

  /// Fetches the latest release description. Without [force], at most once
  /// every [interval]. Returns the update, if newer than this build.
  Future<UpdateInfo?> check({bool force = false}) async {
    await init();
    if (!supported || version == null || checking) return available;
    if (!force) {
      // Local builds have their own numbering: only manual checks.
      if (kDebugMode) return available;
      final last = int.tryParse(await secureStorage.read(key: _checkedKey) ?? '');
      if (last != null && DateTime.now().millisecondsSinceEpoch - last < interval.inMilliseconds) return available;
    }
    checking = true;
    error = null;
    notifyListeners();
    try {
      final r = await http.get(Uri.parse(manifestUrl)).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) throw HttpException('Update check failed (${r.statusCode})');
      final info = UpdateInfo.parse((jsonDecode(r.body) as Map).cast<String, dynamic>());
      await secureStorage.write(key: _checkedKey, value: '${DateTime.now().millisecondsSinceEpoch}');
      available = info.versionCode > build ? info : null;
      if (available != null) dismissed = await secureStorage.read(key: _dismissedKey) == info.version && !force;
    } catch (e) {
      if (force) error = e is HttpException ? e.message : 'Could not check for updates';
    } finally {
      checking = false;
      notifyListeners();
    }
    return available;
  }

  Future<void> dismiss() async {
    dismissed = true;
    notifyListeners();
    final v = available?.version;
    if (v != null) await secureStorage.write(key: _dismissedKey, value: v);
  }

  /// Downloads [available], checks its SHA-256 and opens the installer.
  Future<void> downloadAndInstall() async {
    final info = available;
    final dir = _dir;
    if (info == null || dir == null || progress != null) return;
    progress = 0;
    error = null;
    notifyListeners();
    final client = http.Client();
    File? file;
    try {
      // Only the latest download is kept.
      await for (final old in Directory(dir).list()) {
        if (old is File) await old.delete();
      }
      file = File('$dir/huntaway-${info.version}.apk');
      final response = await client.send(http.Request('GET', Uri.parse(info.url)));
      if (response.statusCode != 200) throw HttpException('Download failed (${response.statusCode})');
      final total = response.contentLength ?? 0;
      final sink = file.openWrite();
      final hash = Sha256().newHashSink();
      var received = 0;
      var shown = 0.0;
      try {
        await for (final chunk in response.stream.timeout(const Duration(seconds: 30))) {
          sink.add(chunk);
          hash.add(chunk);
          received += chunk.length;
          final p = total > 0 ? received / total : 0.0;
          if (p - shown >= 0.01) {
            shown = p;
            progress = p;
            notifyListeners();
          }
        }
      } finally {
        await sink.close();
      }
      hash.close();
      final digest = (await hash.hash()).bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      if (digest != info.sha256) {
        await file.delete();
        throw const HttpException('The download is corrupted (checksum mismatch)');
      }
      progress = null;
      notifyListeners();
      await _install(file.path);
    } catch (e) {
      progress = null;
      error = e is HttpException ? e.message : 'Download failed';
      notifyListeners();
      if (file != null && await file.exists() && _pendingInstall != file.path) await file.delete();
    } finally {
      client.close();
    }
  }

  Future<void> _install(String path) async {
    final allowed = await _channel.invokeMethod<bool>('canInstall') ?? false;
    if (!allowed) {
      // Android asks once to allow installs from Huntaway; continue when
      // the user comes back (see [resumed]).
      _pendingInstall = path;
      await _channel.invokeMethod('openInstallSettings');
      return;
    }
    _pendingInstall = null;
    await _channel.invokeMethod('install', {'path': path});
  }

  /// App back on screen: finish an install waiting for the permission, and
  /// check again when the last check is old.
  Future<void> resumed() async {
    if (!supported) return;
    final pending = _pendingInstall;
    if (pending != null && await _channel.invokeMethod<bool>('canInstall') == true) {
      await _install(pending);
    }
    await check();
  }
}
