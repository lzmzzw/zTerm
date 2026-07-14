// Author: Liz
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import type { ServerInfoSnapshot } from "./serverInfoApi";
import { formatTimestamp, formatUptime, joinDefined } from "./serverInfoFormatters";
import type { NetworkTrafficSnapshot } from "./serverInfoMetricsModel";
import { ServerMetrics, type MetricCardId } from "./ServerMonitorMetrics";

export interface ServerMonitorTarget {
  kind: "local" | "ssh";
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
}

const serverInfoRefreshOptions = [
  { label: "手动", value: 0 },
  { label: "1s", value: 1000 },
  { label: "3s", value: 3000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
  { label: "60s", value: 60000 },
];

interface ServerMonitorPanelProps {
  active: boolean;
  target: ServerMonitorTarget | null;
  error: string | null;
  loading: boolean;
  networkTraffic: NetworkTrafficSnapshot | null;
  refreshIntervalMs: number;
  snapshot: ServerInfoSnapshot | null;
  onRefresh: (options?: { force?: boolean }) => Promise<unknown> | unknown;
  onRefreshIntervalChange: (value: number) => void;
}

export function ServerMonitorPanel({
  active: _active,
  target,
  error,
  loading,
  networkTraffic,
  refreshIntervalMs,
  snapshot,
  onRefresh,
  onRefreshIntervalChange,
}: ServerMonitorPanelProps) {
  const [expandedCards, setExpandedCards] = useState<Set<MetricCardId>>(() => new Set());

  function toggleCard(cardId: MetricCardId) {
    setExpandedCards((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  if (!target) {
    return <div className="zt-empty-line">当前连接暂不支持资源监控</div>;
  }

  return (
    <section className="zt-monitor-panel" aria-label="资源监控">
      <section className="zt-monitor-overview">
        <header>
          <div>
            <strong>{snapshot?.host_name ?? target.name}</strong>
            <span>{target.kind === "local" ? "本机资源" : `${target.username}@${target.host}:${target.port}`}</span>
          </div>
          <button
            type="button"
            aria-label="刷新服务器信息"
            title="刷新服务器信息"
            onClick={() => void onRefresh({ force: true })}
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? "zt-spin" : ""} />
          </button>
        </header>
        <div className="zt-monitor-overview-grid">
          <OverviewTile label="主机名" value={snapshot?.hostname ?? snapshot?.host_name} />
          <OverviewTile label="系统" value={joinDefined([snapshot?.os, snapshot?.architecture])} />
          <OverviewTile label="Kernel" value={snapshot?.kernel} />
          <OverviewTile label="运行时间" value={formatUptime(snapshot?.uptime_seconds)} />
        </div>
        <footer>
          <span>{snapshot ? `上次采集 ${formatTimestamp(snapshot.captured_at)}` : loading ? "正在读取服务器信息" : "等待首次采集"}</span>
          <label>
            采集间隔
            <ZtSelect
              ariaLabel="服务器信息采集间隔"
              value={String(refreshIntervalMs)}
              options={serverInfoRefreshOptions.map((option) => ({ value: String(option.value), label: option.label }))}
              onChange={(nextValue) => onRefreshIntervalChange(Number(nextValue))}
            />
          </label>
        </footer>
        {error ? <div className="zt-monitor-error">{error}</div> : null}
      </section>

      {loading && !snapshot ? <div className="zt-empty-line">正在读取服务器信息...</div> : null}
      {!loading && !snapshot && !error ? <div className="zt-empty-line">暂无服务器信息，点击刷新重新采集。</div> : null}
      {snapshot ? (
        <ServerMetrics
          expandedCards={expandedCards}
          networkTraffic={networkTraffic}
          onToggleMetric={toggleCard}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

function OverviewTile({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}
