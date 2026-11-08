import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const HOST_FACILITIES =
  /\b(?:chrome|browser)\.(?:runtime|tabs|scripting|downloads)|__TAURI|from ["'](?:wxt|@tauri-apps|react|chrome)/;

/** The runtime is injected into documents a host does not control and must run
 * under every host, so it may not import a host SDK or touch host globals. A
 * typecheck cannot see this: the extension and a webview host both compile
 * `chrome.*` and `window.__TAURI_INTERNALS__` perfectly well. */
test("the in-page runtime reaches no host facilities", () => {
  for (const file of sources(new URL("../src/", import.meta.url)))
    assert.doesNotMatch(readFileSync(file, "utf8"), HOST_FACILITIES, file.pathname);
});

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const url = entry.isDirectory()
      ? new URL(`${entry.name}/`, directory)
      : new URL(entry.name, directory);
    if (entry.isDirectory()) yield* sources(url);
    else if (entry.name.endsWith(".ts")) yield url;
  }
}
