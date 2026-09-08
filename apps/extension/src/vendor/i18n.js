// GENERATED from packages/shared-ui/src/i18n.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/shared-ui/src/i18n.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Shared-UI message dictionary (English plus French, German, Italian).
//
// User-facing copy renders through `t(key, vars)` against one table per
// locale. English (`en`) is the canonical source: every other locale mirrors
// it key for key with identical `{placeholders}`. Lookups fall back to
// English per key, so a missing translation never renders `undefined`.
// There is deliberately one lookup path only: a new locale adds a sibling
// table under `locales/` plus a `SUPPORTED_LOCALES` entry, never a second
// dictionary shape.
//
// Locale selection: hosts call `setLocale()` with an explicit picker choice,
// or `pickLocale()` with an `Accept-Language` header value or a
// `navigator.languages` list. Unknown tags fail closed to English.
// The website documents the picker in `docs/user/website.md`; help bodies
// stay English and regenerate via `scripts/build-help.mjs`.
//
// Rules (see `packages/shared-ui/AGENTS.md`):
// - User copy goes through `t()`; stable codes, diagnostics, technical logs,
//   URLs, transport codes, and protocol strings stay literal English.
// - Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub
//   Releases", format names such as "PNG") stay literal in code; translators
//   never rewrite them.
// - Interpolation is `{name}` substitution only (no plurals engine, no
//   markup). Callers escape with `escapeHtml` when composing `innerHTML`.
// - The extension modal ships with no bundler and cannot import this module
//   by relative path: it renders through its vendored `vendor/i18n.js`
//   codegen mirror (see `scripts/sync-web-js.mjs`), which carries these same
//   tables behind the same `t(key, vars)` shape. `test/ui-i18n.test.mjs`
//   fails when a renderer uses a key outside this table, when a locale
//   drops a key, or when placeholders diverge per locale.
//
// This module is erasable-syntax-only TypeScript (type aliases, plain
// functions) so `scripts/sync-web-js.mjs` can mirror it to `i18n.js` for
// browsers exactly like the other shared-ui modules.

import { fr } from "./locales/fr.js";
import { de } from "./locales/de.js";
import { it } from "./locales/it.js";

export const DEFAULT_LOCALE         = "en";

export const SUPPORTED_LOCALES                        = ["en", "fr", "de", "it"];

let activeLocale         = DEFAULT_LOCALE;

export function getLocale()         {
  return activeLocale;
}

/** True only for the four shipped locale names (case-insensitive, base tag). */
export function isSupportedLocaleName(name        )          {
  return normalizeLocaleName(name) !== null;
}

/**
 * Normalize one language tag to a shipped locale (`"fr-CA"` -> `"fr"`,
 * `"DE_at"` -> `"de"`). Returns null for unknown or empty tags so callers
 * fail closed to English.
 */
