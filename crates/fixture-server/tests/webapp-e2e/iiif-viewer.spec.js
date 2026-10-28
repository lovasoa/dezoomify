const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const sharp = require("sharp");

const root = path.resolve(__dirname, "../../../..");
const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const cli = path.join(target, "debug", `dezoomify-cli${process.platform === "win32" ? ".exe" : ""}`);
const color = { r: 196, g: 48, b: 48 };

test.beforeAll(() => {
  test.setTimeout(180000);
  const build = spawnSync("cargo", ["build", "--locked", "-p", "dezoomify-cli"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(build.status, build.stderr).toBe(0);
});

async function exportImage(work, format, width, height) {
  const tiles = path.join(work, "source_files", String(Math.ceil(Math.log2(Math.max(width, height)))));
  fs.mkdirSync(tiles, { recursive: true });
  for (let y = 0; y < height; y += 256) {
    for (let x = 0; x < width; x += 256) {
      await sharp({
        create: {
          width: Math.min(256, width - x),
          height: Math.min(256, height - y),
          channels: 3,
          background: color,
        },
      }).toFile(path.join(tiles, `${x / 256}_${y / 256}.${format}`));
    }
  }
  const source = path.join(work, "source.dzi");
  fs.writeFileSync(
    source,
    `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="256" Overlap="0" Format="${format}"><Size Width="${width}" Height="${height}"/></Image>`,
  );
  const output = path.join(work, "output.iiif");
  const saved = spawnSync(cli, ["--largest", source, output], { encoding: "utf8" });
  expect(saved.status, saved.stderr).toBe(0);
  const moved = path.join(work, "moved image folder.iiif");
  fs.renameSync(output, moved);
  return moved;
}

async function imageHeight(viewer) {
  const { data, info } = await sharp(await viewer.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let height = 0;
  for (let y = 0; y < info.height; y++) {
    const offset = (y * info.width + Math.floor(info.width / 2)) * info.channels;
    const red = [...data.subarray(offset, offset + 3)].every(
      (value, channel) => Math.abs(value - Object.values(color)[channel]) < 8,
    );
    if (red) height++;
  }
  return height;
}

for (const [format, width, height] of [["png", 513, 259], ["jpg", 513, 259], ["png", 128, 65]]) {
  test(`${format} ${width}x${height}: exported viewer renders and zooms offline after moving`, async ({ page }) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "dezoomify-iiif-viewer-"));
    try {
      const output = await exportImage(work, format, width, height);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => errors.push(request.url()));
      await page.route(/^https?:/, (route) => {
        errors.push(route.request().url());
        return route.abort();
      });
      await page.setViewportSize({ width: 800, height: 600 });
      await page.goto(pathToFileURL(path.join(output, "viewer.html")).href);
      const viewer = page.getByRole("region", { name: "Zoomable image" });
      await expect.poll(() => imageHeight(viewer)).toBeGreaterThan(350);
      const original = await imageHeight(viewer);
      await page.getByRole("button", { name: "Zoom out", exact: true }).dblclick();
      await expect.poll(() => imageHeight(viewer)).toBeLessThan(original - 5);
      await page.getByRole("button", { name: "Zoom in", exact: true }).dblclick();
      await expect.poll(() => imageHeight(viewer)).toBeGreaterThanOrEqual(original - 1);
      await page.getByRole("button", { name: "Zoom out", exact: true }).dblclick();
      await expect.poll(() => imageHeight(viewer)).toBeLessThan(original - 5);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect.poll(() => imageHeight(viewer)).toBeGreaterThanOrEqual(original - 1);
      const fullscreen = page.getByRole("button", { name: "Fullscreen", exact: true });
      await fullscreen.click();
      await expect(viewer).toHaveClass(/fullpage/);
      await expect(fullscreen).toBeVisible();
      await fullscreen.click();
      await expect(viewer).not.toHaveClass(/fullpage/);
      expect(errors).toEqual([]);
    } finally {
      await page.goto("about:blank");
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
