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

export function listenTauri<T>(event: string, handler: EventCallback<T>, options?: Options): Promise<UnlistenFn> {
  if (browserTauriMockEnabled()) return listenBrowserTauri(event, handler);
  return options === undefined ? listen<T>(event, handler) : listen<T>(event, handler, options);
}

export type { UnlistenFn };
