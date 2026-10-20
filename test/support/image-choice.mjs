/** Browser-side fixture interaction, shared by Playwright and WebDriver matrices. */
export function chooseFixtureImages(index = 0) {
  const choices = document.querySelectorAll("[data-dz-image-index]");
  if (choices.length) {
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
