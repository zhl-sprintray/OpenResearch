import { useEffect, useRef } from "react";
import { followRunLog } from "../runLogStream";
import { mountTerminal } from "./terminal";

/** Live log terminal for one run, fed by {@link followRunLog}. */
export function LogTerminal({ runId }: { runId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { terminal: term, dispose } = mountTerminal(wrap, true);
    const stop = followRunLog(runId, (bytes) => term.write(bytes));
    return () => {
      stop();
      dispose();
    };
  }, [runId]);

  return <div ref={wrapRef} className="h-full w-full" />;
}
