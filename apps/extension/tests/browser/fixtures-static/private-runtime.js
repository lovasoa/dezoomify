(() => {
  const levels = [
    {
      tiledimagewidth: 512,
      tiledimageheight: 512,
      flat: { url: "/fixtures/krpano/basic/tiles/%h-%v.png?token=one&v=two" },
    },
  ];
  const image = {
    tilesize: 256,
    baseindex: 1,
    stereo: false,
    frames: 1,
    tileoverlap: 0,
    level: { getArray: () => levels },
  };
  const runtime = { image, parsepath: (path) => path };
  const viewer = document.getElementById("viewer");
  Object.assign(viewer, {
    get(path) {
      return path === "global" ? runtime : undefined;
    },
    set() {
      throw new Error("scanning must not modify the viewer");
    },
    call() {
      throw new Error("scanning must not run viewer actions");
    },
    screentosphere() {},
    spheretoscreen() {},
    unload() {
      throw new Error("scanning must not unload the viewer");
    },
  });
  document.documentElement.dataset.viewerReady = "true";
})();
