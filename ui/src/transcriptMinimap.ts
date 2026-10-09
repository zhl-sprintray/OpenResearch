import type { ChatMessage } from "./api";

/** One user turn on the transcript minimap, pointing at its virtual row. */
export interface MinimapItem {
  id: string;
  /** Index into the transcript's visible rows. */
  index: number;
  userText: string;
  /** The turn's last assistant answer, for the hover preview. */
  assistantText: string;
}

export const MINIMAP_MIN_ITEMS = 2;
const ITEM_SPACING = 8;
/** Relative to the transcript overlay, leaving room for the prev/next buttons. */
const MAX_HEIGHT_CSS = "calc(100% - 4rem)";
/** Gutter wide enough to keep the minimap visible without hovering. */
const PERSISTENT_GUTTER = 48;
const HIT_STRIP_START = 12;
const HIT_STRIP_MAX_WIDTH = 40;
/** The prev/next buttons hang 14px past the strip's start edge. */
const NAVIGATION_REACH = 14;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(message: ChatMessage, final: boolean): string {
  return compact(
    message.parts
      .filter((part) => part.type === "text" && !(final && part.phase === "commentary"))
      .map((part) => part.text ?? "")
      .join(" "),
  );
}

/** User turns in display order. Shell exchanges carry no prompt, so they are skipped. */
export function deriveMinimapItems(messages: readonly ChatMessage[]): MinimapItem[] {
  const items: MinimapItem[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    if (!message.parts.some((part) => part.type === "text" || part.type === "image" || part.type === "annotation")) return;
    let assistantText = "";
    for (let next = index + 1; next < messages.length && messages[next].role !== "user"; next += 1) {
      assistantText = textOf(messages[next], true) || assistantText;
    }
    items.push({ id: message.id, index, userText: textOf(message, false), assistantText });
  });
  return items;
}

export function minimapHeightStyle(itemCount: number): string {
  return `min(${Math.max(1, (itemCount - 1) * ITEM_SPACING)}px, ${MAX_HEIGHT_CSS})`;
}

export function minimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function minimapIndexFromPointer(itemCount: number, railTop: number, railHeight: number, pointerY: number): number | null {
  if (itemCount <= 0 || railHeight <= 0) return null;
  const progress = Math.max(0, Math.min(1, (pointerY - railTop) / railHeight));
  return Math.round(progress * (itemCount - 1));
}

/** The first turn in view, else the last one scrolled past. */
export function minimapCurrentIndex(
  scrollTop: number,
  scrollBottom: number,
  bounds: ReadonlyArray<{ top: number; height: number } | null>,
): number | null {
  let preceding: number | null = null;
  for (const [index, item] of bounds.entries()) {
    if (!item) continue;
    if (item.top < scrollBottom && item.top + Math.max(1, item.height) > scrollTop) return index;
    if (item.top <= scrollTop) preceding = index;
  }
  return preceding;
}

export function minimapHasPersistentGutter(sideGutter: number): boolean {
  return sideGutter >= PERSISTENT_GUTTER;
}

/** Cap the hover strip to the side gutter so it never covers message text; 0 makes it inert. */
export function minimapHitStripWidth(sideGutter: number): number {
  return Math.max(0, Math.min(HIT_STRIP_MAX_WIDTH, Math.floor(sideGutter) - HIT_STRIP_START));
}

export function minimapNavigationInteractive(hitStripWidth: number): boolean {
  return hitStripWidth >= NAVIGATION_REACH;
}
