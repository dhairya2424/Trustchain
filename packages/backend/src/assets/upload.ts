import { randomUUID } from "node:crypto";
import path from "node:path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type AllowedMime = "image/png" | "image/jpeg" | "image/webp" | "application/pdf";

export interface FileTypeSignature {
  mime: AllowedMime;
  extension: string;
  /** Returns true when the buffer's leading bytes match this format. */
  matches: (buffer: Buffer) => boolean;
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

/**
 * Magic-byte signatures for the four permitted formats.
 *
 * The declared Content-Type is a claim by the uploader and nothing more — renaming
 * shell.exe to avatar.png sets it to image/png. Only the leading bytes say what a file
 * actually is, so those decide.
 */
export const SIGNATURES: FileTypeSignature[] = [
  {
    mime: "image/png",
    extension: "png",
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: "image/jpeg",
    extension: "jpg",
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    mime: "image/webp",
    extension: "webp",
    // RIFF....WEBP — the size field sits between the two markers.
    matches: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  {
    mime: "application/pdf",
    extension: "pdf",
    matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
  },
];

export type UploadRejection =
  | "empty_file"
  | "too_large"
  | "unrecognised_content"
  | "mime_mismatch"
  | "declared_mime_not_allowed";

export type UploadInspection =
  | { ok: true; mime: AllowedMime; extension: string; storageName: string }
  | { ok: false; reason: UploadRejection; detail: string };

/** Detects the true type from content alone. Returns null when nothing matches. */
export function detectType(buffer: Buffer): FileTypeSignature | null {
  return SIGNATURES.find((signature) => signature.matches(buffer)) ?? null;
}

/**
 * Validates an upload and assigns it a storage name.
 *
 * The declared MIME must be allowed AND agree with the magic bytes. Checking both is not
 * redundant: a mismatch is a stronger signal than either check alone, because an honest
 * client has no reason to ever produce one.
 *
 * The stored filename is random and derived only from the detected type. The original
 * name is never used for storage — it is attacker-controlled and carries traversal
 * sequences, null bytes, and double extensions.
 */
export function inspectUpload(params: {
  buffer: Buffer;
  declaredMime: string;
  originalName?: string;
}): UploadInspection {
  const { buffer, declaredMime } = params;

  if (buffer.length === 0) {
    return { ok: false, reason: "empty_file", detail: "upload is empty" };
  }

  if (buffer.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `${buffer.length} bytes exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
    };
  }

  const normalisedDeclared = declaredMime.split(";")[0]?.trim().toLowerCase() ?? "";
  const declaredAllowed = SIGNATURES.some((s) => s.mime === normalisedDeclared);

  if (!declaredAllowed) {
    return {
      ok: false,
      reason: "declared_mime_not_allowed",
      detail: `${normalisedDeclared || "(none)"} is not an accepted type`,
    };
  }

  const detected = detectType(buffer);
  if (!detected) {
    return {
      ok: false,
      reason: "unrecognised_content",
      detail: "file content does not match any accepted format",
    };
  }

  if (detected.mime !== normalisedDeclared) {
    return {
      ok: false,
      reason: "mime_mismatch",
      detail: `declared ${normalisedDeclared} but content is ${detected.mime}`,
    };
  }

  return {
    ok: true,
    mime: detected.mime,
    extension: detected.extension,
    storageName: `${randomUUID()}.${detected.extension}`,
  };
}

/**
 * Sanitises a filename for display only.
 *
 * Never used to build a storage path — {@link inspectUpload} generates that. This exists
 * so an original name can be shown back to a user without carrying traversal sequences
 * or control characters into a log line or a UI.
 */
export function safeDisplayName(originalName: string): string {
  const base = path.basename(originalName).replace(/\0/g, "");
  const cleaned = base.replace(/[^\w. -]/g, "_").replace(/\.{2,}/g, ".");

  return cleaned.slice(0, 120) || "upload";
}
