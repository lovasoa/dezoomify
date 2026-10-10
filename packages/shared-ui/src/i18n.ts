// Shared-UI message dictionary (English plus French, German, Italian).
//
// English (`en`) is the canonical source: every other locale covers it key
// for key with identical `{placeholders}`, and lookups fall back to English
// per key. Rules for user copy: `packages/shared-ui/AGENTS.md`.
//
// Locale selection: hosts call `setLocale()` (explicit picker choice) or
// `pickLocale()` (`Accept-Language` / `navigator.languages`); unknown tags
// fail closed to English. This module is erasable-syntax-only TypeScript so
// node can type-strip it directly in tests.

import { de } from "./locales/de.ts";
import { fr } from "./locales/fr.ts";
import { it } from "./locales/it.ts";

export type Locale = "en" | "fr" | "de" | "it";

export const DEFAULT_LOCALE: Locale = "en";

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "fr", "de", "it"];

let activeLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return activeLocale;
}

/** True only for the four shipped locale names (case-insensitive, base tag). */
export function isSupportedLocaleName(name: string): boolean {
  return normalizeLocaleName(name) !== null;
}

/**
 * Normalize one language tag to a shipped locale (`"fr-CA"` -> `"fr"`,
 * `"DE_at"` -> `"de"`). Returns null for unknown or empty tags so callers
 * fail closed to English.
 */
