Small lossless reference images encoded with Pillow 12.3 / OpenJPEG 2.5.4,
independently of the Rust codec. RGB pixels are `(17*x, 31*y, 13*(x+y))` on
an 11×7 canvas. The 5×3 grayscale codestream has 16-bit samples
`4096*(x+5*y)`. All images start at the origin and use reversible coding.
