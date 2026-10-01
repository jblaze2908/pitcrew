import { useCallback, useEffect, useRef, useState } from "react";

export interface Fetched<T> { data: T | null; error: string | null; reload: () => void }

/** Loads data for a view. A slower, older response never replaces a newer one; reload keeps the old data on screen. */
export function useFetch<T>(load: () => Promise<T>, deps: readonly unknown[]): Fetched<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const my = ++seq.current;
    load().then(
      (data) => { if (my === seq.current) setState({ data, error: null }); },
      (e: Error) => { if (my === seq.current) setState((s) => ({ data: s.data, error: e.message })); },
    );
  }, deps);
  useEffect(() => { setState({ data: null, error: null }); reload(); }, [reload]);
  return { ...state, reload };
}
