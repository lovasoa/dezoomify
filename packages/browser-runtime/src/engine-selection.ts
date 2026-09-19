// Deterministic catalog selection for engine hosts.
//
// The extension job tab drives the Rust job engine, whose catalog event
// carries an immutable ordered catalog. Headless callers may provide a deterministic selection
// rule; this is the shared one: the ready image whose largest declared level
// is biggest, and inside it the largest level that fits the browser canvas
// (falling back to the smallest declared level so the plan gate fails fast,
// mirroring `pickLevel` in `./limits.ts`). When no ready image is selectable,
// `pickDeferredUri` surfaces the first still-deferred entry so the host can
// follow it with a fresh bounded attempt, mirroring the native driver. Pure:
// no I/O, no clocks.
import { BROWSER_LIMITS, probeLimits, safeArea } from "./limits.ts";
import type { BrowserLimits } from "./types.ts";
import type { CatalogDto, EngineSnapshotDto, ImageDto, LevelDto } from "@dezoomify/wasm-bindings";

/**
 * Deferred-resolution bound: the initial discovery plus this many deferred
 * follows, matching the native driver's `MAX_DEFERRED_FOLLOWS`.
 */
export const MAX_DEFERRED_FOLLOWS = 10;

export interface EngineSelection {
  image: number;
  level: number;
  /** Optional core-extracted title, never a UI fallback. */
  title?: string;
}

function levelArea(level: LevelDto): number | null {
  return safeArea(level.width, level.height);
}

function levelFits(level: LevelDto, limits: BrowserLimits): boolean {
  return probeLimits({ width: level.width, height: level.height }, limits).verdict === "ok";
}

/**
 * Deterministic selection over an engine catalog. Returns null when no
 * ready image declares a selectable level (the caller renders a typed
 * failure; the engine never guesses silently).
 */
export function pickEngineSelection(
  catalog: CatalogDto | undefined,
  limits: BrowserLimits = BROWSER_LIMITS,
): EngineSelection | null {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  let bestImage: ImageDto | null = null;
  let bestImageIndex = -1;
  let bestImageArea = -1;
  for (const [imageIndex, entry] of entries.entries()) {
    if (!entry || entry.kind !== "image") continue;
    const levels = Array.isArray(entry.levels) ? entry.levels : [];
    if (levels.length === 0) continue;
    let imageArea = -1;
    for (const level of levels) {
      const area = levelArea(level) ?? -1;
      if (area >= imageArea) imageArea = area;
    }
    // Probe-driven and adversarial dimensions may not have a safe area yet.
    // They remain selectable; declared geometry is evaluated below.
    if (!bestImage || imageArea >= bestImageArea) {
      bestImage = entry;
      bestImageIndex = imageIndex;
      bestImageArea = imageArea;
    }
  }
  if (!bestImage) return null;
  const levels = Array.isArray(bestImage.levels) ? bestImage.levels : [];
  let best: LevelDto | null = null;
  let bestIndex = -1;
  let bestArea = -1;
  let smallest: LevelDto | null = null;
  let smallestIndex = -1;
  let smallestArea = Number.POSITIVE_INFINITY;
  for (const [levelIndex, level] of levels.entries()) {
    const area = levelArea(level);
    const declared = level.width > 0 && level.height > 0;
    const orderingArea = area ?? Number.POSITIVE_INFINITY;
    if (declared && levelFits(level, limits) && area !== null && area >= bestArea) {
      best = level;
      bestIndex = levelIndex;
      bestArea = area;
    }
    if (declared && (smallest === null || orderingArea < smallestArea)) {
      smallest = level;
      smallestIndex = levelIndex;
      smallestArea = orderingArea;
    }
  }
  const chosen = best ?? smallest;
  if (!chosen) return null;
  return {
    image: bestImageIndex,
    level: best ? bestIndex : smallestIndex,
    ...(typeof bestImage.title === "string" ? { title: bestImage.title } : {}),
  };
}

