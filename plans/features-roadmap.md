# Feature proposals

These proposals build on the shared asynchronous algorithm and injected Host
capabilities. Product behavior and shipped capabilities are defined in
[User guides](../docs/user/README.md), [Native apps](../docs/native-apps.md), and
[Browser runtime](../docs/browser-runtime.md).

## Preview and estimate

Add a pre-acquisition estimate for images with declared dimensions: tile count,
expected memory, applicable browser limits, and a useful next action. Derive
these facts from the selected image and concrete platform limits.

Acceptance:

- Show the estimate before tile acquisition for declared geometry.
- Name memory requirements and offer a smaller level or the desktop app when appropriate.
- Keep the explanation brief, with technical detail expandable.
- Preserve bounded allocation and typed failures when estimates are unavailable.

## Signed distribution

Extend the release workflow with signed installers for supported desktop targets.
Store packages declare only permissions used by shipped behavior. Installation
guides remain sourced from `docs/user/`.

Acceptance:

- Signing and verification fail closed when prerequisites are missing.
- Each published installer installs, launches, and saves a fixture image.
- Store listings match the shipped permissions and data-use guidance.

## Accessibility and translation

Extend the existing React shared UI and translation catalog as new controls are
added. Every supported locale preserves the same actions and capability limits.

Acceptance:

- Complete a fixture journey and one recovery path using the keyboard.
- Verify focus, accessible names, announcements, and contrast.
- Translate user-facing controls; keep diagnostic codes stable.
