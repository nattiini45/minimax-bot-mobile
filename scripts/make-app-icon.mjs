#!/usr/bin/env node
/**
 * Draws the app's icons: the team's own mark, stacked the way the desktop stacks it.
 *
 * A launcher icon cannot be fetched at runtime — it is baked into the app binary — so
 * this script draws the mark once from the desktop's own artwork and writes the whole
 * icon set: the legacy icon, the Android adaptive foreground, the monochrome layer the
 * launcher tints, the splash and the web favicon.
 *
 * The mark is the desktop's group mark: up to three member octopuses in one picture,
 * the admin in front. The layout is the desktop's own (`miniapp/client/octopus.js`,
 * `groupMark`), so the icon and the desktop show the same team.
 *
 * The artwork is MiniMax's, under the MIT licence that ships with it
 * (`apps/app/assets/LICENSE-MINIMAX.txt`).
 *
 * Usage:
 *   node scripts/make-app-icon.mjs <skin.png> <skin.png> <skin.png> [--out <dir>]
 *
 * The skins are the pictures of the group's first three members, in the desktop's
 * order: the admin first.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/** The colour the app's own surfaces use, and the background of the icons. */
const BACKGROUND = [242, 244, 247];

/**
 * Where each member of the mark sits, as a fraction of the mark's size: x, y, scale.
 *
 * The same table the desktop draws its group marks with.
 */
const LAYOUTS = {
  1: [[0.08, 0.08, 0.84]],
  2: [
    [0, 0, 0.66],
    [0.36, 0.34, 0.64],
  ],
  3: [
    [0.2, 0, 0.6],
    [0, 0.44, 0.54],
    [0.46, 0.44, 0.54],
  ],
};

/** How far the pieces reach outside the mark's own square, so nothing is cut off. */
const BLEED = 0.02;

/* ------------------------------------------------------------------ PNG ---- */

/** The CRC table PNG chunks are checksummed with. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC of a chunk's type and data. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: its length, its type, its data and its checksum. */
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The chunks of a PNG, in the order they come. */
function chunksOf(buffer) {
  const out = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    out.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

/** The predictor PNG's filters use. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Reads a PNG into RGBA bytes.
 *
 * Only what this project needs: 8-bit, not interlaced, grey / RGB / palette / grey+alpha
 * / RGBA. The artwork the desktop uses is RGBA; the rest is here so the script can be
 * pointed at any of the app's own images.
 */
function decodePng(buffer) {
  const parts = chunksOf(buffer);
  const header = parts.find((part) => part.type === 'IHDR')?.data;
  if (!header) throw new Error('not a PNG: no header');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colour = header[9];
  const interlace = header[12];
  if (depth !== 8) throw new Error(`only 8-bit PNGs are read, this one is ${depth}-bit`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not read');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(`unsupported colour type ${colour}`);

  const palette = parts.find((part) => part.type === 'PLTE')?.data;
  const alpha = parts.find((part) => part.type === 'tRNS')?.data;
  const raw = inflateSync(
    Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.data)),
  );

  const stride = width * channels;
  const lines = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const source = raw.subarray(at, at + stride);
    at += stride;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = source[x];
          break;
        case 1:
          value = source[x] + left;
          break;
        case 2:
          value = source[x] + up;
          break;
        case 3:
          value = source[x] + ((left + up) >> 1);
          break;
        case 4:
          value = source[x] + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
    row.copy(lines, y * stride);
    previous = row;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const to = index * 4;
    if (colour === 6) {
      lines.copy(rgba, to, from, from + 4);
    } else if (colour === 2) {
      rgba[to] = lines[from];
      rgba[to + 1] = lines[from + 1];
      rgba[to + 2] = lines[from + 2];
      rgba[to + 3] = 255;
    } else if (colour === 0) {
      rgba[to] = lines[from];
      rgba[to + 1] = lines[from];
      rgba[to + 2] = lines[from];
      rgba[to + 3] = 255;
    } else if (colour === 4) {
      rgba[to] = lines[from];
      rgba[to + 1] = lines[from];
      rgba[to + 2] = lines[from];
      rgba[to + 3] = lines[from + 1];
    } else {
      const index8 = lines[from];
      rgba[to] = palette[index8 * 3];
      rgba[to + 1] = palette[index8 * 3 + 1];
      rgba[to + 2] = palette[index8 * 3 + 2];
      rgba[to + 3] = alpha && index8 < alpha.length ? alpha[index8] : 255;
    }
  }
  return { width, height, pixels: rgba };
}

/** Writes RGBA bytes as a PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- drawing ---- */

/** A blank RGBA canvas. */
function canvas(width, height, fill) {
  const pixels = Buffer.alloc(width * height * 4);
  if (fill) {
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 4] = fill[0];
      pixels[index * 4 + 1] = fill[1];
      pixels[index * 4 + 2] = fill[2];
      pixels[index * 4 + 3] = 255;
    }
  }
  return { width, height, pixels };
}

/** One pixel of an image, bilinearly sampled at a point in its own coordinates. */
function sample(image, x, y) {
  const fx = Math.min(Math.max(x, 0), image.width - 1);
  const fy = Math.min(Math.max(y, 0), image.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (px, py) => {
    const index = (py * image.width + px) * 4;
    return [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2], image.pixels[index + 3]];
  };
  const mix = (a, b, t) => a + (b - a) * t;
  const top = at(x0, y0).map((value, channel) => mix(value, at(x1, y0)[channel], tx));
  const bottom = at(x0, y1).map((value, channel) => mix(value, at(x1, y1)[channel], tx));
  return top.map((value, channel) => mix(value, bottom[channel], ty));
}

