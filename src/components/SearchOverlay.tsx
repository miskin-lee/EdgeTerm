import { useEffect, useRef, useState } from "react";

import { useActiveTab, useStore } from "../store";
import { getController } from "../terminalRegistry";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchOverlay({ open, onOpenChange }: Props) {
  const tab = useActiveTab();
  const activeId = useStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && tab?.info.kind !== "ftp") inputRef.current?.focus();
  }, [open, tab?.info.id, tab?.info.kind]);

  if (!open || !tab || tab.info.kind === "ftp") return null;

  const runSearch = (forward: boolean) => {
    if (!activeId || !query) return;
    getController(activeId)?.search(query, forward);
  };

  return (
    <div className="terminal-search" role="search">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in buffer"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") runSearch(!event.shiftKey);
          if (event.key === "Escape") onOpenChange(false);
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
}
