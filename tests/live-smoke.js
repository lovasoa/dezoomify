const DEFAULT_TIMEOUT_MS = 15000;

const targets = [
  {
    name: "Arts & Culture",
    url: "https://artsandculture.google.com/asset/liza-kottou-0113/3gGrYhjfhcwvbA",
    expect: /window\.INIT_data[\s\S]+\/\/lh3\.googleusercontent\.com\/ci\//,
  },
  {
    name: "Generic tile template",
    url: "https://uffizicloud.centrica.it/7711/closer/hi-res/A1456.imgf?cmd=tile&x=0&y=0&z=32",
    method: "HEAD",
  },
  {
    name: "National Gallery IIIF page",
    url: "https://www.nationalgallery.org.uk/paintings/alexandre-calame-at-handeck",
    expect: /IIIF|server\.iip/i,
  },
  {
    name: "National Gallery of Victoria Zoomify page",
    url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
    expect: /zoomify|ImageProperties|openseadragon/i,
  },
  {
    name: "Memorix TopViewer JSON",
    url: "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9",
    expect: /tileSources|tiles|width|height/i,
  },
  {
    name: "krpano XML",
    url: "https://krpano.com/panos/andreabiffi/galleria_04.xml",
    expect: /<krpano|<image/i,
  },
  {
    name: "krpano multires tour",
    url: "https://krpano.com/tours/corfu/tour.xml",
    expect: /multires|<krpano|<image/i,
  },
  {
    name: "Polona page",
    url: "https://polona.pl/item/9388882/0/",
  },
  {
    name: "British Library page",
    url: "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar",
  },
  {
    name: "Bibliotheques specialisees de Paris page",
    url: "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs",
  },
  {
    name: "National Archives DZI",
    url: "https://catalog.archives.gov/OpaAPI/media/7029407/opa-renditions/image-tiles/95-GP-3287-Box0552_003_001_AC.jpg.dzi",
  },
  {
    name: "National Library of Australia page",
    url: "https://nla.gov.au/nla.obj-152644715/view",
  },
  {
    name: "FSI viewer page",
    url: "https://www.neptunelabs.com/fsi-viewer/",
    expect: /fsi/i,
  },
  {
    name: "VLS page",
    url: "https://www.e-rara.ch/zut/content/pageview/102788",
    expect: /image\/tiler\/square|pageview|VLS/i,
  },
  {
    name: "OpenSeadragon Zoomify example",
    url: "https://openseadragon.github.io/examples/tilesource-zoomify/",
    expect: /Zoomify|TileGroup|ImageProperties/i,
  },
  {
    name: "DeepZoom tile URL",
    url: "https://storage.googleapis.com/raremaps/img/dzi/img_46087_files/0/0_0.jpg",
    method: "HEAD",
  },
  {
    name: "IIIF v2 without @id",
    url: "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
    expect: /tiles|width|height/i,
  },
  {
    name: "IIIF map-view fallback",
    url: "https://map-view.nls.uk/iiif/19619%2F196194600/info.json",
    expect: /tiles|tile_width|width|height/i,
  },
  {
    name: "WMTS capabilities",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/WMTS/1.0.0/WMTSCapabilities.xml",
    expect: /Capabilities|TileMatrixSet|WMTS/i,
  },
  {
    name: "pnav catalog.shm.ru",
    url: "https://catalog.shm.ru/entity/OBJECT/2117418",
    expect: /og:image|pnav|entity\/OBJECT/i,
  },
  {
    name: "pnav collection.pushkinmuseum.art",
    url: "https://collection.pushkinmuseum.art/entity/OBJECT/77606",
    expect: /og:image|pnav|entity\/OBJECT/i,
  },
  {
    name: "pnav collection.ethnomuseum.ru",
    url: "https://collection.ethnomuseum.ru/entity/OBJECT/32945",
    expect: /og:image|pnav|entity\/OBJECT/i,
  },
];

function escapeAnnotation(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

async function readText(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const maxBytes = 2 * 1024 * 1024;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function check(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeout || DEFAULT_TIMEOUT_MS);
  const method = target.method || (target.expect ? "GET" : "HEAD");

  try {
    const response = await fetch(target.url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 dezoomify-live-smoke",
      },
    });

    const result = {
      name: target.name,
      status: response.ok ? "pass" : "changed",
      code: response.status,
      url: response.url,
    };

    if (!response.ok) return result;

    if (target.expect) {
      const text = await readText(response);
      if (!target.expect.test(text)) {
        return {
          ...result,
          status: "changed",
          error: `response did not match ${target.expect}`,
        };
      }
    }

    return result;
  } catch (error) {
    return { name: target.name, status: "down", code: "-", url: target.url, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const rows = await Promise.all(targets.map(check));
  console.table(rows);

  const failures = rows.filter((row) => row.status !== "pass");
  for (const failure of failures) {
    const details = `${failure.name}: ${failure.status} ${failure.code} ${failure.url}` +
      (failure.error ? ` (${failure.error})` : "");
    console.warn(`::warning title=Live smoke failed::${escapeAnnotation(details)}`);
  }

  if (failures.length > 0) process.exitCode = 1;
})();
