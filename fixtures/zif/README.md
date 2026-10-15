# ZIF input

Synthetic GPL-3.0-or-later fixtures use the shared JPEG tiles. The viewer's
literal string concatenation reproduces [issue #1239](https://github.com/lovasoa/dezoomify/issues/1239)
from [Nichibun's map viewer](https://lapis.nichibun.ac.jp/chizu/zoomify/mapview.php?m=004672986_o).
No source-site scripts or image bytes are copied.

The fixture-local handler constructs a two-level JPEG BigTIFF and serves exact
byte ranges. Its tile index sits beyond 8 MiB, and full-file requests fail, so
successful saves require bounded metadata and tile reads. The direct variant
also checks preservation of query parameters.
