import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";

import { IS_MAC } from "../platform";
import {
  chordLabel,
  chordMatches,
  keyLabel,
  matchAppShortcut,
  type KeyChord,
} from "../shortcuts";
import { useActiveTab, useStore } from "../store";
import {
  DEFAULT_FIND_OPTIONS,
  queryError,
  SEARCH_HIGHLIGHT_LIMIT,
  setFindCloser,
  type FindOptions,
  type SearchResults,
} from "../terminalSearch";
import { getController } from "../terminalRegistry";
import { useTmux } from "../useTmux";
import { isFileSession } from "../types";
import { Icon, type IconName } from "./icons";

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
 * The toggles' keys, VS Code's: Alt+letter, and ⌥⌘letter on macOS, where
 * Option alone types a character into the box. They act only while the box
 * has focus — in the terminal Alt+C, Alt+W and Alt+L are readline's.
 */
const toggleChord = (code: string): KeyChord => ({
  ctrl: false,
  alt: true,
  shift: false,
  meta: IS_MAC,
  code,
});

type Toggle = keyof FindOptions | "inSelection";

const TOGGLES: { id: Toggle; label: string; icon: IconName; chord: KeyChord }[] =
  [
    {
      id: "caseSensitive",
      label: "Match Case",
      icon: "case-sensitive",
      chord: toggleChord("KeyC"),
    },
    {
      id: "wholeWord",
      label: "Match Whole Word",
      icon: "whole-word",
      chord: toggleChord("KeyW"),
    },
    {
      id: "regex",
      label: "Use Regular Expression",
      icon: "regex",
      chord: toggleChord("KeyR"),
    },
    {
      id: "inSelection",
      label: "Find in Selection",
      icon: "list-selection",
      chord: toggleChord("KeyL"),
    },
  ];

const ENTER_LABEL = keyLabel("Enter");
const SHIFT_ENTER_LABEL = chordLabel({
  ctrl: false,
  alt: false,
  shift: true,
  meta: false,
  code: "Enter",
});

