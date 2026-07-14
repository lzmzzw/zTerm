// Author: Liz
import { Copy, Edit3, Play, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { ZtButton, ZtContextMenu, ZtDialog, ZtInput, ZtSwitch, ZtTextarea } from "../../components/ZtUi";
import { t } from "../settings/i18n";
import type { AppLanguage } from "../settings/settingsStore";
import type {
  CommandHistoryEntry,
  HistoryScopeKind,
  SessionCommandGroup,
  SessionCommandGroupDraft,
} from "./historyStore";

export type CommandHistoryView = "history" | "groups";
type CommandGroupFormMode = "selected" | "new" | "edit";

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
  onSend: (command: string) => Promise<void> | void;
  onClear: () => void;
  onDeleteEntries: (entryIds: string[]) => Promise<void> | void;
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
  onDeleteEntries,
  onDeduplicateHistoryChange,
  onSaveCommandGroup,
  onDeleteCommandGroup,
}: CommandHistoryPanelProps) {
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingGroup, setEditingGroup] = useState<SessionCommandGroup | null>(null);
  const [formMode, setFormMode] = useState<CommandGroupFormMode | null>(null);
  const [formName, setFormName] = useState("");
  const [formCommands, setFormCommands] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const orderedEntries = useMemo(
    () => [...entries].sort((left, right) => historyEntryTime(left) - historyEntryTime(right)),
    [entries],
  );
  const selectedEntries = useMemo(
    () => orderedEntries.filter((entry) => selectedEntryIds.includes(entry.id)),
    [orderedEntries, selectedEntryIds],
  );
  const selectedCommands = useMemo(
    () => selectedEntries.map((entry) => entry.command),
    [selectedEntries],
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
    setContextMenu(null);
    resetForm();
  }, [activeView, historyScopeKind, historyScopeId]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [contextMenu]);

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

    if (!usesAdditiveSelection && selectedEntryIds.includes(entryId)) {
      setSelectedEntryIds((current) => current.filter((id) => id !== entryId));
      if (selectionAnchorId === entryId) setSelectionAnchorId(null);
      return;
    } else if (usesAdditiveSelection) {
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
    if (event.key === "Enter") {
      if (!selectedEntryIds.includes(entryId)) return;
      event.preventDefault();
      void sendSelectedEntries();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      if (selectedEntryIds.length === 0) return;
      event.preventDefault();
      void deleteSelectedEntries();
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      selectEntry(entryId, event);
    }
  }

  function openContextMenu(entryId: string, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    if (!hasHistoryScope) return;
    if (!selectedEntryIds.includes(entryId)) {
      setSelectedEntryIds([entryId]);
      setSelectionAnchorId(entryId);
    }
    setContextMenu({ x: event.clientX, y: event.clientY });
  }

  function copySelectedEntries() {
    if (selectedCommands.length === 0) return;
    onCopy(selectedCommands.join("\n"));
    setContextMenu(null);
  }

  async function sendSelectedEntries() {
    if (selectedCommands.length === 0) return;
    setContextMenu(null);
    for (const command of selectedCommands) {
      await onSend(command);
    }
  }

  async function deleteSelectedEntries() {
    if (selectedEntryIds.length === 0) return;
    setContextMenu(null);
    try {
      await onDeleteEntries(selectedEntryIds);
      setSelectedEntryIds([]);
      setSelectionAnchorId(null);
    } catch {
      // The parent store exposes the failed operation through the history error state.
    }
  }

  function openSelectedGroupForm() {
    if (!hasHistoryScope || selectedCommands.length === 0) return;
    setContextMenu(null);
    setEditingGroup(null);
    setFormName("");
    setFormCommands(selectedCommands.join("\n"));
    setFormError(null);
    setFormMode("selected");
  }

  function openNewGroupForm() {
    if (!hasHistoryScope) return;
    setEditingGroup(null);
    setFormName("");
    setFormCommands("");
    setFormError(null);
    setFormMode("new");
  }

  function openEditGroupForm(group: SessionCommandGroup) {
    setEditingGroup(group);
    setFormName(group.name);
    setFormCommands(group.items.map((item) => item.command).join("\n"));
    setFormError(null);
    setFormMode("edit");
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
    setFormSaving(true);
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
    } finally {
      setFormSaving(false);
    }
  }

  function resetForm() {
    setEditingGroup(null);
    setFormMode(null);
    setFormName("");
    setFormCommands("");
    setFormError(null);
    setFormSaving(false);
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
            groupError={groupError}
            groupLoading={groupLoading}
            language={language}
            hasHistoryScope={hasHistoryScope}
            onCopy={onCopy}
            onDeleteCommandGroup={onDeleteCommandGroup}
            onEditGroup={openEditGroupForm}
            onNewGroup={openNewGroupForm}
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
          </div>

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
                  onContextMenu={(event) => openContextMenu(entry.id, event)}
                  onKeyDown={(event) => handleEntryKeyDown(entry.id, event)}
                >
                <code>{entry.command}</code>
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
          {contextMenu ? (
            <ZtContextMenu className="zt-context-menu" role="menu" x={contextMenu.x} y={contextMenu.y}>
              <button type="button" role="menuitem" onClick={openSelectedGroupForm}>
                {t(language, "save")}
              </button>
              <button type="button" role="menuitem" onClick={copySelectedEntries}>
                复制
              </button>
              <button type="button" role="menuitem" onClick={() => void sendSelectedEntries()}>
                发送
              </button>
              <button type="button" className="zt-delete-button" role="menuitem" onClick={() => void deleteSelectedEntries()}>
                删除
              </button>
            </ZtContextMenu>
          ) : null}
        </div>
      )}

      {formMode ? (
        <CommandGroupDialog
          commands={formCommands}
          error={formError}
          language={language}
          mode={formMode}
          name={formName}
          saving={formSaving}
          onCancel={resetForm}
          onCommandsChange={setFormCommands}
          onNameChange={setFormName}
          onSave={() => void saveGroup()}
        />
      ) : null}
    </section>
  );
}

