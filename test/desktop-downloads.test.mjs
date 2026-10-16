import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopDownloads } from "../src/desktop-downloads.ts";

const suffixes = ["windows-x86_64.msi", "macos-aarch64.dmg", "linux-x86_64.deb"];
function metadata() {
  return {
    assets: suffixes.map((suffix) => {
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
    [{ platform: "Mac", architecture: "arm64" }, "macos"],
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
    [{ platform: "Unknown" }, undefined],
    [{}, undefined],
  ]) {
    const downloads = createDesktopDownloads(async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/lovasoa/dezoomify/releases/latest");
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
    for (const installer of installers)
      assert.match(
        installer.url,
        /\/releases\/download\/rolling-v3\.1\.123\/dezoomify-desktop-v3\.1\.123-/,
      );
  }
});

test("desktop release discovery shares in-flight requests and caches successful results", async () => {
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
  assert.equal(first, second);
  respond(Response.json(metadata()));
  const result = await first;
  assert.equal(await downloads.load(), result);
  assert.equal(calls, 1);
});

test("desktop release discovery evicts failed requests and permits retry", async () => {
  for (const failure of [
    () => new Response("rate limited", { status: 403 }),
    () => Response.json({ assets: [] }),
    () =>
      Response.json({
        assets: [{ name: "unexpected.msi", browser_download_url: "https://example.test" }],
      }),
    () => Response.json(null),
    () => {
      throw new Error("network unavailable");
    },
  ]) {
    let calls = 0;
    const downloads = createDesktopDownloads(
      async () => (++calls === 1 ? failure() : Response.json(metadata())),
      {},
    );
    await assert.rejects(downloads.load());
    assert.equal((await downloads.load()).length, 3);
    assert.equal(calls, 2);
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
