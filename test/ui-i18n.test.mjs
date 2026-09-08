import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  t,
  EN,
  FR,
  DE,
  IT,
  getLocale,
  setLocale,
  pickLocale,
  normalizeLocaleName,
  getDictionary,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} from "../packages/shared-ui/src/i18n.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

/** Every `t("key")` reference in a TypeScript source (not a replica table). */
function tRefs(source) {
  const out = new Set();
  const re = /(?<![A-Za-z])t\("([^"]+)"(?=[,)])/g;
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

const LOCALES = { en: EN, fr: FR, de: DE, it: IT };

function placeholdersOf(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
}

test("i18n: English table is namespaced, complete, and well-formed", () => {
  const keys = Object.keys(EN);
  assert.ok(keys.length > 100, `en dictionary holds the full catalog (saw ${keys.length})`);
  for (const key of keys) {
    assert.match(key, /^(view|desktop|page)\.[a-zA-Z0-9.]+$/, `key is namespaced: ${key}`);
    assert.ok(typeof EN[key] === "string" && EN[key].length > 0, `value is non-empty: ${key}`);
    const opens = (EN[key].match(/\{/g) || []).length;
    const closes = (EN[key].match(/\}/g) || []).length;
    assert.equal(opens, closes, `balanced interpolation braces: ${key}`);
    for (const varMatch of EN[key].matchAll(/\{([^}]*)\}/g)) {
      assert.match(varMatch[1], /^[A-Za-z]\w*$/, `placeholder is a plain var: ${key}`);
    }
  }
});

test("i18n: fr/de/it mirror the English key set with identical placeholders", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual([...SUPPORTED_LOCALES], ["en", "fr", "de", "it"]);
  for (const name of ["fr.ts", "de.ts", "it.ts"]) {
    assert.ok(
      fs.existsSync(path.join(rootDir, "packages/shared-ui/src/locales", name)),
      `locale file ships: locales/${name}`,
    );
  }
  const enKeys = Object.keys(EN);
  assert.ok(enKeys.length > 100, `catalog stays complete (saw ${enKeys.length})`);
  for (const [label, table] of Object.entries(LOCALES)) {
    if (label === "en") continue;
    const keys = Object.keys(table);
    assert.deepEqual(
      new Set(keys),
      new Set(enKeys),
      `${label} ships exactly the English key set (no orphans, nothing missing)`,
    );
    for (const key of enKeys) {
      assert.ok(typeof table[key] === "string" && table[key].length > 0, `${label} value is non-empty: ${key}`);
      assert.equal(
        placeholdersOf(table[key]),
        placeholdersOf(EN[key]),
        `${label} keeps the English placeholders: ${key}`,
      );
      assert.ok(!table[key].includes("\u2014"), `${label} uses no em dashes: ${key}`);
    }
  }
});

