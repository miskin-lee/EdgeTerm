import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { IS_MAC } from "../platform";
import { useActiveTab, useStore } from "../store";
import { getController } from "../terminalRegistry";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface SearchOverlayHandle {
  /** Jump to the next match, or focus the input when there is no query yet. */
  findNext: () => void;
}

// Find Next while typing in the box: ⌘G on macOS, Alt+G elsewhere. The
// window-level shortcut handler ignores key events from inputs, so the
// shortcut is mirrored here.
const isFindNextKey = (event: KeyboardEvent) =>
  event.key.toLowerCase() === "g" &&
  !event.shiftKey &&
  (IS_MAC
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey);

export const SearchOverlay = forwardRef<SearchOverlayHandle, Props>(
  function SearchOverlay({ open, onOpenChange }, ref) {
    const tab = useActiveTab();
    const activeId = useStore((s) => s.activeId);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (open && tab?.info.kind !== "ftp") inputRef.current?.focus();
    }, [open, tab?.info.id, tab?.info.kind]);

    const runSearch = (forward: boolean) => {
      if (!activeId || !query) return;
      getController(activeId)?.search(query, forward);
    };

    useImperativeHandle(
      ref,
      () => ({
        findNext: () => {
          if (query) runSearch(true);
          else inputRef.current?.focus();
        },
      }),
      [activeId, query],
    );

    if (!open || !tab || tab.info.kind === "ftp") return null;

    return (
      <div className="terminal-search" role="search">
        <input
          ref={inputRef}
          value={query}
          placeholder="Find in buffer"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch(!event.shiftKey);
            else if (event.key === "Escape") onOpenChange(false);
            else if (isFindNextKey(event)) {
              event.preventDefault();
              runSearch(true);
            }
          }}
        />
        <button
          className="panel-action"
          onClick={() => runSearch(false)}
          title="Previous match"
        >
          ↑
        </button>
        <button
          className="panel-action"
          onClick={() => runSearch(true)}
          title="Next match"
        >
          ↓
        </button>
        <button
          className="panel-action"
          onClick={() => onOpenChange(false)}
          title="Close search"
        >
          ✕
        </button>
      </div>
    );
  },
);
