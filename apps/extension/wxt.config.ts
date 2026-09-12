import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, "../..");
const publicDir = path.join(root, "public");
const isTestPackage = process.env.DEZOOMIFY_TEST_DRIVER === "1";
const testOrigin = process.env.DEZOOMIFY_TEST_ORIGIN ?? "";
const testScenario = process.env.DEZOOMIFY_TEST_SCENARIO ?? "";

function testHostPermissions(): string[] {
  if (process.env.DEZOOMIFY_TEST_HOST_PERMISSIONS !== "1") return [];
  if (!/^https?:\/\/[^/]+$/.test(testOrigin)) {
    throw new Error("DEZOOMIFY_TEST_ORIGIN must be an http(s) origin for the E2E package");
  }
  return ["http://127.0.0.1/*", "http://localhost/*", `${testOrigin}/*`];
}

export default defineConfig({
  targetBrowsers: ["chrome", "firefox"],
  manifestVersion: 3,
  outDir: isTestPackage ? ".output-test" : ".output",
  imports: false,
  dev: { reloadCommand: false },
  zip: {
    name: "dezoomify",
    artifactTemplate: "dezoomify-{{browser}}.zip",
    zipSources: false,
  },
  manifest: ({ browser }) => ({
    action: {
      default_title: "Dezoomify",
      default_icon: {
        16: "icons/icon16-grey.png",
        48: "icons/icon48-grey.png",
        128: "icons/icon128-grey.png",
      },
    },
    browser_specific_settings: browser === "firefox" ? {
      gecko: {
        id: "{14074c89-8a5f-4813-98df-a7117f062871}",
        strict_min_version: "128.0",
      },
    } : undefined,
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'",
    },
    description: "Click to find zoomable images on the current page and rebuild them at full resolution. No background monitoring.",
    host_permissions: testHostPermissions(),
    icons: {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
    name: "Dezoomify",
    optional_host_permissions: ["http://*/*", "https://*/*"],
    optional_permissions: ["cookies"],
    permissions: ["activeTab", "scripting", "nativeMessaging"],
    minimum_chrome_version: browser === "chrome" ? "121" : undefined,
  }),
  hooks: {
    async "build:before"() {
      const wasm = path.join(repository, "wasm");
      for (const file of ["dezoomify-wasm.js", "dezoomify-wasm_bg.wasm"]) {
        try {
          await access(path.join(wasm, file));
        } catch {
          throw new Error(`missing wasm/${file}; run cargo xtask build extension first`);
        }
      }

      await rm(publicDir, { recursive: true, force: true });
      await mkdir(publicDir, { recursive: true });
      await cp(path.join(root, "src/icons"), path.join(publicDir, "icons"), { recursive: true });
      await mkdir(path.join(publicDir, "wasm"), { recursive: true });
      await cp(path.join(wasm, "dezoomify-wasm.js"), path.join(publicDir, "wasm/dezoomify-wasm.js"));
      await cp(path.join(wasm, "dezoomify-wasm_bg.wasm"), path.join(publicDir, "wasm/dezoomify-wasm_bg.wasm"));

      if (isTestPackage) {
        await cp(path.join(root, "src/test"), path.join(publicDir, "test"), { recursive: true });
        await writeFile(
          path.join(publicDir, "test/config.js"),
          `globalThis.__DEZOOMIFY_TEST_ORIGIN__ = ${JSON.stringify(testOrigin)};\n` +
          `globalThis.__DEZOOMIFY_TEST_SCENARIO__ = ${JSON.stringify(testScenario)};\n`,
        );
      }
    },
  },
  vite: () => ({
    plugins: [react()],
    define: {
      __DEZOOMIFY_TEST_DRIVER__: JSON.stringify(isTestPackage),
    },
  }),
});