export function normalizeLocaleName(tag        )                {
  const base = String(tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (base === "en" || base === "fr" || base === "de" || base === "it") return base;
  return null;
}

/** Accept only known locales; unknown names fail closed and keep the current locale. */
export function setLocale(locale        )          {
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
export function pickLocale(input                                                   )         {
  if (input === null || input === undefined) return DEFAULT_LOCALE;
  const tags                = Array.isArray(input) ? [...input] : parseAcceptLanguage(String(input));
  for (const tag of tags) {
    const match = normalizeLocaleName(tag);
    if (match !== null) return match;
  }
  return DEFAULT_LOCALE;
}

/** Order one `Accept-Language` header by descending `q`, dropping `q=0` and `*`. */
function parseAcceptLanguage(header        )                {
  const ranked                                                   = [];
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

const en = {
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Got it",
  "view.modal.closeDialog": "Close dialog",
  "view.modal.closeTitle": "Close",
  // Desktop-app guidance modal.
  "view.desktop.title": "Dezoomify Desktop App",
  "view.desktop.subtitle":
    "High-performance native application for gigapixel museum artworks and local scans",
  "view.desktop.noInstaller":
    "No installer ships for {platform} yet. Only Linux has a .deb (unsigned) on",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.whyTitle": "Why use the Desktop App?",
  "view.desktop.why1Title": "Handles Larger Artworks:",
  "view.desktop.why1Body":
    "A browser tab can only hold a certain amount of picture. The desktop app assembles the image in memory (up to its 8 GiB canvas limit, needing matching free memory) and writes the finished output to disk.",
  "view.desktop.why2Title": "Saves the Finished Picture:",
  "view.desktop.why2Body": "Each job saves to one output file on your computer. You can queue several jobs; they save one at a time.",
  "view.desktop.why3Title": "When the Website Cannot Finish:",
  "view.desktop.why3Body":
    "The website stops the job with an error and points to the desktop app for the full-size image.",
  "view.desktop.howTitle": "How to use it",
  "view.desktop.step1":
    "No installer ships for {platform} yet; only Linux has an unsigned .deb on our GitHub Releases page. Verify SHA256SUMS and signatures before installing. There is no auto-update.",
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
  "view.ext.firefoxVersion": "Firefox version",
  "view.ext.firefoxSoon": "On its way",
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
  "view.ext.step1":
    "Install the extension from the Chrome Web Store. The Firefox version is on its way.",
  "view.ext.step2":
    "Navigate to the museum or library page displaying your artwork, logging in if needed.",
  "view.ext.step3":
    "Click the Dezoomify icon in your browser toolbar to automatically detect and extract the full-resolution image!",
  // Idle input section.
  "view.idle.intro": "allows you to save",
  "view.idle.zoomable": "zoomable images",
  "view.idle.zoomableTitle": "Large images in which you can navigate inside a webpage.",
  "view.idle.enterThe": "Enter the",
  "view.idle.urlAbbr": "URL",
  "view.idle.urlTitle": "Uniform Resource Locator, the address of a webpage",
  "view.idle.body":
    "of such an image in the text field below. The image will be saved at maximal resolution. You can then right-click on the image, and choose \"Save As\" in order to save it as a PNG file on your computer. If it doesn't work, read our",
  "view.idle.troubleLink": "troubleshooting guide",
  "view.idle.moreInfo": "If you want more information, read our",
  "view.idle.projectLink": "project page",
  "view.idle.license1": "This script is released under the",
  "view.idle.gplLink": "GPL",
  "view.idle.sourceLink": "See the source code",
  "view.idle.termsLink": "We decline any responsibility for an illegal use of this software",
  "view.idle.urlPlaceholder": "URL of the webpage containing your image",
  "view.idle.urlAria": "URL of the webpage containing your zoomable image",
  "view.idle.clearTitle": "Clear input",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Finding the zoomable image…",
  "view.step.choosingImage": "Image found; picking the best one…",
  "view.step.choosingLevel": "Choosing the highest resolution…",
  "view.step.preflighting": "Checking the image size…",
  "view.step.downloading": "Saving image tiles…",
  "view.step.saving": "Assembling the final picture…",
  "view.step.working": "Working…",
  // Live job section.
  "view.job.workingOn": "Working on",
  "view.job.cancel": "Cancel",
  "view.job.change": "Change",
  "view.job.techDetails": "Technical details & logs",
  "view.job.oneImage": "1 image",
  "view.job.manyImages": "{count} images",
  "view.job.autoChoiceFull": "Found {noun}, saving largest that fits ({width}×{height}, {tiles} tiles).",
  "view.job.autoChoiceDims": "Found {noun}, saving largest that fits ({width}×{height}).",
  "view.job.autoChoiceTiles": "Found {noun}, saving largest that fits ({tiles} tiles).",
  "view.job.autoChoiceBare": "Found {noun}, saving largest that fits.",
  "view.job.stalled":
    "Still working, {host} is slow to answer. You can wait, or cancel and try again later.",
  // Display-only section.
  "view.display.title": "Showing preview – not saved yet",
  "view.display.shownPlain": "Shown below without saving.",
  "view.display.shownPrefix": "Shown below without saving.",
  "view.display.openDesktop": "Open in desktop app",
  // One-click desktop handoff (todo 5.5): the button names the origin and the
  // summary names scope/recipient/job memory-only, mirroring the extension
  // consent pattern (origins, cookie names, job). The desktop app confirms
  // again before any effect; declining there does nothing.
  "view.handoff.send": "Send to desktop app",
  "view.handoff.sendOrigin": "Send to desktop app ({origin})",
  "view.handoff.summary":
    "Sends {origin} to the desktop app. No sign-in details travel; one job only, kept in memory.",
  "view.handoff.localNote":
    "Local files stay on this computer. Open the desktop app and choose the file there; nothing is sent.",
  "view.display.waysTitle": "Ways to save this artwork",
  "view.display.extTitle": "Browser Extension Guide",
  "view.display.extDesc":
    "For pages requiring login or session cookies. Automatically detects viewers on active pages.",
  "view.display.deskTitle": "Desktop App Guide",
  "view.display.deskDescClean": "For a clean full-size save when the browser can only show the image.",
  "view.display.startOver": "Start over",
  // Completion section.
  "view.done.ready": "Your image is ready.",
  "view.done.savedDisk": "Saved to disk",
  "view.done.readyTitle": "Ready to save",
  "view.done.saveNow": "Save image now",
  "view.done.another": "Dezoomify another image",
  // Already-saved completion (ViewContext.savedOutput): the host wrote the
  // output before rendering (for example the extension blob-anchor save), so
  // completion reads as saved with the file name and offers no second-click
  // save button. Absent keeps the website ready plus save-now path.
  "view.done.savedFile": "Saved",
  "view.done.gaps": "Saved with gaps",
  "view.done.savedFull": "Saved {name} ({w}x{h}).",
  "view.done.savedPartial":
    "Saved {name} ({w}x{h}, {done} of {total} tiles; {failed} tile(s) missing).",
  // Gap map behind a kept partial: the missing-tile ledger renders inline
  // with the completion summary, so a partial save never reads as silent
  // gaps. `shown` lists the first ledger ids, `rest` names the overflow.
  "view.done.gapMap": "Missing tiles ({failed} of {total}): {shown}{rest}.",
  "view.done.gapMapMore": ", and {n} more",
  // Failure section.
  "view.fail.fallback": "Dezoomify could not find or save the zoomable image at this address.",
  "view.fail.title": "Could not dezoomify image",
  "view.fail.deskDescLimits":
    "For images that exceed browser memory limits, within an 8 GiB canvas cap (needing matching free memory). Processes natively on your computer.",
  "view.fail.helpTitle": "Help & URL Extraction",
  "view.fail.helpDesc":
    "How to find the image address on museum & archive sites, and what to try when nothing is found.",
  "view.fail.techDetails": "Technical error details & bug report",
  "view.fail.reportBug": "Report a bug on GitHub",
  "view.fail.retry": "Try again",
  // Cancelled section.
  "view.cancel.title": "Save cancelled",
  "view.cancel.message": "The image save was stopped.",
  // Generic fallback for unknown phases (debug surface; status codes stay raw).
  "view.generic.status": "Status:",
  "view.generic.reset": "Reset",
  // Image and level picker dialogs.
  "view.pick.imageTitle": "Choose an image",
  "view.pick.imageSub":
    "The recommended image is already selected. Press Use selected to continue in one click.",
  "view.pick.imageGroup": "Images found on this page",
  "view.pick.autoImage": "Use largest that fits",
  "view.pick.autoImageMeta": "Recommended, one click",
  "view.pick.cancel": "Cancel",
  "view.pick.useSelected": "Use selected",
  "view.pick.levelTitle": "Choose a resolution",
  "view.pick.levelSub": "Fit screen is already selected. Press Use selected to continue in one click.",
  "view.pick.levelGroup": "Resolutions for the chosen image",
  "view.pick.fitScreen": "Fit screen",
  "view.pick.fitScreenMeta": "Highest resolution that fits, recommended",
  "view.pick.fullRes": "Full resolution",
  "view.pick.fullResMeta": "Largest available",
  "view.pick.levelName": "Level {index}",
  "view.pick.loadingSize": "size shown while loading",
  "view.pick.fits": "fits in browser",
  "view.pick.tooLarge": "too large, needs desktop app",
  "view.pick.tilesMeta": ", {tiles} tiles",
  // Job section picker and share chrome.
  "view.job.shareTitle": "Copies the page address for this job, not the image file itself",
  "view.job.shareLink": "Copy link to this job",
  "view.job.chooseImage": "Found {noun}. Choose which image to save{suffix}",
  "view.job.chooseLevel": "Image chosen. Choose a resolution{suffix}",
  "view.job.chooseBtn": "Choose",
  "view.job.chooseAria": "Choose from the offered options",
  "view.job.changeAria": "About automatic choice",
  "view.job.pickHint": "The recommended choice is already selected. Press Choose to review it.",
  "view.job.autoHintChoose":
    "The website saves the largest image automatically. To choose a different image, use Choose while choosing, or the desktop app.",
  "view.job.countsFull": "{current} of {total} tiles",
  "view.job.countsElapsed": "{current} of {total} tiles · {elapsed} elapsed",
  "view.job.elapsedOnly": "{elapsed} elapsed",
  // Recent-jobs history (todo 5.2): local-only ledger.
  "view.history.title": "Recent pictures",
  "view.history.empty": "No recent pictures yet. Saved pictures appear here.",
  "view.history.localOnly": "Kept only on this device.",
  "view.history.open": "Open again",
  "view.history.clear": "Clear history",
  "view.history.dims": "{w} by {h} pixels",
  // Failure "What happened" explainer.
  "view.fail.whatHappened": "What happened",
  "view.fail.rateProxy":
    "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened. The browser extension and the desktop app download from your own internet connection instead of our server, so they are not affected by this limit.",
  "view.fail.rateDirect":
    "The website hosting this image is receiving too many requests from your own connection right now. Waiting a few minutes usually clears it, and the browser extension or desktop app will see the same busy signal until it does.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Please enter a valid web address starting with http:// or https://",
  "desktop.url.notWebPage":
    "That address does not look like a web page address. Enter an address starting with http:// or https://.",
  "desktop.settings.unusable":
    "These download settings cannot be used. Adjust the highlighted settings and try again.",
  "desktop.settings.invalidSubmit": "These download settings are invalid. Adjust them and try again.",
  "desktop.output.deniedPick": "The save destination was not accepted. Choose a different file to continue.",
  "desktop.output.deniedFallback": "The save destination was denied.",
  "desktop.proto.incompatible":
    "This app version cannot open this picture from {host}. Update the app and try again.",
  "desktop.handoff.rejected":
    "This link cannot be opened from {host}. Try a different address without sign-in details.",
  "desktop.handoff.acceptedDetail":
    "This picture can be handed to another app. You are already in the native app, so you can continue here.",
  "desktop.handoff.rejectedDetail":
    "This picture cannot be handed to another app. Continue here or try a different picture.",
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
  "desktop.tile.partialDiscarded":
    "The partial picture was discarded so no file was kept. Try again from {host} with a steady connection.",
  "desktop.tile.partialChoice":
    "Some pieces of this picture from {host} could not be saved. Retry the failed pieces, or keep the partial picture with blank areas.",
  "desktop.discovery.none":
    "Could not find a zoomable image at this address from {host}. Try a different page or check the address.",
  "desktop.plan.none":
    "This picture has no usable size to save from {host}. Try a different picture or a smaller Max width.",
  "desktop.transport.stalled": "Saving stalled while contacting {host}. Check your connection and try again.",
  "desktop.output.writeFail":
    "Could not write this picture from {host}. Choose a different save destination and try again.",
  "desktop.job.cancelledMsg": "The image save was stopped. Any unfinished file was removed.",
  "desktop.start.failed": "Could not start saving this picture from {host}. Try again.",
  "desktop.choice.failed": "That choice was not accepted. Try again.",
  "desktop.save.generic": "Could not save this picture from {host}. Try again with a different address.",
  "desktop.internal.error":
    "Something unexpected stopped this save from {host}. Try again, and copy diagnostics if it keeps happening.",
  "desktop.save.fallback": "Could not save this picture from {host}. Try again.",
  "desktop.job.failedFallback": "The job failed.",
  "desktop.invoke.startFallback": "Could not start the job.",
  "desktop.invoke.choiceImage": "The image choice was rejected.",
  "desktop.invoke.choiceLevel": "The level choice was rejected.",
  "desktop.invoke.retry": "The retry request was rejected.",
  "desktop.invoke.partial": "The partial-image choice was rejected.",
  "desktop.invoke.destination": "Could not request the save destination.",
  "desktop.step.chooseWhere": "Choose where to save…",
  "desktop.step.chooseWhereDetail": "The save destination needs attention before the job can continue.",
  "desktop.step.pickOutput": "Pick the output file to continue.",
  "desktop.step.partialTitle": "Some tiles could not be saved…",
  "desktop.step.partialDetail": "Choose whether to keep the partial image, discard it, or retry.",
  "desktop.step.displayPreview": "Display-only preview…",
  "desktop.step.displayDetail": "This picture can only be viewed here.",
  "desktop.step.cleanupDetail": "Cleaning up… removing unfinished file…",
  "desktop.step.cleaningShort": "Cleaning up…",
  "desktop.step.encodingNative": "Encoding in the native app",
  "desktop.step.encodingPartial": "Encoding partial image in the native app",
  "desktop.step.discardingPartial": "Discarding partial image",
  "desktop.step.retrying": "Retrying",
  "desktop.step.appAutoDetail": "The app saves the first image automatically; no picker is offered.",
  "desktop.step.foundFits": "Found {noun}, saving largest that fits…",
  "desktop.step.tilesAtFull": "{current} of {total} tiles at full resolution",
  "desktop.step.savedDims": "Saved {width} by {height} pixels",
  "desktop.step.partialDims": "Partial image {width} by {height} pixels; {summary}",
  "desktop.step.partialSaved": "Partial image saved; {summary}",
  "desktop.step.savedWord": "Saved",
  "desktop.step.contacting": "Contacting {host}…",
  "desktop.link.title": "Another app wants to open an image in Dezoomify.",
  "desktop.link.source": "Source: {url}",
  "desktop.link.prov": "Provenance: dezoomify:// link (v{version})",
  "desktop.link.provHint": "Provenance: dezoomify:// link (v{version}) · {hint}",
  "desktop.link.note": "Nothing runs until you confirm. Declining does nothing.",
  "desktop.link.dismiss": "Dismiss",
  "desktop.link.open": "Open image",
  "desktop.rec.partialTitle": "Some tiles could not be saved",
  "desktop.rec.partialDesc":
    "Part of the image is missing. {summary} Keep the partial image (blank areas stay empty), discard it, or retry the failed tiles.",
  "desktop.rec.missing": "Missing tiles: {shown}{rest}.",
  "desktop.rec.more": " and {n} more",
  "desktop.rec.destTitle": "Save destination needs attention",
  "desktop.rec.destDesc":
    "The save destination was not accepted. Choose an output file, try again, or use another app.",
  "desktop.rec.chooseTitle": "Choose where to save",
  "desktop.rec.chooseDesc": "Pick the output file to continue saving this image.",
  "desktop.rec.keep": "Keep partial image",
  "desktop.rec.discard": "Discard partial",
  "desktop.rec.retryTiles": "Retry failed tiles",
  "desktop.rec.chooseOutput": "Choose output…",
  "desktop.rec.tryAgain": "Try again",
  "desktop.rec.useOther": "Use another app",
  "desktop.rec.missingSome": "Some tiles could not be saved.",
  "desktop.rec.missingCount": "{count} tile{plural} could not be saved.",
  "desktop.rec.missingList": "{n} tile{plural} missing: {shown}{rest}.",
  "desktop.done.partialTitle": "Partial image saved",
  "desktop.done.partialDesc":
    "This file is marked as partial: {summary} Missing areas are left blank. This distinguishes it from a complete save.",
  "desktop.cancel.note": "Save cancelled. Cleanup is done and any unfinished file was removed.",
  "desktop.copy.diagnostics": "Copy diagnostics",
  "desktop.copy.copied": "Copied!",
  // Multi-job queue panel (desktop integration queue, todo 5.3). Jobs save
  // one at a time in the order they were added; a failed job never stops the
  // rest. Only redacted origins appear here, never full addresses.
  "desktop.queue.title": "Queue",
  "desktop.queue.statusQueued": "Waiting",
  "desktop.queue.statusActive": "Running",
  "desktop.queue.statusDone": "Done",
  "desktop.queue.statusFailed": "Failed",
  "desktop.queue.statusCancelled": "Cancelled",
  "desktop.queue.cancel": "Cancel",
  "desktop.queue.cancelAll": "Cancel all",
  "desktop.queue.retry": "Retry",
  "desktop.queue.summary": "{succeeded} done, {failed} failed, {total} total",
  "desktop.queue.progress": "{current} of {total} tiles",
  "desktop.queue.unknownOrigin": "the server",
  "desktop.panel.outputFormat": "Output format",
  "desktop.panel.jobActions": "Desktop job actions",
  "desktop.help.title": "Help and about",
  "desktop.help.help": "Help",
  "desktop.help.desktopGuide": "Desktop guide",
  "desktop.help.troubleshooting": "Troubleshooting",
  "desktop.help.faq": "FAQ",
  "desktop.help.privacy": "Privacy",
  "desktop.help.terms": "Terms",
  "desktop.help.donate": "Donate",
  "desktop.settings.title": "Settings",
  "desktop.settings.desc":
    "Minimal download settings. Saved on this device and used for the next job. Headers are sent to the image origin only and never logged.",
  "desktop.settings.outputDir": "Output directory (optional)",
  "desktop.settings.compression": "Compression 0-100 (default 5)",
  "desktop.settings.maxWidth": "Max width px (optional)",
  "desktop.settings.maxHeight": "Max height px (optional)",
  "desktop.settings.retries": "Retries 0-100 (default 3, 0 = none)",
  "desktop.settings.cacheDir": "Cache directory (optional resume cache)",
  "desktop.settings.emptyLargest": "empty = largest",
  "desktop.settings.browse": "Browse…",
  "desktop.settings.browseOutput": "Browse for output directory",
  "desktop.settings.browseCache": "Browse for cache directory",
  "desktop.settings.headersAdv": "Advanced: request headers (trusted)",
  "desktop.settings.headersLabel": "Request headers, one per line as Name: value (optional, trusted)",
  "desktop.settings.reset": "Reset settings",
  // Extension modal user copy. The modal imports this table through its
  // vendored `vendor/i18n.js` codegen
  // mirror (see `scripts/sync-web-js.mjs`) and renders through the same
  // `t(key, vars)` shape; log and diagnostics lines stay literal English and
  // never use these keys. `test/ui-i18n.test.mjs` fails when the page renders
  // a key outside this table.
  "page.step.scanning": "Scanning page…",
  "page.step.finding": "Finding the zoomable image ({done}/{total})…",
  "page.step.choosing": "Choosing the highest resolution…",
  "page.step.saving": "Saving image tiles…",
  "page.step.assembling": "Assembling the final picture…",
  "page.step.done": "Done",
  "page.step.cancelled": "Cancelled",
  "page.step.cancelling": "Cancelling…",
  "page.step.displaying": "Displaying the image…",
  "page.tabs.scan": "Scan {label}",
  "page.tabs.hint":
    "Open a page with a zoomable image, then click the Dezoomify toolbar button to scan that tab.",
  "page.handoff.sendOrigin": "Send to desktop app ({origin})",
  "page.handoff.stay": "Stay in extension",
  "page.handoff.send": "Send to desktop app",
  "page.handoff.title": "Send to desktop app?",
  "page.handoff.host": "Host: {host}",
  "page.handoff.origins": "Origins: {list}",
  "page.handoff.originsNone": "Origins: (none)",
  "page.handoff.cookies": "Cookies: {list}",
  "page.handoff.cookiesNone": "Cookies: (none)",
  "page.handoff.job": "Job: {id}",
  "page.handoff.note": "Nothing is sent until you confirm. Declining keeps the job in the extension.",
  "page.ui.techDetails": "Technical details & logs",
}         ;

/** Canonical English templates. Tests enumerate this table. */
export const EN                         = en;

/** French templates (same keys, same placeholders). */
export const FR                         = fr;

/** German templates (same keys, same placeholders). */
export const DE                         = de;

/** Italian templates (same keys, same placeholders). */
export const IT                         = it;

const dictionaries                                         = { en, fr, de, it };

/** Read one locale table with English fallback (never undefined). */
export function getDictionary(locale        )                         {
  const match = normalizeLocaleName(locale);
  if (match !== null) return dictionaries[match] ?? EN;
  return EN;
}

/**
 * Render one message with `{var}` substitution in the active locale (or an
 * explicit locale override). Unknown keys fall back to the key itself; keys
 * missing from the active locale fall back to English per key.
 */
export function t(key         , vars           , locale         )         {
  const want         =
    typeof locale === "string" && locale !== "" ? (normalizeLocaleName(locale) ?? activeLocale) : activeLocale;
  const table                         = dictionaries[want] ?? EN;
  const template         = table[key          ] ?? EN[key          ] ?? (key          );
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name        ) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
