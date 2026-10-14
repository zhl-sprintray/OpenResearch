/** Swipe gestures of the Mobile layout. Every gesture has a button doing the
 * same thing; gestures are shortcuts only. */

export type SwipeAction = "openDrawer" | "closeDrawer" | "popPanel";

export interface SwipeTrack {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface SwipeContext {
  drawerOpen: boolean;
  /** A full-screen panel (or the desktop-only placeholder) covers the chat. */
  panelOpen: boolean;
  /** Right-to-left layouts put the drawer on the right and mirror swipes. */
  rtl: boolean;
  /** Viewport width, to measure the start edge in right-to-left layouts. */
  width: number;
}

/** Touches starting closer than this to the edge belong to the browser:
 * iOS Safari's tab back/forward swipe starts at the screen edge. */
export const EDGE_INSET = 20;
/** Edge swipes must start within this distance of the edge. */
export const EDGE_ZONE = 56;
/** Minimum horizontal travel for a swipe. */
export const MIN_TRAVEL = 60;

/** Classifies a finished one-finger touch into a navigation action, or null
 * when it was not a swipe this layout handles. */
export function classifySwipe(track: SwipeTrack, context: SwipeContext): SwipeAction | null {
  const sign = context.rtl ? -1 : 1;
  // Distance travelled toward the end edge (rightward in left-to-right).
  const forward = (track.endX - track.startX) * sign;
  const vertical = Math.abs(track.endY - track.startY);
  if (Math.abs(forward) < MIN_TRAVEL || Math.abs(forward) < vertical * 1.5) return null;

  if (context.drawerOpen) return forward < 0 ? "closeDrawer" : null;
  if (forward < 0) return null;
  const fromEdge = context.rtl ? context.width - track.startX : track.startX;
  if (fromEdge < EDGE_INSET || fromEdge > EDGE_ZONE) return null;
  return context.panelOpen ? "popPanel" : "openDrawer";
}
