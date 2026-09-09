import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";

/**
 * QR scanning: the browser's own decoder where it exists, a loaded one where it does not.
 *
 * This used to be BarcodeDetector only, on the reasoning that "Chrome and Edge on Android
 * and desktop ship a detector already" and a decoding library was weight most visitors
 * would never use. The first half of that is wrong: BarcodeDetector is part of the Shape
 * Detection API, and on **Windows** Chrome does not expose it. Verified by decoding in a
 * real Chrome on Windows and getting nothing. So scanning was simply unavailable to a large
 * share of desktop users, who saw "this browser has no QR decoder" and had to type a hash
 * by hand.
 *
 * The weight argument still holds, so the decoder is *dynamically imported* and only when
 * the native one is missing. Browsers that ship a detector download nothing; the rest get a
 * working scanner instead of an apology.
 *
 * Two things it is careful about, both about not holding a camera it is not using:
 *   - every track is stopped on unmount and on a successful read, so the camera light goes
 *     out when scanning ends rather than when the tab does
 *   - the detection loop is cancelled before the stream is torn down, so a frame in flight
 *     cannot resurrect it
 */

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

interface WindowWithDetector extends Window {
  BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike;
}

/**
 * Whether scanning can be offered at all.
 *
 * Now a question about the camera rather than the decoder, since a decoder can always be
 * loaded. Without `getUserMedia` there is no image to decode and the button would open a
 * panel that could only apologise.
 */
export function isQrSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/** Decodes one frame. Returns the payload, or null when the frame holds no code. */
type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

/**
 * The native detector, or jsQR loaded on demand.
 *
 * jsQR needs pixels rather than a video element, so the frame is drawn to an offscreen
 * canvas first. The canvas is created once and reused: allocating one per frame at 60fps
 * produces exactly the garbage-collection pauses that make a scanner feel broken.
 */
async function buildDecoder(): Promise<FrameDecoder> {
  const native = (window as WindowWithDetector).BarcodeDetector;

  if (native) {
    const detector = new native({ formats: ["qr_code"] });
    return async (video) => {
      const found = await detector.detect(video);
      return found[0]?.rawValue?.trim() ?? null;
    };
  }

  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return async (video) => {
    if (!context || !video.videoWidth) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    // "attemptBoth" reads codes shown on a screen as well as printed ones — a demo is as
    // likely to be scanning a laptop display as a badge.
    const result = jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth",
    });
    return result?.data?.trim() ?? null;
  };
}

/**
 * Decode a QR from an image file — a screenshot, a photo, a saved code.
 *
 * The camera is not always the right instrument, and sometimes not an available one. A
 * verifier is often sent a credential as a picture: a screenshot in a chat, a photo of a
 * printed badge, a PNG in an email. Asking them to display it on a second screen and point a
 * webcam at it is theatre.
 *
 * It uses the same decoder strategy as the live scanner — the browser's own where it exists,
 * jsQR loaded on demand where it does not — because the reason the live path needed a
 * fallback (Windows Chrome ships no `BarcodeDetector`) applies identically here.
 *
 * ## Why it tries twice
 *
 * A photograph of a code is usually far larger than the code needs to be, and jsQR scans a
 * full-resolution image slowly and, on a noisy phone photo, sometimes not at all. So a failed
 * full-size read is retried on a downscaled copy, which suppresses sensor noise and often
 * succeeds where the original did not. Two attempts, then an honest "no code found" — a
 * scanner that silently gives up is indistinguishable from one that is broken.
 */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  try {
    const native = (window as WindowWithDetector).BarcodeDetector;
    if (native) {
      const detector = new native({ formats: ["qr_code"] });
      const found = await detector.detect(bitmap).catch(() => []);
      const value = found[0]?.rawValue?.trim();
      if (value) return value;
      // Fall through to jsQR rather than trusting a single detector: the native one is
      // stricter about blur than jsQR is, and a photo of a badge is usually a bit blurred.
    }

    const { default: jsQR } = await import("jsqr");

    const attempt = (maxEdge: number): string | null => {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;

      context.drawImage(bitmap, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);

      // "attemptBoth" reads a light-on-dark code as readily as the usual dark-on-light —
      // this application's own on-screen QR is the former.
      return (
        jsQR(image.data, image.width, image.height, {
          inversionAttempts: "attemptBoth",
        })?.data?.trim() ?? null
      );
    };

    return attempt(2000) ?? attempt(800);
  } finally {
    // Bitmaps hold decoded pixels; a verifier checking a dozen codes should not accumulate
    // a dozen full-resolution buffers.
    bitmap.close?.();
  }
}

export interface QrScannerProps {
  onResult: (value: string) => void;
  onClose: () => void;
}

export function QrScanner({ onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      // Explicit: a stream left running keeps the camera indicator lit, which reads as the
      // page watching you after you thought it had stopped.
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch {
        setError("Camera access was refused. Paste the credential instead.");
        return;
      }

      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      video.srcObject = stream;
      await video.play().catch(() => {});

      let decode: FrameDecoder;
      try {
        decode = await buildDecoder();
      } catch {
        setError("The QR decoder could not be loaded. Paste the credential instead.");
        stop();
        return;
      }

      if (stopped) return;

      const tick = async () => {
        if (stopped || !videoRef.current) return;

        try {
          const value = await decode(videoRef.current);
          if (value) {
            stop();
            onResult(value);
            return;
          }
        } catch {
          // A dropped frame is not an error worth surfacing; the next one usually works.
        }

        frame = requestAnimationFrame(() => void tick());
      };

      frame = requestAnimationFrame(() => void tick());
    };

    void run();
    return stop;
  }, [onResult]);

  return (
    <div className="panel p-4" data-testid="qr-scanner">
      <div className="flex items-center justify-between gap-3">
        <Status tone="neutral">Scanning</Status>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-fg-muted" data-testid="qr-error">
          {error}
        </p>
      ) : (
        <div className="relative mt-4 overflow-hidden rounded border border-line">
          <video
            ref={videoRef}
            className="aspect-video w-full bg-canvas object-cover"
            muted
            playsInline
          />
          <span
            className="pointer-events-none absolute inset-[15%] rounded border border-fg-faint"
            aria-hidden="true"
          />
        </div>
      )}

      <p className="mt-3 text-xs text-fg-faint">
        Point the camera at a credential QR code. Nothing is uploaded — decoding happens on this
        device, and only the decoded value is sent to be verified.
      </p>
    </div>
  );
}