/** Draws an image into a square of the canvas, scaled to fit it. */
function drawScaled(target, image, left, top, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = sample(
        image,
        (x / size) * (image.width - 1),
        (y / size) * (image.height - 1),
      );
      const alpha = source[3] / 255;
      if (alpha <= 0) continue;
      const tx = left + x;
      const ty = top + y;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const index = (ty * target.width + tx) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        target.pixels[index + channel] = Math.round(
          source[channel] * alpha + target.pixels[index + channel] * (1 - alpha),
        );
      }
      target.pixels[index + 3] = Math.round(
        255 * alpha + target.pixels[index + 3] * (1 - alpha),
      );
    }
  }
}

/** Draws the silhouette of an image in one colour, so the launcher can tint it. */
function drawSilhouette(target, image, left, top, size, colour) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = sample(
        image,
        (x / size) * (image.width - 1),
        (y / size) * (image.height - 1),
      );
      const alpha = source[3] / 255;
      if (alpha <= 0) continue;
      const tx = left + x;
      const ty = top + y;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const index = (ty * target.width + tx) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        target.pixels[index + channel] = colour[channel];
      }
      target.pixels[index + 3] = Math.round(
        255 * alpha + target.pixels[index + 3] * (1 - alpha),
      );
    }
  }
}

/**
 * The group's mark: the members stacked into one picture.
 *
 * @param {Array<{width: number, height: number, pixels: Buffer}>} members
 * @param {number} size the mark's width in pixels
 * @param {{background?: number[], halo?: boolean, monochrome?: boolean}} options
 */
function groupMark(members, size, { background, halo = true, monochrome = false } = {}) {
  const target = canvas(size, size, background);
  const list = members.slice(0, 3);
  const slots = LAYOUTS[list.length] ?? [];
  // The members behind are drawn first: the admin is in front, as on the desktop.
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const [x, y, scale] = slots[index] ?? [0, 0, 1];
    const side = Math.round(scale * size);
    const left = Math.round(x * size);
    const top_ = Math.round(y * size);
    if (halo && list.length > 1) {
      // A ring in the background's own colour keeps the pieces apart, the way the
      // desktop separates them with a stroke.
      const ring = Math.max(2, Math.round(size * 0.02));
      drawSilhouette(
        target,
        list[index],
        left - ring,
        top_ - ring,
        side + ring * 2,
        background ?? BACKGROUND,
      );
    }
    if (monochrome) {
      drawSilhouette(target, list[index], left, top_, side, [255, 255, 255]);
    } else {
      drawScaled(target, list[index], left, top_, side);
    }
  }
  return target;
}

/* ----------------------------------------------------------------- main ---- */

/**
 * The arguments: the member pictures, and where to write the icons.
 */
function argumentsOf(argv) {
  const skins = [];
  let out = resolve('apps/app/assets');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = resolve(argv[index + 1]);
      index += 1;
    } else {
      skins.push(resolve(argv[index]));
    }
  }
  return { skins, out };
}

async function main() {
  const { skins, out } = argumentsOf(process.argv.slice(2));
  if (skins.length === 0) {
    throw new Error('usage: node scripts/make-app-icon.mjs <skin.png> [<skin.png> ...] [--out <dir>]');
  }
  const members = [];
  for (const file of skins) {
    members.push(decodePng(await readFile(file)));
  }

  // The mark, drawn big once and scaled down for the smaller icons.
  const master = 1024;
  const mark = groupMark(members, master, { background: null });

  /** The mark on a square of the given size, scaled to a fraction of it. */
  const scaled = (size, fraction, options) => {
    const small = groupMark(members, Math.round(size * fraction), options);
    const target = canvas(size, size, options.background);
    const offset = Math.round((size - small.width) / 2);
    drawScaled(target, small, offset, offset, small.width);
    return target;
  };

  // The legacy icon: the mark on the app's own background.
  const icon = scaled(master, 0.78, { background: BACKGROUND });
  await writeFile(resolve(out, 'icon.png'), encodePng(master, master, icon.pixels));

  // The Android adaptive foreground: the mark inside the safe zone, so no launcher
  // mask can cut a piece off.
  const foreground = scaled(512, 0.6, { background: null });
  await writeFile(
    resolve(out, 'android-icon-foreground.png'),
    encodePng(512, 512, foreground.pixels),
  );

  // The background layer: the app's own surface, without the template's guides.
  await writeFile(
    resolve(out, 'android-icon-background.png'),
    encodePng(512, 512, canvas(512, 512, BACKGROUND).pixels),
  );

  // The monochrome layer the launcher tints.
  const monochrome = scaled(432, 0.6, { background: null, monochrome: true });
  await writeFile(
    resolve(out, 'android-icon-monochrome.png'),
    encodePng(432, 432, monochrome.pixels),
  );

  // The splash: the mark, smaller, on nothing — the splash paints the background.
  const splash = scaled(1024, 0.42, { background: null });
  await writeFile(
    resolve(out, 'splash-icon.png'),
    encodePng(1024, 1024, splash.pixels),
  );

  // The web favicon.
  const favicon = scaled(48, 0.92, { background: BACKGROUND });
  await writeFile(resolve(out, 'favicon.png'), encodePng(48, 48, favicon.pixels));

  console.log(`wrote the icon set to ${out}`);
  console.log(`the mark is ${mark.width}x${mark.height}`);
}

await main();
