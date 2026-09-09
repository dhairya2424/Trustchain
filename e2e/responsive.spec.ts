import { expect, test, type Page } from "@playwright/test";

/**
 * Responsive integrity, measured rather than eyeballed.
 *
 * The failure this catches is horizontal overflow: one element wider than the viewport
 * makes the whole page scroll sideways, and on a phone that turns every vertical swipe into
 * a fight. It is invisible on a desktop browser at any width, so it survives review and
 * ships.
 *
 * Long unbroken strings are the usual cause here specifically — this product is full of
 * addresses, hashes and DIDs, none of which contain a natural break opportunity.
 */

const NETWORK = {
  id: "hardhat",
  label: "LOCAL HARDHAT",
  chainId: 31337,
  verifiability: "local",
  verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
  explorerUrl: null,
  isPrimary: false,
  isFallback: true,
};

const SESSION = {
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  // Deliberately long and unbroken, because that is what stresses the layout — but not
  // hex-shaped, so the secret scanner does not have to guess whether it is a key.
  did: "did:trustchain:zQmVeryLongIdentifierWithNoBreakOpportunitiesWhatsoeverForWrapping",
  roles: ["ADMIN", "MANAGER"],
};

const HASH = `0x${"a".repeat(64)}`;

async function stubApi(page: Page) {
  await page.route("**/network", (route) => route.fulfill({ json: { active: NETWORK } }));
  await page.route("**/auth/session", (route) => route.fulfill({ json: SESSION }));
  await page.route("**/audit**", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            entryId: 1,
            action: "ASSET_MINTED",
            actionCode: 1,
            actor: SESSION.address,
            executor: "0x1111111111111111111111111111111111111111",
            didHash: HASH,
            refHash: HASH,
            via: "0x2222222222222222222222222222222222222222",
            blockNumber: 42,
            transactionHash: HASH,
            occurredAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
        source: "chain",
      },
    }),
  );
  await page.route("**/credentials/verify", (route) =>
    route.fulfill({
      json: {
        valid: true,
        status: "valid",
        credentialHash: HASH,
        proof: {
          signatureChecked: true,
          signatureValid: true,
          issuer: SESSION.address,
          subject: SESSION.did,
          type: ["ProofOfInspection"],
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          revokedAt: null,
          revocationReason: null,
        },
      },
    }),
  );
}

/** The narrowest phone still worth supporting. */
const PHONE = { width: 375, height: 812 };

const ROUTES = ["/", "/dashboard", "/admin", "/admin/mint", "/admin/roles", `/verify?hash=${HASH}`];

test.describe("no horizontal overflow on a phone", () => {
  for (const route of ROUTES) {
    test(`${route} fits 375px`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await stubApi(page);
      await page.goto(route);

      // Wait for the page to have settled, so this measures the loaded layout rather than
      // a skeleton that happens to fit.
      //
      // Deliberately not the network badge: it is `hidden lg:inline-flex` in the header, so
      // on a phone it never becomes visible and waiting on it would time out before the
      // overflow was ever measured — which is exactly what happened the first time.
      await page.waitForLoadState("networkidle");
      await expect(page.locator("#main")).toBeVisible();

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        if (doc.scrollWidth <= doc.clientWidth) return null;

        // Name the widest offender rather than only reporting that something overflowed.
        let worst: { tag: string; cls: string; right: number } | null = null;
        for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
          const right = element.getBoundingClientRect().right;
          if (right <= doc.clientWidth + 1) continue;
          if (!worst || right > worst.right) {
            worst = {
              tag: element.tagName,
              cls: String(element.className).slice(0, 80),
              right,
            };
          }
        }

        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, worst };
      });

      expect(
        overflow,
        overflow
          ? `page scrolls sideways: ${overflow.scrollWidth}px in a ${overflow.clientWidth}px viewport.\n` +
              `widest offender: ${overflow.worst?.tag}.${overflow.worst?.cls}`
          : "",
      ).toBeNull();
    });
  }
});

test.describe("the header survives a narrow viewport", () => {
  test("navigation stays reachable at 375px", async ({ page }) => {
    // The nav wraps to its own row below `sm`. It must still be there and still be
    // tappable — a nav that wraps off-screen is worse than one that scrolls.
    await page.setViewportSize(PHONE);
    await stubApi(page);
    await page.goto("/");

    const verify = page.getByRole("link", { name: "Verify", exact: true });
    await expect(verify).toBeVisible();

    const box = await verify.boundingBox();
    expect(box).not.toBeNull();
    // 24px is well below the 44px target, but the row is scrollable — this asserts the
    // link is genuinely laid out rather than collapsed to nothing.
    expect(box!.height).toBeGreaterThan(24);
  });
});
