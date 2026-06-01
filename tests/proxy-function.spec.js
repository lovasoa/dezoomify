const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

async function loadProxyFunction() {
  const functionPath = path.join(__dirname, "..", "functions", "proxy.php.js");
  return import(pathToFileURL(functionPath));
}

test.describe("Cloudflare Pages proxy function", () => {
  test("proxies GET and HEAD requests on the proxy.php route", async () => {
    const proxy = await loadProxyFunction();
    const request = new Request(
      "http://example.test/proxy.php?url=data%3Atext%2Fplain%2Chello"
    );

    const getResponse = await proxy.onRequestGet({ request });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(await getResponse.text()).toBe("hello");

    const headResponse = await proxy.onRequestHead({ request });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-type")).toBe("text/plain");
    expect(await headResponse.text()).toBe("");
  });
});
