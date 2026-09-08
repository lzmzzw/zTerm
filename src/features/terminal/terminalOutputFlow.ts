// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

export interface TerminalOutputFlowEvent {
  runtimeSessionId: string;
  generation: number | null | undefined;
  sequence: number | null | undefined;
}

type CompleteTerminalOutputFlowEvent = TerminalOutputFlowEvent & {
  generation: number;
  sequence: number;
};

interface TerminalOutputFlowLease {
  generation: number;
}

interface RenderWaiter {
  generation: number;
  sequence: number;
  resolve: () => void;
}

interface RuntimeRenderState {
  consumers: number;
  renderedThroughByGeneration: Map<number, number>;
  waiters: RenderWaiter[];
}

const leases = new Map<string, number>();
const renderStates = new Map<string, RuntimeRenderState>();

export function resetTerminalOutputFlowForTest() {
  leases.clear();
  renderStates.clear();
}

export async function openTerminalOutputFlow(runtimeSessionId: string): Promise<() => void> {
  const lease = await invokeTauri<TerminalOutputFlowLease>("terminal_output_flow_open", { runtimeSessionId });
  leases.set(runtimeSessionId, lease.generation);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (leases.get(runtimeSessionId) === lease.generation) {
      leases.delete(runtimeSessionId);
      const renderState = renderStates.get(runtimeSessionId);
      if (renderState) {
        resolveAll(renderState);
        renderStates.delete(runtimeSessionId);
      }
      void invokeTauri("terminal_output_flow_close", {
        runtimeSessionId,
        generation: lease.generation,
      }).catch(() => undefined);
    }
  };
}

export function beginTerminalOutputRender(runtimeSessionId: string): () => void {
  const state = renderStateFor(runtimeSessionId);
  state.consumers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = renderStates.get(runtimeSessionId);
    if (current !== state) return;
    state.consumers = Math.max(0, state.consumers - 1);
    if (state.consumers === 0) {
      resolveAll(state);
      renderStates.delete(runtimeSessionId);
    }
  };
}

export function waitForTerminalOutputRender(event: TerminalOutputFlowEvent): Promise<void> {
  if (!isFlowEvent(event)) return Promise.resolve();
  const state = renderStates.get(event.runtimeSessionId);
  if (!state || state.consumers === 0) return Promise.resolve();
  const renderedThrough = state.renderedThroughByGeneration.get(event.generation) ?? 0;
  if (renderedThrough >= event.sequence) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.waiters.push({
      generation: event.generation,
      sequence: event.sequence,
      resolve,
    });
  });
}

export function markTerminalOutputRendered(event: TerminalOutputFlowEvent) {
  if (!isFlowEvent(event)) return;
  const state = renderStates.get(event.runtimeSessionId);
  if (!state) return;
  const previous = state.renderedThroughByGeneration.get(event.generation) ?? 0;
  if (event.sequence > previous) {
    state.renderedThroughByGeneration.set(event.generation, event.sequence);
  }
  resolveCompleted(state);
}

export async function acknowledgeTerminalOutputFlow(event: TerminalOutputFlowEvent): Promise<void> {
  if (!isFlowEvent(event) || leases.get(event.runtimeSessionId) !== event.generation) return;
  await invokeTauri("terminal_output_flow_ack", {
    runtimeSessionId: event.runtimeSessionId,
    generation: event.generation,
    sequence: event.sequence,
  });
}

function isFlowEvent(event: TerminalOutputFlowEvent): event is CompleteTerminalOutputFlowEvent {
  return Number.isSafeInteger(event.generation)
    && (event.generation ?? 0) > 0
    && Number.isSafeInteger(event.sequence)
    && (event.sequence ?? 0) > 0;
}

function renderStateFor(runtimeSessionId: string): RuntimeRenderState {
  let state = renderStates.get(runtimeSessionId);
  if (!state) {
    state = {
      consumers: 0,
      renderedThroughByGeneration: new Map(),
      waiters: [],
    };
    renderStates.set(runtimeSessionId, state);
  }
  return state;
}

function resolveCompleted(state: RuntimeRenderState) {
  state.waiters = state.waiters.filter((waiter) => {
    const renderedThrough = state.renderedThroughByGeneration.get(waiter.generation) ?? 0;
    if (renderedThrough < waiter.sequence) return true;
    waiter.resolve();
    return false;
  });
}

function resolveAll(state: RuntimeRenderState) {
  const waiters = state.waiters;
  state.waiters = [];
  waiters.forEach((waiter) => waiter.resolve());
}
