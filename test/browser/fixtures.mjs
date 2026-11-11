import { test as base } from "@playwright/test";

// Load ordinary modules in the inspected page's realm. Vite serves TypeScript
// and workspace imports; Playwright owns browser/context cleanup and isolation.
export const test = base.extend({
  loadModule: async ({ baseURL, request }, use) => {
    await use(async (scope, path = "/test/browser/page-agent.ts") => {
      const page = typeof scope.page === "function" ? scope.page() : scope;
      // Serve modules at the fixture's origin, including in inline frames.
      // Browser local-network restrictions must not turn replay into live I/O.
      await page.route("**/__agent/**", async (route) => {
        const url = new URL(route.request().url());
        const response = await request.get(new URL(url.pathname + url.search, baseURL).href);
        await route.fulfill({ response });
      });
      await scope.addScriptTag({ type: "module", url: `/__agent${path}` });
    });
  },
});

export { expect } from "@playwright/test";
