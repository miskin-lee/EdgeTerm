/**
 * What the search overlay and the search addon have to agree on. It lives
 * apart from `terminal.ts` so the overlay can read it without pulling xterm
 * into the start-up bundle (see `ensureController` in actions.ts).
 */

/** The search addon stops highlighting (and counting) past this many matches. */
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export interface SearchResults {
  /** Zero-based index of the selected match; -1 when it is not among the highlighted ones. */
  resultIndex: number;
  /** Highlighted match count, capped at SEARCH_HIGHLIGHT_LIMIT. */
  resultCount: number;
}
