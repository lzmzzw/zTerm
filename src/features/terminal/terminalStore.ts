// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { useWorkspaceStore } from "../workspace/workspaceStore";
import {
  consumeTerminalZmodemData,
  releaseTerminalZmodemRuntime,
} from "./zmodemTransfer";
import { TerminalReplayBuffer, type TerminalReplayResult } from "./terminalReplay";

type RuntimeSessionKind = "local" | "ssh" | "ssh_container" | "rdp_placeholder";
type HistoryScopeKind = "saved_session" | "local_profile";

export interface RuntimeSessionInfo {
  runtime_session_id: string;
  saved_session_id: string | null;
  history_scope_kind: HistoryScopeKind | null;
  history_scope_id: string | null;
  pane_id: string;
  title: string;
  kind: RuntimeSessionKind;
  initial_cwd: string | null;
  cols: number;
  rows: number;
}

export interface CommandCompletionCandidate {
  provider: "history" | "system" | "path";
  replacement_text: string;
  suffix: string;
  replacement_range: {
    start: number;
    end: number;
  };
  score: number;
  source_label: string;
}

export interface SshContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
}

interface TerminalDataEvent {
  runtime_session_id: string;
  data: string;
  data_base64?: string;
}

interface TerminalOutputChunk {
  serial: number;
  data: string;
}

interface TerminalExitEvent {
  runtime_session_id: string;
  exit_code: number | null;
  message: string | null;
}

interface TerminalHistoryChangedEvent {
  runtime_session_id: string;
}

const MAX_TERMINAL_OUTPUT_CHARS = 50_000;
const MAX_TERMINAL_VISUAL_TAIL_CHARS = 8_000;