// Match Case, Whole Word and Regular Expression outlast the box, as in VS
// Code. Find in Selection does not: its range is a selection of the moment.
let lastOptions: FindOptions = { ...DEFAULT_FIND_OPTIONS };

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
    const tabId = useStore((s) => s.activeId);
    const { session: tmux, snapshot } = useTmux(tabId);
    const activeId = snapshot?.activePane && tmux
      ? tmux.paneControllerId(snapshot.activePane)
      : tabId;
    const [query, setQuery] = useState(() => selectedText(activeId));
    const [options, setOptions] = useState(lastOptions);
    const [inSelection, setInSelection] = useState(false);
    // The toggles as of the last key, which a second key in the same event
    // loop turn must see before React has rendered the first one.
    const optionsRef = useRef(options);
    const inSelectionRef = useRef(false);
    // Why Find in Selection did not turn on, until the next change.
    const [notice, setNotice] = useState<string | null>(null);
    const [results, setResults] = useState<SearchResults | null>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // The session whose buffer currently carries match highlights (or a
    // Find in Selection range), so they can be dropped when the search
    // moves elsewhere or ends.
    const searchedRef = useRef<string | null>(null);
    const error = queryError(query, options);

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
      inSelectionRef.current = false;
      setInSelection(false);
    };

    // An empty query clears the highlights but keeps a Find in Selection
    // range, which is drawn before anything is typed.
    const runSearch = (
      forward: boolean,
      incremental = false,
      term = query,
      opts = optionsRef.current,
    ) => {
      if (!activeId) return;
      if (searchedRef.current !== activeId) clearSearch();
      searchedRef.current = activeId;
      getController(activeId)?.search(term, opts, forward, incremental);
    };

    const toggleOption = (key: keyof FindOptions) => {
      const current = optionsRef.current;
      const next = { ...current, [key]: !current[key] };
      optionsRef.current = next;
      lastOptions = next;
      setOptions(next);
      setNotice(null);
      // Incremental, so the current match stays when it still matches.
      runSearch(true, true, query, next);
    };

    const toggleInSelection = () => {
      const controller = activeId ? getController(activeId) : undefined;
      if (!activeId || !controller) return;
      if (searchedRef.current !== activeId) clearSearch();
      searchedRef.current = activeId;
      const was = inSelectionRef.current;
      const on = controller.setSearchScope(!was);
      inSelectionRef.current = on;
      setInSelection(on);
      setNotice(on || was ? null : "No selection");
      runSearch(true, true);
    };

    const toggle = (id: Toggle) => {
      if (id === "inSelection") toggleInSelection();
      else toggleOption(id);
    };

    // Closing from the box hands the keyboard back to the terminal, as VS
    // Code does; Esc pressed in the terminal leaves the focus where it is.
    const close = () => {
      const focused = boxRef.current?.contains(document.activeElement);
      onClose();
      if (focused && activeId) getController(activeId)?.focus();
    };
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
      setFindCloser(() => closeRef.current());
      return () => setFindCloser(null);
    }, []);

    // Highlights and the counter belong to one session; switching tabs ends
    // that search rather than showing stale numbers.
    useEffect(() => {
      if (searchedRef.current && searchedRef.current !== activeId) clearSearch();
    }, [activeId]);

    // Subscribed before the initial search below so its count is not missed:
    // the engine reports results synchronously.
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

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      // Enter and Esc belong to the IME while it composes.
      if (event.nativeEvent.isComposing) return;
      const pressed = TOGGLES.find(({ chord }) => chordMatches(chord, event));
      if (pressed) {
        event.preventDefault();
        toggle(pressed.id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.target !== inputRef.current) {
        // The buttons keep their own Enter and Space.
      } else if (event.key === "Enter") {
        runSearch(!event.shiftKey);
      } else if (isFindKey(event)) {
        // ⌘F inside the box re-selects the query, like ⌘F elsewhere.
        event.preventDefault();
        event.currentTarget.querySelector("input")?.select();
      } else if (isFindNextKey(event)) {
        event.preventDefault();
        runSearch(true);
      }
    };

    const toggleButton = ({ id, label, icon, chord }: (typeof TOGGLES)[number]) => {
      const on = id === "inSelection" ? inSelection : options[id];
      return (
        <button
          key={id}
          className={`search-toggle${on ? " is-on" : ""}`}
          // Clicking keeps the focus where it was, so typing goes on into
          // the query (or the terminal).
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => toggle(id)}
          title={`${label} (${chordLabel(chord)})`}
          aria-label={label}
          aria-pressed={on}
        >
          <Icon name={icon} />
        </button>
      );
    };

    const status =
      notice ??
      (error
        ? "Invalid regex"
        : query && results
          ? formatResults(results)
          : "");

    return (
      <div
        ref={boxRef}
        className="terminal-search"
        role="search"
        onKeyDown={onKeyDown}
      >
        <div className={`search-field${error ? " is-invalid" : ""}`}>
          <input
            ref={inputRef}
            value={query}
            placeholder="Find in buffer"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            title={error ?? undefined}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              const term = event.target.value;
              setQuery(term);
              setNotice(null);
              // Search as the query is typed so the counter always matches it.
              runSearch(true, true, term);
            }}
          />
          {TOGGLES.slice(0, 3).map(toggleButton)}
        </div>
        <span
          className={`search-count${
            notice || error || (query && results?.resultCount === 0)
              ? " is-empty"
              : ""
          }`}
          aria-live="polite"
        >
          {status}
        </span>
        <button
          className="panel-action"
          onClick={() => runSearch(false)}
          title={`Previous Match (${SHIFT_ENTER_LABEL})`}
          aria-label="Previous match"
        >
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action"
          onClick={() => runSearch(true)}
          title={`Next Match (${ENTER_LABEL})`}
          aria-label="Next match"
        >
          <Icon name="arrow-down" />
        </button>
        {toggleButton(TOGGLES[3])}
        <button
          className="panel-action"
          onClick={close}
          title="Close (Esc)"
          aria-label="Close search"
        >
          <Icon name="close" />
        </button>
      </div>
    );
  },
);