export function normalizeLocaleName(tag: string): Locale | null {
  const base = String(tag ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  if (base === "en" || base === "fr" || base === "de" || base === "it") return base;
  return null;
}

/** Accept only known locales; unknown names fail closed and keep the current locale. */
export function setLocale(locale: string): boolean {
  const next = normalizeLocaleName(locale);
  if (next === null) return false;
  activeLocale = next;
  return true;
}

/**
 * Pick the best shipped locale from an `Accept-Language` header value or a
 * `navigator.languages`-style tag list. Quality values (`q=`) order header
 * entries; tags without a shipped base are skipped. Anything unparseable,
 * empty, or without a match falls back to English.
 */
export function pickLocale(input: string | ReadonlyArray<string> | null | undefined): Locale {
  if (input === null || input === undefined) return DEFAULT_LOCALE;
  const tags: Array<string> = Array.isArray(input)
    ? [...input]
    : parseAcceptLanguage(String(input));
  for (const tag of tags) {
    const match = normalizeLocaleName(tag);
    if (match !== null) return match;
  }
  return DEFAULT_LOCALE;
}

/** Order one `Accept-Language` header by descending `q`, dropping `q=0` and `*`. */
function parseAcceptLanguage(header: string): Array<string> {
  const ranked: Array<{ tag: string; q: number; order: number }> = [];
  const parts = String(header ?? "").split(",");
  for (let i = 0; i < parts.length; i++) {
    const segments = parts[i].split(";");
    const tag = segments[0].trim();
    if (tag === "" || tag === "*") continue;
    let q = 1;
    for (let s = 1; s < segments.length; s++) {
      const pair = segments[s].trim().split("=");
      if (pair.length === 2 && pair[0].trim().toLowerCase() === "q") {
        const parsed = Number(pair[1].trim());
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (!(q > 0)) continue;
    ranked.push({ tag, q, order: i });
  }
  ranked.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.order - b.order));
  return ranked.map((entry) => entry.tag);
}

export type I18nVars = Record<string, string | number>;

const en = {
  "view.diagnostics.signedInNote":
    "If this site requires you to sign in, these details may contain sensitive information. Review them before sharing.",
  "view.diagnostics.save": "Save diagnostic report",
  "view.diagnostics.copyFailed": "Could not copy. Select and copy the details below.",
  "view.diagnostics.loadFailed":
    "Could not read the full report. The available details are shown below.",
  "view.retry.title": "Download paused",
  "view.retry.summary": "{done} of {total} tiles were retrieved.",
  "view.retry.explanation":
    "Automatic retries were exhausted. Retry once more or cancel; no file has been saved.",
  "view.retry.retry": "Retry once more",
  "view.retry.cancel": "Cancel",
  "desktop.done.title": "Image saved",
  "desktop.done.size": "{width} × {height} pixels",
  "desktop.done.saved": "Saved in your chosen folder.",
  "desktop.done.open": "Open image",
  "desktop.done.reveal": "Show in folder",
  "desktop.done.openError":
    "Could not open the image. Check that a default image viewer is installed.",
  "desktop.done.folderError":
    "Could not open the containing folder. Check that a file manager is installed.",
  "desktop.done.missingError": "The saved image or folder no longer exists.",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Got it",
  "view.modal.closeDialog": "Close dialog",
  "view.modal.closeTitle": "Close",
  // Desktop-app guidance modal.
  "view.desktop.title": "Dezoomify Desktop App",
  "view.desktop.subtitle":
    "High-performance native application for gigapixel museum artworks and local scans",
  "view.desktop.installer": "The unsigned {installer} for {platform} is on",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.releasesNote": "No auto-update; check GitHub Releases manually.",
  "view.desktop.installerMsi": ".msi installer",
  "view.desktop.installerDmg": "Apple silicon .dmg",
  "view.desktop.installerDeb": ".deb installer",
  "view.desktop.installerGeneric": "installer",
  "view.desktop.platformGeneric": "your platform",
  "view.desktop.whyTitle": "Why use the Desktop App?",
  "view.desktop.why1Title": "Handles Larger Artworks:",
  "view.desktop.why1Body":
    "A browser tab can only hold a certain amount of picture. The desktop app assembles the image in memory subject to available memory and writes the finished output to disk.",
  "view.desktop.why2Title": "Saves the Finished Picture:",
  "view.desktop.why2Body": "Each job saves to one output file on your computer.",
  "view.desktop.why3Title": "When the Website Cannot Finish:",
  "view.desktop.why3Body":
    "The website stops the job with an error and points to the desktop app for the full-size image.",
  "view.desktop.howTitle": "How to use it",
  "view.desktop.step1":
    "Save the unsigned {installer} for {platform} from our GitHub Releases page, then install it. There is no auto-update.",
  "view.desktop.step2": "Launch Dezoomify and paste your zoomable image or manifest URL.",
  "view.desktop.step3":
    "Select your desired resolution and destination folder to save the complete composite image.",
  "view.desktop.cliTitle": "Need automation? Try the Dezoomify CLI",
  "view.desktop.cliDesc":
    "The CLI provides headless, scriptable single-job saving ideal for automated pipelines and server environments without a GUI.",
  "view.desktop.cliLink": "Save CLI from GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Dezoomify Browser Extension",
  "view.ext.subtitle":
    "Automatic viewer discovery for password-protected digital archives and complex pages",
  "view.ext.availableOn": "Available on",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Why use the Browser Extension?",
  "view.ext.why1Title": "Signed-In Pages:",
  "view.ext.why1Body":
    "While you look at a zoomable image, it can find the image behind the viewer automatically, including on pages where you are signed in, such as library portals, museum subscriptions, and academic archives.",
  "view.ext.why2Title": "Easy to Use:",
  "view.ext.why2Body":
    "Press the Dezoomify button in the browser toolbar and pick the image to save, or send the job to the desktop app if the image is very large.",
  "view.ext.why3Title": "Private:",
  "view.ext.why3Body":
    "It only looks at the page you pointed it at, only after you pressed the button. It does not watch your browsing in the background.",
  "view.ext.howTitle": "How to use it in 3 steps",
  "view.ext.step1": "Install the extension from the Chrome Web Store or Firefox Browser Add-ons.",
  "view.ext.step2":
    "Navigate to the museum or library page displaying your artwork, logging in if needed.",
  "view.ext.step3":
    "Click the Dezoomify icon in your browser toolbar to automatically detect and extract the full-resolution image!",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Allow access to continue",
  "view.access.usesOrigin": "This image uses files from {origin}.",
  "view.access.needAccess":
    "Dezoomify needs access to read those files and assemble your image in this browser.",
  "view.access.requesting": "Requesting access…",
  "view.access.allow": "Allow access and continue",
  // Idle input section.
  "view.idle.clearTitle": "Clear input",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Finding the zoomable image…",
  "view.step.preflighting": "Checking the image size…",
  "view.step.downloading": "Saving image tiles…",
  "view.step.saving": "Assembling the final picture…",
  "view.step.contactingDetail": "Contacting the image host…",
  // Live job section.
  "view.job.techDetails": "Technical details & logs",
  "view.job.manyImages": "{count} images",
  "view.job.paused": "Paused",
  "view.job.retryingTiles": "Retrying tiles ({count})…",
  "view.job.waiting": "Waiting for {host}…",
  "view.job.sourceLabel": "Source",
  "view.job.pause": "Pause",
  "view.job.resume": "Resume",
  "view.job.stopReturn": "Stop and return to start",
  "view.job.progressValue": "{done} done, {active} in progress, {remaining} remaining",
  // Display-only section.
  "view.display.title": "Showing preview – not saved yet",
  "view.display.waysTitle": "Ways to save this artwork",
  "view.display.extTitle": "Browser Extension Guide",
  "view.display.extDesc":
    "For pages requiring login or session cookies. Automatically detects viewers on active pages.",
  "view.display.deskTitle": "Desktop App Guide",
  "view.display.deskDescClean":
    "For a clean full-size save when the browser can only show the image.",
  "view.display.startOver": "Start over",
  // Resolution downgrade notice: automatic selection took a smaller known
  // level than the maximum because of browser limits (website and extension).
  "view.resolution.title": "Image too large for this browser",
  "view.resolution.notice":
    "Not downloading at maximal resolution due to browser limitations. Try the desktop app to remove browser limitations.",
  "view.resolution.sizes": "Saving at {selected} pixels instead of the maximum {maximum} pixels.",
  "view.resolution.download": "Download desktop app",
  "view.resolution.tryMaximum": "Try maximum",
  "view.resolution.stop": "Stop",
  // Completion section.
  "view.done.ready": "Your image is ready.",
  "view.done.readyTitle": "Ready to save",
  "view.done.saveNow": "Save image now",
  "view.done.another": "Dezoomify another image",
  // Failure section.
  "view.fail.title": "Could not dezoomify image",
  "view.fail.deskDescLimits":
    "For images that exceed browser memory limits, subject to available memory. Processes natively on your computer.",
  "view.fail.helpTitle": "Help & URL Extraction",
  "view.fail.helpDesc":
    "How to find the image address on museum & archive sites, and what to try when nothing is found.",
  "view.fail.reportBug": "Report a bug on GitHub",
  "view.fail.reportBugDesc": "Prepare a GitHub issue with the diagnostics from this attempt.",
  "view.fail.retry": "Try again",
  // Browser canvas failure family (allocation, 2D context):
  // the desktop app is the recovery, so every message names it.
  "view.fail.canvasAllocation":
    "This picture is too large to assemble in this browser tab. The desktop app can save it at full size.",
  "view.fail.canvasContext":
    "This browser tab could not create the picture surface at this size. The desktop app can save it at full size.",
  // Cancelled section.
  "view.cancel.title": "Save cancelled",
  "view.cancel.message": "The image save was stopped.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} of {total} tiles",
  "view.job.pixelCounts": "{current} of {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation": "{percent}% of pixels prepared. Finishing the saved image.",
  "view.job.countsActive": "{current} of {total} tiles · {active} in progress",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Recent pictures",
  "view.history.empty": "No recent pictures yet. Images you start appear here.",
  "view.history.localOnly": "Kept only on this device.",
  "view.history.clear": "Clear history",
  "view.history.image": "Image",
  "view.history.time": "Started",
  "view.history.size": "Size (px)",
  "view.history.status": "Status",
  "view.history.remove": "Remove",
  "view.history.removeImage": "Remove {image} from recent pictures",
  "view.history.status.started": "Started",
  "view.history.status.completed": "Completed",
  "view.history.status.preview": "Preview only",
  "view.history.status.failed": "Failed",
  "view.history.status.cancelled": "Cancelled",
  "view.history.status.deleted": "Deleted",
  "view.history.status.checking": "Checking file…",
  "view.history.status.unavailable": "File unavailable",
  "view.history.status.opening": "Opening…",
  "view.history.openImage": "Open {image}",
  "view.history.openFailed": "Could not open file.",
  "view.input.description":
    "Dezoomify downloads zoomable tiled images from libraries, museums, galleries, and other websites. Paste the URL of an image below to download it.",
  "view.input.placeholder": "Paste an image viewer or manifest URL",
  "view.input.aria": "Address of the webpage containing your zoomable image",
  "view.input.start": "Find image",
  // Rate-limit explainers, rendered from the typed `rate-limited` failure at
  // display time (see `plainMessageFor` in failure.ts): an upstream 429
  // through the metadata proxy means OUR server was throttled; a direct 429
  // means the user's own connection was throttled. The two cases name
  // different fixes.
  "view.fail.rateProxy":
    "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened. The browser extension and the desktop app download from your own internet connection instead of our server, so they are not affected by this limit.",
  "view.fail.rateDirect":
    "The website hosting this image is receiving too many requests from your own connection right now. Waiting a few minutes usually clears it, and the browser extension or desktop app will see the same busy signal until it does.",
  // Fetch-failure family, rendered from the typed facts at display time
  // (see `plainMessageFor` in failure.ts): every observed cause names its
  // own next fix, so identical causes read identically everywhere.
  "view.fail.httpNotFound": "This page could not be found. Check the address and try again.",
  "view.fail.httpRefused":
    "The site refused to share this file (HTTP {http}). It may block shared servers; the browser extension or the desktop app may still work.",
  "view.fail.httpSiteProblem": "The site had a problem opening this page. Try again shortly.",
  "view.fail.httpNotOpened": "This page could not be opened. Check the address and try again.",
  "view.fail.policyBlocked":
    "This address cannot be opened through the website. {hint} The browser extension or the desktop app may still work.",
  "view.fail.hintAddress": "Check the address and try again.",
  "view.fail.hintPrivate": "The website cannot open private or local addresses.",
  "view.fail.hintContentType":
    "The site answered with a file type the website does not check here.",
  "view.fail.hintRedirect": "The site redirected in a way the website cannot follow.",
  "view.fail.proxyBudget":
    "This page is too large to check here. Try the desktop app for very large images.",
  "view.fail.proxyFetch": "The metadata proxy could not fetch this address. Try again shortly.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Please enter a valid web address starting with http:// or https://",
  "desktop.settings.unusable":
    "These download settings cannot be used. Adjust the highlighted settings and try again.",
  "desktop.settings.invalidSubmit":
    "These download settings are invalid. Adjust them and try again.",
  "desktop.output.deniedPick":
    "The save destination was not accepted. Choose a different file to continue.",
  "desktop.output.exists":
    "A file already exists at the save destination from {host}. Choose a different file or confirm overwriting to continue.",
  "desktop.output.destDenied":
    "The save destination was not accepted from {host}. Choose a different file to continue.",
  "desktop.job.gone": "This job is no longer active from {host}. Start again with a fresh address.",
  "desktop.msg.thisPicture": "this picture",
  "desktop.msg.dimsPixels": "{a} by {b} pixels",
  "desktop.msg.needAbout": " It needs about {need} of memory",
  "desktop.output.canvasLimit":
    "This picture is too large to assemble on this computer ({dims},{need} at 4 bytes per pixel, limit {limit}). Save a smaller version with Max width (CLI: --max-width). Note: JPEG saves at most {jpegMax} pixels per side; keep PNG for larger pictures. From {host}.",
  "desktop.output.jpegLimit":
    "This picture ({dims}) is too large for JPEG, which allows at most {jpegMax} pixels per side. Save it as PNG instead. From {host}.",
  "desktop.output.webpLimit":
    "This picture ({dims}) is too large for WebP, which allows at most {webpMax} pixels per side. Save it as PNG instead. From {host}.",
  "desktop.tile.failed":
    "Could not retrieve a tile from {host}. Check the source image and try again.",
  "view.discovery.none":
    "No zoomable image was found at this address. Try a page that contains a zoom viewer, or try the browser extension.",
  "view.discovery.noneExtension":
    "No zoomable image was found on this page. Report a bug with the diagnostics, or follow the guide to find the image address.",
  "desktop.plan.none":
    "This picture has no usable size to save from {host}. Try a different picture or a smaller Max width.",
  "desktop.transport.stalled":
    "Saving stalled while contacting {host}. Check your connection and try again.",
  "desktop.output.writeFail":
    "Could not write this picture from {host}. Choose a different save destination and try again.",
  "desktop.job.cancelledMsg": "The image save was stopped. Any unfinished file was removed.",
  "desktop.start.failed": "Could not start saving this picture from {host}. Try again.",
  "desktop.choice.failed": "That choice was not accepted. Try again.",
  "desktop.internal.error":
    "Something unexpected stopped this save from {host}. Try again, and copy diagnostics if it keeps happening.",
  "desktop.save.fallback": "Could not save this picture from {host}. Try again.",
  "desktop.invoke.startFallback": "Could not start the job.",
  "desktop.invoke.retry": "The retry choice was rejected.",
  "desktop.cancel.note": "Save cancelled. Cleanup is done and any unfinished file was removed.",
  "desktop.copy.diagnostics": "Copy diagnostics",
  "desktop.copy.copied": "Copied!",
  "desktop.panel.jobActions": "Desktop job actions",
  "desktop.settings.reset": "Reset settings",
  "desktop.quick.info": "More information",
  "desktop.quick.auto": "Auto",
  "desktop.quick.sizeEstimate": "<{size} MB",
  "desktop.quick.folderInfo": "Choose where downloaded images are saved.",
  "desktop.quick.formatInfo":
    "Choose an output format. Auto saves JPEG for opaque images up to 65,535 pixels per side; otherwise PNG.",
  "desktop.quick.sizeInfo":
    "Presets select the largest source level within these width and height targets. If none fits, the smallest level is used, which may exceed the targets and encoder limits. Images are not resized. Estimates assume the listed dimensions; actual sizes and format compatibility depend on the source. Estimated MB = width × height × bytes/pixel / 1,000,000. PNG uses 1.6 bytes/pixel; lossless WebP 1.3; TIFF/ZIF 3. JPEG uses a small native-encoder calibration sample (two paintings and a map): quality ≤25: 0.1; ≤50: 0.15; ≤75: 0.2; ≤90: 0.3; ≤95: 0.4; ≤98: 0.45; ≤100: 0.5 bytes/pixel. Auto estimates an opaque JPEG; transparency uses PNG instead. ZIF/IIIF add one third for pyramid levels. Every estimate gets a 10% buffer, then rounds up to the next 5 MB. These are heuristics, not guaranteed file-size limits; detail, source compression, aspect ratio, metadata and encoder settings affect actual files. Full/custom sizes need source dimensions.",
  "desktop.quick.maxWidth": "Max width",
  "desktop.quick.maxHeight": "Max height",
  "desktop.quick.original": "Original",
  "desktop.quick.userDefined": "User-defined",
  "desktop.quick.estimatedSize": "Estimated size ({format})",
  "desktop.quick.networkInfo":
    "Fast uses up to 16 simultaneous requests without pacing. Balanced starts up to 5 requests per second; Gentle starts up to 2. Slower pacing can help busy servers.",
  "desktop.quick.source": "Source-dependent",
  "desktop.quick.exact": "Custom",
  "desktop.quick.upTo": "Up to {size}K",
  "desktop.quick.hint.auto": "adaptive",
  "desktop.quick.hint.png": "lossless",
  "desktop.quick.hint.jpeg": "compressed",
  "desktop.quick.hint.tiff": "archival",
  "desktop.quick.hint.webp": "lossless",
  "desktop.quick.hint.zif": "zoomable",
  "desktop.quick.hint.iiifDir": "tiled",
  "desktop.quick.format.auto":
    "JPEG for opaque images up to 65,535 pixels per side; PNG for transparency or larger images. JPEG quality also applies to Auto.",
  "desktop.quick.format.png":
    "Lossless pixels and transparency; larger files, suitable for editing.",
  "desktop.quick.format.jpeg":
    "Smaller lossy files. No transparency; limited to 65,535 pixels per side. Adjust quality in More settings.",
  "desktop.quick.format.tiff": "Lossless output for archiving and editing.",
  "desktop.quick.format.webp": "Lossless compressed output, limited to 16,383 pixels per side.",
  "desktop.quick.format.zif": "A lossless tiled TIFF pyramid for zooming at several resolutions.",
  "desktop.quick.format.iiifDir": "A folder of JPEG tiles and info.json for hosting an IIIF image.",
  "desktop.quick.rate.maximum": "16 parallel",
  "desktop.quick.rate.balanced": "5/s",
  "desktop.quick.rate.gentle": "2/s",
  "desktop.quick.folder": "Folder",
  "desktop.quick.askEachTime": "Ask each time",
  "desktop.quick.chosenFolder": "Chosen folder",
  "desktop.quick.chooseFolder": "Choose a starting folder for the save dialog",
  "desktop.quick.format": "Format",
  "desktop.quick.size": "Size",
  "desktop.quick.network": "Network",
  "desktop.quick.fast": "Fast",
  "desktop.quick.balanced": "Balanced",
  "desktop.quick.gentle": "Gentle",
  "desktop.quick.fullResolution": "Full resolution",
  "desktop.quick.upTo4k": "Up to 4K",
  "desktop.quick.upTo2k": "Up to 2K",
  "desktop.quick.custom": "Custom…",
  "desktop.quick.more": "More settings",
  "desktop.advanced.title": "Advanced settings",
  "desktop.advanced.done": "Done",
  "desktop.advanced.jpegQuality": "JPEG quality",
  "desktop.advanced.jpegQualityDesc": "Higher keeps more image detail.",
  "desktop.advanced.compressionEffort": "Compression effort",
  "desktop.advanced.compressionEffortDesc":
    "Image quality stays lossless; higher values take longer.",
  "desktop.advanced.dimensions": "Custom dimensions",
  "desktop.advanced.dimensionsDesc":
    "Leave either value empty to preserve the original proportion.",
  "desktop.advanced.width": "Width",
  "desktop.advanced.height": "Height",
  "desktop.advanced.retries": "Retries",
  "desktop.advanced.retriesDesc": "Automatic retries before asking whether to retry once more.",
  "desktop.advanced.resumeCache": "Resume cache",
  "desktop.advanced.resumeCacheDesc": "Reuse tiles after an interrupted save.",
  "desktop.advanced.choose": "Choose…",
  "desktop.advanced.change": "Change…",
  "desktop.advanced.headers": "Request headers",
  "desktop.advanced.headersDesc": "For protected viewers. Sent only to the image origin.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;

export type I18nKey = keyof typeof en;

/** Canonical English templates. Tests enumerate this table. */
export const EN: Record<string, string> = en;

/** French templates (same keys, same placeholders). */
export const FR: Record<string, string> = fr;

/** German templates (same keys, same placeholders). */
export const DE: Record<string, string> = de;

/** Italian templates (same keys, same placeholders). */
export const IT: Record<string, string> = it;

const dictionaries: Record<string, Record<string, string>> = { en, fr, de, it };

/** Read one locale table with English fallback (never undefined). */
export function getDictionary(locale: string): Record<string, string> {
  const match = normalizeLocaleName(locale);
  if (match !== null) return dictionaries[match] ?? EN;
  return EN;
}

/**
 * Render one message with `{var}` substitution in the active locale (or an
 * explicit locale override). Unknown keys fall back to the key itself; keys
 * missing from the active locale fall back to English per key.
 */
export function t(key: I18nKey, vars?: I18nVars, locale?: string): string {
  const want: string =
    typeof locale === "string" && locale !== ""
      ? (normalizeLocaleName(locale) ?? activeLocale)
      : activeLocale;
  const table: Record<string, string> = dictionaries[want] ?? EN;
  const template: string = table[key as string] ?? EN[key as string] ?? (key as string);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
