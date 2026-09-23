import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
const hosts: HTMLElement[] = [];

function createController() {
  const controller = new TerminalController(
    "copy-on-select-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
    },
    13,
    100,
  );
  controllers.push(controller);
  // The clipboard is not there in jsdom; the copy itself is covered elsewhere.
  vi.spyOn(controller, "copySelection").mockReturnValue(true);
  // The terminal is not opened here, so stand in for the element xterm would
  // be drawn into: it is what the mouse handlers check a press against.
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  (controller as unknown as { host: HTMLElement }).host = host;
  return { controller, host };
}

/** What xterm reports while the pointer drags across the screen. */
function selectionChanges(controller: TerminalController) {
  (controller as unknown as { selectionChanged: boolean }).selectionChanged =
    true;
}

const press = (target: HTMLElement, button = 0) =>
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button }));

const release = (target: HTMLElement, button = 0) =>
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button }));

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

describe("copy on select", () => {
  it("stays off until it is turned on", () => {
    const { controller, host } = createController();

    press(host);
    selectionChanges(controller);
    release(host);

    expect(controller.copySelection).not.toHaveBeenCalled();
  });

  it("copies a selection the mouse made, once the button comes up", () => {
    const { controller, host } = createController();
    controller.setCopyOnSelect(true);

    press(host);
    selectionChanges(controller);
    expect(controller.copySelection).not.toHaveBeenCalled();

    release(host);
    expect(controller.copySelection).toHaveBeenCalledTimes(1);

    // A second release without a new selection must not copy again.
    release(host);
    expect(controller.copySelection).toHaveBeenCalledTimes(1);
  });

  it("copies a drag that ends outside the terminal", () => {
    const { controller, host } = createController();
    controller.setCopyOnSelect(true);

    press(host);
    selectionChanges(controller);
    release(document.body);

    expect(controller.copySelection).toHaveBeenCalledTimes(1);
  });

  it("leaves a right click alone", () => {
    const { controller, host } = createController();
    controller.setCopyOnSelect(true);

    // Menu mode selects the word under the pointer; opening the menu is not
    // a request to replace the clipboard.
    press(host, 2);
    selectionChanges(controller);
    release(host, 2);

    expect(controller.copySelection).not.toHaveBeenCalled();
  });

  it("leaves a selection the mouse had no part in alone", () => {
    const { controller, host } = createController();
    controller.setCopyOnSelect(true);

    // Select All from a key or a menu: the whole scrollback must not land on
    // the clipboard at the next click.
    selectionChanges(controller);
    release(host);

    expect(controller.copySelection).not.toHaveBeenCalled();
  });

  it("ignores a press in another terminal", () => {
    const { controller } = createController();
    const other = createController();
    controller.setCopyOnSelect(true);

    press(other.host);
    selectionChanges(controller);
    release(other.host);

    expect(controller.copySelection).not.toHaveBeenCalled();
  });

  it("lets go of the document once disposed", () => {
    const { controller, host } = createController();
    controller.setCopyOnSelect(true);
    controller.dispose();

    press(host);
    selectionChanges(controller);
    release(host);

    expect(controller.copySelection).not.toHaveBeenCalled();
  });
});
