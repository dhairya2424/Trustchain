/**
 * Registers the DOM matchers (`toBeInTheDocument`, `toHaveTextContent`, …) for every test
 * file, so individual tests do not each have to remember to import them.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * Unmount between tests.
 *
 * Testing Library registers this automatically only when Vitest runs with `globals: true`.
 * This project runs with globals off — imports are explicit everywhere else — so without
 * this the previous test's tree stays in the document and the next `getByTestId` fails with
 * "Found multiple elements", which reads as a duplicate-render bug in the component rather
 * than as leftover state.
 *
 * It also matters for correctness beyond the query: an unmounted component's effects are
 * torn down here, so timers and media-query listeners do not keep firing into a DOM that
 * the next test is trying to use.
 */
afterEach(() => {
  cleanup();
});

/*
 * jsdom implements no canvas at all, and calling getContext prints a "Not implemented"
 * warning per call through its virtual console — enough noise to bury a real failure.
 *
 * Returning null is not a workaround but an accurate model: jsdom genuinely cannot provide
 * a context, and null is exactly what a browser returns when it will not give one. Both
 * hero renderers already handle that, so this exercises the fallback path rather than
 * hiding it.
 */
HTMLCanvasElement.prototype.getContext = () => null;

/*
 * jsdom implements no PointerEvent, and Radix's dismissable layer listens for `pointerdown`
 * to close a dialog on an outside press. Without this the event dispatched by a test is a
 * plain Event that Radix ignores, and the outside-press behaviour looks broken when it is
 * only untestable.
 *
 * A minimal subclass of MouseEvent is enough: the properties Radix reads are the ones
 * MouseEvent already provides, plus pointerType.
 */
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }

  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  globalThis.PointerEvent = window.PointerEvent;
}

// Radix calls these on the element it is about to trap focus in; jsdom has neither.
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}
