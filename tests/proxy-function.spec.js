const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

async function loadProxyFunction() {
  const functionPath = path.join(__dirname, "..", "functions", "proxy.js");
  return import(pathToFileURL(functionPath));
}

test.describe("Cloudflare Pages proxy function", () => {
  test("proxies GET and HEAD requests on the proxy route", async () => {
    const proxy = await loadProxyFunction();
    const request = new Request(
      "http://example.test/proxy?url=data%3Atext%2Fplain%2Chello"
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

  test("uses a modern browser user agent for upstream requests", async () => {
    const proxy = await loadProxyFunction();
    const originalFetch = global.fetch;
    let userAgent;
    global.fetch = async (_url, options) => {
      userAgent = options.headers.get("User-Agent");
      return new Response("ok");
    };

    try {
      await proxy.onRequestGet({
        request: new Request("http://example.test/proxy?url=https%3A%2F%2Fexample.com", {
          headers: { "User-Agent": "Mozilla/5.0 Chrome/58.0.3029.110" },
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }

    expect(userAgent).toContain("Chrome/149.0.0.0");
  });
});

test.describe("Node proxy adapter", () => {
  test("proxies through the shared handler", async () => {
    const server = require(path.join(__dirname, "..", "node-app", "proxy.js"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const response = await fetch(
        `http://${address.address}:${address.port}/proxy?url=data%3Atext%2Fplain%2Cnode`
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe("node");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
