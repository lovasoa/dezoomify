import { expect, test } from "../../../../test/browser/fixtures.mjs";

test("a long source address fits beside elapsed time and copies in full", async ({
  page,
  baseURL,
  loadModule,
}) => {
  await page.goto(`${baseURL}/__agent/test/browser/index.html`);
  await page.setContent(
    '<main class="dz-main"><div id="source-test"></div><textarea aria-label="Paste target"></textarea></main>',
  );
  await loadModule(page, "/test/browser/source-view.ts");
  const url = `https://collections.chateauversailles.fr/cc/${"imageproxy/".repeat(30)}imageproxy.aspx?&filename=objectimages/MV%208181_014.dzi`;
  const source = page.locator("#dz-job-source-url");
  for (const width of [1280, 603, 375]) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate((url) => {
      const { renderView, presentProgress } = window.sourceTest;
      renderView(
        document.querySelector("#source-test"),
        presentProgress({ phase: "acquisition", completed: 8, total: 13 }),
        {},
        { sourceUrl: url, jobActivity: { startedAt: 0, now: 72000 } },
      );
    }, url);
    await expect(source).toBeVisible();
    await expect(source).toHaveText(url);
    const time = page.locator("#dz-job-time");
    await expect(time).toHaveText("1 min 12 s / ~1 min 57 s");
    const addressBox = await source.boundingBox(),
      timeBox = await time.boundingBox();
    expect(addressBox.width).toBeGreaterThan(0);
    expect(addressBox.x + addressBox.width).toBeLessThanOrEqual(timeBox.x + 1);
    expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(width);
    const target = page.getByRole("textbox", { name: "Paste target" });
    await target.fill("");
    await source.click();
    await page.keyboard.press("ControlOrMeta+c");
    await target.focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(target).toHaveValue(url);
  }
});
