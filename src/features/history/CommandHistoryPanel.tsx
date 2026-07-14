// Author: Liz
import { CheckSquare, Copy, Edit3, Play, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { ZtSwitch } from "../../components/ZtUi";
import { t } from "../settings/i18n";
import type { AppLanguage } from "../settings/settingsStore";
import type {
  CommandHistoryEntry,
  HistoryScopeKind,
  SessionCommandGroup,
  SessionCommandGroupDraft,
} from "./historyStore";

export type CommandHistoryView = "history" | "groups";

interface CommandHistoryPanelProps {
  activeView: CommandHistoryView;
  commandGroups: SessionCommandGroup[];
  deduplicateHistory: boolean;
  entries: CommandHistoryEntry[];
  query: string;
  loading: boolean;
  error: string | null;
  groupLoading: boolean;
  groupError: string | null;
  language?: AppLanguage;
  historyScopeKind: HistoryScopeKind | null;
  historyScopeId: string | null;
  onViewChange: (view: CommandHistoryView) => void;
  onQueryChange: (query: string) => void;
  onSearch: (options?: { deduplicate?: boolean }) => void;
  onCopy: (command: string) => void;
  onSend: (command: string) => void;
  onClear: () => void;
  onDeduplicateHistoryChange: (enabled: boolean) => void;
  onSaveCommandGroup: (draft: SessionCommandGroupDraft) => Promise<unknown> | unknown;
  onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
}

export function CommandHistoryPanel({
  activeView,
  commandGroups,
  deduplicateHistory,
  entries,
  query,
  loading,
  error,
  groupLoading,
  groupError,
  language = "zhCN",
  historyScopeKind,
  historyScopeId,
  onViewChange,
  onQueryChange,
  onSearch,
  onCopy,
  onSend,
  onClear,
  onDeduplicateHistoryChange,
  onSaveCommandGroup,
  onDeleteCommandGroup,
}: CommandHistoryPanelProps) {
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<SessionCommandGroup | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formCommands, setFormCommands] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const orderedEntries = useMemo(
    () => [...entries].sort((left, right) => historyEntryTime(left) - historyEntryTime(right)),
    [entries],
  );
  const selectedCommands = useMemo(
    () =>
      selectedEntryIds
        .map((id) => orderedEntries.find((entry) => entry.id === id)?.command)
        .filter((command): command is string => Boolean(command)),
    [orderedEntries, selectedEntryIds],
  );
  const hasHistoryScope = Boolean(historyScopeKind && historyScopeId);

  useLayoutEffect(() => {
    if (activeView !== "history") return;
    const list = historyListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [activeView, orderedEntries]);

  useEffect(() => {
    setSelectedEntryIds([]);
    setSelectionAnchorId(null);
    resetForm();
  }, [activeView, historyScopeKind, historyScopeId]);

  function changeView(view: CommandHistoryView) {
    onViewChange(view);
    if (view === "history") {
      onSearch({ deduplicate: deduplicateHistory });
    }
  }

  function selectEntry(
    entryId: string,
    modifiers: Pick<ReactMouseEvent<HTMLElement>, "ctrlKey" | "metaKey" | "shiftKey">,
  ) {
    if (!hasHistoryScope) return;
    const usesAdditiveSelection = modifiers.ctrlKey || modifiers.metaKey;
    const entryIndex = orderedEntries.findIndex((entry) => entry.id === entryId);
    const anchorIndex = selectionAnchorId ? orderedEntries.findIndex((entry) => entry.id === selectionAnchorId) : -1;

    if (modifiers.shiftKey && anchorIndex >= 0 && entryIndex >= 0) {
      const rangeIds = orderedEntries
        .slice(Math.min(anchorIndex, entryIndex), Math.max(anchorIndex, entryIndex) + 1)
        .map((entry) => entry.id);
      setSelectedEntryIds((current) => (usesAdditiveSelection ? [...new Set([...current, ...rangeIds])] : rangeIds));
      return;
    }

    if (usesAdditiveSelection) {
      setSelectedEntryIds((current) =>
        current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
      );
    } else {
      setSelectedEntryIds([entryId]);
    }
    setSelectionAnchorId(entryId);
  }

  function handleEntryClick(entryId: string, event: ReactMouseEvent<HTMLElement>) {
    selectEntry(entryId, event);
  }

  function handleEntryKeyDown(entryId: string, event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectEntry(entryId, event);
  }

  function openSelectedGroupForm() {
    if (!hasHistoryScope || selectedCommands.length === 0) return;
    setEditingGroup(null);
    setFormName("");
    setFormCommands(selectedCommands.join("\n"));
    setFormError(null);
    setFormOpen(true);
  }

  function openNewGroupForm() {
    if (!hasHistoryScope) return;
    setEditingGroup(null);
    setFormName("");
    setFormCommands("");
    setFormError(null);
    setFormOpen(true);
  }

  function openEditGroupForm(group: SessionCommandGroup) {
    setEditingGroup(group);
    setFormName(group.name);
    setFormCommands(group.items.map((item) => item.command).join("\n"));
    setFormError(null);
    setFormOpen(true);
  }

  async function saveGroup() {
    if (!historyScopeKind || !historyScopeId) {
      setFormError("当前终端没有历史作用域，不能保存指令组");
      return;
    }
    const name = formName.trim();
    const commands = normalizeCommands(formCommands);
    if (!name) {
      setFormError("请输入指令组名称");
      return;
    }
    if (commands.length === 0) {
      setFormError("请输入至少一条命令");
      return;
    }
    setFormError(null);
    try {
      await onSaveCommandGroup({
        id: editingGroup?.id,
        saved_session_id: historyScopeKind === "saved_session" ? historyScopeId : null,
        scope_kind: historyScopeKind,
        scope_id: historyScopeId,
        name,
        commands,
      });
      setSelectedEntryIds([]);
      resetForm();
    } catch (error) {
      setFormError(unknownErrorMessage(error, "指令组保存失败"));
    }
  }

  function resetForm() {
    setEditingGroup(null);
    setFormOpen(false);
    setFormName("");
    setFormCommands("");
    setFormError(null);
  }

  return (
    <section className="zt-history-panel" aria-label={t(language, "history")}>
      <div className="zt-history-mode-tabs" role="tablist" aria-label={t(language, "history")}>
        <button type="button" aria-selected={activeView === "history"} onClick={() => changeView("history")}>
          {t(language, "history")}
        </button>
        <button type="button" aria-selected={activeView === "groups"} onClick={() => changeView("groups")}>
          {t(language, "commandGroups")}
        </button>
      </div>

      {activeView === "groups" ? (
        <div className="zt-history-groups-view">
          <CommandGroupView
            commandGroups={commandGroups}
            formCommands={formCommands}
            formError={formError}
            formName={formName}
            formOpen={formOpen}
            groupError={groupError}
            groupLoading={groupLoading}
            language={language}
            hasHistoryScope={hasHistoryScope}
            onCancelForm={resetForm}
            onCopy={onCopy}
            onDeleteCommandGroup={onDeleteCommandGroup}
            onEditGroup={openEditGroupForm}
            onFormCommandsChange={setFormCommands}
            onFormNameChange={setFormName}
            onNewGroup={openNewGroupForm}
            onSaveGroup={() => void saveGroup()}
            onSend={onSend}
          />
        </div>
      ) : (
        <div className="zt-history-entries-view">
          <div className="zt-history-toolbar">
            <label className="zt-history-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                aria-label={t(language, "filterHistory")}
                value={query}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder={t(language, "filterHistory")}
              />
            </label>
            <ZtSwitch
              label={t(language, "deduplicated")}
              ariaLabel={t(language, "deduplicateHistory")}
              checked={deduplicateHistory}
              onChange={onDeduplicateHistoryChange}
            />
            <button
              type="button"
              aria-label={t(language, "saveAsCommandGroup")}
              className="zt-history-icon-button"
              onClick={openSelectedGroupForm}
              title={t(language, "saveAsCommandGroup")}
              disabled={loading || !hasHistoryScope || selectedCommands.length === 0}
            >
              <Save size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t(language, "clearHistory")}
              className="zt-history-icon-button"
              onClick={onClear}
              title={t(language, "clearHistory")}
              disabled={loading || !hasHistoryScope}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>

          {formOpen ? (
            <CommandGroupForm
              commands={formCommands}
              error={formError}
              language={language}
              name={formName}
              onCancel={resetForm}
              onCommandsChange={setFormCommands}
              onNameChange={setFormName}
              onSave={() => void saveGroup()}
            />
          ) : null}

          {error ? <div className="zt-history-error">{error}</div> : null}

          <div className="zt-history-list" role="list" ref={historyListRef}>
            {orderedEntries.length === 0 ? <div className="zt-empty-line">{t(language, "noHistory")}</div> : null}
            {orderedEntries.map((entry) => {
              const selected = selectedEntryIds.includes(entry.id);
              return (
                <article
                  className={`zt-history-entry${selected ? " is-selected" : ""}`}
                  key={entry.id}
                  role="listitem"
                  tabIndex={hasHistoryScope ? 0 : -1}
                  aria-label={`${t(language, "selectPrefix")} ${entry.command}`}
                  aria-disabled={!hasHistoryScope}
                  onClick={(event) => handleEntryClick(entry.id, event)}
                  onKeyDown={(event) => handleEntryKeyDown(entry.id, event)}
                >
                <code>{entry.command}</code>
                <button
                  type="button"
                  aria-label={`${t(language, "copyPrefix")} ${entry.command}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy(entry.command);
                  }}
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`${t(language, "sendPrefix")} ${entry.command}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSend(entry.command);
                  }}
                >
                  <Play size={14} aria-hidden="true" />
                </button>
              </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function CommandGroupView({
  commandGroups,
  formCommands,
  formError,
  formName,
  formOpen,
  groupError,
  groupLoading,
  hasHistoryScope,
  language,
  onCancelForm,
  onCopy,
  onDeleteCommandGroup,
  onEditGroup,
  onFormCommandsChange,
  onFormNameChange,
  onNewGroup,
  onSaveGroup,
  onSend,
}: {
  commandGroups: SessionCommandGroup[];
  formCommands: string;
  formError: string | null;
  formName: string;
  formOpen: boolean;
  groupError: string | null;
  groupLoading: boolean;
  hasHistoryScope: boolean;
  language: AppLanguage;
  onCancelForm: () => void;
  onCopy: (command: string) => void;
  onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
  onEditGroup: (group: SessionCommandGroup) => void;
  onFormCommandsChange: (value: string) => void;
  onFormNameChange: (value: string) => void;
  onNewGroup: () => void;
  onSaveGroup: () => void;
  onSend: (command: string) => void;
}) {
  return (
    <>
      <div className="zt-history-group-toolbar">
        <button type="button" onClick={onNewGroup} disabled={!hasHistoryScope || groupLoading}>
          <Plus size={14} aria-hidden="true" />
          {t(language, "addCommandGroup")}
        </button>
      </div>

      {formOpen ? (
        <CommandGroupForm
          commands={formCommands}
          error={formError}
          language={language}
          name={formName}
          onCancel={onCancelForm}
          onCommandsChange={onFormCommandsChange}
          onNameChange={onFormNameChange}
          onSave={onSaveGroup}
        />
      ) : null}

      {groupError ? <div className="zt-history-error">{groupError}</div> : null}

      <div className="zt-history-group-list">
        {!hasHistoryScope ? <div className="zt-empty-line">{t(language, "cannotSaveCommandGroup")}</div> : null}
        {hasHistoryScope && commandGroups.length === 0 ? <div className="zt-empty-line">{t(language, "noCommandGroups")}</div> : null}
        {hasHistoryScope
          ? commandGroups.map((group) => (
              <article className="zt-history-group" key={group.id}>
                <header>
                  <strong>{group.name}</strong>
                  <button type="button" aria-label={`${t(language, "copyPrefix")} ${group.name}`} onClick={() => onCopy(group.items.map((item) => item.command).join("\n"))}>
                     <Copy size={14} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`${t(language, "editPrefix")} ${group.name}`} onClick={() => onEditGroup(group)}>
                     <Edit3 size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="zt-delete-button" aria-label={`${t(language, "deletePrefix")} ${group.name}`} onClick={() => void onDeleteCommandGroup(group.id)}>
              <Trash2 size={14} aria-hidden="true" />
                  </button>
                </header>
                <div className="zt-history-group-items">
                  {group.items.map((item) => (
                    <div className="zt-history-group-item" key={item.id}>
                      <code>{item.command}</code>
                      <button type="button" aria-label={`${t(language, "copyPrefix")} ${item.command}`} onClick={() => onCopy(item.command)}>
                  <Copy size={14} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`${t(language, "sendPrefix")} ${item.command}`} onClick={() => onSend(item.command)}>
                  <Play size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            ))
          : null}
      </div>
    </>
  );
}

function CommandGroupForm({
  commands,
  error,
  language,
  name,
  onCancel,
  onCommandsChange,
  onNameChange,
  onSave,
}: {
  commands: string;
  error: string | null;
  language: AppLanguage;
  name: string;
  onCancel: () => void;
  onCommandsChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="zt-history-group-form">
      <label>
        <span>{t(language, "commandGroupNameLabel")}</span>
        <input
          type="text"
          aria-label={t(language, "commandGroupName")}
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t(language, "commandGroupCommandsLabel")}</span>
        <textarea
          aria-label={t(language, "commandGroupCommands")}
          value={commands}
          onChange={(event) => onCommandsChange(event.currentTarget.value)}
          placeholder={t(language, "commandGroupCommandsPlaceholder")}
        />
      </label>
      {error ? <div className="zt-history-error">{error}</div> : null}
      <div className="zt-history-group-form-actions">
        <button
          type="button"
          className="zt-history-group-save-action"
          onClick={onSave}
          aria-label={t(language, "saveCommandGroup")}
          title={t(language, "saveCommandGroup")}
        >
          <CheckSquare size={14} aria-hidden="true" />
          {t(language, "saveCommandGroup")}
        </button>
        <button
          type="button"
          className="zt-history-group-cancel-action"
          onClick={onCancel}
          aria-label={t(language, "cancel")}
          title={t(language, "cancel")}
        >
          <X size={14} aria-hidden="true" />
          {t(language, "cancel")}
        </button>
      </div>
    </div>
  );
}

function historyEntryTime(entry: CommandHistoryEntry) {
  return entry.finished_at_ms ?? entry.started_at_ms;
}

function normalizeCommands(value: string) {
  return value
    .split(/\r?\n/)
    .map((command) => command.trim())
    .filter(Boolean);
}