test("i18n: substitution renders per locale and degrades safely", () => {
  try {
    assert.equal(setLocale("en"), true);
    assert.equal(t("view.modal.ok"), "Got it");
    assert.equal(t("view.step.discovering"), "Finding the zoomable image…");
    assert.equal(
      t("view.job.stalled", { host: "artsandculture.google.com" }),
      "Still working, artsandculture.google.com is slow to answer. You can wait, or cancel and try again later.",
    );
    assert.equal(t("view.job.manyImages", { count: 3 }), "3 images");
    assert.equal(t("view.job.countsFull", { current: 2, total: 9 }), "2 of 9 tiles");
    assert.equal(
      t("view.done.savedPartial", { name: "dezoomify-4x4.png", w: 4, h: 4, done: 14, total: 16, failed: 2 }),
      "Saved dezoomify-4x4.png (4x4, 14 of 16 tiles; 2 tile(s) missing).",
    );
    // Per-locale rendering through the same keys.
    assert.equal(t("view.modal.ok", undefined, "fr"), "Compris");
    assert.equal(t("view.modal.ok", undefined, "de"), "Verstanden");
    assert.equal(t("view.modal.ok", undefined, "it"), "Capito");
    assert.equal(t("view.step.discovering", undefined, "fr"), "Recherche de l image zoomable…");
    assert.equal(t("view.step.discovering", undefined, "de"), "Zoombares Bild wird gesucht…");
    assert.equal(t("view.step.discovering", undefined, "it"), "Ricerca dell immagine zoomabile…");
    assert.equal(t("view.job.manyImages", { count: 3 }, "de"), "3 Bilder");
    assert.equal(t("view.job.manyImages", { count: 3 }, "fr"), "3 images");
    assert.equal(
      t("view.done.savedFull", { name: "a.png", w: 4, h: 4 }, "it"),
      "a.png salvata (4x4).",
    );
    assert.ok(
      t("view.job.stalled", { host: "example.test" }, "fr").includes("example.test"),
      "fr substitution carries the host var",
    );
    // Active-locale rendering follows setLocale.
    assert.equal(setLocale("fr"), true);
    assert.equal(t("view.modal.ok"), "Compris");
    assert.equal(setLocale("de"), true);
    assert.equal(t("view.modal.ok"), "Verstanden");
    assert.equal(setLocale("it"), true);
    assert.equal(t("view.modal.ok"), "Capito");
    // A missing variable leaves its placeholder instead of crashing.
    assert.equal(setLocale("en"), true);
    assert.equal(t("view.job.manyImages"), "{count} images");
    assert.equal(t("view.job.manyImages", undefined, "fr"), "{count} images");
    // Unknown keys fall back to the key itself (never undefined).
    assert.equal(t("view.no.such.key"), "view.no.such.key");
    assert.equal(t("view.no.such.key", undefined, "de"), "view.no.such.key");
    // An unknown explicit locale falls back to the active locale.
    assert.equal(t("view.modal.ok", undefined, "es"), "Got it");
  } finally {
    setLocale("en");
  }
});

test("i18n: setLocale accepts en/fr/de/it, normalizes tags, and fails closed", () => {
  try {
    assert.equal(DEFAULT_LOCALE, "en");
    assert.equal(getLocale(), "en");
    assert.equal(setLocale("en"), true);
    assert.equal(setLocale("fr"), true);
    assert.equal(getLocale(), "fr");
    assert.equal(setLocale("de"), true);
    assert.equal(setLocale("it"), true);
    // Region subtags and case variants normalize to the shipped base.
    assert.equal(setLocale("fr-CA"), true);
    assert.equal(getLocale(), "fr");
    assert.equal(setLocale("DE_at"), true);
    assert.equal(getLocale(), "de");
    assert.equal(setLocale("IT"), true);
    assert.equal(getLocale(), "it");
    // Unknown or empty names fail closed and keep the current locale.
    assert.equal(setLocale("es"), false);
    assert.equal(setLocale("pt-BR"), false);
    assert.equal(setLocale(""), false);
    assert.equal(getLocale(), "it");
    assert.equal(normalizeLocaleName("fr-FR"), "fr");
    assert.equal(normalizeLocaleName("EN"), "en");
    assert.equal(normalizeLocaleName("xx"), null);
    assert.equal(normalizeLocaleName(""), null);
    assert.deepEqual(getDictionary("es"), EN);
    assert.equal(getDictionary("fr"), FR);
  } finally {
    setLocale("en");
  }
  assert.equal(getLocale(), "en");
});

test("i18n: pickLocale follows Accept-Language headers and language lists", () => {
  assert.equal(pickLocale(null), "en");
  assert.equal(pickLocale(undefined), "en");
  assert.equal(pickLocale(""), "en");
  assert.equal(pickLocale([]), "en");
  // Plain header order wins; region subtags reduce to the shipped base.
  assert.equal(pickLocale("fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7"), "fr");
  assert.equal(pickLocale("de-AT, fr;q=0.5"), "de");
  assert.equal(pickLocale("it-IT,it;q=0.9,en;q=0.8"), "it");
  // Quality values reorder; q=0 never matches; unknown tags are skipped.
  assert.equal(pickLocale("en;q=0.1, fr;q=0.9"), "fr");
  assert.equal(pickLocale("fr;q=0, de;q=0.5"), "de");
  assert.equal(pickLocale("es, pt;q=0.9"), "en");
  // Navigator-style lists keep preference order.
  assert.deepEqual(pickLocale(["es", "de-AT", "fr"]), "de");
  assert.deepEqual(pickLocale(["it", "fr"]), "it");
  assert.deepEqual(pickLocale(["FR-ca"]), "fr");
});

