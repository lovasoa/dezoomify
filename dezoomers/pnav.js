const tileSize = 512;

function open(url) {
  ZoomManager.getFile(url, { type: "htmltext" }, function (text) {
    const regex = /<meta property="og:image" content="(.*?)\?w=1000&h=1000/;
    const match = text.match(regex);
    if (match) {
      const imageUrl = match[1];
      const firstTileUrl = `${imageUrl}?w=2000&h=2000&cl=0&ct=0&cw=512&ch=512`;
      const jsonUrl = imageUrl.replace(/\.(jpe?g)$/i, ".json");

      let width, height, tileWidth, tileHeight;

      const getMeta = (url, cb) => {
        const img = new Image();
        img.onload = () => cb(null, img);
        img.onerror = (err) => cb(err);
        img.src = url;
      };
      const getMetaPromise = new Promise((resolve, reject) => {
        getMeta(firstTileUrl, (err, img) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
            });
          }
        });
      });

      const imageSizePromise = new Promise((resolve, reject) => {
        ZoomManager.getFile(jsonUrl, { type: "json" }, function (info) {
          const { width, height } = info;
          resolve({ width, height });
        });
      });

      Promise.all([imageSizePromise, getMetaPromise])
        .then(([imageSizePromise, imgInfo]) => {
          width = imageSizePromise.width;
          height = imageSizePromise.height;
          tileWidth = imgInfo.naturalWidth;
          tileHeight = imgInfo.naturalHeight;

          const wStep = Math.floor(width / tileSize);
          const hStep = Math.floor(height / tileSize);
          const wMod = width % tileSize;
          const hMod = height % tileSize;
          const tileScaleRatio = tileWidth / tileSize;

          const tileUrls = {};
          for (let i = 0; i < hStep + 1; i += 1) {
            for (let j = 0; j < wStep + 1; j += 1) {
              const cw = j === wStep ? wMod : tileSize;
              const ch = i === hStep ? hMod : tileSize;
              let w = 2000;
              let h = 2000;

              if (cw !== 0 && ch !== 0) {
                if (j === wStep && i === hStep) {
                  w = Math.ceil(
                    wMod * tileScaleRatio || tileSize * tileScaleRatio
                  );
                  h = Math.ceil(
                    hMod * tileScaleRatio || tileSize * tileScaleRatio
                  );
                }

                tileUrls[j + "," + i] = `${imageUrl}?w=${w}&h=${h}&cl=${
                  j * tileSize
                }&ct=${i * tileSize}&cw=${cw}&ch=${ch}`;
              }
            }
          }
          const data = {
            origin: tileUrls[0],
            width: Math.round(tileWidth * wStep + wMod * tileScaleRatio),
            height: Math.round(tileHeight * hStep + hMod * tileScaleRatio),
            tileSize: tileHeight,
            maxZoomLevel: 1,
            tileUrls: tileUrls,
          };

          ZoomManager.readyToRender(data);
        })
        .catch((err) => {
          console.error(err);
        });
    }
  });
}

ZoomManager.addDezoomer({
  name: "pnav",
  description:
    "An image viewer used on shm.ru, pushkinmuseum.art, ethnomuseum.ru...",
  urls: [/\/entity\/OBJECT\/\d+/],
  contents: [],
  findFile(baseUrl, callback) {
    return callback(baseUrl);
  },
  open,
  getTileURL(x, y, zoom, data) {
    return data.tileUrls[x + "," + y];
  },
});
