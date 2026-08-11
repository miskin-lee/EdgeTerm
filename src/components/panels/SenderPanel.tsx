import { useEffect, useRef, useState } from "react";

import * as api from "../../api";
import { useStore } from "../../store";

type Encoding = "text" | "hex";
type Granularity = "line" | "char";
type Target = "current" | "all";

export function SenderPanel() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setStatus = useStore((s) => s.setStatus);

  const [text, setText] = useState("");
  const [encoding, setEncoding] = useState<Encoding>("text");
  const [granularity, setGranularity] = useState<Granularity>("line");
  const [count, setCount] = useState(1);
  const [interval, setInterval] = useState(1);
  const [target, setTarget] = useState<Target>("current");
  const [running, setRunning] = useState(false);
  const abort = useRef(false);

  useEffect(() => () => { abort.current = true; }, []);

  const targets = (): string[] => {
    if (target === "all") return tabs.map((tab) => tab.info.id);
    return activeId ? [activeId] : [];
  };

  const send = async () => {
    const ids = targets();
    if (ids.length === 0) {
      setStatus("Sender: no session selected");
      return;
    }

    let units: (string | Uint8Array)[];
    try {
      units = buildUnits(text, encoding, granularity);
    } catch (e) {
      setStatus(`Sender: ${e}`);
      return;
    }
    if (units.length === 0) return;

    abort.current = false;
    setRunning(true);
    const delay = Math.max(0, interval) * 1000;

    try {
      for (let repeat = 0; repeat < Math.max(1, count); repeat++) {
        for (const unit of units) {
          if (abort.current) return;
          await Promise.all(
            ids.map((id) =>
              typeof unit === "string"
                ? api.writeSession(id, unit)
                : api.writeSessionBinary(id, api.bytesToBase64(unit)),
            ),
          );
          if (delay > 0) await sleep(delay);
          if (abort.current) return;
        }
      }
      setStatus(`Sender: sent ${units.length * Math.max(1, count)} unit(s)`);
    } catch (e) {
      setStatus(`Sender: ${e}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="sender-tabs">
        <div className="sender-tab is-active">
          <span className="panel-dot" style={{ background: "#f85149" }} />
          Sender
        </div>
      </div>

      <div className="sender-toolbar">
            <button
              className="sender-btn is-play"
              onClick={send}
              disabled={running}
              title="Send"
            >
              ▶
            </button>
            <button
              className="sender-btn is-stop"
              onClick={() => {
                abort.current = true;
                setRunning(false);
              }}
              disabled={!running}
              title="Stop"
            >
              ■
            </button>
            <button
              className="sender-btn"
              onClick={() => setText("")}
              title="Clear"
            >
              ✕
            </button>

            <div className="sender-group">
              <label>
                <input
                  type="radio"
                  checked={encoding === "text"}
                  onChange={() => setEncoding("text")}
                />
                Text
              </label>
              <label>
                <input
                  type="radio"
                  checked={encoding === "hex"}
                  onChange={() => setEncoding("hex")}
                />
                Hex
              </label>
            </div>

            <div className="sender-group">
              <span>By:</span>
              <label>
                <input
                  type="radio"
                  checked={granularity === "line"}
                  onChange={() => setGranularity("line")}
                />
                Line
              </label>
              <label>
                <input
                  type="radio"
                  checked={granularity === "char"}
                  onChange={() => setGranularity("char")}
                />
                Char
              </label>
            </div>

            <div className="sender-group">
              <span>Count:</span>
              <input
                className="sender-num"
                type="number"
                min={1}
                value={count}
                onChange={(event) => setCount(Number(event.target.value) || 1)}
              />
            </div>

            <div className="sender-group">
              <span>Interval:</span>
              <input
                className="sender-interval"
                type="number"
                min={0}
                step={0.1}
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value) || 0)}
              />
              <span>s</span>
            </div>

            <div className="sender-group">
              <span>Targets:</span>
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value as Target)}
              >
                <option value="current">Current Session</option>
                <option value="all">All Sessions ({tabs.length})</option>
              </select>
            </div>
      </div>

      <div className="sender-input">
            <textarea
              value={text}
              placeholder={
                encoding === "hex"
                  ? "48 65 6C 6C 6F   (hex bytes)"
                  : "Type text to send. Each line is sent with a trailing Enter."
              }
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
      </div>
    </>
  );
}

function buildUnits(
  text: string,
  encoding: Encoding,
  granularity: Granularity,
): (string | Uint8Array)[] {
  if (encoding === "hex") {
    const cleaned = text.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (cleaned.length === 0) return [];
    if (cleaned.length % 2 !== 0) {
      throw new Error("hex input needs an even number of digits");
    }
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    return granularity === "char"
      ? [...bytes].map((byte) => Uint8Array.of(byte))
      : [bytes];
  }

  if (text.length === 0) return [];
  return granularity === "char"
    ? [...text]
    : text.split("\n").map((line) => `${line}\r`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
