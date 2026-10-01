// Text cut short with an ellipsis (session and file names in a narrow
// panel, tab titles, menu entries, the window title) shows in full in a
// tooltip once the pointer rests on it. One document-level listener serves
// the whole app, so a component only has to style its label with
// `text-overflow: ellipsis`; a label that is not actually truncated gets no
// tooltip. Plain DOM, not React: it must not re-render anything on hover.
//
// A native `title` on the row around the label (a profile's address, a
// tab's protocol) would pop up on top of ours a moment later, so while our
// tooltip shows, that title is lifted off the element and shown as a second
// line instead, then put back. Elements that draw a tooltip of their own
// opt out with `data-own-tooltip`.

export const OVERFLOW_TOOLTIP_DELAY_MS = 450;
/** How far up from the hovered node to look for the truncated label. */
const MAX_DEPTH = 4;
const GAP = 6;
const MARGIN = 8;

interface Shown {
  label: HTMLElement;
  /** The element whose `title` was lifted, and the value to put back. */
  titled: HTMLElement | null;
  title: string;
}

let tip: HTMLDivElement | null = null;
let timer = 0;
let pending: HTMLElement | null = null;
let shown: Shown | null = null;

/** The truncated label at or just above `node`, if any. */
export function truncatedLabel(node: EventTarget | null): HTMLElement | null {
  let element = node instanceof Element ? node : null;
  for (let depth = 0; element && depth < MAX_DEPTH; depth++) {
    if (!(element instanceof HTMLElement)) return null;
    if (element.closest("[data-own-tooltip]")) return null;
    if (getComputedStyle(element).textOverflow === "ellipsis") {
      // One pixel of slack: sub-pixel layout can report a fitting label as
      // one wider than its box.
      const cut = element.scrollWidth > element.clientWidth + 1;
      return cut && element.textContent?.trim() ? element : null;
    }
    element = element.parentElement;
  }
  return null;
}

const ensureTip = () => {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "overflow-tooltip";
    tip.setAttribute("role", "tooltip");
  }
  if (!tip.isConnected) document.body.appendChild(tip);
  return tip;
};

function show(label: HTMLElement) {
  if (!label.isConnected) return;
  const titled = label.closest<HTMLElement>("[title]");
  const title = titled?.getAttribute("title") ?? "";
  const text = label.textContent?.trim() ?? "";
  const element = ensureTip();
  element.replaceChildren();
  const main = document.createElement("div");
  main.textContent = text;
  element.appendChild(main);
  if (title && title !== text) {
    const detail = document.createElement("span");
    detail.textContent = title;
    element.appendChild(detail);
  }
  if (titled) titled.removeAttribute("title");
  shown = { label, titled, title };

  // Below the label, or above it when there is no room; kept on screen.
  element.style.left = "0px";
  element.style.top = "0px";
  element.classList.add("is-visible");
  const anchor = label.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const maxLeft = window.innerWidth - box.width - MARGIN;
  const left = Math.max(MARGIN, Math.min(anchor.left - 1, maxLeft));
  let top = anchor.bottom + GAP;
  if (top + box.height > window.innerHeight - MARGIN) {
    top = Math.max(MARGIN, anchor.top - GAP - box.height);
  }
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

/** Hides the tooltip and gives the row back its own title. */
export function hideOverflowTooltip() {
  window.clearTimeout(timer);
  pending = null;
  if (!shown) return;
  const { titled, title } = shown;
  // A re-render may have set a new title meanwhile; that one wins.
  if (titled && title && !titled.hasAttribute("title")) {
    titled.setAttribute("title", title);
  }
  shown = null;
  tip?.classList.remove("is-visible");
}

const onPointerOver = (event: PointerEvent) => {
  // Not while a button is held: tab, panel and splitter drags pass over
  // labels all the time.
  if (event.buttons !== 0) return;
  const label = truncatedLabel(event.target);
  if (label && (label === shown?.label || label === pending)) return;
  hideOverflowTooltip();
  if (!label) return;
  pending = label;
  timer = window.setTimeout(() => {
    pending = null;
    show(label);
  }, OVERFLOW_TOOLTIP_DELAY_MS);
};

const onPointerOut = (event: PointerEvent) => {
  const watched = shown?.label ?? pending;
  if (!watched) return;
  const next = event.relatedTarget;
  if (next instanceof Node && watched.contains(next)) return;
  hideOverflowTooltip();
};

let installed = false;

export function installOverflowTooltip() {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  // Anything that changes what is under the pointer ends the hover.
  for (const type of ["pointerdown", "keydown", "wheel"] as const) {
    document.addEventListener(type, hideOverflowTooltip, true);
  }
  document.addEventListener("scroll", hideOverflowTooltip, true);
  window.addEventListener("blur", hideOverflowTooltip);
}
