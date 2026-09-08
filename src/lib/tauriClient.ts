// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type Options, type UnlistenFn } from "@tauri-apps/api/event";

import {
  browserTauriMockEnabled,
  invokeBrowserTauri,
  listenBrowserTauri,
} from "./browserTauriMock";

type TauriInvokeArgs = Record<string, unknown>;

export function invokeTauri<T = void>(command: string, args?: TauriInvokeArgs): Promise<T> {
  if (browserTauriMockEnabled()) return invokeBrowserTauri<T>(command, args);
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

interface TypedCommandArgs {
  terminal_write: { runtimeSessionId: string; data: string };
  terminal_resize: { runtimeSessionId: string; cols: number; rows: number };
  terminal_close: { runtimeSessionId: string; releaseExternalSession?: boolean };
  agent_set_active_terminal: { runtimeSessionId: string | null };
  agent_codex_close: { agentSessionId: string; runtimeSessionId: string };
}

/** 核心终端生命周期命令禁止任意参数名；其余 IPC 渐进迁移。 */
export function invokeTypedTauri<K extends keyof TypedCommandArgs>(
  command: K,
  args: TypedCommandArgs[K],
): Promise<void> {
  return invokeTauri<void>(command, args);
}

export function listenTauri<T>(event: string, handler: EventCallback<T>, options?: Options): Promise<UnlistenFn> {
  if (browserTauriMockEnabled()) return listenBrowserTauri(event, handler);
  return options === undefined ? listen<T>(event, handler) : listen<T>(event, handler, options);
}

export type { UnlistenFn };
