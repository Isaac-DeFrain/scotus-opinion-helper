import { useEffect } from "react";

import type { ExchangeSummary } from "@/src/chat/analytics";

type HistoryDirection = "newer" | "older";

type UseHistoryKeyboardNavProps = {
  items: ExchangeSummary[];
  selectedExchangeId: number | null;
  onSelect: (id: number) => void;
  isBlocked: boolean;
};

function isHistoryShortcut(event: KeyboardEvent): HistoryDirection | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }

  if (event.key === "ArrowUp") return "newer";
  if (event.key === "ArrowDown") return "older";
  return null;
}

/**
 * Navigates persisted exchanges with Ctrl+ArrowUp (newer) and Ctrl+ArrowDown (older).
 */
export function useHistoryKeyboardNav({
  items,
  selectedExchangeId,
  onSelect,
  isBlocked,
}: UseHistoryKeyboardNavProps): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isBlocked) return;

      const direction = isHistoryShortcut(event);
      if (!direction || items.length === 0) return;

      const currentIndex =
        selectedExchangeId === null
          ? -1
          : items.findIndex((item) => item.id === selectedExchangeId);

      let nextIndex: number;
      if (direction === "newer") {
        nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
      } else {
        nextIndex =
          currentIndex < 0 ? 0 : Math.min(currentIndex + 1, items.length - 1);
      }

      const nextItem = items[nextIndex];
      if (!nextItem || nextItem.id === selectedExchangeId) return;

      event.preventDefault();
      onSelect(nextItem.id);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isBlocked, items, onSelect, selectedExchangeId]);
}
