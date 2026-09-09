import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";

/**
 * QR scanning, via the browser's own `BarcodeDetector`.
 *
 * No dependency: a QR decoding library is 40–200 kB that most visitors never use, and
 * Chrome and Edge on Android and desktop ship a detector already. Where it is missing —
 * Safari and Firefox at time of writing — this says so plainly and the paste field beside
 * it does the same job. That is a better trade than shipping a decoder to everyone so that
 * a minority need not paste.
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

export function isQrSupported(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

export interface QrScannerProps {
  onResult: (value: string) => void;
  onClose: () => void;
}

export function QrScanner({ onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const detectorCtor = (window as WindowWithDetector).BarcodeDetector;
    if (!detectorCtor) {
      setError("This browser has no QR decoder. Paste the credential instead.");
      return;
    }

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

      const detector = new detectorCtor({ formats: ["qr_code"] });

      const tick = async () => {
        if (stopped || !videoRef.current) return;

        try {
          const found = await detector.detect(videoRef.current);
          const value = found[0]?.rawValue?.trim();
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
