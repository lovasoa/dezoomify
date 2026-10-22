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
    const q = languageQuality(segments.slice(1));
    if (!(q > 0)) continue;
    ranked.push({ tag, q, order: i });
  }
  ranked.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.order - b.order));
  return ranked.map((entry) => entry.tag);
}

function languageQuality(parameters: string[]): number {
  let quality = 1;
  for (const parameter of parameters) {
    const pair = parameter.trim().split("=");
    if (pair.length !== 2 || pair[0].trim().toLowerCase() !== "q") continue;
    const parsed = Number(pair[1].trim());
    if (Number.isFinite(parsed)) quality = parsed;
  }
  return quality;
}

export type I18nVars = Record<string, string | number>;

const en = {
  "view.images.title": "Choose an image",
  "view.images.untitled": "Image {number}",
  "view.images.noPreview": "No preview available",
  "view.images.unknownSize": "Dimensions unknown",
  "view.images.choose": "Choose",
  "view.images.chooseNamed": "Choose {title} (image {number})",
  "view.images.cancel": "Cancel",
  "page.brand": "Save zoomable images",
  "page.nav.label": "Main navigation",
  "page.nav.extension": "Browser extension",
  "page.nav.desktop": "Desktop app",
  "page.nav.help": "Help",
  "page.nav.donate": "Donate",
  "page.nav.donateTitle": "Help cover hosting costs",
  "page.footer.source": "Source code (GPL)",
  "page.footer.faq": "Frequently asked questions",
  "page.footer.privacy": "Privacy",
  "page.footer.terms": "Terms",
  "page.legacy.title": "Looking for the old Dezoomify?",
  "page.legacy.link": "Open the legacy site",
  "page.preview.zoomOut": "Zoom out",
  "page.preview.zoomIn": "Zoom in",
  "page.preview.reset": "Reset zoom to 100 percent",
  "page.preview.fit": "Fit",
  "page.preview.fitLabel": "Fit image inside preview",
  "view.diagnostics.signedInNote":
    "If this site requires you to sign in, these details may contain sensitive information. Review them before sharing.",
  "view.diagnostics.save": "Save diagnostic report",
  "view.diagnostics.copyFailed": "Could not copy. Select and copy the details below.",
  "view.diagnostics.loadFailed":
    "Could not read the full report. The available details are shown below.",
  "view.retry.title": "Download paused",
  "view.retry.summary": "{done} of {total} image pieces downloaded.",
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
  "view.desktop.download.windows": "Windows installer · x64 (MSI)",
  "view.desktop.download.macos": "macOS installer · Apple Silicon (DMG)",
  "view.desktop.download.linux": "Linux installer · x64 (DEB)",
  "view.desktop.step1": "Download the installer above for your system, then install it.",
  "view.desktop.subtitle": "Save large images directly to your computer",
  "view.desktop.whyTitle": "Why use the Desktop App?",
  "view.desktop.why1Title": "Download larger images:",
  "view.desktop.why1Body":
    "Save images that exceed your browser’s size limits. The app can build the file as it downloads, without keeping the whole image in memory. Very large images may still need a different file format or a smaller size.",
  "view.desktop.why2Title": "Use your own connection:",
  "view.desktop.why2Body":
    "The app gets image information and every piece of the picture directly from the source site using your internet connection. This can help when a site blocks Dezoomify’s shared server.",
  "view.desktop.why3Title": "Choose your file format:",
  "view.desktop.why3Body":
    "Save as JPEG, PNG, TIFF, or other formats for viewing, editing, or archiving. Choose the folder where your images are saved.",
  "view.desktop.howTitle": "How to use it",
  "view.desktop.step2": "Open Dezoomify and paste the address of the page or zoomable image.",
  "view.desktop.step3": "Choose a folder, file format, and image size, then start the download.",
  "view.desktop.cliTitle": "Need automation? Try the Dezoomify CLI",
  "view.desktop.cliDesc":
    "Use the command-line version to download images from scripts or process a list of addresses.",
  "view.desktop.cliLink": "Download the CLI from GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Dezoomify Browser Extension",
  "view.ext.subtitle":
    "Save zoomable images from the page you’re viewing, including sites where you’re signed in",
  "view.ext.availableOn": "Available on",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Why use the Browser Extension?",
  "view.ext.why1Title": "Use your existing login:",
  "view.ext.why1Body":
    "Download images you can access while signed in to a library, museum, or archive. If access to another site is needed, the extension asks for your permission.",
  "view.ext.why2Title": "Skip the search for an image address:",
  "view.ext.why2Body":
    "Click Dezoomify in your browser toolbar to find the image in the page’s viewer. The download starts in a new tab. Browser size limits still apply.",
  "view.ext.why3Title": "Runs when you ask:",
  "view.ext.why3Body":
    "The extension checks the page only when you click its button. It does not watch your browsing in the background.",
  "view.ext.howTitle": "How to use it in 3 steps",
  "view.ext.step1": "Install the extension from the Chrome Web Store or Firefox Browser Add-ons.",
  "view.ext.step2":
    "Open the page with your image, sign in if needed, and zoom in once to let the image load.",
  "view.ext.step3":
    "Click Dezoomify in the browser toolbar. Allow access if asked, and keep the download tab open until saving finishes.",
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
  "view.step.downloading": "Downloading image pieces…",
  "view.step.saving": "Assembling the final picture…",
  "view.step.contactingDetail": "Contacting the source site…",
  // Live job section.
  "view.job.techDetails": "Technical details & logs",
  "view.job.manyImages": "{count} images",
  "view.job.paused": "Paused",
  "view.job.retryingTiles": "Retrying image pieces ({count})…",
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
    "Find the image on the page you’re viewing, including pages where you’re signed in.",
  "view.display.deskTitle": "Desktop App Guide",
  "view.display.deskDescClean":
    "Download directly from the source site when your browser can only show a preview.",
  "view.display.startOver": "Start over",
  // Resolution downgrade notice: automatic selection took a smaller known
  // level than the maximum because of browser limits (website and extension).
  "view.resolution.title": "Lower-resolution image",
  "view.resolution.sizes": "Image size: {selected} pixels. Maximum available: {maximum} pixels.",
  "view.resolution.download": "Get full resolution with the desktop app",
  "view.desktop.handoffTitle": "Download this image in the desktop app",
  "view.desktop.handoffInstall":
    "Choose the installer for your operating system, then open Dezoomify.",
  "view.desktop.handoffPaste": "Paste this address into the desktop app:",
  "view.desktop.handoffCopy": "Copy address",
  "view.desktop.handoffCopied": "Address copied. Paste it into the desktop app.",
  "view.desktop.handoffCopyFailed":
    "Could not copy. Select the address above and copy it manually.",
  "view.desktop.handoffStart": "Choose Full resolution in the Size menu, then start the download.",
  "view.desktop.handoffAccess":
    "The desktop app cannot use your browser login. For images that require signing in, try the browser extension.",
  "view.desktop.handoffUnavailable":
    "There is no image address to copy for this download. Copy the original page’s address and try it in the desktop app.",
  // Completion section.
  "view.done.ready": "Your image is ready.",
  "view.done.readyTitle": "Ready to save",
  "view.done.saveNow": "Save image now",
  "view.done.another": "Dezoomify another image",
  "view.done.guidance":
    "Use the save button to download your image. Colors may shift slightly because browser downloads do not keep the original color profile. For formats that preserve color profiles, use the desktop app.",
  "view.done.summary": "{width} × {height} pixels ({mime})",
  "view.done.fallback":
    "Saved an image available on this page. If it isn’t the image you wanted, you can report it using the technical details below.",
  "view.display.guidance":
    "Your browser can display this image, but the source site does not allow it to create a downloadable file. Try the desktop app or browser extension to save it.",
  // Failure section.
  "view.fail.title": "Could not dezoomify image",
  "view.fail.deskDescLimits":
    "Save larger images directly from the source site using your own internet connection.",
  "view.fail.helpTitle": "Help finding an image",
  "view.fail.helpDesc":
    "How to find the image address on museum & archive sites, and what to try when nothing is found.",
  "view.fail.reportBug": "Report a bug on GitHub",
  "view.fail.reportBugDesc": "Prepare a GitHub issue with the diagnostics from this attempt.",
  "view.fail.retry": "Try again",
  // Browser canvas failure family (allocation, 2D context):
  // the desktop app is the recovery, so every message names it.
  "view.fail.canvasAllocation":
    "This image is too large for this browser tab. Try the desktop app to save a larger image.",
  "view.fail.canvasContext":
    "Your browser could not prepare an image this size. Try the desktop app, or close other tabs and try again.",
  // Cancelled section.
  "view.cancel.title": "Save cancelled",
  "view.cancel.message": "The image save was stopped.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} of {total} image pieces",
  "view.job.pixelCounts": "{current} of {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation": "{percent}% of pixels prepared. Finishing the saved image.",
  "view.job.countsActive": "{current} of {total} image pieces · {active} in progress",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Recent pictures",
  "view.history.empty": "No recent pictures yet. Images you start appear here.",
  "view.history.localOnly": "Kept only on this device.",
  "view.history.clear": "Clear history",
  "view.history.source": "Source",
  "view.history.time": "Started",
  "view.history.size": "Size (px)",
  "view.history.result": "Result",
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
    "Save zoomable images from museums, libraries, archives, and other websites. Paste the address of the page showing your image to get started.",
  "view.input.placeholder": "Paste a page or image address",
  "view.input.aria": "Address of the webpage containing your zoomable image",
  "view.input.start": "Find image",
  // Rate-limit explainers, rendered from the typed `rate-limited` failure at
  // display time (see `plainMessageFor` in failure.ts): an upstream 429
  // through the metadata proxy means OUR server was throttled; a direct 429
  // means the user's own connection was throttled. The two cases name
  // different fixes.
  "view.fail.rateProxy":
    "The source site is limiting downloads from our server. Wait a few minutes, or try the desktop app or browser extension to download using your own internet connection.",
  "view.fail.rateDirect":
    "The source site is limiting downloads from your own connection. Wait a few minutes before trying again. Switching to the desktop app or extension uses the same connection and may not help.",
  // Fetch-failure family, rendered from typed facts and product context
  // at display time (see `plainMessageFor` in failure.ts).
  "view.fail.httpNotFound": "This page could not be found. Check the address and try again.",
  "view.fail.httpRefused":
    "The site refused to share this file (HTTP {http}). Open the original page to check that you can still access the image, then try again.",
  "view.fail.httpRefusedProxy":
    "The site refused to send this file to Dezoomify’s server (HTTP {http}). Try the browser extension or desktop app to download directly using your own internet connection.",
  "view.fail.httpSiteProblem": "The site had a problem opening this page. Try again shortly.",
  "view.fail.httpNotOpened": "This page could not be opened. Check the address and try again.",
  "view.fail.policyBlocked":
    "This address cannot be opened through the website. {hint} The browser extension or the desktop app may still work.",
  "view.fail.hintAddress": "Check the address and try again.",
  "view.fail.hintPrivate": "The website cannot open private or local addresses.",
  "view.fail.hintContentType":
    "The source site returned a type of file Dezoomify cannot read here.",
  "view.fail.hintRedirect": "The site redirected in a way the website cannot follow.",
  "view.fail.proxyBudget":
    "This file is too large for our server to retrieve. Try the desktop app to download it directly.",
  "view.fail.proxyFetch":
    "Our server could not retrieve this address. Try again shortly, or use the desktop app to connect directly to the source site.",
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
    "This picture needs more memory than is available ({dims},{need}; limit {limit}). Save a smaller version with Max width (CLI: --max-width), or choose a tile folder. From {host}.",
  "desktop.output.codecLimit":
    "This picture ({dims}) is too large for {format}, which allows at most {maxSide} pixels per side. Save it as PNG instead. From {host}.",
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
  "desktop.quick.compression": "Compression",
  "desktop.quick.compressionInfo":
    "Higher values aim for smaller files. Each format determines the effect on image quality and encoding time.",
  "desktop.quick.compressionUnavailable": "Compression cannot be adjusted for this format.",
  "desktop.quick.compressionWarning":
    "Severe detail loss: this compression may make text and fine details unreadable.",
  "desktop.quick.sizeEstimate": "Up to about {size}",
  "desktop.quick.folderInfo": "Choose where downloaded images are saved.",
  "desktop.quick.formatInfo":
    "Choose an output format. Auto selects a format appropriate for the image.",
  "desktop.quick.sizeInfo":
    "Each estimate assumes an image filling the preset's maximum width and height. A smaller source or different aspect ratio can produce a much smaller file. Estimates interpolate measurements for the codec and compression setting, include extra pyramid levels where applicable, add a 10% buffer and round up to two significant digits with units appropriate to the size. They are rough budgets, not guaranteed file-size or memory limits; detail, transparency and metadata affect actual files. Auto assumes an opaque JPEG; transparency uses PNG. Presets select a source level without resizing. If none fits, the smallest level is used and may exceed the selected maximum. Full/custom sizes depend on the source.",
  "desktop.quick.maxWidth": "Max width",
  "desktop.quick.maxHeight": "Max height",
  "desktop.quick.original": "Original",
  "desktop.quick.userDefined": "User-defined",
  "desktop.quick.estimatedSize": "Estimate at max size ({format})",
  "desktop.quick.networkInfo":
    "Fast uses up to 16 simultaneous requests without pacing. Balanced starts up to 5 requests per second; Gentle starts up to 2. Slower pacing can help busy servers.",
  "desktop.quick.source": "Source-dependent",
  "desktop.quick.exact": "Custom",
  "desktop.quick.upTo": "Up to {size}K",
  "desktop.quick.hint.adaptive": "adaptive",
  "desktop.quick.hint.lossless": "lossless",
  "desktop.quick.hint.compressed": "compressed",
  "desktop.quick.hint.advancedCompression": "advanced compression",
  "desktop.quick.hint.archival": "archival",
  "desktop.quick.hint.zoomable": "zoomable",
  "desktop.quick.hint.tiled": "tiled",
  "desktop.quick.format.auto":
    "JPEG for opaque images up to {maxSide} pixels per side; PNG for transparency or larger images. Compression also applies to Auto.",
  "desktop.quick.format.png":
    "Lossless pixels and transparency; larger files, suitable for editing.",
  "desktop.quick.format.jpeg":
    "Smaller lossy files. No transparency; limited to {maxSide} pixels per side. Adjust compression in the Size menu.",
  "desktop.quick.format.tiff": "Lossless output for archiving and editing.",
  "desktop.quick.format.webp": "Lossless compressed output, limited to {maxSide} pixels per side.",
  "desktop.quick.format.avif":
    "Advanced compression with transparency. Lossy output, limited to {maxSide} pixels per side. Adjust compression in the Size menu. Needs the complete image in memory and does not preserve embedded color profiles. Even the lowest compression is lossy.",
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
  "desktop.quick.format.generic": "Save the image as {format}.",
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
