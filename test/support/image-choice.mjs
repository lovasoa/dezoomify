/** Browser-side fixture interaction, shared by Playwright and WebDriver matrices. */
export function chooseFixtureImages(index = 0) {
  const choices = document.querySelectorAll("[data-dz-image-index]");
  if (choices.length) {
    // Catalog fixtures provide a preview for every row, including deferred IIIF pages.
    if (document.querySelectorAll(".dz-image-thumbnail img").length !== choices.length)
      return false;
    const chosen = choices[index];
    if (!chosen) throw new Error(`Catalog has no image ${index}`);
    if (!chosen.disabled) chosen.click();
    return false;
  }
  return [".dz-completed-section", ".dz-error-section"].some((selector) => {
    const element = document.querySelector(selector);
    return element && element.getBoundingClientRect().height > 0;
  });
}
