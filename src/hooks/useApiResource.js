import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads one server resource and reports loading / error / data.
 *
 * `loading` is **derived**, not stored: it is true whenever the key of the last
 * settled result differs from the key currently being requested. That removes
 * the need to call setState synchronously inside the effect — the pattern the
 * prototype used, and the cause of every `react-hooks/set-state-in-effect`
 * error it reported.
 *
 * In-flight requests are aborted and their results discarded when the key
 * changes or the component unmounts, so a slow response can never overwrite a
 * newer one.
 *
 * @param fetcher  (signal) => Promise<data>. May change identity freely; the
 *                 latest is always the one called.
 * @param deps     Values that identify the request. A change refetches.
 * @param options  `enabled` gates the request; `intervalMs` refetches on a
 *                 timer, for the queue screen where the server dictates cadence.
 */
export function useApiResource(fetcher, deps = [], options = {}) {
  const { enabled = true, intervalMs = null } = options;

  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState({ key: null, data: null, error: null });

  const key = enabled ? `${nonce}:${JSON.stringify(deps)}` : null;

  // The fetcher is held in a ref so a new closure on every render does not
  // retrigger the request. It is refreshed in an effect rather than during
  // render, and this effect is declared first so it lands before the one below
  // reads it.
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = new AbortController();
    let cancelled = false;

    async function run() {
      try {
        const data = await fetcherRef.current(controller.signal);
        if (!cancelled) setSettled({ key, data, error: null });
      } catch (error) {
        if (cancelled || error?.name === "AbortError") return;
        setSettled({ key, data: null, error });
      }
    }

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, enabled]);

  // Polling refetches in the background; it never puts the screen back into a
  // loading state, so a refreshing queue does not flicker.
  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;

    const timer = setInterval(reload, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, reload]);

  const isFirstLoad = settled.key === null;

  return {
    data: settled.data,
    error: settled.error,
    loading: enabled && settled.key !== key,
    /** True only before anything has ever loaded — for skeletons vs. refreshes. */
    initialLoading: enabled && isFirstLoad,
    reload,
  };
}

export default useApiResource;
