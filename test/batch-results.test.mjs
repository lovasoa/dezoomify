import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { BatchResults } from "../apps/desktop/src/batch-results.tsx";
import { presentIdle } from "../packages/shared-ui/src/presentation.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { act, click, makeContainer } from "./react-dom.mjs";

test("batch results preserve individual outcomes and report output action failures locally", async () => {
  const el = makeContainer();
  const saved = { id: "saved-painting", filename: "painting.png" };
  const opened = [];
  let reset = 0;
  const batch = {
    cancelled: true,
    items: [
      {
        id: 1,
        title: "Painting",
        state: { kind: "saved", result: { saved_output: saved } },
      },
      { id: 2, state: { kind: "failed", error: { kind: "no-image-found" } } },
      { id: 3, state: { kind: "cancelled" } },
    ],
  };
  act(() =>
    renderView(
      el,
      presentIdle(),
      {},
      {},
      {
        replace: createElement(BatchResults, {
          batch,
          running: false,
          onReset: () => reset++,
          onOpen: async (output, reveal) => {
            opened.push({ output, reveal });
            if (reveal) throw { kind: "output-not-found" };
          },
        }),
      },
    ),
  );
  assert.match(el.textContent, /Downloads stopped/);
  assert.match(el.textContent, /1 of 3 saved/);
  assert.match(el.textContent, /1 failed · 1 cancelled · 0 remaining/);
  assert.match(el.querySelector('[data-batch-item="2"]').textContent, /Image 2/);
  assert.match(
    el.querySelector('[data-batch-item="2"]').textContent,
    /No zoomable image was found at this address/,
  );
  assert.match(el.querySelector('[data-batch-item="3"]').textContent, /Not downloaded/);
  const row = el.querySelector('[data-batch-item="1"]');
  assert.match(row.textContent, /Saved/);
  assert.match(row.textContent, /painting.png/);
  const buttons = row.querySelectorAll("button");
  await act(async () => click(buttons[0]));
  await act(async () => click(buttons[1]));
  assert.deepEqual(opened, [
    { output: saved, reveal: false },
    { output: saved, reveal: true },
  ]);
  assert.match(row.querySelector('[role="alert"]').textContent, /no longer exists/);
  assert.equal(row.querySelector(".dz-batch-status").textContent, "Saved");
  click(el.querySelector(".dz-actions-row button"));
  assert.equal(reset, 1);
});
