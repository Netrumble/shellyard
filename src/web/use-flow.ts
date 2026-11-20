import { useEffect, useState } from 'react';
import type { FlowSummary } from '../shared/types.js';
import { api } from './api.js';

/** How the day went, read now and every `everyMs` while the view showing it is open. */
export function useFlow(everyMs = 15_000): FlowSummary | null {
  const [flow, setFlow] = useState<FlowSummary | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      api
        .flow()
        .then((f) => live && setFlow(f))
        .catch(() => undefined);
    };
    read();
    const t = setInterval(read, everyMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return flow;
}
