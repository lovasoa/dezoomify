# website

# The Dezoomify website

Open the [Dezoomify website](https://dezoomify.ophir.dev/beta/); no installation
is needed.

## Save an image

1. Copy the address of the page showing the zoomable image.
2. Paste it into Dezoomify and press **Dezoomify !**.
3. Wait for the picture, then press **Save** to download a PNG.

You can also paste a description address such as `info.json`,
`ImageProperties.xml`, or a `.dzi` file. If nothing is found, follow
[finding the image address](./finding-the-image-address.md).

The website selects the largest image and resolution that fit. When it uses a
smaller resolution, it shows the selected and maximum sizes, with the desktop
app, **Try maximum**, and **Stop** while working. **Try maximum** restarts at full
resolution but can fail at the browser's limits. For a specific image or level,
use the [CLI](./command-line.md).

## Saving several images

Use [CLI bulk saving](./command-line.md#saving-many-images) for a list of addresses.

## Recent pictures

History keeps the last 20 started images on this device, including failed and
cancelled attempts. Click an entry to fill the address field without starting.
Remove one with the trash icon or use **Clear history**. Reloading stops the
current run; enter its address again to restart.

## Language

The interface offers English, French, German, and Italian. Choose a language
or let the app follow your browser preference. Help pages, error codes, URLs,
and format names remain untranslated.

## What the website cannot do

- **Use your login.** For members-only images, use the
  [extension](./browser-extension.md) while signed in.
- **Remove browser size limits.** Use the [desktop app](../../apps/desktop/desktop-app.md)
  for full-size images that will not fit. The extension has the same browser limits.
- **Save every visible image.** Some sites permit display without readable image
  data. Dezoomify labels this as display-only; use desktop or the extension to
  try a readable route instead.
- **Keep original color profiles or photo metadata.** Use desktop when metadata
  preservation matters.

For access refusals, interrupted downloads, and other failures, follow
[troubleshooting](./troubleshooting.md). Switching apps cannot grant access to
an image you are not allowed to see.

## Next steps

- [Troubleshooting](./troubleshooting.md)
- [Install the extension](./browser-extension.md)
