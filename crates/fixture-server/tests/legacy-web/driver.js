// Driver helpers mirrored from the untouched legacy suite. The legacy app
// source is never modified; only request routing goes to the new server.
const fs = require("node:fs");
const path = require("node:path");

const AUTO = "Select automatically";
const fixture = (file) => `https://fixtures.test/${file}`;
const localFixture = (file) => `/fixtures/${file}`;

function loadAddr() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "addr.json"), "utf8"));
}

function scenarioDir(id) {
  // crates/fixture-server/tests/legacy-web -> repo root (4 levels).
  return path.resolve(__dirname, "..", "..", "..", "..", "testdata", "scenarios", ...id.split("/"));
}

function stableStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2)
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/blob:[^\s"]+/g, "blob:URL") + "\n";
}

function readLog(logFile) {
  try {
    return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function openApp(page, addr) {
  await page.goto(`${addr}/index.html`);
  await page.waitForFunction(() => window.ZoomManager?.dezoomersList?.pnav);
  // Forward every off-origin request to the deterministic gateway.
  // Same-origin scenario paths (/fixtures, /iiif, /digital, /server.iip,
  // /entity) are also gateway-served with the loopback fixture host.
  // Pixel scenarios serialize tile completion in request order: overlapping
  // tiles raced by concurrent loads would otherwise make seam pixels
  // nondeterministic. App scheduling code is untouched; only test transport
  // completion is ordered.
  const GATEWAY_PREFIXES = ["/fixtures/", "/iiif/", "/digital/", "/server.iip", "/entity/"];
  let tileChain = Promise.resolve();
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    const serverOrigin = new URL(addr).origin;
    const orderedTile = parsed.pathname.includes("/fixtures/assembly/");
    if (parsed.origin !== serverOrigin) {
      if (route.request().method() !== "GET") return route.abort();
      return forward(`${addr}/fetch?url=${encodeURIComponent(url)}`, orderedTile);
    }
    if (GATEWAY_PREFIXES.some((p) => parsed.pathname === p || parsed.pathname.startsWith(p))) {
      if (route.request().method() !== "GET") return route.abort();
      const fixtureUrl = `http://127.0.0.1${parsed.pathname}${parsed.search}`;
      return forward(`${addr}/fetch?url=${encodeURIComponent(fixtureUrl)}`, orderedTile);
    }
    return route.continue();
    async function forward(gateway, ordered) {
      const run = async () => {
        try {
          const res = await page.request.get(gateway);
          const headers = {};
          for (const [k, v] of Object.entries(res.headers())) {
            if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
          }
          await route.fulfill({ status: res.status(), headers, body: await res.body() });
        } catch {
          await route.abort();
        }
      };
      if (!ordered) return run();
      const prev = tileChain;
      let release;
      tileChain = new Promise((r) => { release = r; });
      await prev;
      try {
        await run();
      } finally {
        release();
      }
    }
  });
}

async function runDezoomer(page, addr, dezoomerName, url) {
  url = new URL(url, page.url()).href;
  return page.evaluate(({ dezoomerName, proxyUrl, url }) => new Promise((resolve, reject) => {
    const manager = window.ZoomManager;
    const dezoomer = manager.dezoomersList[dezoomerName];
    if (!dezoomer) return reject(new Error(`Unknown dezoomer: ${dezoomerName}`));
    const tiles = [];
    let settled = false;
    let timeout;
    const snapshot = () => ({
      dezoomerName: manager.dezoomer.name,
      data: JSON.parse(JSON.stringify(manager.data)),
      tiles,
    });
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(result); } };
    const fail = (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error instanceof Error ? error : new Error(String(error))); } };
    const maybeFinish = () => { if (manager.data && manager.status.loaded >= manager.status.totalTiles) finish(snapshot()); };
    timeout = setTimeout(() => fail(new Error(`Timed out: ${JSON.stringify({ data: manager.data, status: manager.status })}`)), 7000);
    window.onerror = (message, source, line) => { fail(new Error(`${message} (${source}:${line})`)); return true; };
    manager.setDezoomer(dezoomer);
    manager.data = null;
    manager.proxy_url = proxyUrl;
    manager.proxy_tiles = "";
    manager.cookies = "";
    manager.nextTick = (fn) => setTimeout(fn, 0);
    manager.addTile = (tileUrl, x, y) => { tiles.push({ url: String(tileUrl), x, y }); manager.status.loaded++; maybeFinish(); };
    manager.loadEnd = () => finish(snapshot());
    manager.error = fail;
    manager.open(url);
  }), { dezoomerName, proxyUrl: `${addr}/proxy`, url });
}

