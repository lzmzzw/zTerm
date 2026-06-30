// Author: Liz
import { useCallback, useEffect, useRef, useState } from "react";

import { getServerInfoSnapshot, type ServerInfoSnapshot } from "./serverInfoApi";
import {
  cachedNetworkTraffic,
  clearServerInfoMetricsCacheForTest,
  type NetworkTrafficSnapshot,
  updateNetworkTrafficCache,
} from "./serverInfoMetricsModel";
import { stringifiedErrorMessage } from "../../lib/unknownErrorMessage";

const snapshotCache = new Map<string, ServerInfoSnapshot>();
const inFlight = new Map<string, Promise<ServerInfoSnapshot>>();

export function clearServerInfoSnapshotCacheForTest() {
  snapshotCache.clear();
  inFlight.clear();
  clearServerInfoMetricsCacheForTest();
}

export function useServerInfoSnapshot(savedSessionId: string | null, active: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(3000);
  const [snapshot, setSnapshot] = useState<ServerInfoSnapshot | null>(() =>
    savedSessionId ? (snapshotCache.get(savedSessionId) ?? null) : null,
  );
  const [networkTraffic, setNetworkTraffic] = useState<NetworkTrafficSnapshot | null>(() =>
    savedSessionId ? cachedNetworkTraffic(savedSessionId, snapshotCache.get(savedSessionId)) : null,
  );
  const requestIdRef = useRef(0);
  const loadingRef = useRef(false);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!savedSessionId || !active) {
        requestIdRef.current += 1;
        setLoading(false);
        return;
      }
      if (loadingRef.current) return;
      const cached = snapshotCache.get(savedSessionId);
      if (cached && !options?.force) {
        setSnapshot(cached);
        setNetworkTraffic(cachedNetworkTraffic(savedSessionId, cached));
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        let request = inFlight.get(savedSessionId);
        if (!request) {
          request = getServerInfoSnapshot(savedSessionId).finally(() => inFlight.delete(savedSessionId));
          inFlight.set(savedSessionId, request);
        }
        const next = await request;
        if (requestIdRef.current === requestId) {
          snapshotCache.set(savedSessionId, next);
          setSnapshot(next);
          setNetworkTraffic(updateNetworkTrafficCache(savedSessionId, next));
        }
      } catch (nextError) {
        if (requestIdRef.current === requestId) {
          setError(stringifiedErrorMessage(nextError));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [active, savedSessionId],
  );

  useEffect(() => {
    setError(null);
    if (!savedSessionId || !active) {
      setSnapshot(null);
      setNetworkTraffic(null);
      setLoading(false);
      return;
    }
    const cached = snapshotCache.get(savedSessionId) ?? null;
    setSnapshot(cached);
    setNetworkTraffic(cachedNetworkTraffic(savedSessionId, cached));
    if (!cached) void refresh({ force: true });
    return () => {
      requestIdRef.current += 1;
      loadingRef.current = false;
    };
  }, [active, refresh, savedSessionId]);

  useEffect(() => {
    if (!savedSessionId || !active || refreshIntervalMs <= 0) return undefined;
    const timer = window.setInterval(() => void refresh({ force: true }), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [active, refresh, refreshIntervalMs, savedSessionId]);

  return {
    error,
    loading,
    networkTraffic,
    refresh,
    refreshIntervalMs,
    setRefreshIntervalMs,
    snapshot,
  };
}
