# Gallica IIIF 1.1 without a declared pyramid

Synthetic GPL-3.0-or-later reproduction of
[issue #1301](https://github.com/lovasoa/dezoomify/issues/1301), distilled from the
user-supplied HAR for
<https://gallica.bnf.fr/view3if/ga/ark:/12148/btv1b52504834s>.
Preserves the manifest's array-valued metadata, separate painting/service IDs,
and the image service's capabilities without tile or scale-factor declarations.
Uses shared fixture pixels, not the source artwork. Focused tests enlarge the
metadata to exercise browser resolution selection without allocating that image.
