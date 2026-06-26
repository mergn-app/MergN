import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

const INTERACTIVE = "button, input, textarea, select, a[href]";

export function useShowcaseSpacePause(
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>,
): {
  rootRef: RefObject<HTMLDivElement | null>;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
} {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      if (e.repeat) return;
      const root = rootRef.current;
      if (!root || document.activeElement !== root) return;
      e.preventDefault();
      setPlaying((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setPlaying]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(INTERACTIVE)) return;
    rootRef.current?.focus({ preventScroll: true });
  };

  return { rootRef, onPointerDown };
}
