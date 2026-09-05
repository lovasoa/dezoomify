# dezoomify node app

## Installation tutorial and information
See our wiki page: https://github.com/lovasoa/dezoomify/wiki/Very-large-images

## Technical details
This is a very simple node script (`dezoomify-node.js`), that makes dezoomify run outside a browser,
using [`jsdom`](https://www.npmjs.com/package/jsdom) to emulate  browser functionality,
and [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) to emulate the canvas on which the image is drawn.
The local proxy server reuses the Cloudflare Pages Function proxy implementation from `functions/proxy.js`.

## Requirements
This script requires a modern Node.js version. CI runs it on Node.js 22, and the current dependencies require Node.js 20.19 or newer.

## How to use
If your zoom viewer is at `http://example.com` and you want to save your image as `filename.jpg`:
```sh
node dezoomify-node.js "http://example.com/" "filename.jpg"
```
