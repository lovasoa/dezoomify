# Browser extension

The extension embeds the shared React UI and adds two privileges: discovery in the active page and browser-session fetching under explicitly granted host permissions. It does not use the metadata CORS proxy.

## Discovery

The extension does not scan pages in the background. Scanning begins only after an explicit extension action. It registers its bounded collectors before at most one user-approved reload, then observes through a finite settle period and hard deadline. A reload never rearms scanning.

The content script collects candidate viewer URLs and bounded page metadata; `crates/dezoomify-core` performs format recognition and discovery. Completion, deadline, or closing the extension page stops observers and releases page references.

## Fetching

The background service worker obtains readable bytes directly under the narrowest host permission and the current browser session. It validates every URL and redirect against that grant, applies size limits, and streams results through typed protocol messages. Website JavaScript cannot call this fetch channel.

The browser runtime decodes these bytes, processes them when required, and creates an origin-clean save surface. Page cookies follow browser extension permission and credential rules. The extension never uses the metadata CORS proxy.

## Native handoff

The extension offers native handoff for huge outputs, local destinations, bulk work, unsupported codecs, or durable jobs. Source URLs, catalog selection, recipes, and non-secret headers form bounded untrusted input that native validates and the user confirms.

The extension reaches native only through allowlisted Native Messaging. Browser enforcement of the native host's allowed extension IDs authenticates the extension sender to the native host. A fresh challenge and one-use nonce bind messages to one explicit consent session and prevent replay; they do not establish identity. Cookies pass only to native after the prompt names the destination origins and scope; they are not intentionally persisted. Declining consent keeps the job in the extension and offers credential-free recovery choices. See [Protocol](protocol.md#handoff) and [Security](security.md#credentials).

## Packaging

Extension-specific code is limited to the manifest, permission flow, content script, background integration, and extension-page host shell. User-facing job behavior comes from the same protocol and scenarios as web and desktop. See [Testing](testing.md) and [Releases](releases.md).
