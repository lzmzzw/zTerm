// Author: Liz
import { TerminalReplayBuffer } from "./terminalReplay";

export interface TerminalRuntimeResources {
  commandInput: string;
  completionRequestGeneration: number;
  cwdResolution: Promise<void> | null;
  knownCwd: string | null;
  liveOutputSubscriptions: number;
  liveOutputChunkCapture: number[] | null;
  outputSerial: number;
  outputFlowOpen: Promise<void> | null;
  outputFlowRelease: (() => void) | null;
  outputAckChain: Promise<void>;
  outputTail: string;
  replayAppendCapture: Promise<void>[] | null;
  replayBuffer: TerminalReplayBuffer | null;
  visualOutputTail: string;
}

export class TerminalRuntimeResourceRegistry {
  private readonly resourcesByRuntime = new Map<string, TerminalRuntimeResources>();

  acquire(runtimeSessionId: string) {
    const existing = this.resourcesByRuntime.get(runtimeSessionId);
    if (existing) return existing;
    const resources: TerminalRuntimeResources = {
      commandInput: "",
      completionRequestGeneration: 0,
      cwdResolution: null,
      knownCwd: null,
      liveOutputSubscriptions: 0,
      liveOutputChunkCapture: null,
      outputSerial: 0,
      outputFlowOpen: null,
      outputFlowRelease: null,
      outputAckChain: Promise.resolve(),
      outputTail: "",
      replayAppendCapture: null,
      replayBuffer: null,
      visualOutputTail: "",
    };
    this.resourcesByRuntime.set(runtimeSessionId, resources);
    return resources;
  }

  get(runtimeSessionId: string) {
    return this.resourcesByRuntime.get(runtimeSessionId) ?? null;
  }

  isCurrent(runtimeSessionId: string, resources: TerminalRuntimeResources) {
    return this.resourcesByRuntime.get(runtimeSessionId) === resources;
  }

  release(runtimeSessionId: string) {
    const resources = this.resourcesByRuntime.get(runtimeSessionId);
    if (!resources) return;
    resources.outputFlowRelease?.();
    resources.replayBuffer?.dispose();
    this.resourcesByRuntime.delete(runtimeSessionId);
  }

  clear() {
    for (const runtimeSessionId of this.resourcesByRuntime.keys()) {
      this.release(runtimeSessionId);
    }
  }

  visualOutputTailSnapshot() {
    return Object.fromEntries(
      Array.from(this.resourcesByRuntime, ([runtimeSessionId, resources]) => [runtimeSessionId, resources.visualOutputTail]),
    );
  }
}
