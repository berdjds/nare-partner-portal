// Regenerates the derived icons from public/brand/nare-icon.webp (the file staging.nare.am uses).
// Run: node scripts/gen-brand-icons.mjs   (requires sharp, which Next already installs)
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const sharp = createRequire(import.meta.url)("sharp");
const src = "public/brand/nare-icon.webp";
const out = { "public/brand/icon-32.png": 32, "public/brand/apple-touch-icon.png": 180, "public/brand/icon-192.png": 192, "public/brand/icon-512.png": 512 };
for (const [p, n] of Object.entries(out)) await sharp(src).resize(n, n, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toFile(p);
// favicon.ico: a one-image ICO whose payload is the 32 px PNG (valid since Windows Vista, supported by every current browser).
const png = await sharp(src).resize(32, 32).png({ compressionLevel: 9 }).toBuffer();
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 32; head[7] = 32; head[8] = 0; head[9] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
writeFileSync("app/favicon.ico", Buffer.concat([head, png]));
console.log("icons written");
