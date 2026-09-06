import { Router, type Request } from "express";
import multer from "multer";
import { nonZeroBytes32 } from "@trustchain/shared";
import { z } from "zod";

import type { Logger } from "../http/logger";
import { stripMetadata } from "./metadata";
import type { MalwareScanner } from "./malware";
import type { IpfsPinner } from "./pinata";
import { buildProvenance, ProvenanceError, type AssetEventSource } from "./provenance";
import type { TransactionRelayer } from "./relayer";
import { toAssetDto, type AssetRecord } from "./serializers";
import { inspectUpload, MAX_UPLOAD_BYTES, safeDisplayName } from "./upload";

/** Memory storage: nothing reaches disk before the scanner has cleared it. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 },
});

const mintFields = z
  .object({
    toDID: nonZeroBytes32,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    soulbound: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((v) => v === true || v === "true"),
  })
  .strict();

export interface AssetDependencies {
  scanner: MalwareScanner;
  pinner: IpfsPinner;
  relayer: TransactionRelayer;
  events: AssetEventSource;
  assets: { find(tokenId: number): Promise<AssetRecord | null> };
  logger: Logger;
  resolveCaller: (req: Request) => { didHash: string; address: string } | null;
}

export function createAssetRouter(deps: AssetDependencies): Router {
  const router = Router();

  router.post("/mint", upload.single("file"), async (req, res) => {
    const caller = deps.resolveCaller(req);
    if (!caller) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const fields = mintFields.safeParse(req.body);
    if (!fields.success) {
      res.status(400).json({
        error: "invalid_request",
        requestId: req.requestId,
        issues: fields.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file_required" });
      return;
    }

    // 1 — content decides the type, not the declared header or the filename.
    const inspection = inspectUpload({
      buffer: file.buffer,
      declaredMime: file.mimetype,
      originalName: file.originalname,
    });

    if (!inspection.ok) {
      deps.logger.log({
        level: "warn",
        msg: "upload.rejected",
        requestId: req.requestId,
        actor: caller.address,
        reason: inspection.reason,
        detail: inspection.detail,
        originalName: safeDisplayName(file.originalname ?? ""),
      });
      res.status(415).json({ error: inspection.reason, detail: inspection.detail });
      return;
    }

    // 2 — scan before anything else touches the bytes.
    let verdict;
    try {
      verdict = await deps.scanner.scan(file.buffer);
    } catch (error) {
      deps.logger.log({
        level: "error",
        msg: "upload.scanner_unavailable",
        requestId: req.requestId,
        detail: error instanceof Error ? error.message : "unknown",
      });
      // The scanner failing is not a reason to accept unscanned content.
      res.status(503).json({ error: "scanner_unavailable" });
      return;
    }

    if (!verdict.clean) {
      deps.logger.log({
        level: "warn",
        msg: "security.malware_upload_blocked",
        requestId: req.requestId,
        actor: caller.address,
        signature: verdict.signature,
      });
      res.status(422).json({ error: "malware_detected" });
      return;
    }

    // 3 — strip metadata before publishing. IPFS is permanent; GPS coordinates in an
    // uploaded photo cannot be recalled once pinned.
    const stripped = stripMetadata(file.buffer, inspection.mime);

    // 4 — pin the file, then the metadata document that points at it.
    const pinnedFile = await deps.pinner.pinFile({
      buffer: stripped.buffer,
      filename: inspection.storageName,
      mime: inspection.mime,
    });

    const pinnedMetadata = await deps.pinner.pinJson(
      {
        name: fields.data.name,
        description: fields.data.description ?? "",
        image: pinnedFile.uri,
        properties: { soulbound: fields.data.soulbound, mimeType: inspection.mime },
      },
      inspection.storageName,
    );

    // 5 — the relayer signs. This process holds no key.
    const relayed = await deps.relayer.relayMint({
      toDID: fields.data.toDID,
      tokenURI: pinnedMetadata.uri,
      soulbound: fields.data.soulbound,
    });

    deps.logger.log({
      level: "info",
      msg: "asset.mint_relayed",
      requestId: req.requestId,
      actor: caller.address,
      toDID: fields.data.toDID,
      cid: pinnedMetadata.cid,
      metadataStripped: stripped.removed,
      transactionId: relayed.transactionId,
    });

    res.status(202).json({
      status: relayed.status,
      transactionId: relayed.transactionId,
      tokenURI: pinnedMetadata.uri,
      imageUri: pinnedFile.uri,
      gatewayUrl: pinnedMetadata.gatewayUrl,
    });
  });

  router.get("/:tokenId", async (req, res) => {
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      res.status(400).json({ error: "invalid_token_id" });
      return;
    }

    const record = await deps.assets.find(tokenId);
    if (!record) {
      res.status(404).json({ error: "asset_not_found" });
      return;
    }

    // Explicit projection. The record carries internal fields; the DTO does not.
    res.json(toAssetDto(record));
  });

  router.get("/:tokenId/provenance", async (req, res) => {
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      res.status(400).json({ error: "invalid_token_id" });
      return;
    }

    try {
      const events = await deps.events.eventsForToken(tokenId);
      res.json(buildProvenance(tokenId, events));
    } catch (error) {
      if (error instanceof ProvenanceError) {
        res.status(error.code === "not_found" ? 404 : 409).json({ error: error.code });
        return;
      }
      throw error;
    }
  });

  return router;
}
