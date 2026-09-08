import { describe, expect, it } from "vitest";

import { selectRenderer, type DeviceCapabilities } from "./selectRenderer";

/**
 * Which hero a device gets.
 *
 * These are the cases that decide whether the landing page is a pleasure or a hot phone,
 * and every one of them is impractical to reproduce in a real browser during a test run —
 * which is exactly why the decision was extracted into a pure function.
 */

const capable: DeviceCapabilities = {
  reducedMotion: false,
  webgl: true,
  cores: 8,
  memoryGb: 8,
  saveData: false,
  connection: "4g",
};

describe("selectRenderer", () => {
  it("gives a capable machine the full particle network", () => {
    expect(selectRenderer(capable)).toBe("webgl");
  });

  it("gives a reduced-motion visitor no animation loop at all", () => {
    // Not a cheaper animation — none. The preference is about motion, not performance.
    expect(selectRenderer({ ...capable, reducedMotion: true })).toBe("static");
  });

  it("prefers the reduced-motion setting over every capability signal", () => {
    // Checked first, so a top-end machine still gets the still frame if asked.
    expect(selectRenderer({ ...capable, reducedMotion: true, cores: 32, memoryGb: 64 })).toBe(
      "static",
    );
  });

  it("falls back to 2D when WebGL cannot be created", () => {
    expect(selectRenderer({ ...capable, webgl: false })).toBe("canvas2d");
  });

  it("honours data saver as a request rather than weighing it as a hint", () => {
    expect(selectRenderer({ ...capable, saveData: true })).toBe("canvas2d");
  });

  it("steps down on a slow connection", () => {
    expect(selectRenderer({ ...capable, connection: "2g" })).toBe("canvas2d");
    expect(selectRenderer({ ...capable, connection: "3g" })).toBe("canvas2d");
  });

  it("keeps the full renderer on 4g", () => {
    expect(selectRenderer({ ...capable, connection: "4g" })).toBe("webgl");
  });

  it("steps down on a low core count", () => {
    expect(selectRenderer({ ...capable, cores: 2 })).toBe("canvas2d");
  });

  it("steps down on a low memory report", () => {
    expect(selectRenderer({ ...capable, memoryGb: 2 })).toBe("canvas2d");
  });

  it("does not penalise a browser that reports no hints", () => {
    // Safari and Firefox report neither value. Treating absence as failure would downgrade
    // a large share of perfectly capable machines for a privacy decision.
    expect(
      selectRenderer({
        reducedMotion: false,
        webgl: true,
        cores: undefined,
        memoryGb: undefined,
        saveData: undefined,
        connection: undefined,
      }),
    ).toBe("webgl");
  });

  it("accepts a machine exactly at the thresholds", () => {
    expect(selectRenderer({ ...capable, cores: 4, memoryGb: 4 })).toBe("webgl");
  });
});