function CommandGroupView({
  commandGroups,
  groupError,
  groupLoading,
  hasHistoryScope,
  language,
  onCopy,
  onDeleteCommandGroup,
  onEditGroup,
  onNewGroup,
  onSend,
}: {
  commandGroups: SessionCommandGroup[];
  groupError: string | null;
  groupLoading: boolean;
  hasHistoryScope: boolean;
  language: AppLanguage;
  onCopy: (command: string) => void;
  onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
  onEditGroup: (group: SessionCommandGroup) => void;
  onNewGroup: () => void;
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

function CommandGroupDialog({
  commands,
  error,
  language,
  mode,
  name,
  saving,
  onCancel,
  onCommandsChange,
  onNameChange,
  onSave,
}: {
  commands: string;
  error: string | null;
  language: AppLanguage;
  mode: CommandGroupFormMode;
  name: string;
  saving: boolean;
  onCancel: () => void;
  onCommandsChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSave: () => void;
}) {
  const title =
    mode === "edit"
      ? t(language, "editCommandGroup")
      : mode === "selected"
        ? t(language, "saveAsCommandGroup")
        : t(language, "addCommandGroup");
  const formId = "zt-command-group-dialog-form";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saving) onSave();
  }

  return (
    <ZtDialog
      ariaLabel={title}
      title={title}
      size="compact"
      className="zt-command-group-dialog"
      onClose={onCancel}
      closeLabel={`${t(language, "close")}${language === "zhCN" ? "" : " "}${title}`}
      closeDisabled={saving}
      footer={
        <>
          <ZtButton disabled={saving} onClick={onCancel}>
            {t(language, "cancel")}
          </ZtButton>
          <ZtButton
            aria-label={t(language, "saveCommandGroup")}
            form={formId}
            type="submit"
            disabled={saving}
            variant="primary"
          >
            {t(language, "saveCommandGroup")}
          </ZtButton>
        </>
      }
    >
      <form id={formId} className="zt-dialog-form zt-command-group-dialog-form" onSubmit={handleSubmit}>
        <label>
          <span>{t(language, "commandGroupNameLabel")}</span>
          <ZtInput
            autoFocus
            aria-label={t(language, "commandGroupName")}
            value={name}
            disabled={saving}
            onChange={(event) => onNameChange(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>{t(language, "commandGroupCommandsLabel")}</span>
          <ZtTextarea
            className="zt-command-group-dialog-commands"
            aria-label={t(language, "commandGroupCommands")}
            value={commands}
            disabled={saving}
            onChange={(event) => onCommandsChange(event.currentTarget.value)}
            placeholder={t(language, "commandGroupCommandsPlaceholder")}
          />
        </label>
        {error ? <p className="zt-command-group-dialog-error" role="alert">{error}</p> : null}
      </form>
    </ZtDialog>
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
