import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";

import { matchAppShortcut } from "../shortcuts";
import { useActiveTab, useStore } from "../store";
import { SEARCH_HIGHLIGHT_LIMIT, type SearchResults } from "../terminal";
import { getController } from "../terminalRegistry";
import { isFileSession } from "../types";
import { Icon } from "./icons";

interface Props {
  onClose: () => void;
}

export interface SearchOverlayHandle {
  /** Jump to the next match, or focus the input when there is no query yet. */
  findNext: () => void;
  /**
   * Focus the input and select the query so typing replaces it. A new
   * single-line terminal selection is searched instead, as when the box opens.
   */
  focus: () => void;
}

// Find / Find Next while typing in the box: ⌘F / ⌘G on macOS,
// Ctrl+Shift+F / Ctrl+Shift+G elsewhere. The window-level shortcut handler
// ignores key events from inputs, so the shortcuts are mirrored here.
const isFindKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "find";
const isFindNextKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "findNext";

/**
 * The terminal's current selection, which opening the box (or pressing ⌘F
 * again) searches for. Multi-line selections cannot match, so they yield "".
 */
const selectedText = (sessionId: string | null) => {
  if (!sessionId) return "";
  const text = getController(sessionId)?.term.getSelection() ?? "";
  return text.includes("\n") ? "" : text;
};

/** "3/12", "1000+" past the highlight limit, or "No results". */
const formatResults = ({ resultIndex, resultCount }: SearchResults) => {
  if (resultCount === 0) return "No results";
  const total =
    resultCount >= SEARCH_HIGHLIGHT_LIMIT
      ? `${SEARCH_HIGHLIGHT_LIMIT}+`
      : String(resultCount);
  return resultIndex >= 0 ? `${resultIndex + 1}/${total}` : total;
};

/**
 * The find box above the terminal. It is mounted only while open, so every
 * opening starts from the terminal selection (or empty) rather than from
 * the previous query.
 */
export const SearchOverlay = forwardRef<SearchOverlayHandle, Props>(
  function SearchOverlay({ onClose }, ref) {
    const tab = useActiveTab();
    const activeId = useStore((s) => s.activeId);
    const [query, setQuery] = useState(() => selectedText(activeId));
    const [results, setResults] = useState<SearchResults | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // The session whose buffer currently carries match highlights, so they
    // can be dropped when the search moves elsewhere or ends.
    const searchedRef = useRef<string | null>(null);

    // Select the previous query on focus so a new search (typed or pasted)
    // replaces it instead of being appended to it. A query taken from the
    // terminal selection is already being searched, so the caret just sits
    // after it.
    const focusInput = (selectQuery = true) => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (selectQuery) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    };

    const clearSearch = () => {
      if (searchedRef.current) getController(searchedRef.current)?.clearSearch();
      searchedRef.current = null;
      setResults(null);
    };

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

    // Highlights and the counter belong to one session; switching tabs ends
    // that search rather than showing stale numbers.
    useEffect(() => {
      if (searchedRef.current && searchedRef.current !== activeId) clearSearch();
    }, [activeId]);

    // Subscribed before the initial search below so its count is not missed:
    // the addon reports results synchronously.
    useEffect(() => {
      if (!activeId) return;
      const listener = getController(activeId)?.onSearchResults(setResults);
      return () => listener?.dispose();
    }, [activeId]);

    // Search the seeded selection right away; the search starts at the
    // selection, so it stays the current match. Closing the box drops the
    // highlights.
    useEffect(() => {
      if (query) runSearch(true, true);
      return clearSearch;
    }, []);

    // The tab the box opened in. Its seeded query is left unselected there;
    // after a tab switch the query is selected so typing replaces it. (Kept
    // as state, not a mutable ref, so StrictMode's repeated effects agree.)
    const [openedIn] = useState({ tab: tab?.info.id, seeded: query !== "" });
    useEffect(() => {
      if (tab && isFileSession(tab.info.kind)) return;
      focusInput(!(openedIn.seeded && tab?.info.id === openedIn.tab));
    }, [tab?.info.id, tab?.info.kind]);

    // Adopt a fresh terminal selection as the query and search it. The input
    // is updated synchronously so the focus that follows sees the new text.
    const adoptSelection = () => {
      const term = selectedText(activeId);
      if (!term || term === query) return false;
      flushSync(() => setQuery(term));
      runSearch(true, true, term);
      return true;
    };

    useImperativeHandle(
      ref,
      () => ({
        findNext: () => {
          if (query) runSearch(true);
          else focusInput();
        },
        focus: () => {
          const adopted = adoptSelection();
          focusInput(!adopted);
        },
      }),
      [activeId, query],
    );

    if (!tab || isFileSession(tab.info.kind)) return null;

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
            else if (event.key === "Escape") onClose();
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
          aria-label="Previous match"
        >
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action"
          onClick={() => runSearch(true)}
          title="Next match"
          aria-label="Next match"
        >
          <Icon name="arrow-down" />
        </button>
        <button
          className="panel-action"
          onClick={onClose}
          title="Close search"
          aria-label="Close search"
        >
          <Icon name="close" />
        </button>
      </div>
    );
  },
);