interface TerminalState {
  runtimes: Record<string, RuntimeSessionInfo>;
  outputChunks: Record<string, TerminalOutputChunk>;
  inputSerialByRuntime: Record<string, number>;
  bindTerminalEvents: () => Promise<UnlistenFn>;
  openTerminal: (savedSessionId: string, paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>;
  openSshContainerTerminal: (
    savedSessionId: string,
    paneId: string,
    containerId: string,
    containerName?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  enterSshContainerRuntime: (
    savedSessionId: string,
    runtimeSessionId: string,
    containerId: string,
  ) => Promise<void>;
  listSshContainers: (savedSessionId: string) => Promise<SshContainerInfo[]>;
  openDefaultLocalTerminal: (paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>;
  writeTerminal: (runtimeSessionId: string, data: string) => Promise<void>;
  suggestCompletion: (
    runtimeSessionId: string,
    input: string,
    cursor: number,
    cwd?: string | null,
  ) => Promise<CommandCompletionCandidate[]>;
  resolveCwd: (
    runtimeSessionId: string,
    currentCwd: string | null,
    target: string | null,
  ) => Promise<string | null>;
  resizeTerminal: (runtimeSessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (runtimeSessionId: string, options?: { releaseExternalSession?: boolean }) => Promise<void>;
  forgetTerminalRuntime: (runtimeSessionId: string) => void;
  appendOutput: (runtimeSessionId: string, data: string) => void;
  getOutputTail: (runtimeSessionId: string) => string;
  getReplayOutput: (runtimeSessionId: string) => TerminalReplayResult;
  getVisualOutputTail: (runtimeSessionId: string) => string;
  getVisualOutputTailSnapshot: () => Record<string, string>;
  beginLiveOutput: (runtimeSessionId: string) => () => void;
}

let terminalEventBinding: Promise<UnlistenFn> | null = null;
let terminalEventSubscribers = 0;
const outputTailByRuntime: Record<string, string> = {};
const visualOutputTailByRuntime: Record<string, string> = {};
const liveOutputSubscriptions: Record<string, number> = {};
const replayBuffersByRuntime: Record<string, TerminalReplayBuffer> = {};
const completionRequestGenerationByRuntime: Record<string, number> = {};

export function resetTerminalOutputCachesForTest() {
  clearRecord(outputTailByRuntime);
  clearRecord(visualOutputTailByRuntime);
  clearRecord(liveOutputSubscriptions);
  clearReplayBuffers();
  clearRecord(completionRequestGenerationByRuntime);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  runtimes: {},
  outputChunks: {},
  inputSerialByRuntime: {},
  bindTerminalEvents() {
    terminalEventSubscribers += 1;
    if (!terminalEventBinding) {
      terminalEventBinding = Promise.all([
        listen<TerminalDataEvent>("terminal:data", (event) => {
          consumeTerminalZmodemData(
            {
              runtimeSessionId: event.payload.runtime_session_id,
              data: event.payload.data,
              dataBase64: event.payload.data_base64,
            },
            {
              appendOutput: get().appendOutput,
            },
          );
        }),
        listen<TerminalExitEvent>("terminal:exit", (event) => {
          const message = terminalExitMessage(event.payload);
          get().appendOutput(event.payload.runtime_session_id, `\r\n[已断开] ${message}\r\n`);
          useWorkspaceStore.getState().markRuntimeExited(
            event.payload.runtime_session_id,
            message,
            get().getVisualOutputTail(event.payload.runtime_session_id),
          );
          get().forgetTerminalRuntime(event.payload.runtime_session_id);
        }),
        listen<TerminalHistoryChangedEvent>("terminal:history-changed", (event) => {
          set((state) => ({
            inputSerialByRuntime: {
              ...state.inputSerialByRuntime,
              [event.payload.runtime_session_id]:
                (state.inputSerialByRuntime[event.payload.runtime_session_id] ?? 0) + 1,
            },
          }));
        }),
      ]).then(([unlistenData, unlistenExit, unlistenHistory]) => () => {
        unlistenData();
        unlistenExit();
        unlistenHistory();
      });
    }
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      terminalEventSubscribers = Math.max(0, terminalEventSubscribers - 1);
      if (terminalEventSubscribers === 0) {
        void terminalEventBinding?.then((unlisten) => {
          if (terminalEventSubscribers === 0) {
            unlisten();
            terminalEventBinding = null;
          }
        });
      }
    });
  },
  async openTerminal(savedSessionId, paneId, workingDirectory) {
    const runtime = await invoke<RuntimeSessionInfo>("terminal_open", {
      savedSessionId,
      paneId,
      workingDirectory,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    return runtime;
  },
  async openSshContainerTerminal(savedSessionId, paneId, containerId, containerName) {
    const runtime = await invoke<RuntimeSessionInfo>("terminal_open_ssh_container", {
      savedSessionId,
      paneId,
      containerId,
      containerName,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    return runtime;
  },
  async enterSshContainerRuntime(savedSessionId, runtimeSessionId, containerId) {
    await invoke("ssh_container_enter_runtime", {
      savedSessionId,
      runtimeSessionId,
      containerId,
    });
    set((state) => ({
      inputSerialByRuntime: {
        ...state.inputSerialByRuntime,
        [runtimeSessionId]: (state.inputSerialByRuntime[runtimeSessionId] ?? 0) + 1,
      },
    }));
  },
  async listSshContainers(savedSessionId) {
    return invoke<SshContainerInfo[]>("ssh_container_list", { savedSessionId });
  },
  async openDefaultLocalTerminal(paneId, workingDirectory) {
    const runtime = await invoke<RuntimeSessionInfo>("terminal_open_default_local", {
      paneId,
      workingDirectory,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    return runtime;
  },
  async writeTerminal(runtimeSessionId, data) {
    await invoke("terminal_write", { runtimeSessionId, data });
    if (isSubmittedTerminalInput(data)) {
      set((state) => ({
        inputSerialByRuntime: {
          ...state.inputSerialByRuntime,
          [runtimeSessionId]: (state.inputSerialByRuntime[runtimeSessionId] ?? 0) + 1,
        },
      }));
    }
  },
  async suggestCompletion(runtimeSessionId, input, cursor, cwd) {
    const generation = (completionRequestGenerationByRuntime[runtimeSessionId] ?? 0) + 1;
    completionRequestGenerationByRuntime[runtimeSessionId] = generation;
    const request = {
      runtime_session_id: runtimeSessionId,
      input,
      cursor,
      limit: 8,
      cwd,
    };
    let candidates = await invoke<CommandCompletionCandidate[]>("command_completion_suggest", { request });
    if (
      get().runtimes[runtimeSessionId]?.kind !== "ssh" ||
      !isPathCompletionInput(input) ||
      candidates.some((candidate) => candidate.provider === "path")
    ) {
      return candidates;
    }
    for (const retryDelay of [300, 500]) {
      await delay(retryDelay);
      if (completionRequestGenerationByRuntime[runtimeSessionId] !== generation) {
        return candidates;
      }
      candidates = await invoke<CommandCompletionCandidate[]>("command_completion_suggest", { request });
      if (candidates.some((candidate) => candidate.provider === "path")) break;
    }
    return candidates;
  },
  async resolveCwd(runtimeSessionId, currentCwd, target) {
    return invoke<string | null>("command_completion_resolve_cwd", {
      request: {
        runtime_session_id: runtimeSessionId,
        current_cwd: currentCwd,
        target,
      },
    });
  },
  async resizeTerminal(runtimeSessionId, cols, rows) {
    await invoke("terminal_resize", { runtimeSessionId, cols, rows });
    replayBuffersByRuntime[runtimeSessionId]?.resize(cols, rows);
    set((state) => {
      const runtime = state.runtimes[runtimeSessionId];
      if (!runtime) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [runtimeSessionId]: { ...runtime, cols, rows },
        },
      };
    });
  },
  async closeTerminal(runtimeSessionId, options) {
    await invoke("terminal_close", {
      runtimeSessionId,
      releaseExternalSession: options?.releaseExternalSession,
    });
    get().forgetTerminalRuntime(runtimeSessionId);
  },
  forgetTerminalRuntime(runtimeSessionId) {
    releaseTerminalZmodemRuntime(runtimeSessionId);
    set((state) => {
      const { [runtimeSessionId]: _runtime, ...runtimes } = state.runtimes;
      const { [runtimeSessionId]: _outputChunk, ...outputChunks } = state.outputChunks;
      const { [runtimeSessionId]: _inputSerial, ...inputSerialByRuntime } = state.inputSerialByRuntime;
      delete outputTailByRuntime[runtimeSessionId];
      delete visualOutputTailByRuntime[runtimeSessionId];
      delete liveOutputSubscriptions[runtimeSessionId];
      delete completionRequestGenerationByRuntime[runtimeSessionId];
      disposeReplayBuffer(runtimeSessionId);
      return { runtimes, outputChunks, inputSerialByRuntime };
    });
  },
  appendOutput(runtimeSessionId, data) {
    outputTailByRuntime[runtimeSessionId] = trimTerminalOutput(`${outputTailByRuntime[runtimeSessionId] ?? ""}${data}`);
    visualOutputTailByRuntime[runtimeSessionId] = trimTerminalVisualTail(
      `${visualOutputTailByRuntime[runtimeSessionId] ?? ""}${data}`,
    );
    replayBufferFor(runtimeSessionId, get().runtimes[runtimeSessionId])?.append(data);
    if ((liveOutputSubscriptions[runtimeSessionId] ?? 0) <= 0) {
      return;
    }
    set((state) => ({
      outputChunks: {
        ...state.outputChunks,
        [runtimeSessionId]: {
          serial: (state.outputChunks[runtimeSessionId]?.serial ?? 0) + 1,
          data,
        },
      },
    }));
  },
  getOutputTail(runtimeSessionId) {
    return outputTailByRuntime[runtimeSessionId] ?? "";
  },
  getReplayOutput(runtimeSessionId) {
    const rawOutput = outputTailByRuntime[runtimeSessionId] ?? "";
    return replayBuffersByRuntime[runtimeSessionId]?.replay(rawOutput) ?? { data: rawOutput, kind: "raw" };
  },
  getVisualOutputTail(runtimeSessionId) {
    return visualOutputTailByRuntime[runtimeSessionId] ?? "";
  },
  getVisualOutputTailSnapshot() {
    return { ...visualOutputTailByRuntime };
  },
  beginLiveOutput(runtimeSessionId) {
    liveOutputSubscriptions[runtimeSessionId] = (liveOutputSubscriptions[runtimeSessionId] ?? 0) + 1;
    return () => {
      const nextCount = Math.max(0, (liveOutputSubscriptions[runtimeSessionId] ?? 0) - 1);
      if (nextCount === 0) {
        delete liveOutputSubscriptions[runtimeSessionId];
        set((state) => {
          const { [runtimeSessionId]: _outputChunk, ...outputChunks } = state.outputChunks;
          return { outputChunks };
        });
      } else {
        liveOutputSubscriptions[runtimeSessionId] = nextCount;
      }
    };
  },
}));

function isPathCompletionInput(input: string) {
  const segment = input.split(/[|;&](?![|&])/).at(-1)?.trimStart() ?? "";
  return /^(?:cd|cp|mv|rm|ls|cat)\s+/i.test(segment);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function isSubmittedTerminalInput(data: string) {
  return data.includes("\r") || data.includes("\n");
}

function terminalExitMessage(event: TerminalExitEvent) {
  const message = event.message?.trim();
  if (message) return message;
  return event.exit_code === null ? "终端已退出" : `终端已退出（退出码 ${event.exit_code}）`;
}

function trimTerminalOutput(output: string) {
  if (output.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    return output;
  }
  return output.slice(-MAX_TERMINAL_OUTPUT_CHARS);
}

function trimTerminalVisualTail(output: string) {
  if (output.length <= MAX_TERMINAL_VISUAL_TAIL_CHARS) {
    return output;
  }
  return output.slice(-MAX_TERMINAL_VISUAL_TAIL_CHARS);
}

function clearRecord(record: Record<string, unknown>) {
  for (const key of Object.keys(record)) {
    delete record[key];
  }
}

function replayBufferFor(runtimeSessionId: string, runtime: RuntimeSessionInfo | undefined) {
  if (replayBuffersByRuntime[runtimeSessionId]) {
    return replayBuffersByRuntime[runtimeSessionId];
  }
  const buffer = new TerminalReplayBuffer(runtime?.cols, runtime?.rows);
  replayBuffersByRuntime[runtimeSessionId] = buffer;
  return buffer;
}

function disposeReplayBuffer(runtimeSessionId: string) {
  replayBuffersByRuntime[runtimeSessionId]?.dispose();
  delete replayBuffersByRuntime[runtimeSessionId];
}

function clearReplayBuffers() {
  for (const runtimeSessionId of Object.keys(replayBuffersByRuntime)) {
    disposeReplayBuffer(runtimeSessionId);
  }
}
