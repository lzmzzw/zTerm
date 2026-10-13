// Author: Liz
import { create } from "zustand";
import { reportZmodemDiagnostic } from "./zmodemDiagnostics";
import type { HistoryScopeKind } from "../history/types";

import { invokeTauri, invokeTypedTauri, listenTauri, type UnlistenFn } from "../../lib/tauriClient";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { listSshContainers as listSshContainersApi, type SshContainerInfo } from "./sshContainerApi";
import { parseSimpleCdTarget, trackTerminalInput } from "./terminalCwd";
import {
  consumeTerminalZmodemData,
  releaseTerminalZmodemRuntime,
} from "./zmodemTransfer";
import {
  acknowledgeTerminalOutputFlow,
  openTerminalOutputFlow,
  waitForTerminalOutputRender,
  type TerminalOutputFlowEvent,
} from "./terminalOutputFlow";
import { TerminalReplayBuffer, type TerminalReplayResult } from "./terminalReplay";
import {
  TerminalRuntimeResourceRegistry,
  type TerminalRuntimeResources,
} from "./terminalRuntimeResources";

type RuntimeSessionKind = "local" | "ssh" | "ssh_container" | "rdp_placeholder";

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

interface TerminalDataEvent {
  runtime_session_id: string;
  data: string;
  data_base64?: string;
  generation?: number | null;
  sequence?: number | null;
}

