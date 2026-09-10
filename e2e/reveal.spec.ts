import { expect, test } from "@playwright/test";

/**
 * Scroll-revealed content must never be content that stays hidden.
 *
 * `useScrollReveal` animates sections in as they enter the viewport, and it does that by
 * setting `opacity: 0` at load and animating back to 1 when ScrollTrigger fires. The hook was
 * already careful about two ways that leaves a blank page — reduced motion, and a failed GSAP
 * import — but not about the third, which is the trigger simply never firing.
 *
 * That case is ordinary rather than exotic. A visitor who lands and reads without scrolling
 * sat looking at three empty rows indefinitely: measured at four seconds, every row was still
 * at `opacity: 0`. The same gap swallows print, PDF export, page capture, an in-page anchor
 * jump and find-in-page, none of which produce the scroll event the reveal was waiting for.
 *
 * These tests pin the guarantee from both ends: the content appears whether or not anyone
 * scrolls, and scrolling still plays the animation rather than finding it already finished.
 *
 * Playwright rather than jsdom deliberately — this is a scroll-position behaviour driven by a
 * real layout, and a jsdom test of it would assert the mock rather than the mechanism.
 */

const ROWS = ".flow-row";

/** Computed opacity of every revealed row, in document order. */
async function opacities(page: import("@playwright/test").Page): Promise<number[]> {
  return page.$$eval(ROWS, (nodes) => nodes.map((n) => Number(getComputedStyle(n).opacity)));
}

test.describe("content revealed on scroll", () => {
  test("appears even when the visitor never scrolls", async ({ page }) => {
    await page.goto("/");

    // Long enough for the hook's own safety net to give up on the trigger. If this ever
    // fails, the landing page is blank below the fold for anyone who does not scroll.
    await expect
      .poll(async () => (await opacities(page)).every((o) => o === 1), { timeout: 10_000 })
      .toBe(true);

    const rows = await opacities(page);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("still animates for a visitor who does scroll", async ({ page }) => {
    await page.goto("/");

    // Caught early, before the safety net could have fired: the rows start hidden, which is
    // what makes the reveal a reveal. Asserting this stops a future "fix" from deleting the
    // animation altogether and calling the first test passed.
    const atLoad = await opacities(page);
    expect(atLoad.some((o) => o < 1)).toBe(true);

    await page.mouse.wheel(0, 2400);

    await expect
      .poll(async () => (await opacities(page)).every((o) => o === 1), { timeout: 10_000 })
      .toBe(true);
  });

  test("ships visible under reduced motion, with nothing to undo", async ({ browser }) => {
    // The hook returns early here, so the hidden state is never applied at all. Someone who
    // asked the system to stop moving things gets the content immediately, not eventually.
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator(ROWS).first()).toBeVisible();
    expect((await opacities(page)).every((o) => o === 1)).toBe(true);

    await context.close();
  });
});
