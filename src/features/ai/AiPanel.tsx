// Author: Liz
import { ArrowLeft, ArrowUp, ChevronDown, ChevronRight, History, Plus, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import { t } from "../settings/i18n";
import type { AppLanguage } from "../settings/settingsStore";
import type {
  AiApprovalMode,
  AiConversationMessage,
  AiConversationPreviewState,
  AiConversationSummary,
  AiTerminalContextSnapshot,
  AiToolSecretInputs,
  AiToolPendingInvocation,
} from "./aiStore";

interface AiPanelProps {
  activeRuntimeSessionId: string | null;
  activePaneId?: string | null;
  activePaneTitle?: string | null;
  activeSavedSessionId?: string | null;
  providersAvailable: boolean;
  recentOutput: string;
  loading: boolean;
  error: string | null;
  conversations?: AiConversationSummary[];
  conversationPreviews?: Record<string, AiConversationPreviewState>;
  activeConversationId?: string | null;
  approvalMode?: AiApprovalMode;
  messages?: AiConversationMessage[];
  contextSnapshot?: AiTerminalContextSnapshot | null;
  pendingInvocations?: AiToolPendingInvocation[];
  language?: AppLanguage;
  onSendChat?: (message: string) => Promise<unknown> | unknown;
  onCancelChat?: () => void;
  onApprovalModeChange?: (mode: AiApprovalMode) => Promise<unknown> | unknown;
  onSelectConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onLoadConversationPreview?: (conversationId: string) => Promise<unknown> | unknown;
  onNewConversation?: () => Promise<unknown> | unknown;
  onDeleteConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onConfirmTool?: (invocationId: string, approved: boolean, secretInputs?: AiToolSecretInputs) => Promise<unknown> | unknown;
}

export function AiPanel({
  activeRuntimeSessionId,
  activePaneId = null,
  activePaneTitle = null,
  activeSavedSessionId = null,
  providersAvailable,
  recentOutput: _recentOutput,
  loading,
  error,
  conversations = [],
  conversationPreviews = {},
  activeConversationId = null,
  approvalMode = "safe",
  messages = [],
  contextSnapshot = null,
  pendingInvocations = [],
  language = "zhCN",
  onSendChat,
  onCancelChat,
  onApprovalModeChange,
  onSelectConversation,
  onLoadConversationPreview,
  onNewConversation,
  onDeleteConversation,
  onConfirmTool,
}: AiPanelProps) {
  const [panelView, setPanelView] = useState<"current" | "history">("current");
  const [expandedConversationIds, setExpandedConversationIds] = useState<string[]>([]);
  const [chatPrompt, setChatPrompt] = useState("");
  const [toolSecretInputs, setToolSecretInputs] = useState<Record<string, string>>({});
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const promptId = useId();
  const canSendChat = providersAvailable && Boolean(chatPrompt.trim()) && !loading && Boolean(onSendChat);
  const canCancelChat = loading && Boolean(onCancelChat);
  const matchingSnapshotTitle =
    contextSnapshot?.runtime_session_id === activeRuntimeSessionId ? contextSnapshot.title?.trim() : null;
  const boundTarget = activeRuntimeSessionId
    ? matchingSnapshotTitle || activePaneTitle?.trim() || activeRuntimeSessionId
    : t(language, "unboundTerminal");
  const boundTargetTitle = activeRuntimeSessionId
    ? [
        boundTarget,
        activePaneId ? `pane=${activePaneId}` : null,
        `runtime=${activeRuntimeSessionId}`,
        activeSavedSessionId ? `session=${activeSavedSessionId}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : boundTarget;
  const historyConversations = conversations.filter((conversation) => conversation.id !== activeConversationId);

  useLayoutEffect(() => {
    if (panelView !== "current") return;
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;
    if (typeof messagesContainer.scrollTo === "function") {
      messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "auto" });
      return;
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }, [messages, panelView]);

  async function sendChat() {
    const message = chatPrompt.trim();
    if (!message || !onSendChat) return;
    setChatPrompt("");
    await onSendChat(message);
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void sendChat();
  }

  function createNewConversation() {
    void onNewConversation?.();
    setPanelView("current");
  }

  async function restoreConversation(conversationId: string) {
    await onSelectConversation?.(conversationId);
    setPanelView("current");
  }

  function toggleHistoryConversation(conversationId: string) {
    const isExpanded = expandedConversationIds.includes(conversationId);
    setExpandedConversationIds((current) =>
      isExpanded ? current.filter((id) => id !== conversationId) : [...current, conversationId],
    );
    if (!isExpanded) {
      void onLoadConversationPreview?.(conversationId);
    }
  }

  function updateToolSecretInput(invocationId: string, value: string) {
    setToolSecretInputs((current) => ({ ...current, [invocationId]: value }));
  }

  function confirmToolInvocation(invocation: AiToolPendingInvocation, approved: boolean) {
    const secret = toolSecretInputs[invocation.id]?.trim() ?? "";
    const secretInputs = invocation.requires_secret_input && approved
      ? invocation.tool_id === "sessions.save"
        ? { password: secret }
        : { api_key: secret }
      : undefined;
    if (secretInputs) {
      void onConfirmTool?.(invocation.id, approved, secretInputs);
    } else {
      void onConfirmTool?.(invocation.id, approved);
    }
    setToolSecretInputs((current) => {
      const next = { ...current };
      delete next[invocation.id];
      return next;
    });
  }

  function renderHistoryPreview(conversationId: string) {
    const preview = conversationPreviews[conversationId];
    if (!preview || preview.loading) {
      return <div className="zt-empty-line">{t(language, "loadingAiHistoryPreview")}</div>;
    }
    if (preview.error) {
      return <div className="zt-session-error">{preview.error}</div>;
    }
    const previewMessages = preview.messages?.slice(-4) ?? [];
    if (previewMessages.length === 0) {
      return <div className="zt-empty-line">{t(language, "noAiHistoryPreview")}</div>;
    }
    return previewMessages.map((message) => renderConversationMessage(message, language));
  }

  return (
    <section className="zt-ai-panel" aria-label="AI 操作台">
      <header className={`zt-ai-bound-target${activeRuntimeSessionId ? "" : " is-unbound"}`} aria-label="当前绑定窗格">
        <div>
          <strong title={boundTargetTitle}>{boundTarget}</strong>
        </div>
        <div className="zt-ai-toolbar" aria-label={panelView === "history" ? t(language, "aiHistory") : t(language, "currentConversation")}>
          {panelView === "history" ? (
            <button
              type="button"
              aria-label={t(language, "backToCurrentConversation")}
              title={t(language, "backToCurrentConversation")}
              onClick={() => setPanelView("current")}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          ) : null}
          {onNewConversation ? (
            <button type="button" aria-label={t(language, "newConversation")} title={t(language, "newConversation")} onClick={createNewConversation}>
              <Plus size={15} aria-hidden="true" />
            </button>
          ) : null}
          {panelView === "current" ? (
            <button
              type="button"
              aria-label={t(language, "aiHistory")}
              title={t(language, "aiHistory")}
              onClick={() => setPanelView("history")}
            >
              <History size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {panelView === "history" ? (
        <div className="zt-ai-history-view" aria-label={t(language, "aiHistory")}>
          {pendingInvocations.length > 0 ? (
            <div className="zt-ai-history-tools-notice">
              {t(language, "aiHistoryPendingToolsNotice", { count: pendingInvocations.length })}
            </div>
          ) : null}
          {error ? <div className="zt-session-error">{error}</div> : null}
          {historyConversations.length === 0 ? <div className="zt-empty-line">{t(language, "noAiConversations")}</div> : null}
          {historyConversations.map((conversation) => {
            const expanded = expandedConversationIds.includes(conversation.id);
            return (
              <article className="zt-ai-history-row" key={conversation.id}>
                <div className="zt-ai-history-row-header">
                  <button
                    type="button"
                    className="zt-ai-history-toggle"
                    aria-label={t(language, expanded ? "collapseAiConversation" : "expandAiConversation", { title: conversation.title })}
                    aria-expanded={expanded}
                    title={t(language, expanded ? "collapseAiConversation" : "expandAiConversation", { title: conversation.title })}
                    onClick={() => toggleHistoryConversation(conversation.id)}
                    onDoubleClick={() => void restoreConversation(conversation.id)}
                  >
                    <span className="zt-ai-history-title">{conversation.title}</span>
                    <time className="zt-ai-history-time" dateTime={new Date(conversation.updated_at_ms).toISOString()}>
                      {formatConversationTime(conversation.updated_at_ms)}
                    </time>
                    {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  </button>
                  {onDeleteConversation ? (
                    <button
                      type="button"
                      className="zt-ai-conversation-delete"
                      aria-label={t(language, "deleteAiConversationTitle", { title: conversation.title })}
                      title={t(language, "deleteAiConversationTitle", { title: conversation.title })}
                      disabled={loading}
                      onClick={() => void onDeleteConversation(conversation.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                {expanded ? <div className="zt-ai-history-preview">{renderHistoryPreview(conversation.id)}</div> : null}
              </article>
            );
          })}
        </div>
      ) : (
        <>
          <div className="zt-ai-messages" aria-label="AI 会话消息" ref={messagesContainerRef}>
            {messages.length === 0 ? <div className="zt-empty-line">{t(language, "noAiMessages")}</div> : null}
            {messages.map((message) => renderConversationMessage(message, language))}
          </div>

          {pendingInvocations.length > 0 ? (
            <div className="zt-ai-tools" aria-label="AI 工具调用">
              {pendingInvocations.map((invocation) => {
                const toolSummary = summarizeToolInvocation(invocation, language);
                return (
                  <section className={`zt-ai-tool-card risk-${invocation.risk_level}`} title={toolSummary.rawDetails} key={invocation.id}>
                    <header>
                      <strong>{invocation.tool_title}</strong>
                      <span>{riskLabel(invocation.risk_level, language)}</span>
                    </header>
                    <div className="zt-ai-tool-summary">
                      <p>
                        <span>{t(language, "aiToolConnection")}：</span>
                        <strong>{toolSummary.connection}</strong>
                      </p>
                      <p>
                        <span>{t(language, "aiToolOperation")}：</span>
                        <strong>{toolSummary.operation}</strong>
                      </p>
                      <p>
                        <span>{toolSummary.detailLabel}：</span>
                        <code>{toolSummary.detail}</code>
                      </p>
                    </div>
                    {invocation.risk_summary ? <small className="zt-ai-tool-risk-note">{invocation.risk_summary}</small> : null}
                    {invocation.requires_secret_input ? (
                      <label className="zt-ai-tool-secret">
                        <span>{invocation.secret_input_label || t(language, "aiToolSecretInput")}</span>
                        <input
                          type="password"
                          autoComplete="off"
                          value={toolSecretInputs[invocation.id] ?? ""}
                          placeholder={t(language, "aiToolSecretRequired")}
                          aria-label={invocation.secret_input_label || t(language, "aiToolSecretInput")}
                          disabled={loading}
                          onChange={(event) => updateToolSecretInput(invocation.id, event.currentTarget.value)}
                        />
                      </label>
                    ) : null}
                    <footer>
                      <button
                        type="button"
                        disabled={loading || (Boolean(invocation.requires_secret_input) && !toolSecretInputs[invocation.id]?.trim())}
                        onClick={() => confirmToolInvocation(invocation, true)}
                      >
                        {t(language, "approve")}
                      </button>
                      <button type="button" disabled={loading} onClick={() => confirmToolInvocation(invocation, false)}>
                        {t(language, "reject")}
                      </button>
                    </footer>
                  </section>
                );
              })}
            </div>
          ) : null}

          {!providersAvailable ? <div className="zt-ai-warning">{t(language, "configureAiProvider")}</div> : null}
          {error ? <div className="zt-session-error">{error}</div> : null}

          <div className="zt-ai-composer" aria-label={t(language, "aiComposer")}>
            <div className="zt-ai-prompt zt-ai-chat-input">
              <div className="zt-ai-composer-box">
                <textarea
                  id={promptId}
                  aria-label={t(language, "aiRequest")}
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.currentTarget.value)}
                  onKeyDown={handlePromptKeyDown}
                />
                <div className="zt-ai-composer-footer">
                  <div
                    className={`zt-ai-approval-mode mode-${approvalMode}`}
                    aria-label={t(language, "approvalMode")}
                    title={t(language, "approvalMode")}
                  >
                    <ShieldCheck size={14} aria-hidden="true" />
                    <ZtSelect
                      ariaLabel={t(language, "approvalMode")}
                      className={`zt-ai-approval-select mode-${approvalMode}`}
                      value={approvalMode}
                      options={approvalModeOptions(language)}
                      disabled={loading}
                      onChange={(value) => void onApprovalModeChange?.(value as AiApprovalMode)}
                    />
                  </div>
                  {loading ? (
                    <button
                      type="button"
                      className="zt-ai-send is-cancel"
                      aria-label={t(language, "cancel")}
                      title={t(language, "cancel")}
                      disabled={!canCancelChat}
                      onClick={() => onCancelChat?.()}
                    >
                      <Square size={14} fill="currentColor" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="zt-ai-send"
                      aria-label={t(language, "send")}
                      title={t(language, "send")}
                      disabled={!canSendChat}
                      onClick={() => void sendChat()}
                    >
                      <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

    </section>
  );
}

function approvalModeOptions(language: AppLanguage): Array<{ value: AiApprovalMode; label: string }> {
  return [
    {
      value: "request_approval",
      label: t(language, "requestApproval"),
    },
    {
      value: "safe",
      label: t(language, "safeApproval"),
    },
    {
      value: "full_access",
      label: t(language, "fullAccess"),
    },
  ];
}

function renderConversationMessage(message: AiConversationMessage, language: AppLanguage) {
  if (message.role === "tool") {
    return renderToolConversationMessage(message, language);
  }
  return (
    <article
      className={`zt-ai-message role-${message.role} status-${message.status}`}
      aria-label={roleLabel(message.role, language)}
      key={message.id}
    >
      <p>{message.content}</p>
    </article>
  );
}

function renderToolConversationMessage(message: AiConversationMessage, language: AppLanguage) {
  const result = formatToolMessage(message.content, t(language, "aiToolCompleted"));
  return (
    <article className={`zt-ai-message role-tool status-${message.status}`} aria-label={roleLabel(message.role, language)} key={message.id}>
      <div className="zt-ai-tool-result">
        <strong className="zt-ai-tool-result-title">{t(language, "aiToolResultTitle")}</strong>
        <dl>
          <div>
            <dt>{t(language, "aiToolStatus")}</dt>
            <dd>{result.status}</dd>
          </div>
          {result.command ? (
            <div>
              <dt>{t(language, "aiToolCommand")}</dt>
              <dd>
                <code>{result.command}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t(language, "aiToolOutput")}</dt>
            <dd>
              <pre className="zt-ai-tool-output">{result.output || t(language, "aiToolNoOutput")}</pre>
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

interface ToolMessageFormat {
  status: string;
  command: string | null;
  output: string;
}

const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function formatToolMessage(content: string, completedFallback: string): ToolMessageFormat {
  const terminalReturn = splitOnce(content, "终端返回：");
  if (terminalReturn) {
    return {
      status: cleanPlainText(terminalReturn[0]) || completedFallback,
      command: null,
      output: cleanTerminalOutput(terminalReturn[1], null),
    };
  }

  const lines = normalizeLineBreaks(content).split("\n");
  const outputIndex = lines.findIndex((line) => line.trimStart().startsWith("终端输出："));
  if (outputIndex >= 0) {
    const commandLine = lines.find((line) => line.trimStart().startsWith("命令："));
    const command = commandLine ? cleanPlainText(commandLine.replace(/^.*?命令：/, "")) : null;
    const status = cleanPlainText(
      lines
        .slice(0, outputIndex)
        .filter((line) => !line.trimStart().startsWith("命令："))
        .join("\n"),
    );
    const outputFirstLine = lines[outputIndex].replace(/^.*?终端输出：/, "");
    const output = [outputFirstLine, ...lines.slice(outputIndex + 1)].join("\n");
    return {
      status: status || completedFallback,
      command: command || null,
      output: cleanTerminalOutput(output, command),
    };
  }

  return {
    status: cleanPlainText(content) || completedFallback,
    command: null,
    output: "",
  };
}

function splitOnce(value: string, separator: string): [string, string] | null {
  const index = value.indexOf(separator);
  if (index < 0) return null;
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function cleanPlainText(value: string) {
  return normalizeLineBreaks(stripTerminalControls(value))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function cleanTerminalOutput(value: string, command: string | null) {
  const commandLines = command ? cleanPlainText(command).split("\n").filter(Boolean) : [];
  return normalizeLineBreaks(stripTerminalControls(value))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !commandLines.includes(line))
    .filter((line) => !looksLikeShellPrompt(line))
    .join("\n");
}

function normalizeLineBreaks(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripTerminalControls(value: string) {
  return value.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "").replace(CONTROL_CHARACTER_PATTERN, "");
}

function looksLikeShellPrompt(line: string) {
  const value = line.trim();
  return (
    (/^[\w.-]+@[\w.-]+:.*[$#]\s*$/.test(value) && value.includes(":")) ||
    /^PS\s+.+>\s*$/.test(value) ||
    (/^[A-Za-z]:\\.*>\s*$/.test(value) && value.endsWith(">"))
  );
}

function roleLabel(role: AiConversationMessage["role"], language: AppLanguage) {
  if (role === "user") return t(language, "userRole");
  if (role === "assistant") return t(language, "assistantRole");
  if (role === "tool") return t(language, "toolRole");
  return t(language, "systemRole");
}

function riskLabel(risk: AiToolPendingInvocation["risk_level"], language: AppLanguage) {
  if (risk === "low") return t(language, "riskLow");
  if (risk === "medium") return t(language, "riskMedium");
  if (risk === "high") return t(language, "riskHigh");
  return t(language, "riskCritical");
}

function summarizeToolInvocation(invocation: AiToolPendingInvocation, language: AppLanguage) {
  const argumentFields = parseSummaryFields(invocation.arguments_summary);
  const targetFields = parseSummaryFields(invocation.target_summary ?? "");
  const connection =
    argumentFields.target_title ??
    targetFields.target_title ??
    targetFields.cwd ??
    argumentFields.cwd ??
    t(language, "aiToolCurrentTerminal");
  const command = invocation.tool_id === "terminal.write" ? argumentFields.data : null;
  const compactArguments = compactToolArguments(argumentFields);
  const detail = command ?? compactArguments ?? invocation.arguments_summary;
  return {
    connection,
    operation: invocation.tool_title,
    detail,
    detailLabel: command ? t(language, "aiToolCommand") : t(language, "aiToolArguments"),
    rawDetails: [
      invocation.tool_id,
      invocation.target_summary ? `${t(language, "target")}: ${invocation.target_summary}` : null,
      invocation.arguments_summary,
      invocation.risk_summary,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function compactToolArguments(fields: Record<string, string>) {
  const hiddenKeys = new Set(["pane_id", "runtime_session_id", "saved_session_id", "target_title", "scope_id"]);
  const parts = Object.entries(fields)
    .filter(([key, value]) => !hiddenKeys.has(key) && value.trim().length > 0)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function parseSummaryFields(summary: string) {
  const fields: Record<string, string> = {};
  const keyPattern = /(?:^|,\s)([a-z_]+)=/g;
  const matches = Array.from(summary.matchAll(keyPattern));
  matches.forEach((match, index) => {
    const key = match[1];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index ?? summary.length : summary.length;
    fields[key] = summary.slice(valueStart, valueEnd).replace(/,\s$/, "").trim();
  });
  return fields;
}

function formatConversationTime(updatedAtMs?: number) {
  if (!updatedAtMs) return "";
  return new Date(updatedAtMs).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
