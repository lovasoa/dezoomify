// Browser canvas failure and source URL helpers.

import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { hostFromUrl } from "../../shared-ui/src/view-helpers.ts";
import { outputError } from "./failure.ts";

function canvasFailure(
  kind: "plan-invalid" | "output-unavailable",
  width: number,
  height: number,
  sourceUrl: string,
  stage: string,
): JobError {
  return outputError(kind, `canvas ${width}x${height} ${stage} for ${hostFromUrl(sourceUrl)}`);
}

/** The plan's declared canvas exceeds the browser canvas limits. */
export function canvasTooLargeFailure(
  width: number,
  height: number,
  sourceUrl: string,
  extra?: string,
): JobError {
  const where = hostFromUrl(sourceUrl);
  const detail = extra
    ? `canvas ${width}x${height} exceeds the browser limit (${extra}) for ${where}`
    : `canvas ${width}x${height} exceeds the browser limit for ${where}`;
  return outputError("plan-invalid", detail);
}

/** The browser refused to allocate the output canvas at this size. */
export function canvasAllocationFailure(
  width: number,
  height: number,
  sourceUrl: string,
): JobError {
  return canvasFailure("output-unavailable", width, height, sourceUrl, "allocation failed");
}

/** The browser gave no 2D context for the output canvas at this size. */
export function canvasSurfaceFailure(width: number, height: number, sourceUrl: string): JobError {
  return canvasFailure("output-unavailable", width, height, sourceUrl, "2D context unavailable");
}
