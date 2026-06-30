// Author: Liz
import { formatBytes } from "../../lib/byteFormatters";
import type { ServerInfoSnapshot } from "./serverInfoApi";

export { formatBytes };

type ServerGpuInfo = ServerInfoSnapshot["gpus"][number];

export function percentOf(used?: number | null, total?: number | null) {
  if (used == null || total == null || total <= 0) return undefined;
  return (used / total) * 100;
}

export function formatPercent(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)}%`;
}

export function formatTrafficRate(value?: number, emptyLabel = "-") {
  return value === undefined || Number.isNaN(value) ? emptyLabel : `${formatBytes(value)}/s`;
}

export function formatUptime(seconds?: number | null) {
  if (seconds == null || Number.isNaN(seconds)) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

export function formatLoadAverage(values?: number[] | null) {
  const list = Array.isArray(values) ? values.filter((item) => Number.isFinite(item)) : [];
  return list.length > 0 ? list.map((item) => item.toFixed(2)).join(" / ") : undefined;
}

export function formatTimestamp(value?: string | null) {
  if (!value) return "-";
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return value;
  return new Date(seconds * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

export function joinDefined(parts: Array<string | null | undefined>) {
  const values = parts.filter(Boolean);
  return values.length > 0 ? values.join(" · ") : undefined;
}

export function gpuMemoryLabel(gpu: ServerGpuInfo) {
  if (gpu.memory_used_bytes != null) return `${formatBytes(gpu.memory_used_bytes)} / ${formatBytes(gpu.memory_total_bytes)}`;
  if (gpu.memory_total_bytes != null) return `总计 ${formatBytes(gpu.memory_total_bytes)}`;
  return "-";
}

export function gpuMissingMessage(status?: string | null) {
  if (status === "nvidia_smi_no_devices") return "nvidia-smi 未返回可用 NVIDIA GPU。";
  if (status === "lspci_no_devices") return "lspci 未发现显卡设备。";
  if (status === "lspci") return "仅通过 lspci 静态识别，无法采集显存和温度。";
  if (status === "no_probe_command") return "远端没有 nvidia-smi 或 lspci，无法识别 GPU。";
  return "远端未返回 GPU 数据。";
}

export function primaryGpuValue(gpus: ServerGpuInfo[]) {
  const usage = gpus.find((gpu) => gpu.utilization_percent != null)?.utilization_percent;
  if (usage != null) return formatPercent(usage);
  const memoryGpu = gpus.find((gpu) => percentOf(gpu.memory_used_bytes, gpu.memory_total_bytes) !== undefined);
  const memory = memoryGpu ? percentOf(memoryGpu.memory_used_bytes, memoryGpu.memory_total_bytes) : undefined;
  return memory !== undefined ? formatPercent(memory) : `${gpus.length} 张`;
}
