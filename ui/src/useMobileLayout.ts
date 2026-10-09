import { useSyncExternalStore } from "react";

/** The Mobile layout's only breakpoint: viewports narrower than this use
 * MobileShell, wider ones the desktop shell. */
export const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`;

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

/** Whether the viewport is in the Mobile layout; re-renders when a resize
 * crosses the breakpoint. Depends only on width, never on how the dashboard
 * is reached. */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribe, isMobile, isMobile);
}
