import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { matchAppShortcut } from "../shortcuts";
import { useActiveTab, useStore } from "../store";
import { getController } from "../terminalRegistry";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface SearchOverlayHandle {
  /** Jump to the next match, or focus the input when there is no query yet. */
  findNext: () => void;
  /** Focus the input and select the current query so typing replaces it. */
  focus: () => void;
}

// Find / Find Next while typing in the box: ⌘F / ⌘G on macOS,
// Ctrl+Shift+F / Ctrl+Shift+G elsewhere. The window-level shortcut handler
// ignores key events from inputs, so the shortcuts are mirrored here.
const isFindKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "find";
const isFindNextKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "findNext";

export const SearchOverlay = forwardRef<SearchOverlayHandle, Props>(
  function SearchOverlay({ open, onOpenChange }, ref) {
    const tab = useActiveTab();
    const activeId = useStore((s) => s.activeId);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    // Select the previous query on focus so a new search (typed or pasted)
    // replaces it instead of being appended to it.
    const focusInput = () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };

    useEffect(() => {
      if (open && tab?.info.kind !== "ftp") focusInput();
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
          else focusInput();
        },
        focus: focusInput,
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
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch(!event.shiftKey);
            else if (event.key === "Escape") onOpenChange(false);
            else if (isFindKey(event)) {
              // ⌘F inside the box re-selects the query, like ⌘F elsewhere.
              event.preventDefault();
              event.currentTarget.select();
            } else if (isFindNextKey(event)) {
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
