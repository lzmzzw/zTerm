// Author: Liz
import type { ServerInfoSnapshot } from "./serverInfoApi";

interface NetworkTrafficSample {
  captured_at_ms?: number;
  received_at_ms: number;
  snapshot: ServerInfoSnapshot;
}

interface NetworkInterfaceTraffic {
  name: string;
  rx_bytes?: number | null;
  rx_bytes_per_second?: number;
  tx_bytes?: number | null;
  tx_bytes_per_second?: number;
}

export interface NetworkTrafficSnapshot {
  interfaces: NetworkInterfaceTraffic[];
  sample_duration_ms?: number;
  top_interface?: NetworkInterfaceTraffic;
  total_rx_bytes_per_second?: number;
  total_tx_bytes_per_second?: number;
}

const serverInfoNetworkSampleCache = new Map<string, NetworkTrafficSample>();
const serverInfoNetworkRateCache = new Map<string, NetworkTrafficSnapshot>();

export function clearServerInfoMetricsCacheForTest() {
  serverInfoNetworkSampleCache.clear();
  serverInfoNetworkRateCache.clear();
}

export function updateNetworkTrafficCache(targetKey: string, snapshot: ServerInfoSnapshot) {
  const received_at_ms = Date.now();
  const captured_at_ms = capturedAtMilliseconds(snapshot);
  const previous = serverInfoNetworkSampleCache.get(targetKey);
  const sample_duration_ms =
    captured_at_ms !== undefined && previous?.captured_at_ms !== undefined && captured_at_ms > previous.captured_at_ms
      ? captured_at_ms - previous.captured_at_ms
      : previous && received_at_ms > previous.received_at_ms
        ? received_at_ms - previous.received_at_ms
        : undefined;
  const traffic = networkTrafficFromSnapshot(snapshot, previous?.snapshot, sample_duration_ms);
  serverInfoNetworkSampleCache.set(targetKey, { captured_at_ms, received_at_ms, snapshot });
  serverInfoNetworkRateCache.set(targetKey, traffic);
  return traffic;
}

export function cachedNetworkTraffic(targetKey: string, snapshot?: ServerInfoSnapshot | null) {
  return serverInfoNetworkRateCache.get(targetKey) ?? (snapshot ? networkTrafficFromSnapshot(snapshot) : null);
}

function networkTrafficFromSnapshot(
  snapshot: ServerInfoSnapshot,
  previousSnapshot?: ServerInfoSnapshot,
  sampleDurationMs?: number,
): NetworkTrafficSnapshot {
  const previous = new Map((previousSnapshot?.network_interfaces ?? []).map((item) => [item.name, item]));
  const seconds = sampleDurationMs && sampleDurationMs > 0 ? sampleDurationMs / 1000 : undefined;
  const interfaces = [...snapshot.network_interfaces]
    .map((item) => ({
      name: item.name,
      rx_bytes: item.rx_bytes,
      rx_bytes_per_second: bytesPerSecond(item.rx_bytes, previous.get(item.name)?.rx_bytes, seconds),
      tx_bytes: item.tx_bytes,
      tx_bytes_per_second: bytesPerSecond(item.tx_bytes, previous.get(item.name)?.tx_bytes, seconds),
    }))
    .sort((left, right) => trafficScore(right) - trafficScore(left));
  const traffic = {
    interfaces,
    sample_duration_ms: seconds ? sampleDurationMs : undefined,
    top_interface: interfaces[0],
    total_rx_bytes_per_second:
      bytesPerSecond(snapshot.network_rx_bytes, previousSnapshot?.network_rx_bytes, seconds) ??
      sumKnown(interfaces.map((item) => item.rx_bytes_per_second)),
    total_tx_bytes_per_second:
      bytesPerSecond(snapshot.network_tx_bytes, previousSnapshot?.network_tx_bytes, seconds) ??
      sumKnown(interfaces.map((item) => item.tx_bytes_per_second)),
  };
  return traffic;
}

function capturedAtMilliseconds(snapshot: ServerInfoSnapshot) {
  const seconds = Number(snapshot.captured_at);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function bytesPerSecond(current?: number | null, previous?: number | null, seconds?: number) {
  if (current == null || previous == null || seconds == null || seconds <= 0) return undefined;
  const delta = current - previous;
  return delta >= 0 ? delta / seconds : undefined;
}

function sumKnown(values: Array<number | undefined>) {
  const known = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : undefined;
}

function trafficScore(item: NetworkInterfaceTraffic) {
  return (item.rx_bytes_per_second ?? item.rx_bytes ?? 0) + (item.tx_bytes_per_second ?? item.tx_bytes ?? 0);
}