/**
 * Follow-up URI of the first still-deferred catalog entry, or null when the
 * catalog has none. The caller follows it with a fresh bounded attempt; the
 * engine never resolves deferred metadata silently.
 */
export function pickDeferredUri(catalog: CatalogDto | undefined): string | null {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  for (const entry of entries) {
    if (
      entry?.kind === "image-request"
      && typeof entry.uri === "string"
      && entry.uri !== ""
    ) {
      return entry.uri;
    }
  }
  return null;
}

/**
 * Closed host decision for one authoritative snapshot: what the product
 * does about selection before rendering. Both browser products (website,
 * extension job tab) drive auto-selection and deferred follows from this
 * one pure projection over the generated DTO; each maps the decision onto
 * its own commands and product side effects (logging, titles, history).
 * Pure: no I/O, no clocks, no commands.
 */
export type SelectionDrive =
  | { action: "selected" }
  | { action: "waiting" }
  | { action: "select"; image: number; level: number; title?: string }
  | { action: "follow-deferred"; position: number }
  | { action: "unselectable" };

export function planSelectionDrive(
  snapshot: EngineSnapshotDto,
  limits: BrowserLimits = BROWSER_LIMITS,
): SelectionDrive {
  const selection = snapshot.selection;
  // An explicitly chosen image needs nothing: the engine owns the rest.
  if (selection?.image !== null && selection?.image !== undefined) return { action: "selected" };
  const catalog = selection?.catalog;
  if (catalog) {
    const picked = pickEngineSelection(catalog, limits);
    if (picked) {
      return {
        action: "select",
        image: picked.image,
        level: picked.level,
        ...(typeof picked.title === "string" ? { title: picked.title } : {}),
      };
    }
    const deferredIndex = catalog.entries.findIndex((entry) => entry?.kind === "image-request");
    if (deferredIndex >= 0) return { action: "follow-deferred", position: deferredIndex };
    return { action: "unselectable" };
  }
  const deferred = Array.isArray(selection?.deferred) ? selection.deferred : [];
  if (deferred.length > 0 && typeof deferred[0]?.position === "number") {
    return { action: "follow-deferred", position: deferred[0].position };
  }
  // No catalog and no deferred entries yet: the engine is still discovering;
  // never fail or select without snapshot facts.
  return { action: "waiting" };
}

/**
 * Idempotent driver over {@link planSelectionDrive}: products call
 * `drive(snapshot)` on every snapshot and send the returned decision at
 * most once per distinct follow target. The follow command's own answer
 * snapshot still carries the old catalog while the fetch is in flight, so
 * without this guard every product would send the same follow twice and
 * the engine would (correctly) reject the duplicate as wrong-state, which
 * the runner treats as terminal for the job. One driver per job run;
 * targets key on catalog position plus entry URI so a replaced catalog may
 * legitimately defer the same position again.
 */
export type DrivenSelection = SelectionDrive | { action: "already-driven" };

export interface SelectionDriver {
  drive(snapshot: EngineSnapshotDto, limits?: BrowserLimits): DrivenSelection;
  reset(): void;
}

export function createSelectionDriver(): SelectionDriver {
  let followed = new Set<string>();
  return {
    drive(snapshot: EngineSnapshotDto, limits: BrowserLimits = BROWSER_LIMITS): DrivenSelection {
      const drive = planSelectionDrive(snapshot, limits);
      if (drive.action !== "follow-deferred") return drive;
      const entries = snapshot.selection.catalog?.entries;
      const candidate = entries?.[drive.position];
      const entryUri = candidate?.kind === "image-request" ? candidate.uri : undefined;
      const deferredUri = snapshot.selection.deferred.find(
        (entry) => entry.position === drive.position,
      )?.uri;
      const key = `${drive.position}:${entryUri ?? deferredUri ?? ""}`;
      if (followed.has(key)) return { action: "already-driven" };
      followed.add(key);
      return drive;
    },
    reset(): void {
      followed = new Set<string>();
    },
  };
}
