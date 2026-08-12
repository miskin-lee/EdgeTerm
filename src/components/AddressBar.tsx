import { useEffect, useRef, useState } from "react";

import { useActiveTab, useStore } from "../store";
import { getController } from "../terminalRegistry";

interface Props {
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
}

export function AddressBar({ searchOpen, onSearchOpenChange }: Props) {
  const tab = useActiveTab();
  const activeId = useStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  if (!tab) {
    return (
      <div className="addressbar">
        <div className="address-crumbs">
          <span className="address-sep">›</span>
          <span>no session</span>
        </div>
      </div>
    );
  }

  const runSearch = (forward: boolean) => {
    if (!activeId || !query) return;
    getController(activeId)?.search(query, forward);
  };

  return (
    <div className="addressbar">
      <span title={tab.message ?? tab.state}>ⓘ</span>
      <div className="address-crumbs">
        <span className="address-sep">›</span>
        <span className="address-proto">{tab.info.protocol}</span>
        <span className="address-sep">›</span>
        <span className="address-host">{tab.info.address}</span>
      </div>

      <span className={`address-state is-${tab.state}`}>
        {tab.state}
      </span>

      {searchOpen && tab.info.kind !== "ftp" && (
        <div className="address-search">
          <input
            ref={inputRef}
            value={query}
            placeholder="Find in buffer"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runSearch(!event.shiftKey);
              if (event.key === "Escape") onSearchOpenChange(false);
            }}
          />
          <button className="panel-action" onClick={() => runSearch(false)}>
            ↑
          </button>
          <button className="panel-action" onClick={() => runSearch(true)}>
            ↓
          </button>
          <button
            className="panel-action"
            onClick={() => onSearchOpenChange(false)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
