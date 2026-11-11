import { default as LayerGroup } from "ol6/layer/Group.js";
import { default as TileLayer } from "ol6/layer/Tile.js";
import { default as OlMap } from "ol6/Map.js";
import { default as IIIF } from "ol6/source/IIIF.js";
import { default as TileWMS } from "ol6/source/TileWMS.js";
import { default as Zoomify } from "ol6/source/Zoomify.js";
import { default as View } from "ol6/View.js";

Object.assign(window, {
  OpenLayersFixture: { Map: OlMap, View, TileLayer, LayerGroup, IIIF, Zoomify, TileWMS },
});