// Todo 2.2: desktop copy moved from main.tsx into errorCopy.ts,
// jobController.ts, settingsPanel.ts, and diagnostics.ts. The key set stays
// identical; only the scanned files widen to the whole desktop src dir.
function readDesktop() {
  const dir = path.join(rootDir, "apps/desktop/src");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => read(`apps/desktop/src/${name}`))
    .join("\n");
}

test("i18n: every desktop t() reference resolves in all four locales", () => {
  const desktopRefs = tRefs(readDesktop());
  assert.ok(desktopRefs.size > 40, `desktop src renders through the dictionary (saw ${desktopRefs.size} keys)`);
  for (const key of desktopRefs) {
    for (const [label, table] of Object.entries(LOCALES)) {
      assert.ok(Object.hasOwn(table, key), `${label} covers desktop key: ${key}`);
    }
  }
});

test("i18n: no orphan locale keys; the dictionary stays ready for the view/page migration", () => {
  // The desktop renderer is the only `t()` caller today; the shared view and
  // the extension modal still renders hardcoded English literals with this
  // dictionary as the single source for their migration (see the module
  // header and `packages/shared-ui/AGENTS.md`). Every English key therefore
  // ships in all four locales now, so the migration needs no retranslation.
  const viewRefs = tRefs(read("packages/shared-ui/src/view.ts"));
  for (const key of viewRefs) {
    for (const [label, table] of Object.entries(LOCALES)) {
      assert.ok(Object.hasOwn(table, key), `${label} covers future view/page key: ${key}`);
    }
  }
  const referenced = new Set([...viewRefs, ...tRefs(readDesktop())]);
  const pending = Object.keys(EN).filter((key) => !referenced.has(key));
  assert.ok(pending.length > 0, "view/page migration keys are staged in the dictionary");
  for (const key of pending) {
    for (const [label, table] of Object.entries(LOCALES)) {
      assert.ok(Object.hasOwn(table, key), `${label} stages migration key: ${key}`);
      assert.equal(
        placeholdersOf(table[key]),
        placeholdersOf(EN[key]),
        `${label} stages matching placeholders: ${key}`,
      );
    }
  }
});

test("i18n: extension modal carries no replica table; its mirror stays generated", () => {
  const modal = read("apps/extension/src/modal/modal.ts");
  assert.ok(!modal.includes("PAGE_EN"), "modal must not carry an i18n replica table");
  assert.ok(!modal.includes("pageT("), "modal must not carry a replica lookup");
  for (const replica of ["const fr =", "const de =", "const it =", "FR_DE_IT"]) {
    assert.ok(!modal.includes(replica), `modal must not vendor a locale table inline (${replica})`);
  }
  // Whatever the modal resolves through `t()` today must exist in all four
  // locales; the modal still renders English literals while its migration is
  // staged, so zero refs is accepted and resolves vacuously.
  const refs = tRefs(modal);
  for (const key of refs) {
    for (const [label, table] of Object.entries(LOCALES)) {
      assert.ok(Object.hasOwn(table, key), `${label} covers extension key: ${key}`);
    }
  }
  // The served browser mirror carries the same four tables via codegen.
  const mirror = read("packages/shared-ui/src/i18n.js");
  for (const mod of ['./locales/fr.js', './locales/de.js', './locales/it.js']) {
    assert.ok(mirror.includes(mod), `browser mirror imports ${mod} (run node scripts/sync-web-js.mjs)`);
  }
  for (const name of ["fr.js", "de.js", "it.js"]) {
    assert.ok(
      fs.existsSync(path.join(rootDir, "packages/shared-ui/src/locales", name)),
      `browser locale mirror ships: locales/${name}`,
    );
  }
});
