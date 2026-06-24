import { useCallback, useEffect, useRef } from "react";

// How close to the bottom (px) the user must be for auto-scroll to stay engaged.
const PIN_THRESHOLD = 80;

/**
 * Keeps a scroll container pinned to the bottom as its content grows (e.g. while
 * an AI message streams in). If the user scrolls up, auto-scroll disengages until
 * they return near the bottom — so we never yank them away from older messages.
 *
 * Returns a ref to pass as the ScrollArea's `viewportRef`.
 */
export function useStickToBottom(dep: unknown) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Track the user's scroll position to decide whether to keep auto-scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Observe content growth — catches streaming text that grows between renders.
  useEffect(() => {
    const el = viewportRef.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // Jump to bottom when messages are added/replaced (new turn, history load).
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [dep, scrollToBottom]);

  return viewportRef;
}
