/**
 * Removes embedded metadata from uploaded images.
 *
 * The concrete risk is GPS coordinates. A photograph taken on a phone carries the exact
 * location it was taken, and an asset image is published to IPFS where it is permanent
 * and world-readable. Stripping it after publication is impossible, so it happens before.
 *
 * Implemented directly against each container format rather than through an image
 * library: the transforms below are pure byte surgery with no re-encoding, so the image
 * a user uploaded is the image that gets pinned, and there is no native dependency to
 * build on every platform.
 */

export interface StripResult {
  buffer: Buffer;
  /** Names of the metadata sections removed, for logging and tests. */
  removed: string[];
}

const JPEG_SOS = 0xda;

/** JPEG APP segments that carry metadata rather than image data. */
const JPEG_METADATA_MARKERS: Record<number, string> = {
  0xe1: "APP1 (EXIF/XMP)",
  0xe2: "APP2 (ICC/FlashPix)",
  0xed: "APP13 (IPTC/Photoshop)",
  0xee: "APP14 (Adobe)",
  0xfe: "COM (comment)",
};

/** PNG ancillary chunks holding text, time or EXIF. */
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function stripJpeg(input: Buffer): StripResult {
  const removed: string[] = [];
  const parts: Buffer[] = [];

  let offset = 2; // past SOI
  parts.push(input.subarray(0, 2));

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) break;

    const marker = input[offset + 1] as number;

    // Start of scan: everything after this is entropy-coded image data.
    if (marker === JPEG_SOS) {
      parts.push(input.subarray(offset));
      break;
    }

    const length = input.readUInt16BE(offset + 2);
    const segmentEnd = offset + 2 + length;
    if (segmentEnd > input.length) break;

    const label = JPEG_METADATA_MARKERS[marker];
    if (label) {
      removed.push(label);
    } else {
      parts.push(input.subarray(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  return { buffer: Buffer.concat(parts), removed };
}

function stripPng(input: Buffer): StripResult {
  const removed: string[] = [];
  const parts: Buffer[] = [input.subarray(0, 8)]; // signature

  let offset = 8;
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkEnd = offset + 12 + length; // length + type + data + crc
    if (chunkEnd > input.length) break;

    if (PNG_METADATA_CHUNKS.has(type)) {
      removed.push(type);
    } else {
      parts.push(input.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (type === "IEND") break;
  }

  return { buffer: Buffer.concat(parts), removed };
}

function stripWebp(input: Buffer): StripResult {
  const removed: string[] = [];
  const parts: Buffer[] = [input.subarray(0, 12)]; // RIFF header + WEBP

  let offset = 12;
  while (offset + 8 <= input.length) {
    const fourCC = input.subarray(offset, offset + 4).toString("ascii");
    const size = input.readUInt32LE(offset + 4);
    // RIFF chunks are padded to an even length.
    const chunkEnd = offset + 8 + size + (size % 2);
    if (chunkEnd > input.length) break;

    if (fourCC === "EXIF" || fourCC === "XMP ") {
      removed.push(fourCC.trim());
    } else {
      parts.push(input.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  const output = Buffer.concat(parts);
  // The RIFF size field counts everything after it, so it must be rewritten.
  if (output.length >= 8) output.writeUInt32LE(output.length - 8, 4);

  return { buffer: output, removed };
}

/**
 * Strips metadata according to the detected type.
 *
 * PDFs are returned untouched and reported as such. Rewriting a PDF's document
 * information dictionary and XMP packet safely needs a real PDF parser, and a
 * half-implemented strip that silently misses the metadata would be worse than an
 * honest "not stripped" — callers can decide whether to accept PDFs at all.
 */
export function stripMetadata(buffer: Buffer, mime: string): StripResult {
  switch (mime) {
    case "image/jpeg":
      return stripJpeg(buffer);
    case "image/png":
      return stripPng(buffer);
    case "image/webp":
      return stripWebp(buffer);
    default:
      return { buffer, removed: [] };
  }
}
