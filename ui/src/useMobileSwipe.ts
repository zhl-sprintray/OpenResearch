import { useEffect, useRef, type RefObject } from "react";
import { classifySwipe, type SwipeAction } from "./mobileGestures";

/** Listens for one-finger swipes on `target` and reports the navigation
 * action each one maps to (see classifySwipe). */
export function useMobileSwipe(
  target: RefObject<HTMLElement | null>,
  state: { drawerOpen: boolean; panelOpen: boolean },
  onSwipe: (action: SwipeAction) => void,
) {
  // Read the latest state and callback at touchend without re-binding listeners.
  const latest = useRef({ state, onSwipe });
  latest.current = { state, onSwipe };

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!start || !touch || event.touches.length > 0) return;
      const action = classifySwipe(
        { startX: start.x, startY: start.y, endX: touch.clientX, endY: touch.clientY },
        { ...latest.current.state, rtl: getComputedStyle(element).direction === "rtl", width: window.innerWidth },
      );
      start = null;
      if (action) latest.current.onSwipe(action);
    };
    const onCancel = () => { start = null; };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onCancel);
    };
  }, [target]);
}
