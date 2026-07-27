const DEZOOMIFY_URL = "https://dezoomify.ophir.dev/#";

const iiifpath = new RegExp(
    "/\\^?(full|square|(pct:)?\\d+,\\d+,\\d+,\\d+)" +
    "/(full|max|\\d+,|,\\d+|pct:\\d+|!?\\d+,\\d+)" +
    "/!?[1-3]?[0-9]?[0-9]" +
    "/(color|gray|bitonal|default|native)" +
    "\\.(jpe?g|tiff?|png|gif|jp2|pdf|webp)"
);

const META_REGEX = new RegExp([
    /\/ImageProperties.xml/,
    /\/info.json/,
    /\?FIF=/,
    /_files\/0\/0_0\.jpe?g(?:\?.*)?$/,
    /\.img.\?cmd=info/,
    /getTilesInfo\?object_id/,
    /\.pff(&requestType=1)?$/,
    /\.ecw(?:\?.*)?$/,
    /\/p.xml(?:\?.*)?$/,
    iiifpath,
    /artsandculture\.google\.com\/asset\//
].map(e => e.source).join('|'));

const META_REPLACE = [
    { pattern: /\.dzi(?:\?.*)?$/, replacement: '_files/0/0_0.jpg' },
    { pattern: /_files\/\d+\/\d+_\d+\.jpe?g(?:\?.*)?$/, replacement: '_files/0/0_0.jpg' },
    { pattern: /\/TileGroup\d+\/\d+-\d+-\d+.jpg(?:\?.*)?$/, replacement: '/ImageProperties.xml' },
    { pattern: /\/ImageProperties\.xml\?t\w+$/, replacement: '/ImageProperties.xml' },
    { pattern: /(\?FIF=[^&]*)&.*/, replacement: '$1' },
    { pattern: /(http.*artsandculture\.google\.com\/asset\/.+\/.+)\?.*/, replacement: '$1' },
    { pattern: iiifpath, replacement: '/info.json' },
    { pattern: /getTilesInfo\?object_id=(.*)&callback.*/, replacement: 'getTilesInfo?object_id=$1' },
];

/**
 * Return a canonical metadata URL when a request belongs to a supported viewer.
 * @param {string} requestUrl
 * @returns {string | undefined}
 */
function recognizeZoomableUrl(requestUrl) {
    let url = requestUrl;
    for (const { pattern, replacement } of META_REPLACE) {
        url = url.replace(pattern, replacement);
    }
    if (META_REGEX.test(url) && !url.startsWith(DEZOOMIFY_URL)) return url;
}
