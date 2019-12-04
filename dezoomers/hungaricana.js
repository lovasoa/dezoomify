var hungaricana = (function () {
  const utf8 = new TextEncoder();
  const key = crypto.subtle.importKey("raw", utf8.encode("dGhpcyBpcyBubyBr"), { name: "AES-CBC" }, true, ["encrypt", "decrypt"]);
  const algorithm = { name: "AES-CBC", iv: new Uint8Array(16) };

  async function get_hash(x, y, z, base_path) {
    const s = base_path.split('').map(x => x.charCodeAt(0)).reduce((a, b) => a + b);
    const padded = `${s % 100}|${z}|${x}|${y}`.padEnd(16, '*');
    const encrypted = await crypto.subtle.encrypt(algorithm, await key, utf8.encode(padded));
    return Array.from(new Uint8Array(encrypted))
      .slice(0, 16)
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
  }

  return {
    name: 'Hungaricana',
    description: 'Hungarian Cultural Heritage Portal (hungaricana.hu)',
    urls: [
      /hungaricana\.hu/,
      /\.ecw$/
    ],
    contents: [
      /(imagepath|files ).*\.ecw/,
    ],
    findFile: function getInfoFile(baseUrl, callback) {
      if (baseUrl.endsWith(".ecw")) return callback(baseUrl);
      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text) {
        var layerUrlMatch = text.match(/layer_?[uU]rl["']?\s*:\s*['"]([^'"]*)/);
        if (!layerUrlMatch) throw new Error("Unable to find the layer base url");
        var layerFileMatch = text.match(/(?:files["']?|images["']?|imagepath)\s*[\:=][\s\[]*["']([^'"]*)/);
        if (!layerFileMatch) throw new Error("Unable to find the layer file name");
        var layerPathMatch = text.match(/\Wpath["']?\s*:\s*["']([^"']*)/);
        var layerPath = layerPathMatch && layerPathMatch[1] || '';
        return callback(layerUrlMatch[1] + layerPath + layerFileMatch[1]);
      });
    },
    open: function (url) {
      ZoomManager.getFile(url, { type: 'json' }, function (data) {
        const [base_url, path] = url.split('imagesize/');
        ZoomManager.readyToRender({
          origin: base_url + 'image/' + path + '/',
          path: path,
          width: data.width,
          height: data.height,
          tileSize: 512,
        });
      });
    },
    getTileURL: function (x, y, zoom, data) {
      return get_hash(x, y, zoom, data.path);
    },
  };
})();
ZoomManager.addDezoomer(hungaricana);
