import { useEffect, useState, type CSSProperties } from "react";

interface Box { top: number; height: number }

function read(): Box | null {
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  // Pinch zoom also shrinks the visual viewport; only the soft keyboard should.
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return null;
  return { top: viewport.offsetTop, height: viewport.height };
}

/** Pin an element to the visual viewport, so the soft keyboard shrinks it
 * instead of covering its bottom edge (where the composer sits). Mobile
 * browsers keep the layout viewport, and with it `100%` heights, the same
 * size while the keyboard is up. */
export function useVisualViewportStyle(): CSSProperties | undefined {
  const [box, setBox] = useState<Box | null>(read);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setBox(read());
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return box ? { position: "fixed", insetInlineStart: 0, width: "100%", top: box.top, height: box.height } : undefined;
}
