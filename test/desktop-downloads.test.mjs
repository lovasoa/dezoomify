import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopDownloads } from "../src/desktop-downloads.ts";

function metadata() {
  return {
    assets: ["windows-x86_64.msi", "macos-aarch64.dmg", "linux-x86_64.deb"].map((suffix) => {
      const name = `dezoomify-desktop-v3.1.123-${suffix}`;
      return {
        name,
        label: "An arbitrary human label",
        browser_download_url: `https://github.com/lovasoa/dezoomify/releases/download/rolling-v3.1.123/${name}`,
      };
    }),
  };
}

test("desktop installers use release filenames, prefer the visitor OS, and retain alternatives", async () => {
  for (const [hints, preferred] of [
    [{ userAgent: "Windows NT 10.0; Win64; x64", platform: "Win32" }, "windows"],
    [
      {
        platform: "MacIntel",
        userAgent: "Macintosh; Intel Mac OS X 10_15_7",
        architecture: "arm64",
      },
      "macos",
    ],
    [{ platform: "Linux x86_64" }, "linux"],
    [{ userAgent: "Android Linux", platform: "Linux" }, undefined],
    [{ platform: "Win32", mobile: true }, undefined],
    [{ platform: "MacIntel", userAgent: "iPad" }, undefined],
    [{ platform: "MacIntel" }, undefined],
    [{ platform: "Linux aarch64" }, undefined],
    [{ platform: "Windows", architecture: "arm64" }, undefined],
    [{ platform: "Linux i686" }, undefined],
    [{}, undefined],
  ]) {
    const downloads = createDesktopDownloads(async (_url, options) => {
      assert.equal(options.credentials, "omit");
      return Response.json(metadata());
    }, hints);
    const installers = await downloads.load();
    assert.equal(installers.length, 3);
    assert.deepEqual(
      installers.filter((i) => i.preferred).map((i) => i.kind),
      preferred ? [preferred] : [],
    );
    if (preferred) assert.equal(installers[0].kind, preferred);
  }
});

test("simultaneous desktop dialogs share one release lookup", async () => {
  let calls = 0;
  let respond;
  const downloads = createDesktopDownloads(() => {
    calls++;
    return new Promise((resolve) => {
      respond = resolve;
    });
  }, {});
  const first = downloads.load();
  const second = downloads.load();
  respond(Response.json(metadata()));
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("releases without usable desktop assets fail", async () => {
  for (const release of [null, { assets: [] }, { assets: [{ name: "unexpected.msi" }] }]) {
    const downloads = createDesktopDownloads(async () => Response.json(release), {});
    await assert.rejects(downloads.load(), /no assets|No desktop installers/);
  }
});

test("desktop installer choices tolerate missing platforms and reject unrelated asset destinations", async () => {
  const release = metadata();
  release.assets[0].browser_download_url = "https://example.test/installer.msi";
  release.assets[1].name = "dezoomify-desktop-v3.1.123-macos-aarch64.dmg.sig";
  const downloads = createDesktopDownloads(async () => Response.json(release), {
    platform: "Windows",
  });
  const choices = await downloads.load();
  assert.deepEqual(
    choices.map((choice) => choice.kind),
    ["linux"],
  );
  assert.equal(choices[0].preferred, false);
});
