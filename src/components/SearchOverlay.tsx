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
import { SEARCH_HIGHLIGHT_LIMIT, type SearchResults } from "../terminal";
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

/** "3/12", "1000+" past the highlight limit, or "No results". */
const formatResults = ({ resultIndex, resultCount }: SearchResults) => {
  if (resultCount === 0) return "No results";
  const total =
    resultCount >= SEARCH_HIGHLIGHT_LIMIT
      ? `${SEARCH_HIGHLIGHT_LIMIT}+`
      : String(resultCount);
  return resultIndex >= 0 ? `${resultIndex + 1}/${total}` : total;
};

export const SearchOverlay = forwardRef<SearchOverlayHandle, Props>(
  function SearchOverlay({ open, onOpenChange }, ref) {
    const tab = useActiveTab();
    const activeId = useStore((s) => s.activeId);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResults | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // The session whose buffer currently carries match highlights, so they
    // can be dropped when the search moves elsewhere or ends.
    const searchedRef = useRef<string | null>(null);

    // Select the previous query on focus so a new search (typed or pasted)
    // replaces it instead of being appended to it.
    const focusInput = () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };

    const clearSearch = () => {
      if (searchedRef.current) getController(searchedRef.current)?.clearSearch();
      searchedRef.current = null;
      setResults(null);
    };

    useEffect(() => {
      if (open && tab?.info.kind !== "ftp") focusInput();
    }, [open, tab?.info.id, tab?.info.kind]);

    // Highlights and the counter belong to one session; switching tabs or
    // closing the box ends that search rather than showing stale numbers.
    useEffect(() => {
      if (!open || (searchedRef.current && searchedRef.current !== activeId)) {
        clearSearch();
      }
    }, [open, activeId]);

    useEffect(() => {
      if (!activeId) return;
      const listener = getController(activeId)?.onSearchResults(setResults);
      return () => listener?.dispose();
    }, [activeId]);

    const runSearch = (forward: boolean, incremental = false, term = query) => {
      if (!activeId) return;
      if (!term) {
        clearSearch();
        return;
      }
      if (searchedRef.current !== activeId) clearSearch();
      searchedRef.current = activeId;
      getController(activeId)?.search(term, forward, incremental);
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
          onChange={(event) => {
            const term = event.target.value;
            setQuery(term);
            // Search as the query is typed so the counter always matches it.
            runSearch(true, true, term);
          }}
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
        <span
          className={`search-count${
            results?.resultCount === 0 ? " is-empty" : ""
          }`}
          aria-live="polite"
        >
          {results ? formatResults(results) : ""}
        </span>
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
