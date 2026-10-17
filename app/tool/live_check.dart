// ignore_for_file: avoid_print
// Live check against a running huntawayd: pairs with the payload printed by
// `huntawayd pair --json`, then reads the state and a timeline.
// Usage: dart run tool/live_check.dart '<payload json>' [address override]
import 'dart:convert';

import 'package:huntaway/api.dart';

Future<void> main(List<String> args) async {
  final json = (jsonDecode(args[0]) as Map).cast<String, dynamic>();
  if (args.length > 1) json['addresses'] = [args[1]];
  final machine = await pair(PairingPayload.parse(jsonEncode(json)), 'live-check');
  print('appairé : ${machine.name} (${machine.deviceId}) via ${machine.addresses.first}');
  final client = BridgeClient(machine);
  final state = await client.state();
  final agents = state['agents'] as List;
  print('état : seq ${state['seq']} · ${agents.length} agents');
  if (agents.isNotEmpty) {
    final id = (agents.first as Map)['id'] as String;
    final (items, hasMore) = await client.timeline(id, limit: 5);
    print('timeline $id : ${items.length} items, has_more=$hasMore');
  }
  print('stream : ${client.streamUri(since: 1, epoch: 'e1')}');
  client.close();
}
