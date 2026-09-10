import { expect, test, type Page } from "@playwright/test";

/**
 * A page that has navigated must be a page you can see.
 *
 * This covers a reported black screen: moving from Home to Dashboard or Admin sometimes left
 * the route changed, the content complete and correct in the DOM, and the screen blank until
 * a full reload.
 *
 * The cause was `AnimatePresence mode="wait"`. The incoming page mounted holding a hidden
 * `initial` state and waited for the outgoing page's exit to finish; when a second navigation
 * began while an exit was still in flight, presence bookkeeping mislabelled the arriving child
 * as outgoing and animated it to `opacity: 0` — a state nothing would animate it back from.
 * The failing element carried the exit's own inline styles, which is what identified it.
 *
 * Two clicks in quick succession is all it takes, so the rapid case below is the point of the
 * spec rather than an edge case bolted on. The general rule it enforces is the one the scroll
 * reveal broke too: content must never depend on an animation running in order to be visible.
 */

const ROUTES = ["Home", "Dashboard", "Admin", "Verify"] as const;

/** What the route wrapper actually looks like right now. */
async function pageState(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("#main");
    const wrapper = main?.firstElementChild;
    const styles = wrapper ? getComputedStyle(wrapper) : null;
    return {
      path: location.pathname,
      chars: main ? (main as HTMLElement).innerText.trim().length : -1,
      opacity: styles ? Number(styles.opacity) : -1,
      inline: wrapper?.getAttribute("style") ?? "",
    };
  });
}

async function expectVisible(page: Page, label: string) {
  const state = await pageState(page);
  expect(state.chars, `${label}: page rendered no text`).toBeGreaterThan(0);
  // The specific failure: present, correct, and invisible.
  expect(state.opacity, `${label}: wrapper is transparent — inline "${state.inline}"`).toBe(1);
}

test.describe("route changes land visible", () => {
  test("every route is visible after an ordinary click", async ({ page }) => {
    await page.goto("/");

    for (const name of ROUTES) {
      await page.getByRole("link", { name, exact: true }).first().click();
      await page.waitForTimeout(500);
      await expectVisible(page, `after clicking ${name}`);
    }
  });

  test("a second click during the first transition does not blank the page", async ({ page }) => {
    // The reproduction. Navigating again before the previous transition settles is what
    // stranded the arriving page, and it is something people do constantly.
    await page.goto("/");

    for (let i = 0; i < 8; i += 1) {
      await page.getByRole("link", { name: "Home", exact: true }).first().click();
      await page.waitForTimeout(40);
      await page.getByRole("link", { name: "Dashboard", exact: true }).first().click();
      await page.waitForTimeout(400);
      await expectVisible(page, `rapid pass ${i + 1} → Dashboard`);

      await page.getByRole("link", { name: "Admin", exact: true }).first().click();
      await page.waitForTimeout(40);
      await page.getByRole("link", { name: "Verify", exact: true }).first().click();
      await page.waitForTimeout(400);
      await expectVisible(page, `rapid pass ${i + 1} → Verify`);
    }
  });

  test("no script owns the route wrapper's visibility", async ({ page }) => {
    /*
     * The deterministic guard, and the one that matters most.
     *
     * The behavioural test above is probabilistic — the original fault appeared on roughly
     * one navigation in thirty, so a regression could slip past a fixed number of clicks.
     * This asserts the property that made the fault possible instead of waiting to observe
     * it: the wrapper must carry no inline `opacity` or `transform`.
     *
     * Framer writes both inline on every element it animates, so any return to an
     * AnimatePresence-driven transition here fails this immediately rather than one run in
     * three. Visibility belongs to CSS, whose resting state is visible.
     */
    await page.goto("/");

    for (const name of ROUTES) {
      await page.getByRole("link", { name, exact: true }).first().click();
      await page.waitForTimeout(300);

      const inline = await page.evaluate(
        () => document.querySelector("#main")?.firstElementChild?.getAttribute("style") ?? "",
      );

      expect(
        inline,
        `${name}: something is writing inline styles on the route wrapper`,
      ).not.toMatch(/opacity|transform/);
    }
  });

  test("the entrance still animates rather than being deleted", async ({ page }) => {
    // Guards the other direction. Making pages visible by removing the transition entirely
    // would pass every assertion above and quietly cost the app its one navigation gesture.
    await page.goto("/");
    await page.getByRole("link", { name: "Dashboard", exact: true }).first().click();

    const animation = await page.evaluate(() => {
      const wrapper = document.querySelector("#main")?.firstElementChild;
      if (!wrapper) return null;
      const styles = getComputedStyle(wrapper);
      return { name: styles.animationName, duration: styles.animationDuration };
    });

    expect(animation?.name).toBe("page-enter");
    expect(animation?.duration).not.toBe("0s");
  });

  test("reduced motion swaps instantly, with no animation to miss", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");

    await page.getByRole("link", { name: "Admin", exact: true }).first().click();
    await page.waitForTimeout(300);
    await expectVisible(page, "reduced motion → Admin");

    const name = await page.evaluate(() => {
      const wrapper = document.querySelector("#main")?.firstElementChild;
      return wrapper ? getComputedStyle(wrapper).animationName : null;
    });
    expect(name).toBe("none");

    await context.close();
  });
});
