/**
 * This is a cloudflare worker for dezoomify
 */

/**
 * Respond to the request
 * @param {Request} request
 */
async function handleRequest(request) {
    const url = new URL(request.url);
    const target_url = new URL(url.searchParams.get("url"));
    let target_request = new Request(target_url, request);
    target_request.headers.set("Origin", target_url.origin);
    target_request.headers.set("Referer", target_url.toString());
    const cookies = url.searchParams.get("cookies");
    if (cookies) target_request.headers.set("Cookie", cookies);
    let response = await fetch(target_request);
    response = new Response(response.body, response);
    const response_cookie = response.headers.get("Set-Cookie");
    if (response_cookie) response.headers.set("X-Set-Cookie", response_cookie);
    response.headers.delete("Set-Cookie");
    return response;
}

/**
 * Handle a fetch event
 * @param {Error} error
 */
async function handleError(error) {
    console.error(error);
    return new Response(error.toString(), { status: 500 });
}

addEventListener('fetch', evt => {
    const req = evt.request;
    console.log(req.url);
    let response = handleRequest(req).catch(handleError);
    evt.respondWith(response);
});