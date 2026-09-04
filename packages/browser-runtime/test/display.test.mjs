import test from "node:test";
import assert from "node:assert/strict";
import { createDisplaySurface, DISPLAY_SAVE_GUIDANCE } from "../src/image-display-surface.ts";

function makeFakeDom() {
  const created = [];
  return {
    created,
    createElement(tag) {
      const attrs = new Map();
      const listeners = new Map();
      let removed = false;
      const el = {
        tagName: tag.toUpperCase(),
        setCalls: [],
        setAttribute(name, value) {
          el.setCalls.push([name, value]);
          attrs.set(name.toLowerCase(), String(value));
        },
        getAttribute(name) {
          return attrs.has(name.toLowerCase()) ? attrs.get(name.toLowerCase()) : null;
        },
        hasAttribute(name) {
          return attrs.has(name.toLowerCase());
        },
        removeAttribute(name) {
          attrs.delete(name.toLowerCase());
        },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
          listeners.get(type)?.delete(fn);
        },
        remove() {
          removed = true;
        },
        get removed() {
          return removed;
        },
        listenerCount(type) {
          return listeners.get(type)?.size ?? 0;
        },
        fire(type) {
          for (const fn of [...(listeners.get(type) ?? [])]) fn();
        },
        // Trap property sets like el.crossOrigin = ...
        _props: {},
      };
      const proxy = new Proxy(el, {
        set(target, prop, value) {
          if (prop === "crossOrigin" || prop === "crossorigin") {
            target._props.crossOriginSet = value;
            throw new Error("crossOrigin must never be set");
          }
          target[prop] = value;
          return true;
        },
      });
      created.push(proxy);
      return proxy;
    },
  };
}

test("created <img> has no crossorigin attribute", async () => {
  const dom = makeFakeDom();
  const s = createDisplaySurface(dom);
  const p = s.loadTile("https://tiles.test/0/0.jpg");
  assert.equal(dom.created.length, 1);
  const img = dom.created[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.hasAttribute("crossorigin"), false);
  assert.equal(img.getAttribute("crossorigin"), null);
  assert.ok(!img.setCalls.some(([k]) => k.toLowerCase() === "crossorigin"));
  assert.equal(img._props.crossOriginSet, undefined);
  img.fire("load");
  assert.equal(await p, "displayed");
  s.dispose();
});

test("error path reports failure and cancel removes nodes/listeners", async () => {
  const dom = makeFakeDom();
  const s = createDisplaySurface(dom);
  const p1 = s.loadTile("https://tiles.test/a.jpg");
  const p2 = s.loadTile("https://tiles.test/b.jpg");
  dom.created[0].fire("error");
  assert.equal(await p1, "failed");
  assert.equal(dom.created[0].removed, true);
  // Cancel removes remaining listeners/nodes.
  s.cancel();
  assert.equal(dom.created[1].removed, true);
  assert.equal(dom.created[1].listenerCount("load"), 0);
  assert.equal(dom.created[1].listenerCount("error"), 0);
  // Idempotent.
  s.cancel();
  s.dispose();
});

test("drawing cross-origin sets originClean=false first; save guidance exposed; zero save calls", () => {
  const dom = makeFakeDom();
  let drawCalls = 0;
  let pixelReads = 0;
  const fakeCanvas = {
    drawImage() {
      drawCalls += 1;
    },
    getImageData() {
      pixelReads += 1;
      return null;
    },
    toBlob() {
      throw new Error("must not be called");
    },
    toDataURL() {
      throw new Error("must not be called");
    },
  };
  const s = createDisplaySurface(dom, { canvas: fakeCanvas });
  assert.equal(s.originClean, true);
  assert.ok(typeof s.saveGuidance === "string" && s.saveGuidance.length > 0);
  assert.equal(s.saveGuidance, DISPLAY_SAVE_GUIDANCE);
  s.drawToCanvas({ fake: "image" }, 0, 0);
  assert.equal(s.originClean, false);
  assert.equal(drawCalls, 1);
  // App surface itself never calls pixel/save APIs.
  assert.equal(pixelReads, 0);
  assert.ok(!("getImageData" in s) && !("toBlob" in s) && !("toDataURL" in s));
});
