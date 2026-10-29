// Author: Liz
import { invokeTypedTauri } from "../../lib/tauriClient";

/** Preserve binary mouse/ZMODEM octets instead of UTF-8 encoding them. */
export function writeTerminalBytes(runtimeSessionId: string, data: number[]): Promise<void> {
  return invokeTypedTauri("terminal_write_bytes", { runtimeSessionId, data });
}
