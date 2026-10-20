import { type I18nKey, t } from "@dezoomify/shared-ui";

/** Translate the website shell after the host selects its locale. */
export function localizeWebsite(document: Document): void {
  const labels: Array<[string, I18nKey, string?]> = [
    [".dz-brand", "page.brand", "title"],
    [".dz-nav-links", "page.nav.label", "aria-label"],
    ["#dz-nav-btn-extension", "page.nav.extension"],
    ["#dz-nav-btn-extension", "view.ext.whyTitle", "title"],
    ["#dz-nav-btn-desktop", "page.nav.desktop"],
    ["#dz-nav-btn-desktop", "view.desktop.whyTitle", "title"],
    [".help-link", "page.nav.help"],
    [".help-link", "page.nav.help", "title"],
    ['a[href="https://github.com/sponsors/lovasoa/"]', "page.nav.donate"],
    [".donate", "page.nav.donateTitle", "title"],
    ['.dz-footer-links a[href="https://github.com/lovasoa/dezoomify"]', "page.footer.source"],
    ['.dz-footer-links a[href="./help/troubleshooting.html"]', "page.footer.faq"],
    ['.dz-footer-links a[href="./privacy.html"]', "page.footer.privacy"],
    ['.dz-footer-links a[href="./terms.html"]', "page.footer.terms"],
    ["#dz-legacy-notice-title", "page.legacy.title"],
    ["#dz-legacy-notice-link", "page.legacy.link"],
    ["#dz-legacy-notice-close", "view.modal.closeTitle", "aria-label"],
    ["#preview-zoom-out", "page.preview.zoomOut", "aria-label"],
    ["#preview-zoom-in", "page.preview.zoomIn", "aria-label"],
    ["#preview-zoom-100", "page.preview.reset", "aria-label"],
    ["#preview-zoom-fit", "page.preview.fit"],
    ["#preview-zoom-fit", "page.preview.fitLabel", "aria-label"],
  ];
  for (const [selector, key, attribute] of labels) {
    for (const element of document.querySelectorAll(selector)) {
      if (attribute) element.setAttribute(attribute, t(key));
      else element.textContent = t(key);
    }
  }
}
