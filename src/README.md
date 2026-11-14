# Website

The current website lets users paste an image address and save a picture without
installing an app. It combines the [browser runtime](../packages/browser-runtime/)
and [shared UI](../packages/shared-ui/) with website navigation and saving.

This directory also contains the public-resource proxy shared by local and
deployed website servers. The [deployed entry points](../functions/) expose that
service. The [extension](../apps/extension/) provides browser-session access
when the website cannot reach an image. See the [website guide](../docs/user/website.md).
