export interface RunEvent {
  id: string;
  workflowId: string;
  status: string;
  trigger: string;
  errorType?: string; // set on failed runs (transient|auth|logic|unknown)
}

type Listener = (event: RunEvent) => void;

const listeners = new Map<string, Set<Listener>>();

function key(spaceId: string, workflowId: string): string {
  return `${spaceId} ${workflowId}`;
}

export function emitRun(spaceId: string, event: RunEvent): void {
  const set = listeners.get(key(spaceId, event.workflowId));
  if (!set) return;
  for (const l of set) {
    try {
      l(event);
    } catch {
      void 0;
    }
  }
}

export function onRun(
  spaceId: string,
  workflowId: string,
  listener: Listener,
): () => void {
  const k = key(spaceId, workflowId);
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(k);
  };
}