async function selectDezoomer(page, addr, url) {
  return page.evaluate((url) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    const automatic = manager.dezoomersList["Select automatically"];
    const originalOpen = manager.open;
    manager.proxy_url = `${window.location.origin}/proxy`;
    manager.cookies = "";
    manager.open = () => { const name = manager.dezoomer.name; manager.open = originalOpen; resolve(name); };
    automatic.open(url);
  }), new URL(url, page.url()).href);
}

async function findFile(page, addr, dezoomerName, url) {
  url = new URL(url, page.url()).href;
  return page.evaluate(({ dezoomerName, proxyUrl, url }) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    manager.proxy_url = proxyUrl;
    manager.cookies = "";
    manager.updateProgress = () => {};
    manager.dezoomersList[dezoomerName].findFile(url, resolve);
  }), { dezoomerName, proxyUrl: `${addr}/proxy`, url });
}

async function probeGeneric(page, addr, url) {
  return page.evaluate(({ proxyUrl, url }) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    const originalReadyToRender = manager.readyToRender;
    manager.proxy_url = proxyUrl;
    manager.cookies = "";
    manager.readyToRender = (data) => { manager.readyToRender = originalReadyToRender; resolve(data); };
    manager.dezoomersList["Generic dezoomer"].open(url);
  }), { proxyUrl: `${addr}/proxy`, url });
}

async function renderAssembly(page, addr, spec) {
  await page.evaluate((input) => {
    const manager = window.ZoomManager;
    const tiles = new Map(input.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
    const data = {
      width: input.width, height: input.height, tileSize: input.tileSize,
      nbrTilesX: input.nbrTilesX, nbrTilesY: input.nbrTilesY,
      totalTiles: input.nbrTilesX * input.nbrTilesY, maxZoomLevel: 1, overlap: input.overlap || 0,
    };
    manager.dezoomer = {
      getTileURL(x, y) {
        const tile = tiles.get(`${x},${y}`);
        if (!tile) return;
        const params = new URLSearchParams({
          x: String(x), y: String(y),
          w: String(tile.width || input.tileSize), h: String(tile.height || input.tileSize),
          color: tile.color,
        });
        return `${window.location.origin}/fixtures/assembly/tile.svg?${params}`;
      },
    };
    manager.data = data;
    manager.status = { error: false, loaded: 0, totalTiles: data.totalTiles };
    manager.proxy_tiles = "";
    manager.cookies = "";
    manager.nextTick = (fn) => setTimeout(fn, 0);
    UI.setupRendering(data);
    manager.defaultRender(data);
  }, spec);
  await page.waitForFunction((totalTiles) => window.ZoomManager.status.loaded >= totalTiles, spec.nbrTilesX * spec.nbrTilesY);
  // SVG rasterization can lag the load event by a frame; poll until pixels
  // stabilize (still asserting exact values, never tolerances).
  return page.evaluate(async (points) => {
    const read = () => points.map(({ x, y }) => Array.from(UI.ctx.getImageData(x, y, 1, 1).data));
    let prev = JSON.stringify(read());
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const cur = JSON.stringify(read());
      if (cur === prev) return JSON.parse(cur);
      prev = cur;
    }
    return JSON.parse(prev);
  }, spec.points);
}

function writeTranscript(id, transcript) {
  const dir = scenarioDir(id);
  fs.mkdirSync(path.join(dir, "expected"), { recursive: true });
  fs.writeFileSync(path.join(dir, "expected", "legacy-web.json"), stableStringify(transcript));
}

module.exports = {
  AUTO, fixture, localFixture, loadAddr, scenarioDir, stableStringify,
  readLog, openApp, runDezoomer, selectDezoomer, findFile, probeGeneric,
  renderAssembly, writeTranscript,
};
