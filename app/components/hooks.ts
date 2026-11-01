"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One cancellable request at a time; starting a new one aborts the previous. */
export function useRequest() {
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(async <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    try {
      return await task(current.signal);
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }, []);

  const cancel = useCallback(() => controller.current?.abort(), []);
  return { busy, run, cancel };
}

/** Seconds since `active` became true, for long-running requests. */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}
