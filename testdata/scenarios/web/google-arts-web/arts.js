// Shared by the two Arts fixtures. Signing and encrypted containers belong here.
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";

export function verifiedBase(pathname) {
  const match = pathname.match(/^\/arts\/([^=]+)=x(.*)-y(.*)-z(.*)-t([^/]+)$/);
  if (!match) return null;
  const [, base, x, y, z, signature] = match;
  const expected = createHmac("sha1", Buffer.from("7b2b4e23de2cc5c5", "hex"))
    .update(`arts/${base}=x${x}-y${y}-z${z}-tsample-token`)
    .digest("base64")
    .replace(/[+/]/g, "_")
    .replace(/=+$/, "");
  return signature === expected ? base : null;
}

export function decryptTile(stored) {
  const text = stored.toString().replace(/\s/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[a-z\d+/]*={0,2}$/i.test(text) || text.length % 4 === 1) throw new Error("bad base64");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x0a0a0a0a) return bytes;
  if (bytes.length < 8) throw new Error("short encrypted container");
  const prefixEnd = 4 + bytes.readUInt32LE(bytes.length - 4);
  if (prefixEnd + 4 > bytes.length) throw new Error("bad prefix");
  const start = prefixEnd + 4;
  const end = start + bytes.readUInt32LE(prefixEnd);
  if (end > bytes.length - 4) throw new Error("bad encrypted length");
  const key = Buffer.from("5b63db113b7af3e0b1435556c8f9530c", "hex");
  const iv = Buffer.from("71e70405353a778bfa6fbc30321b9592", "hex");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const pad = Buffer.concat([cipher.update(Buffer.alloc(32, 16)), cipher.final()]);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([
    decipher.update(Buffer.concat([bytes.subarray(start, end), pad])),
    decipher.final(),
  ]);
  return Buffer.concat([
    bytes.subarray(4, prefixEnd),
    plain.subarray(0, plain.length - 32),
    bytes.subarray(end, -4),
  ]);
}
