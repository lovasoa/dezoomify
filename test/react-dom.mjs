// Real-DOM test harness for the React shared UI.
//
// The root suite runs on bare `node --test`; this module installs linkedom as
// the global DOM and re-exports React's `act` so tests can mount components,
// dispatch events, and assert on the rendered tree. It replaces the hand-rolled
// mock DOM the imperative renderer used to require.
import { parseHTML } from "linkedom";
import { act } from "react";

const { document } = parseHTML(
  "<!doctype html><html lang='en'><head><title>t</title></head><body></body></html>",
);

function expose(name, value) {
  if (value === undefined) return;
  try {
    globalThis[name] = value;
  } catch {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

try {
  Object.defineProperty(document.defaultView, "location", {
    value: { protocol: "http:", href: "http://localhost/", origin: "http://localhost" },
    configurable: true,
    writable: true,
  });
} catch {
  // The DOM implementation may already expose a writable location.
}

expose("document", document);
expose("window", document.defaultView);
expose("navigator", document.defaultView?.navigator);
expose("HTMLElement", document.defaultView?.HTMLElement);
expose("Element", document.defaultView?.Element);
expose("Event", document.defaultView?.Event);
expose("KeyboardEvent", document.defaultView?.KeyboardEvent);
expose("IS_REACT_ACT_ENVIRONMENT", true);

export { document, act };

/** A fresh detached container appended to the document body. */
export function makeContainer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** Click one element through React's event system inside `act`. */
export function click(element) {
  act(() => {
    element.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  });
}

/** Type into an input through React's event system inside `act`. */
export function input(element, value) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
  });
}
