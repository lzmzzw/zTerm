// Author: Liz
import { Bot, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { ZtInlineError } from "../../components/ZtUi";
import { XtermPane } from "../terminal/XtermPane";
import { useTerminalStore } from "../terminal/terminalStore";
import type { McpApprovalMode, McpToolSecretInputs } from "./mcpStore";
import type { AgentCodexSession, AgentPendingInvocation } from "./agentCodexApi";

const EMPTY_LIVE_OUTPUT_CHUNKS: never[] = [];

export function AgentCodexPanel({
  session,
  active = true,
  activeTargetLabel,
  loading,
  error,
  approvalMode,
  pendingInvocations,
  onApprovalModeChange,
  onClose,
  onConfirmTool,
  onRestart,
}: {
  session: AgentCodexSession | null;
  active?: boolean;
  activeTargetLabel?: string | null;
  loading: boolean;
  error: string | null;
  approvalMode: McpApprovalMode;
  pendingInvocations: AgentPendingInvocation[];
  onApprovalModeChange: (mode: McpApprovalMode) => Promise<unknown> | unknown;
  onClose: () => Promise<unknown> | unknown;
  onConfirmTool: (invocationId: string, approved: boolean, secretInputs?: McpToolSecretInputs) => Promise<unknown> | unknown;
  onRestart: () => Promise<unknown> | unknown;
}) {
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const runtimeSessionId = session?.runtime.runtime_session_id ?? null;
  const outputChunks = useTerminalStore((state) =>
    runtimeSessionId ? (state.outputChunks[runtimeSessionId] ?? EMPTY_LIVE_OUTPUT_CHUNKS) : EMPTY_LIVE_OUTPUT_CHUNKS,
  );
  const discardLiveOutputChunks = useTerminalStore((state) => state.discardLiveOutputChunks);
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const resizeTerminal = useTerminalStore((state) => state.resizeTerminal);
  const initialOutput = useMemo(
    () => (runtimeSessionId ? useTerminalStore.getState().getOutputTail(runtimeSessionId) : ""),
    [runtimeSessionId],
  );

  useEffect(() => {
    if (!runtimeSessionId) return undefined;
    return useTerminalStore.getState().beginLiveOutput(runtimeSessionId);
  }, [runtimeSessionId]);

  return (
    <div className="zt-agent-codex-panel">
      <header className="zt-agent-codex-header">
        <div className="zt-agent-codex-target">
          <Bot size={16} aria-hidden="true" />
          <div>
            <strong>Codex CLI</strong>
            <span>所属连接：{session?.target_label ?? "未连接"}</span>
            {activeTargetLabel ? <span>当前终端：{activeTargetLabel}</span> : null}
          </div>
        </div>
        <label className={`zt-ai-approval-mode mode-${approvalMode}`}>
          <ShieldCheck size={14} aria-hidden="true" />
          <ZtSelect
            ariaLabel="审批模式"
            className={`zt-ai-approval-select mode-${approvalMode}`}
            value={approvalMode}
            options={approvalOptions}
            onChange={(value) => void onApprovalModeChange(value as McpApprovalMode)}
          />
        </label>
      </header>

      {pendingInvocations.length > 0 ? (
        <div className="zt-agent-codex-approvals" aria-label="待审批操作">
          {pendingInvocations.map((invocation) => (
            <section key={invocation.id} className={`zt-ai-tool-card risk-${invocation.risk_level}`}>
              <strong>{invocation.tool_id}</strong>
              <div className="zt-ai-tool-summary">
                {invocation.target_summary ? (
                  <p><span>目标</span><strong>{invocation.target_summary}</strong></p>
                ) : null}
                <p><span>参数</span><code>{invocation.arguments_summary}</code></p>
              </div>
              <span>{invocation.risk_summary || invocation.reason || "Codex 请求操作当前终端"}</span>
              {invocation.requires_secret_input ? (
                <label className="zt-ai-tool-secret">
                  <span>{invocation.secret_input_label || "本次操作所需密码"}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    aria-required="true"
                    value={secretInputs[invocation.id] ?? ""}
                    onChange={(event) =>
                      setSecretInputs((current) => ({ ...current, [invocation.id]: event.currentTarget.value }))
                    }
                  />
                </label>
              ) : null}
              <footer>
                <button
                  type="button"
                  disabled={Boolean(invocation.requires_secret_input) && !secretInputs[invocation.id]?.trim()}
                  onClick={() =>
                    void onConfirmTool(
                      invocation.id,
                      true,
                      invocation.requires_secret_input ? { password: secretInputs[invocation.id] } : undefined,
                    )
                  }
                >批准</button>
                <button type="button" onClick={() => void onConfirmTool(invocation.id, false)}>拒绝</button>
              </footer>
            </section>
          ))}
        </div>
      ) : null}

      {session && runtimeSessionId && loading ? (
        <div className="zt-agent-codex-state"><LoaderCircle className="zt-spin" size={18} />正在启动本机 Codex CLI...</div>
      ) : null}
      {session && runtimeSessionId && error ? (
        <div className="zt-agent-codex-state is-error">
          <ZtInlineError>{error}</ZtInlineError>
        </div>
      ) : null}

      <div className="zt-agent-codex-terminal">
        {session && runtimeSessionId ? (
          <XtermPane
            autoFocus={active}
            contextMenuEnabled
            contextMenuClearEnabled={false}
            contextMenuSearchEnabled={false}
            data={initialOutput}
            replayKind="raw"
            replayKey={runtimeSessionId}
            streamId={runtimeSessionId}
            liveChunks={outputChunks}
            onLiveChunksQueued={(throughSerial) => discardLiveOutputChunks(runtimeSessionId, throughSerial)}
            onInput={(data) => void writeTerminal(runtimeSessionId, data)}
            onCloseTerminal={() => void onClose()}
            onResize={(cols, rows) => void resizeTerminal(runtimeSessionId, cols, rows)}
            onRestart={() => void onRestart()}
          />
        ) : loading ? (
          <div className="zt-agent-codex-state"><LoaderCircle className="zt-spin" size={18} />正在启动本机 Codex CLI...</div>
        ) : error ? (
          <div className="zt-agent-codex-state is-error">
            <ZtInlineError>{error}</ZtInlineError>
          </div>
        ) : (
          <div className="zt-agent-codex-state">请先打开一个可操作的终端标签页。</div>
        )}
      </div>
    </div>
  );
}

const approvalOptions = [
  { value: "request_approval", label: "每次批准" },
  { value: "safe", label: "高效审批" },
  { value: "full_access", label: "完全自动" },
];
