// Independent decoder for native codec tests. Header: u32 LE width, height;
// remaining stdout is unpremultiplied RGBA8, with no color-profile conversion.
import sharp from "sharp";

const { data, info } = await sharp(process.argv[2])
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const header = Buffer.alloc(8);
header.writeUInt32LE(info.width, 0);
header.writeUInt32LE(info.height, 4);
process.stdout.write(header);
process.stdout.write(data);
