import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:unifiedpush/unifiedpush.dart';

import 'models.dart';

/// Local notifications + UnifiedPush (PRD §12).
///
/// While the app runs, notifications arrive on the WebSocket. When it is
/// closed, the bridge posts to the UnifiedPush endpoint (ntfy or another
/// distributor) and Android starts us in the background to show them.
class Notifier {
  Notifier._();
  static final instance = Notifier._();

  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  /// Called with "machineId|agentId" when a notification is tapped.
  void Function(String machineId, String agentId)? onOpen;

  /// Called when UnifiedPush gives us a new endpoint to send to the bridges.
  void Function(String? endpoint)? onEndpoint;

  String? endpoint;
  String? distributor;

  static const _hideKey = 'huntaway.hide_lockscreen_content';
  final _storage = secureStorage;

  /// Hide title and text on a secure lock screen (PRD §12.4).
  bool hideOnLockScreen = false;

  AndroidNotificationDetails get _channel => AndroidNotificationDetails(
        'agents',
        'Agents',
        channelDescription: 'Agents that are blocked or done',
        importance: Importance.high,
        priority: Priority.high,
        visibility: hideOnLockScreen ? NotificationVisibility.private : NotificationVisibility.public,
        color: const Color(0xFFE39B4B),
      );

  Future<void> setHideOnLockScreen(bool value) async {
    hideOnLockScreen = value;
    await _storage.write(key: _hideKey, value: value ? '1' : '0');
  }

  Future<void> init() async {
    if (_ready) return;
    _ready = true;
    try {
      hideOnLockScreen = await _storage.read(key: _hideKey) == '1';
    } catch (_) {}
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@drawable/ic_stat_huntaway'),
        // Permission is asked after pairing (requestPermission), not at launch.
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
        macOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (r) {
        final parts = (r.payload ?? '').split('|');
        if (parts.length == 2) onOpen?.call(parts[0], parts[1]);
      },
    );
  }

  Future<String?> launchPayload() async {
    final details = await _plugin.getNotificationAppLaunchDetails();
    return details?.didNotificationLaunchApp == true ? details?.notificationResponse?.payload : null;
  }

  /// Off in automated runs, where nobody can answer a system dialog.
  bool askPermission = true;

  Future<void> requestPermission() async {
    if (!askPermission) return;
    await _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();
    await _plugin
        .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()
        ?.requestPermissions(alert: true, sound: true);
    await _plugin
        .resolvePlatformSpecificImplementation<MacOSFlutterLocalNotificationsPlugin>()
        ?.requestPermissions(alert: true, sound: true);
  }

  Future<void> show(AgentNotification n) async {
    await init();
    await _plugin.show(
      id: '${n.machineId}/${n.agentId}'.hashCode & 0x7fffffff,
      title: n.title,
      body: n.body,
      notificationDetails: NotificationDetails(
        android: _channel,
        iOS: const DarwinNotificationDetails(),
        macOS: const DarwinNotificationDetails(),
      ),
      payload: '${n.machineId}|${n.agentId}',
    );
  }

  // ------------------------------------------------------------ UnifiedPush

  bool get pushSupported => !kIsWeb && Platform.isAndroid;

  Future<void> initPush() async {
    if (!pushSupported) return;
    await UnifiedPush.initialize(
      onNewEndpoint: (e, _) {
        endpoint = e.url;
        onEndpoint?.call(e.url);
      },
      onUnregistered: (_) {
        endpoint = null;
        onEndpoint?.call(null);
      },
      onMessage: (message, _) => _onPush(message.content),
    );
    distributor = await UnifiedPush.getDistributor();
    if (distributor != null) await UnifiedPush.register();
  }

  /// Distributors installed on the phone (ntfy…).
  Future<List<String>> distributors() async => pushSupported ? UnifiedPush.getDistributors() : [];

  Future<void> useDistributor(String id) async {
    await UnifiedPush.saveDistributor(id);
    distributor = id;
    await UnifiedPush.register();
  }

  Future<void> disablePush() async {
    if (!pushSupported) return;
    await UnifiedPush.unregister();
    distributor = null;
    endpoint = null;
    onEndpoint?.call(null);
  }

  Future<void> _onPush(Uint8List content) async {
    try {
      final j = jsonDecode(utf8.decode(content)) as Map<String, dynamic>;
      await show(AgentNotification(
        j['machine_id'] as String? ?? '',
        j['agent_id'] as String? ?? '',
        j['kind'] as String? ?? '',
        j['title'] as String? ?? 'Huntaway',
        j['body'] as String? ?? '',
      ));
    } catch (_) {
      // Not a Huntaway payload: ignore.
    }
  }
}
