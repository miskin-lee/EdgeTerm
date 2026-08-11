import { TerminalController } from "./terminal";

/**
 * Terminal instances outlive the React components that display them, so that
 * switching tabs never destroys scrollback. React only ever borrows the DOM
 * node; this registry owns the lifetime.
 */
const registry = new Map<string, TerminalController>();

export function setController(id: string, controller: TerminalController) {
  registry.set(id, controller);
}

export function getController(id: string): TerminalController | undefined {
  return registry.get(id);
}

export function disposeController(id: string) {
  registry.get(id)?.dispose();
  registry.delete(id);
}

export function allControllers(): TerminalController[] {
  return [...registry.values()];
}
