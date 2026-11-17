import { useSyncExternalStore } from "react";
import { getTmux, subscribeTmux } from "./tmuxRegistry";

const noopSubscribe = () => () => {};
const empty = () => null;
export function useTmux(id: string | null) {
  const session = useSyncExternalStore(subscribeTmux, () =>
    id ? getTmux(id) : undefined,
  );
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.snapshot ?? empty,
  );
  return { session, snapshot };
}
