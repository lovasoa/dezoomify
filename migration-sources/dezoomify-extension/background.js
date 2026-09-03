// @ts-ignore
const VALID_RESOURCE_TYPES = new Set(Object.values(chrome.webRequest['ResourceType']));

/**
 * Selector for which requests we want to intercept
 * @type chrome.webRequest.RequestFilter
 */
const REQUESTS_FILTER = {
    urls: ["<all_urls>"],
    // @ts-ignore
    types: [
        "main_frame",
        "image",
        "object",
        "object_subrequest",
        "sub_frame",
        "xmlhttprequest",
        "script",
        "other"
    ].filter(t => VALID_RESOURCE_TYPES.has(t))
};

/** @type {Map<number, PageListener>} */
const page_listeners = new Map;

/**
 * Handle a click on the extension's icon
 * @param {chrome.tabs.Tab} unchecked_tab 
 */
async function click(unchecked_tab) {
    const tab = checkTab(unchecked_tab);
    chrome.browserAction.setBadgeText({ text: '...', tabId: tab.id });
    const listener = page_listeners.get(tab.id);
    if (listener && listener.isListening()) {
        // Open the images that may have been found, and stop the existing listener
        listener.openFound();
        listener.close();
        page_listeners.delete(checkTab(listener.tab).id);
    } else {
        // No active listener, start the extension for this tab
        if (listener) listener.close();
        const newListener = new PageListener(tab);
        page_listeners.set(tab.id, newListener);
    }
}

chrome.browserAction.onClicked.addListener(click);

// Remove page listeners when their tab is closed  
chrome.tabs.onRemoved.addListener(tabID => {
    const listener = page_listeners.get(tabID);
    if (listener) {
        listener.stop();
        page_listeners.delete(tabID);
    }
});

/**
 * Tracks the state of dezoomify on a given tab
 */
class PageListener {
    /**
     * @param {chrome.tabs.Tab} tab 
     */
    constructor(tab) {
        this.tab = checkTab(tab);
        /** @type {Set<string>} */
        this.found = new Set;
        this.listener = this.handleRequest.bind(this);
        const filter = { tabId: this.tab.id, ...REQUESTS_FILTER };
        chrome.webRequest.onBeforeRequest.addListener(this.listener, filter);
        this.handleRequest(this.tab);
        this.updateStatus();
        this.interval = setInterval(this.updateStatus.bind(this), 1000);
    }


    /**
     * Stop listening, free all resources used by this listener, and reset the icon
     */
    close() {
        this.stop();
        this.found.clear();
        this.updateStatus();
    }

    /**
     * Stop listening and free all resources used by this listener.
     */
    stop() {
        chrome.webRequest.onBeforeRequest.removeListener(this.listener);
        clearInterval(this.interval);
    }

    /**
     * @returns {boolean}
     */
    isListening() {
        return chrome.webRequest.onBeforeRequest.hasListener(this.listener);
    }

    /**
     * Returns whether the listener currently looks "activated" from the user's perspective
     * @returns {Promise<boolean>}
     */
    hasVisibleResults() {
        return new Promise((accept) => {
            chrome.browserAction.getTitle({ tabId: this.tab.id }, title => {
                accept(title !== getManifest().browser_action.default_title);
            });
        });
    }

    /**
     * @param {{url:string }} request 
     */
    handleRequest({ url }) {
        const recognizedUrl = recognizeZoomableUrl(url);
        if (recognizedUrl) this.foundZoomableImage(recognizedUrl);
    }

    /**
     * Adds a request to the cached zoomable image requests
     * @param {string} url 
     */
    foundZoomableImage(url) {
        let parsed_url = new URL(url);
        // Avoid duplicated URLs. Favor the https variant
        if (parsed_url.protocol === "http:") {
            parsed_url.protocol = "https:";
            if (this.found.has(parsed_url.toString())) return;
        } else if (parsed_url.protocol === "https:") {
            parsed_url.protocol = "http:";
            this.found.delete(parsed_url.toString());
        }
        this.found.add(url);
        this.updateStatus();
    }

    /**
     * Sets the extension's icon status
     */
    updateStatus() {
        const manifest = getManifest();
        const found = this.found.size;
        let badge = (found || '').toString();
        let title = '';
        const { host } = new URL(this.tab.url);
        if (!this.isListening()) {
            badge = '';
            title = '' + manifest.browser_action.default_title;
        } else if (found === 0) {
            title = `Listening for zoomable image requests from ${host}... ` +
                'Zoom on your image and it should be detected.';
        } else if (found === 1) {
            title = `Found a zoomable image on ${host}. Click to open it.`;
        } else {
            title = `Found ${found} images on ${host}. Click to open them.`
        }
        const tabId = this.tab.id;
        chrome.browserAction.setBadgeText({ text: badge, tabId });
        chrome.browserAction.setTitle({ title, tabId });
        const path = this.isListening() ? manifest.icons : manifest.browser_action.default_icon;
        chrome.browserAction.setIcon({ tabId, path });
    }

    openFound() {
        for (const url of this.found) openDezoomify(url);
    }
}


/**
 * Open dezoomify in a tab
 * @param {string} image_url 
 */
function openDezoomify(image_url) {
    const url = DEZOOMIFY_URL + image_url;
    return chrome.tabs.create({ url })
}

/**
 * Throw an error if a tab does not have an id or an URL
 * @typedef {{id:number, url:string} & chrome.tabs.Tab} GoodTab
 * @param {chrome.tabs.Tab} tab 
 * @returns {GoodTab}
 */
function checkTab(tab) {
    if (!tab.id || !tab.url) throw new Error(`bad tab: ${tab}`);
    // @ts-ignore
    return tab;
}

/**
 * Checks whether the two tabs point to the same site
 * @param {string} url1 
 * @param {string} url2 
 */
function sameSite(url1, url2) {
    return new URL(url1).origin === new URL(url2).origin;
}


/**
 * @returns {{browser_action:chrome.runtime.ManifestAction} & chrome.runtime.Manifest} the extension's manifest
 */
function getManifest() {
    const { browser_action, ...manifest } = chrome.runtime.getManifest();
    if (!browser_action) throw new Error(`Invalid manifest: ${manifest}`);
    return { browser_action, ...manifest };
}

/**
 * A context menu action
 * @typedef {{
    *      title:string,
    *      url?:string,
    *      onclick?: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
    * }} MenuAction
    */

/**
 * @type {MenuAction[]}
 */
const DEFAULT_MENU_ACTIONS = [
    {
        title: "Usage instructions and information",
        url: 'https://github.com/lovasoa/dezoomify-extension/#dezoomify-extension',
    },
    {
        title: "Open the Dezoomify website",
        onclick(_info, tab) { openDezoomify(checkTab(tab).url) },
    },
    {
        title: "Deactivate dezoomify on all tabs",
        onclick(_info, _tab) {
            for (const l of page_listeners.values()) l.close();
            page_listeners.clear();
        },
    },
    {
        title: "Report a problem with this extension",
        url: 'https://github.com/lovasoa/dezoomify-extension/issues/new',
    },
    {
        title: "Support me, the developer !",
        url: "https://github.com/sponsors/lovasoa"
    }
]

/**
 * Add right-click menu actions
 */
chrome.contextMenus.removeAll();
DEFAULT_MENU_ACTIONS.forEach(({ title, url, onclick }) => {
    chrome.contextMenus.create({
        title,
        contexts: ["browser_action"],
        onclick: onclick || (_ => chrome.tabs.create({ url, active: true, }))
    });
});
