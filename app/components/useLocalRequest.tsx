import { useEffect, useRef, useState } from "react";

/** A cancelled or unmounted view must never receive an old request's result. */
export function useLocalRequest() {
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  function begin() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    return request;
  }
  function isCurrent(request: AbortController) { return controller.current === request && !request.signal.aborted; }
  function finish(request: AbortController) {
    if (controller.current === request) { controller.current = null; setBusy(false); }
  }
  function cancel() { controller.current?.abort(); controller.current = null; setBusy(false); }
  return { busy, begin, isCurrent, finish, cancel };
}
