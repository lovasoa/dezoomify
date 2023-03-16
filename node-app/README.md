# dezoomify node app

## Installation tutorial and information
See our wiki page: https://github.com/lovasoa/dezoomify/wiki/Very-large-images

## Technical details
This is a very simple node script (`dezoomify-node.js`), that makes dezoomify run outside a browser,
using [`jsdom`](https://www.npmjs.com/package/jsdom) to emulate  browser functionality,
and [`canvas`](https://www.npmjs.com/package/canvas) to emulate the canvas on which the image is drawn (canvas itself uses cairo).

## Requirements
This script requires node version 5 or superior.

## How to use
If your zoom viewer is at `http://example.com` and you want to save your image as `filename.jpg`:
```sh
node dezoomify-node.js "http://example.com/" "filename.jpg"
```
