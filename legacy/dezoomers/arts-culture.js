import { compute_signed_path, decrypt_image } from './arts-culture-crypto.js';

function findFile(baseUrl, callback) {
	ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
		let reg = /]\n?,"(\/\/[a-zA-Z0-9./_\-]+)",(?:"([^"]+)"|null)/m;
		let matches = text.match(reg);
		if (!matches) throw new Error("Unable to find arts and culture image metadata URL");
		let url = 'https:' + matches[1]
		let path = new URL(url).pathname.slice(1);
		let token = matches[2] || "";
		callback(url + "=g", { path, token });
	});
}

function open(url, gapdata) {
	ZoomManager.getFile(url, { type: "xml" }, function (xml, xhr) {
		let int = (e, a) => parseInt(e.getAttribute(a));
		let infos = xml.getElementsByTagName("TileInfo")[0];
		if (!infos) return ZoomManager.error("Invalid XML info file: " + url);
		let tile_w = int(infos, "tile_width");
		let tile_h = int(infos, "tile_height");
		let levels = Array.from(infos.children).map(function (level, level_num) {
			const xtiles = int(level, "num_tiles_x");
			const ytiles = int(level, "num_tiles_y");
			const empty_x = int(level, "empty_pels_x");
			const empty_y = int(level, "empty_pels_y");

			return {
				origin: url,
				width: xtiles * tile_w - empty_x,
				height: ytiles * tile_h - empty_y,
				tileSize: tile_w,
				numTiles: xtiles * ytiles,
				maxZoomLevel: level_num,
				gapdata: gapdata
			}
		}).filter(function (level) {
			return level.width * level.height < UI.MAX_CANVAS_AREA;
		});
		ZoomManager.readyToRender(levels[levels.length - 1]);
	});
}

async function getTileURL(
	x, y, z,
	{ gapdata: { path, token }, origin }
) {
	const tile_path = await compute_signed_path(path, token, x, y, z);
	const tile_url = ZoomManager.resolveRelative("/"+tile_path, origin);
	const buffer = await new Promise(accept =>
		ZoomManager.getFile(tile_url, { type: 'binary', is_tile: true }, accept)
	);
	const tile = await decrypt_image({ buffer });
	const blob = new Blob([tile], { type: "image/jpeg" });
	return URL.createObjectURL(blob);
}


ZoomManager.addDezoomer({
	"name": "Arts & Culture",
	"description": "Zoomable images from the Arts and Culture website",
	"urls": [
		/artsandculture\.google\.com/,
		/\/g.co\/arts\//
	],
	"contents": [],
	findFile, open, getTileURL
});