import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { m } from "../paraglide/messages.js";
import {
  MINIMAP_MIN_ITEMS,
  minimapCurrentIndex,
  minimapHasPersistentGutter,
  minimapHeightStyle,
  minimapHitStripWidth,
  minimapIndexFromPointer,
  minimapNavigationInteractive,
  minimapTopPercent,
  type MinimapItem,
} from "../transcriptMinimap";
import { Tooltip } from "./ui";
import { cn } from "./ui/cn";

/** Where the preview card starts, past the ticks. */
const PREVIEW_START = 32;

/** One tick per user turn along the transcript's start edge (after t3code's
 * timeline minimap). Hover previews a turn, click jumps to it, and the chevrons
 * step to the previous or next turn from the reader's position. Rendered into
 * `host`, a non-scrolling box laid over the scroller. */
export function TranscriptMinimap({
  host,
  scrollEl,
  columnEl,
  items,
  getBounds,
  onSelect,
}: {
  host: HTMLElement | null;
  scrollEl: HTMLElement | null;
  /** The centered content column rows are laid out in; the gap beside it is the minimap's gutter. */
  columnEl: HTMLElement | null;
  items: MinimapItem[];
  /** A row's top and height relative to `columnEl`, if measured. */
  getBounds: (index: number) => { top: number; height: number } | null;
  onSelect: (item: MinimapItem) => void;
}) {
  const [strips] = useState(() => new Map<string, HTMLSpanElement>());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [sideGutter, setSideGutter] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const latest = useRef({ items, getBounds });
  const scheduleUpdate = useRef(() => {});
  useLayoutEffect(() => {
    latest.current = { items, getBounds };
  });

  // The listener lives as long as the scroller; renders only queue a frame,
  // since streamed rows resize without scrolling.
  useEffect(() => {
    if (!scrollEl) return;
    const update = () => {
      const { items, getBounds } = latest.current;
      const scrollTop = scrollEl.scrollTop;
      const scrollBottom = scrollTop + scrollEl.clientHeight;
      const offset = columnEl ? columnEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollTop : 0;
      const bounds = items.map((item) => {
        const box = getBounds(item.index);
        return box && { top: box.top + offset, height: box.height };
      });
      items.forEach((item, index) => {
        const strip = strips.get(item.id);
        const box = bounds[index];
        const next = box && box.top < scrollBottom && box.top + Math.max(1, box.height) > scrollTop ? "true" : "false";
        // Runs every scroll frame; skip writes that would not change anything.
        if (strip && strip.dataset.inView !== next) strip.dataset.inView = next;
      });
      setCurrentIndex(minimapCurrentIndex(scrollTop, scrollBottom, bounds));
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scheduleUpdate.current = schedule;
    schedule();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollEl.removeEventListener("scroll", schedule);
      scheduleUpdate.current = () => {};
    };
  }, [scrollEl, columnEl, strips]);

  useEffect(() => {
    scheduleUpdate.current();
  });

  useEffect(() => {
    if (!scrollEl || !columnEl) return;
    const measure = () => {
      const outer = scrollEl.getBoundingClientRect();
      const column = columnEl.getBoundingClientRect();
      const rtl = getComputedStyle(scrollEl).direction === "rtl";
      setSideGutter(Math.max(0, rtl ? outer.right - column.right : column.left - outer.left));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    observer.observe(columnEl);
    return () => observer.disconnect();
  }, [scrollEl, columnEl]);

  const count = items.length;
  const pointerIndex = useCallback((event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return minimapIndexFromPointer(count, rect.top, rect.height, event.clientY);
  }, [count]);

  if (!host || count < MINIMAP_MIN_ITEMS) return null;

  const active = activeIndex !== null && activeIndex < count ? activeIndex : null;
  const activeItem = active === null ? null : items[active];
  const current = currentIndex !== null && currentIndex < count ? currentIndex : null;
  const previousItem = current === null ? null : items[current - 1] ?? null;
  const nextItem = current === null ? null : items[current + 1] ?? null;
  const hitStripWidth = minimapHitStripWidth(sideGutter);
  const navigationInteractive = minimapNavigationInteractive(hitStripWidth);
  const moveActive = (delta: number) =>
    setActiveIndex((index) => Math.max(0, Math.min(count - 1, (index ?? current ?? 0) + delta)));
  const selectFromKeyboard = () => {
    const item = activeItem ?? (current === null ? null : items[current]);
    if (item) onSelect(item);
  };

  return createPortal(
    <div
      className={cn(
        "transcript-minimap group/minimap pointer-events-none absolute inset-y-0 start-0 z-20 hidden w-18 [@media(pointer:fine)]:block",
        minimapHasPersistentGutter(sideGutter)
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {/* The rail never grows past the gutter, so it cannot cover message text;
        only the preview card (and the bridge leading to it) reaches into the column. */}
      <div
        ref={railRef}
        className={cn(
          "absolute start-3 top-1/2 -translate-y-1/2 select-none",
          hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ height: minimapHeightStyle(count), width: hitStripWidth }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <MinimapStep direction="previous" target={previousItem} interactive={navigationInteractive} onSelect={onSelect} />
        <button
          type="button"
          aria-label={m.chat_minimap_jump_to({ text: activeItem?.userText || m.chat_minimap_user_message() })}
          aria-describedby={activeItem?.assistantText ? previewId : undefined}
          className="absolute inset-y-0 start-0 w-full cursor-pointer bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-text"
          onMouseMove={(event) => setActiveIndex(pointerIndex(event))}
          onFocus={() => setActiveIndex((index) => index ?? current ?? 0)}
          onBlur={() => {
            // Keep the preview while the pointer is on it, so its text stays selectable.
            if (!railRef.current?.matches(":hover")) setActiveIndex(null);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            // Keyboard activation is handled on keydown; a synthetic click has no pointer position.
            if (event.detail === 0) return;
            const index = pointerIndex(event);
            if (index !== null) onSelect(items[index]);
            event.currentTarget.blur();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") moveActive(1);
            else if (event.key === "ArrowUp") moveActive(-1);
            else if (event.key === "Home") setActiveIndex(0);
            else if (event.key === "End") setActiveIndex(count - 1);
            else if (event.key === "Enter" || event.key === " ") selectFromKeyboard();
            else return;
            event.preventDefault();
          }}
        >
          {items.map((item, index) => {
            const distance = active === null ? null : Math.abs(index - active);
            return (
              // Only transform and opacity animate: in-view state flips on every
              // scroll frame, so width tiers are a scale-x and the highlight is a
              // faded overlay rather than a background-color transition.
              <span
                key={item.id}
                ref={(node) => {
                  if (node) strips.set(item.id, node);
                  else strips.delete(item.id);
                }}
                aria-hidden
                data-in-view="false"
                className={cn(
                  "group/strip pointer-events-none absolute start-0 h-0.5 w-6 -translate-y-1/2 rounded-full transition-transform duration-150 ltr:origin-left rtl:origin-right",
                  distance === 0 ? "bg-subtext/75" : "bg-subtext/35",
                  distance === 0 ? "scale-x-100" : distance === 1 ? "scale-x-67" : distance === 2 ? "scale-x-42" : "scale-x-33",
                )}
                style={{ top: `${minimapTopPercent(index, count)}%` }}
              >
                <span className="absolute inset-0 rounded-full bg-text opacity-0 transition-opacity duration-150 group-data-[in-view=true]/strip:opacity-90" />
              </span>
            );
          })}
        </button>
        {activeItem && active !== null && (
          // Starts at the rail's edge; the transparent padding bridges the pointer
          // across to the card without the rail itself widening.
          <div
            className="absolute w-80 cursor-text select-text"
            style={{
              insetInlineStart: hitStripWidth,
              paddingInlineStart: Math.max(0, PREVIEW_START - hitStripWidth),
              top: `${minimapTopPercent(active, count)}%`,
              transform: `translateY(${active === 0 ? "0%" : active === count - 1 ? "-100%" : "-50%"})`,
            }}
          >
            <div className="rounded-lg border border-border bg-background p-3 text-start shadow-popover">
              <div className="truncate text-sm font-medium text-text" dir="auto">
                {activeItem.userText || m.chat_minimap_user_message()}
              </div>
              {activeItem.assistantText && (
                <div id={previewId} className="mt-1 line-clamp-3 text-sm text-subtext" dir="auto">
                  {activeItem.assistantText}
                </div>
              )}
            </div>
          </div>
        )}
        <MinimapStep direction="next" target={nextItem} interactive={navigationInteractive} onSelect={onSelect} />
      </div>
    </div>,
    host,
  );
}

function MinimapStep({
  direction,
  target,
  interactive,
  onSelect,
}: {
  direction: "previous" | "next";
  target: MinimapItem | null;
  /** False when the gutter is too narrow, so the button cannot cover message text. */
  interactive: boolean;
  onSelect: (item: MinimapItem) => void;
}) {
  const previous = direction === "previous";
  const label = previous ? m.chat_minimap_previous_turn() : m.chat_minimap_next_turn();
  const Icon = previous ? ChevronUp : ChevronDown;
  return (
    <span
      className={cn(
        "absolute start-1 z-10 inline-flex opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 ltr:-translate-x-1/2 rtl:translate-x-1/2",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
      )}
    >
      <Tooltip interactive content={label} side={previous ? "top" : "bottom"} className="rounded-sm">
        <button
          type="button"
          aria-label={label}
          disabled={target === null}
          onClick={() => {
            if (target) onSelect(target);
          }}
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm p-0 text-subtext hover:bg-surface hover:text-text disabled:pointer-events-none disabled:opacity-64 focus-visible:outline-2 focus-visible:outline-text"
        >
          <Icon size={16} className="text-text/90" />
        </button>
      </Tooltip>
    </span>
  );
}
