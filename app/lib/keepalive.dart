import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'models.dart';

/// Fallback when no UnifiedPush distributor is installed (PRD §12.3): an
/// Android foreground service keeps the process, hence the WebSocket, alive
/// while the app is in the background. Stops with the app task.
class BackgroundLink {
  BackgroundLink._();
  static final instance = BackgroundLink._();

  static const _key = 'huntaway.keepalive';
  bool enabled = false;
  bool _initialized = false;

  bool get supported => !kIsWeb && Platform.isAndroid;

  Future<void> load() async {
    if (!supported) return;
    try {
      enabled = await secureStorage.read(key: _key) == '1';
    } catch (_) {}
  }

  Future<void> setEnabled(bool value) async {
    enabled = value;
    await secureStorage.write(key: _key, value: value ? '1' : '0');
    if (!value) await stop();
  }

  void _init() {
    if (_initialized) return;
    _initialized = true;
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'huntaway_link',
        channelName: 'Connexion Huntaway',
        channelDescription: 'Garde la connexion aux machines quand Huntaway est en arrière-plan',
      ),
      iosNotificationOptions: const IOSNotificationOptions(showNotification: false),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.nothing(),
        allowWifiLock: true,
        stopWithTask: true,
      ),
    );
  }

  /// App going to background: keep the connection if the fallback is on.
  Future<void> start() async {
    if (!supported || !enabled) return;
    _init();
    if (await FlutterForegroundTask.isRunningService) return;
    await FlutterForegroundTask.startService(
      serviceId: 7420,
      serviceTypes: const [ForegroundServiceTypes.remoteMessaging],
      notificationTitle: 'Huntaway surveille tes agents',
      notificationText: 'Connexion maintenue pour les alertes',
      notificationIcon: const NotificationIcon(metaDataName: 'app.huntaway.NOTIFICATION_ICON'),
      callback: keepAliveCallback,
    );
  }

  Future<void> stop() async {
    if (!supported) return;
    if (await FlutterForegroundTask.isRunningService) await FlutterForegroundTask.stopService();
  }
}

/// Entry point required by the plugin; the work happens in the main isolate.
@pragma('vm:entry-point')
void keepAliveCallback() => FlutterForegroundTask.setTaskHandler(_IdleHandler());

class _IdleHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {}
}