interface TerminalOutputChunk {
  flow?: TerminalOutputFlowEvent;
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
const PATH_COMMAND_CONTEXT =
  /^(?:cat|cd|cmp|cp|diff|du|file|head|less|ln|ls|mkdir|more|mv|nano|readlink|realpath|rm|rmdir|stat|tail|tar|touch|unzip|vi|vim|wc|zip)(?:\s|$)/i;
const PATH_COMMAND_LOOKUP =
  /^(?:cat|cd|cmp|cp|diff|du|file|head|less|ln|ls|mkdir|more|mv|nano|readlink|realpath|rm|rmdir|stat|tail|tar|touch|unzip|vi|vim|wc|zip)\s+/i;
const DOCKER_COMPOSE_CONTEXT = /^(?:docker\s+compose|docker-compose)(?:\s|$)/i;
const DOCKER_COMPOSE_PATH_CONTEXT =
  /(?:^|\s)(?:-f|--file|--env-file|--project-directory)(?:=[^\s]*|\s+[^\s]*)?$/i;
const DOCKER_COMPOSE_PATH_LOOKUP =
  /(?:^|\s)(?:-f|--file|--env-file|--project-directory)(?:=[^\s]*|\s+[^\s]*)$/i;

interface TerminalState {
  runtimes: Record<string, RuntimeSessionInfo>;
  outputChunks: Record<string, TerminalOutputChunk[]>;
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
  recordCwd: (runtimeSessionId: string, cwd: string) => void;
  resizeTerminal: (runtimeSessionId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (runtimeSessionId: string, options?: { releaseExternalSession?: boolean }) => Promise<void>;
  forgetTerminalRuntime: (runtimeSessionId: string) => void;
  appendOutput: (runtimeSessionId: string, data: string) => Promise<void>;
  getOutputTail: (runtimeSessionId: string) => string;
  getReplayOutput: (runtimeSessionId: string) => TerminalReplayResult;
  getVisualOutputTail: (runtimeSessionId: string) => string;
  getVisualOutputTailSnapshot: () => Record<string, string>;
  beginLiveOutput: (runtimeSessionId: string) => () => void;
  discardLiveOutputChunks: (runtimeSessionId: string, throughSerial: number) => void;
}

let terminalEventBinding: Promise<UnlistenFn> | null = null;
let terminalEventSubscribers = 0;
const terminalRuntimeResources = new TerminalRuntimeResourceRegistry();

export function resetTerminalOutputCachesForTest() {
  terminalRuntimeResources.clear();
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  runtimes: {},
  outputChunks: {},
  inputSerialByRuntime: {},
  bindTerminalEvents() {
    terminalEventSubscribers += 1;
    if (!terminalEventBinding) {
      terminalEventBinding = Promise.all([
        listenTauri<TerminalDataEvent>("terminal:data", (event) => {
          consumeTerminalDataEvent(event.payload, get);
        }),
        listenTauri<TerminalExitEvent>("terminal:exit", (event) => {
          const message = terminalExitMessage(event.payload);
          get().appendOutput(event.payload.runtime_session_id, `\r\n[已断开] ${message}\r\n`);
          useWorkspaceStore.getState().markRuntimeExited(
            event.payload.runtime_session_id,
            message,
            get().getVisualOutputTail(event.payload.runtime_session_id),
          );
          get().forgetTerminalRuntime(event.payload.runtime_session_id);
        }),
        listenTauri<TerminalHistoryChangedEvent>("terminal:history-changed", (event) => {
          set((state) => ({
            inputSerialByRuntime: {
              ...state.inputSerialByRuntime,
              [event.payload.runtime_session_id]:
                (state.inputSerialByRuntime[event.payload.runtime_session_id] ?? 0) + 1,
            },
          }));
        }),
      ]).then(async ([unlistenData, unlistenExit, unlistenHistory]) => {
        await Promise.all(
          Object.keys(get().runtimes).map((runtimeSessionId) => ensureTerminalOutputFlow(runtimeSessionId)),
        );
        return () => {
          unlistenData();
          unlistenExit();
          unlistenHistory();
        };
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
    const runtime = await invokeTauri<RuntimeSessionInfo>("terminal_open", {
      savedSessionId,
      paneId,
      workingDirectory,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    void ensureTerminalOutputFlow(runtime.runtime_session_id);
    return runtime;
  },
  async openSshContainerTerminal(savedSessionId, paneId, containerId, containerName) {
    const runtime = await invokeTauri<RuntimeSessionInfo>("terminal_open_ssh_container", {
      savedSessionId,
      paneId,
      containerId,
      containerName,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    void ensureTerminalOutputFlow(runtime.runtime_session_id);
    return runtime;
  },
  async enterSshContainerRuntime(savedSessionId, runtimeSessionId, containerId) {
    await invokeTauri("ssh_container_enter_runtime", {
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
    return listSshContainersApi(savedSessionId);
  },
  async openDefaultLocalTerminal(paneId, workingDirectory) {
    const runtime = await invokeTauri<RuntimeSessionInfo>("terminal_open_default_local", {
      paneId,
      workingDirectory,
    });
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.runtime_session_id]: runtime },
    }));
    void ensureTerminalOutputFlow(runtime.runtime_session_id);
    return runtime;
  },
  async writeTerminal(runtimeSessionId, data) {
    if (data === "\x03") reportZmodemDiagnostic("frontend-ctrl-c", "", runtimeSessionId);
    const resources = terminalRuntimeResources.acquire(runtimeSessionId);
    await invokeTypedTauri("terminal_write", { runtimeSessionId, data });
    if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
    const tracked = trackTerminalInput(resources.commandInput, data);
    resources.commandInput = tracked.buffer;
    for (const command of tracked.submittedCommands) {
      if (command.trim() === "rz") reportZmodemDiagnostic("frontend-rz", "", runtimeSessionId);
      const parsedCd = parseSimpleCdTarget(command);
      if (parsedCd) queueRuntimeCwdResolution(runtimeSessionId, parsedCd.target, resources, get);
    }
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
    const resources = terminalRuntimeResources.acquire(runtimeSessionId);
    const generation = resources.completionRequestGeneration + 1;
    resources.completionRequestGeneration = generation;
    if (cwd && !resources.knownCwd && !resources.cwdResolution) {
      resources.knownCwd = cwd;
    }
    await resources.cwdResolution?.catch(() => undefined);
    if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return [];
    const request = {
      runtime_session_id: runtimeSessionId,
      input,
      cursor,
      limit: 8,
      cwd: resources.knownCwd ?? cwd,
    };
    let candidates = await invokeTauri<CommandCompletionCandidate[]>("command_completion_suggest", { request });
    const pathCompletion = isPathCompletionInput(input);
    if (pathCompletion) {
      candidates = candidates.filter((candidate) => candidate.provider === "path");
    }
    if (
      get().runtimes[runtimeSessionId]?.kind !== "ssh" ||
      !isPathCompletionLookupInput(input) ||
      candidates.length > 0
    ) {
      return candidates;
    }
    for (const retryDelay of [300, 500]) {
      await delay(retryDelay);
      if (
        !terminalRuntimeResources.isCurrent(runtimeSessionId, resources) ||
        resources.completionRequestGeneration !== generation
      ) {
        return candidates;
      }
      candidates = await invokeTauri<CommandCompletionCandidate[]>("command_completion_suggest", { request });
      candidates = candidates.filter((candidate) => candidate.provider === "path");
      if (candidates.length > 0) break;
    }
    return candidates;
  },
  async resolveCwd(runtimeSessionId, currentCwd, target) {
    const resources = terminalRuntimeResources.acquire(runtimeSessionId);
    const resolved = await invokeTauri<string | null>("command_completion_resolve_cwd", {
      request: {
        runtime_session_id: runtimeSessionId,
        current_cwd: currentCwd,
        target,
      },
    });
    if (resolved && terminalRuntimeResources.isCurrent(runtimeSessionId, resources) && get().runtimes[runtimeSessionId]) {
      resources.knownCwd = resolved;
    }
    return resolved;
  },
  recordCwd(runtimeSessionId, cwd) {
    if (get().runtimes[runtimeSessionId] && cwd.trim()) {
      terminalRuntimeResources.acquire(runtimeSessionId).knownCwd = cwd;
    }
  },
  async resizeTerminal(runtimeSessionId, cols, rows) {
    await invokeTypedTauri("terminal_resize", { runtimeSessionId, cols, rows });
    terminalRuntimeResources.get(runtimeSessionId)?.replayBuffer?.resize(cols, rows);
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
    await invokeTypedTauri("terminal_close", {
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
      terminalRuntimeResources.release(runtimeSessionId);
      return { runtimes, outputChunks, inputSerialByRuntime };
    });
  },
  appendOutput(runtimeSessionId, data) {
    const resources = terminalRuntimeResources.acquire(runtimeSessionId);
    resources.outputTail = trimTerminalOutput(`${resources.outputTail}${data}`);
    resources.visualOutputTail = trimTerminalVisualTail(`${resources.visualOutputTail}${data}`);
    const replayed = replayBufferFor(resources, get().runtimes[runtimeSessionId]).append(data);
    resources.replayAppendCapture?.push(replayed);
    if (resources.liveOutputSubscriptions <= 0) {
      return replayed;
    }
    set((state) => ({
      outputChunks: {
        ...state.outputChunks,
        [runtimeSessionId]: [
          ...(state.outputChunks[runtimeSessionId] ?? []),
          { serial: (resources.outputSerial += 1), data },
        ],
      },
    }));
    resources.liveOutputChunkCapture?.push(resources.outputSerial);
    return replayed;
  },
  getOutputTail(runtimeSessionId) {
    return terminalRuntimeResources.get(runtimeSessionId)?.outputTail ?? "";
  },
  getReplayOutput(runtimeSessionId) {
    const resources = terminalRuntimeResources.get(runtimeSessionId);
    const rawOutput = resources?.outputTail ?? "";
    return resources?.replayBuffer?.replay(rawOutput) ?? { data: rawOutput, kind: "raw" };
  },
  getVisualOutputTail(runtimeSessionId) {
    return terminalRuntimeResources.get(runtimeSessionId)?.visualOutputTail ?? "";
  },
  getVisualOutputTailSnapshot() {
    return terminalRuntimeResources.visualOutputTailSnapshot();
  },
  beginLiveOutput(runtimeSessionId) {
    const resources = terminalRuntimeResources.acquire(runtimeSessionId);
    resources.liveOutputSubscriptions += 1;
    void ensureTerminalOutputFlow(runtimeSessionId, resources);
    return () => {
      if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
      const nextCount = Math.max(0, resources.liveOutputSubscriptions - 1);
      if (nextCount === 0) {
        resources.liveOutputSubscriptions = 0;
        set((state) => {
          const { [runtimeSessionId]: _outputChunk, ...outputChunks } = state.outputChunks;
          return { outputChunks };
        });
      } else {
        resources.liveOutputSubscriptions = nextCount;
      }
    };
  },
  discardLiveOutputChunks(runtimeSessionId, throughSerial) {
    set((state) => {
      const chunks = state.outputChunks[runtimeSessionId];
      if (!chunks?.length) return state;
      const remaining = chunks.filter((chunk) => chunk.serial > throughSerial);
      if (remaining.length === chunks.length) return state;
      if (remaining.length === 0) {
        const { [runtimeSessionId]: _outputChunks, ...outputChunks } = state.outputChunks;
        return { outputChunks };
      }
      return {
        outputChunks: {
          ...state.outputChunks,
          [runtimeSessionId]: remaining,
        },
      };
    });
  },
}));

function consumeTerminalDataEvent(event: TerminalDataEvent, getState: () => TerminalState) {
  const runtimeSessionId = event.runtime_session_id;
  const resources = terminalRuntimeResources.acquire(runtimeSessionId);
  const replayAppends: Promise<void>[] = [];
  const liveOutputSerials: number[] = [];
  resources.replayAppendCapture = replayAppends;
  resources.liveOutputChunkCapture = liveOutputSerials;
  try {
    consumeTerminalZmodemData(
      {
        runtimeSessionId,
        data: event.data,
        dataBase64: event.data_base64,
      },
      { appendOutput: getState().appendOutput },
    );
  } finally {
    resources.replayAppendCapture = null;
    resources.liveOutputChunkCapture = null;
  }
  const waitsForRenderedOutput = replayAppends.length > 0;

  const flowEvent: TerminalOutputFlowEvent = {
    runtimeSessionId,
    generation: event.generation,
    sequence: event.sequence,
  };
  const lastLiveOutputSerial = liveOutputSerials.at(-1);
  if (lastLiveOutputSerial !== undefined) useTerminalStore.setState((state) => {
    const chunks = state.outputChunks[runtimeSessionId];
    const chunkIndex = chunks?.findIndex((chunk) => chunk.serial === lastLiveOutputSerial) ?? -1;
    if (chunkIndex < 0 || !chunks) return state;
    return {
      outputChunks: {
        ...state.outputChunks,
        [runtimeSessionId]: chunks.map((chunk, index) =>
          index === chunkIndex ? { ...chunk, flow: flowEvent } : chunk,
        ),
      },
    };
  });
  const acknowledge = resources.outputAckChain
    .catch(() => undefined)
    .then(async () => {
      await Promise.all(replayAppends);
      if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
      await ensureTerminalOutputFlow(runtimeSessionId, resources);
      if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
      if (waitsForRenderedOutput) {
        await waitForTerminalOutputRender(flowEvent);
      }
      if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
      await acknowledgeTerminalOutputFlow(flowEvent);
    })
    .catch(() => undefined);
  resources.outputAckChain = acknowledge;
}

function ensureTerminalOutputFlow(
  runtimeSessionId: string,
  resources = terminalRuntimeResources.acquire(runtimeSessionId),
) {
  if (resources.outputFlowRelease) return Promise.resolve();
  if (resources.outputFlowOpen) return resources.outputFlowOpen;
  const opening = openTerminalOutputFlow(runtimeSessionId)
    .then((release) => {
      if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) {
        release();
        return;
      }
      resources.outputFlowRelease = release;
    })
    .catch(() => undefined);
  resources.outputFlowOpen = opening;
  void opening.then(() => {
    if (terminalRuntimeResources.isCurrent(runtimeSessionId, resources) && resources.outputFlowOpen === opening) {
      resources.outputFlowOpen = null;
    }
  });
  return opening;
}

function queueRuntimeCwdResolution(
  runtimeSessionId: string,
  target: string | null,
  resources: TerminalRuntimeResources,
  getState: () => TerminalState,
) {
  const previous = resources.cwdResolution ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (!terminalRuntimeResources.isCurrent(runtimeSessionId, resources)) return;
    const currentCwd = resources.knownCwd
      ?? getState().runtimes[runtimeSessionId]?.initial_cwd
      ?? null;
    const resolved = await invokeTauri<string | null>("command_completion_resolve_cwd", {
      request: {
        runtime_session_id: runtimeSessionId,
        current_cwd: currentCwd,
        target,
      },
    });
    if (resolved && terminalRuntimeResources.isCurrent(runtimeSessionId, resources) && getState().runtimes[runtimeSessionId]) {
      resources.knownCwd = resolved;
    }
  });
  resources.cwdResolution = current;
  const release = () => {
    if (terminalRuntimeResources.isCurrent(runtimeSessionId, resources) && resources.cwdResolution === current) {
      resources.cwdResolution = null;
    }
  };
  void current.then(release, release);
}

function isPathCompletionInput(input: string) {
  const segment = input.split(/[|;&](?![|&])/).at(-1)?.trimStart() ?? "";
  return PATH_COMMAND_CONTEXT.test(segment) || (
    DOCKER_COMPOSE_CONTEXT.test(segment) && DOCKER_COMPOSE_PATH_CONTEXT.test(segment)
  );
}

function isPathCompletionLookupInput(input: string) {
  const segment = input.split(/[|;&](?![|&])/).at(-1)?.trimStart() ?? "";
  return PATH_COMMAND_LOOKUP.test(segment) || (
    DOCKER_COMPOSE_CONTEXT.test(segment) && DOCKER_COMPOSE_PATH_LOOKUP.test(segment)
  );
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

function replayBufferFor(resources: TerminalRuntimeResources, runtime: RuntimeSessionInfo | undefined) {
  if (resources.replayBuffer) {
    return resources.replayBuffer;
  }
  const buffer = new TerminalReplayBuffer(runtime?.cols, runtime?.rows);
  resources.replayBuffer = buffer;
  return buffer;
}
