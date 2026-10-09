# Privacy

Dezoomify assembles images on your device. It has no accounts, advertising,
analytics, or automatic crash reporting. Here is what each app accesses and
what can leave your device.

## What dezoomify does, in one paragraph

You provide an image page or description address. Dezoomify finds the tiles,
downloads them, and assembles a picture you can save. Image tiles travel from
the source site to your device; the project's metadata proxy does not fetch them.

## Our promises

The website reads public resources without your browser login. When direct
metadata access fails, it can use the project's helper proxy to fetch eligible
public description files or viewer pages. That helper necessarily receives the
requested address; it does not receive your browser cookies or Authorization
headers. The application's proxy code does not log requested source addresses.

Desktop and CLI fetch from your device without using that helper. Recent-image
history, settings, cached tiles, and diagnostic reports stay on your device.
Clearing history does not delete saved pictures.

Dezoomify does not automatically send diagnostic reports. **Technical details &
logs** can include full page and image addresses, query parameters, settings, and
error details. These may contain sign-in tokens or other sensitive information.
Review and remove sensitive details before copying, saving, or sharing a report
or submitting the issue draft the app prepares. Do not assume reports are
automatically sanitized.

## The browser extension

The extension examines a source page only after you click its toolbar button.
It reads a snapshot for that attempt, rather than watching unrelated browsing.
The dedicated job tab handles the download; a retry takes another snapshot.
Navigating the source page invalidates access to its old document.

### Cookies and private login information

Source-page requests can use that site's existing browser session to reach
images you are allowed to see. Cross-origin extension requests are
credential-free and require granted host permissions. The extension does not
transfer browser cookies or login credentials to the project server or desktop
app. Reports can still contain sensitive addresses; see
[extension data use](user/browser-extension.md#what-the-extension-does-with-your-data).

## Where to learn more

[User guides](user/README.md) explain each app. [Security](security.md) describes
the technical trust boundaries for contributors.
