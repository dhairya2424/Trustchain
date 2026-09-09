import { expect, test, type Page } from "@playwright/test";

/**
 * The demo journey, in a real browser.
 *
 * Landing → dashboard → admin → verifier, which is the path a judge takes. What this adds
 * over the component suite is everything jsdom cannot do: real layout and therefore real
 * layout *shift*, real focus order, real navigation, and the stylesheet actually applying.
 *
 * The API is stubbed at the network boundary with `page.route` rather than run for real.
 * That is deliberate for the parts of the journey that are about the interface: it makes
 * the suite runnable in CI with no chain, and it lets a test assert what the UI does with a
 * 403 or a 503 without having to manufacture one on-chain. The claim that the *backend*
 * behaves correctly is made by tools/e2e-flow.mjs, tools/e2e-roles.mjs and
 * tools/e2e-verify-page.mjs, which use no stubs at all.
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
  did: "did:trustchain:0xabc123",
  roles: ["ADMIN", "MANAGER"],
};

const CREDENTIAL_HASH = `0x${"a".repeat(64)}`;

const AUDIT_ENTRY = {
  entryId: 1,
  action: "ASSET_MINTED",
  actionCode: 1,
  actor: SESSION.address,
  executor: "0x1111111111111111111111111111111111111111",
  didHash: "0xdid",
  refHash: "0xref",
  via: "0x2222222222222222222222222222222222222222",
  blockNumber: 42,
  transactionHash: `0x${"3".repeat(64)}`,
  occurredAt: new Date().toISOString(),
};

/** Stubs the API. `signedIn` decides whether /auth/session answers or 401s. */
async function stubApi(page: Page, { signedIn = true }: { signedIn?: boolean } = {}) {
  await page.route("**/network", (route) => route.fulfill({ json: { active: NETWORK } }));

  await page.route("**/auth/session", (route) =>
    signedIn
      ? route.fulfill({ json: SESSION })
      : route.fulfill({ status: 401, json: { error: "unauthenticated" } }),
  );

  await page.route("**/audit**", (route) =>
    route.fulfill({ json: { entries: [AUDIT_ENTRY], nextCursor: null, source: "chain" } }),
  );

  await page.route("**/roles/**", (route) =>
    route.fulfill({ json: { address: SESSION.address, did: SESSION.did, roles: ["ADMIN"] } }),
  );

  await page.route("**/credentials/verify", (route) =>
    route.fulfill({
      json: {
        valid: true,
        status: "valid",
        credentialHash: CREDENTIAL_HASH,
        proof: {
          signatureChecked: true,
          signatureValid: true,
          issuer: "0xissuer",
          subject: "did:trustchain:subject",
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

test.describe("the demo journey", () => {
  test("landing page states the three guarantees and names the active network", async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1, name: /TrustChain/ })).toBeVisible();
    // By role, not by text: the footer names the same three concepts in a sentence, and a
    // bare text match is ambiguous between the pillar heading and that.
    await expect(page.getByRole("heading", { name: "Decentralized Identity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "On-Chain RBAC" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "NFT Asset Ownership" })).toBeVisible();

    // Never claims Amoy while running locally.
    await expect(page.getByTestId("network-badge").first()).toContainText("LOCAL HARDHAT");
    await expect(page.getByTestId("network-badge").first()).not.toContainText("POLYGON AMOY");
  });

  test("dashboard shows the signed-in identity", async ({ page }) => {
    await stubApi(page);
    await page.goto("/dashboard");

    await expect(page.getByTestId("identity-did")).toContainText("did:trustchain:0xabc123");
    await expect(page.getByTestId("identity-qr")).toBeVisible();
    await expect(page.getByTestId("activity-feed")).toBeVisible();
  });

  test("dashboard asks for a sign-in rather than showing an empty cockpit", async ({ page }) => {
    // An empty dashboard would read as "you own nothing", which is a claim about the chain
    // rather than about the session.
    await stubApi(page, { signedIn: false });
    await page.goto("/dashboard");

    await expect(page.getByTestId("signin-prompt")).toBeVisible();
    await expect(page.getByTestId("asset-grid")).toHaveCount(0);
  });

  test("admin console walks the mint wizard to its confirm step", async ({ page }) => {
    await stubApi(page);
    await page.goto("/admin/mint");

    await page.getByTestId("mint-name").fill("Turbine 4 gearbox");
    await page.getByTestId("mint-description").fill("Annual inspection record");
    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("drop-zone")).toBeVisible();

    // A real file, chosen through the real input.
    await page.getByTestId("file-input").setInputFiles({
      name: "asset.png",
      mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
    });

    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("wizard-confirm")).toBeVisible();
    await expect(page.getByTestId("wizard-confirm")).toContainText("Turbine 4 gearbox");
    // A mint is permanent, and the confirm step says so before the button is pressed.
    await expect(page.getByTestId("wizard-confirm")).toContainText("cannot be undone");
  });

  test("verifier shows AUTHENTIC in one click from a shared link", async ({ page }) => {
    // The judge path: open the link, see the verdict, having done nothing.
    await stubApi(page);
    await page.goto(`/verify?hash=${CREDENTIAL_HASH}`);

    const verdict = page.getByTestId("verdict");
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveAttribute("data-kind", "authentic");
    await expect(verdict).toContainText("AUTHENTIC");

    // Built from the response, not invented.
    await expect(page.getByTestId("provenance-timeline")).toBeVisible();
  });

  test("the verifier works with no session at all", async ({ page }) => {
    // The requirement: a credential only its issuer can check is not verifiable in any
    // useful sense.
    await stubApi(page, { signedIn: false });
    await page.goto(`/verify?hash=${CREDENTIAL_HASH}`);

    await expect(page.getByTestId("verdict")).toHaveAttribute("data-kind", "authentic");
  });
});

test.describe("navigation and keyboard", () => {
  test("the skip link is the first thing a keyboard reaches", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.keyboard.press("Tab");

    await expect(page.locator(":focus")).toContainText("Skip to content");
  });

  test("routes are reachable by keyboard and mark the current page", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.getByRole("link", { name: "Verify", exact: true }).click();

    await expect(page).toHaveURL(/\/verify$/);
    await expect(page.getByRole("link", { name: "Verify", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("layout stability", () => {
  /**
   * Zero layout shift, measured rather than asserted by eye.
   *
   * The plan asks for "skeleton loaders everywhere — zero layout shift", and this is the
   * only place that claim can actually be checked: CLS needs real layout, which jsdom does
   * not have. The budget is Google's "good" threshold; anything above it is visible as
   * content jumping under the reader's eye.
   */
  test("loading the dashboard does not shift the layout", async ({ page }) => {
    await stubApi(page);

    await page.goto("/dashboard");
    await expect(page.getByTestId("identity-did")).toBeVisible();

    const { total, sources } = await page.evaluate(
      () =>
        new Promise<{ total: number; sources: string[] }>((resolve) => {
          let total = 0;
          const sources: string[] = [];

          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & {
                value: number;
                hadRecentInput: boolean;
                sources?: { node?: Element }[];
              };

              // Shifts within 500ms of an interaction are expected and excluded from CLS.
              if (shift.hadRecentInput) continue;

              total += shift.value;

              // Recorded so a failure names what moved. A bare number tells whoever hits
              // this only that something shifted, which is the least useful half of it.
              for (const source of shift.sources ?? []) {
                sources.push(
                  `${shift.value.toFixed(4)} ${source.node?.tagName ?? "?"}.${String(
                    source.node?.className ?? "",
                  ).slice(0, 60)}`,
                );
              }
            }
          });

          observer.observe({ type: "layout-shift", buffered: true });

          setTimeout(() => {
            observer.disconnect();
            resolve({ total, sources });
          }, 1200);
        }),
    );

    expect(total, `layout shifted — sources:\n${sources.join("\n")}`).toBeLessThan(0.1);
  });
});
