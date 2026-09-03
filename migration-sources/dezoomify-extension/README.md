# dezoomify-extension

## What does it do ?
This project is a browser extension for detecting zoomable images in web pages and downloading them with [dezoomify](https://github.com/lovasoa/dezoomify). It works with the websites of many different museums, art galleries, libraries, and numerous other sources. 


[![Google Chrome: download on the chrome web store](https://developer-chrome-com.imgix.net/image/BrQidfK9jaQyIHwdw91aVpkPiib2/LclHxMxqoswLNRcUW3m5.png?auto=format&h=60)](https://chrome.google.com/webstore/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
[![Mozilla Firefox: download on mozilla addons](https://user-images.githubusercontent.com/552629/82738693-f4900f80-9d39-11ea-816c-1bddb73b6967.png)](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/)

## How to use
1. Install the extension
2. open a zoomable image in your browser
3. click the grey magnifying glass icon in the address bar (![dezoomify inactive icon](./icons/grey/icon-24.png))
4. the icon should become blue (![dezoomify active icon](./icons/color/icon-24.png)), denoting that the extension is now actively listening for zoomable image requests
5. zoom into the image or reload the page
6. if the extension detects zoomable images, you should see a small badge appear over the icon specifying the number of images found
7. click the icon to open the image in the dezoomify website
8. click "dezoomify", and wait while the image downloads at maximal resolution
9. right-click on the downloaded image, and choose "Save As" to save it as a PNG file on your computer

See the [illustrated guide with screenshots](https://github.com/lovasoa/dezoomify-extension/wiki/Illustrated-Guide-with-Screenshots)

### Animated Tutorial
[![Short animated tutorial](https://user-images.githubusercontent.com/552629/77237075-ea7c5400-6bc4-11ea-85fb-319a033c32f9.gif)](https://user-images.githubusercontent.com/552629/77237075-ea7c5400-6bc4-11ea-85fb-319a033c32f9.gif)

## If the image is very large
As [stated in its documentation](https://github.com/lovasoa/dezoomify/wiki/Very-large-images), dezoomify may fail with very large images. In this case, you can still use this extension to find the zoomable image address, and then use [**dezoomify-rs**](https://lovasoa.github.io/dezoomify-rs/) instead of **dezoomify** to download the image. When the extension opens a new tab with dezoomify, don't click *Dezoomify!*, but instead copy the image URL, open dezoomify-rs on your computer, and paste it. 

## How to install
You can install this extension from your browser's official plugin market :
 - for Firefox, see [dezoomify on **Mozilla Addons**](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/)
 - for Chrome, see [dezoomify on the **Chrome Web Store**](https://chrome.google.com/webstore/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm) ( *Unfortunately, google takes several weeks to review extension updates, so this version is usually less up-to-date and has more bugs than the firefox one* )

You can also [download the extension](https://github.com/lovasoa/dezoomify-extension/releases) and install it manually in developer mode.

## How does it work ?

When you click on the extension icon (the magnifying glass), it starts intercepting
all network requests coming from the site you are currently on.

When a request to a zoomable image (based on a set of URL patterns) is found,
it shows a little badge in your address bar, which you can click 
to download the image with dezoomify.

For more information about dezoomify, see the [dezoomify readme](https://github.com/lovasoa/dezoomify#dezoomify).

## What to do if it doesn't work

You can read [dezoomify's Frequently Asked Questions](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ).
If you think you found a bug with the extension, or want to suggest a new feature, you can [open a ticket here](https://github.com/lovasoa/dezoomify-extension/issues/new).

## Permissions

This browser addon requires the following permissions:

 - *Access your data for all websites*:
    needed to intercept the requests that pages make, in order to look for zoomable images inside them

## Free Software
This addon is a free software (see [LICENSE](./LICENSE)).
You can see its source code at: https://github.com/lovasoa/dezoomify-extension/
