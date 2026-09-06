/**
 * Renders the Defender Monitor definitions for a deployed network.
 *
 *   npx hardhat run scripts/defenderRegister.ts --network amoy
 *
 * The deterministic half of Defender setup is address substitution, and that is exactly
 * where a copy-paste mistake produces a monitor that watches nothing and stays silent
 * forever. So this script does that part from deployments/{network}.json and refuses to
 * emit anything with an unresolved placeholder.
 *
 * The credentialed half — creating the Action and Monitors in Defender — is a runbook
 * step in docs/DEPLOY.md. It needs a team API key that must never live in this repo, and
 * an operator who can confirm the alert actually arrives.
 */
import { network } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RenderResult {
  rendered: unknown;
  unresolved: string[];
}

/**
 * Replaces every `${ContractName}` placeholder with its deployed address.
 * Exported so the substitution can be tested without Defender credentials.
 */
export function renderMonitors(
  template: unknown,
  contracts: Record<string, { address: string }>,
): RenderResult {
  const unresolved: string[] = [];

  const serialised = JSON.stringify(template).replace(
    /\$\{([A-Za-z0-9_]+)\}/g,
    (_match, name: string) => {
      const address = contracts[name]?.address;
      if (!address) {
        unresolved.push(name);
        return `\${${name}}`;
      }
      return address;
    },
  );

  return { rendered: JSON.parse(serialised), unresolved };
}

async function main(): Promise<void> {
  const deploymentFile = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(deploymentFile)) {
    throw new Error(`no deployment record at deployments/${network.name}.json — deploy first`);
  }

  const templateFile = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "infra",
    "defender",
    "sentinel-role-and-mint.json",
  );
  if (!existsSync(templateFile)) throw new Error(`monitor template missing at ${templateFile}`);

  const record = JSON.parse(readFileSync(deploymentFile, "utf8"));
  const template = JSON.parse(readFileSync(templateFile, "utf8"));

  const { rendered, unresolved } = renderMonitors(template, record.contracts);

  if (unresolved.length > 0) {
    throw new Error(
      `unresolved contract placeholders: ${[...new Set(unresolved)].join(", ")}. ` +
        `A monitor pointed at a placeholder watches nothing and would never alert.`,
    );
  }

  const outDir = path.join(__dirname, "..", "..", "..", "infra", "defender", "generated");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.monitors.json`);
  writeFileSync(outFile, `${JSON.stringify(rendered, null, 2)}\n`);

  console.log(
    `monitors rendered for ${network.name} -> infra/defender/generated/${network.name}.monitors.json\n`,
  );
  console.log("Next, in Defender (see docs/DEPLOY.md step 6):");
  console.log("  1. Create an Action from infra/defender/action-alert.js");
  console.log("  2. Add secret ALERT_WEBHOOK_URL to that Action");
  console.log("  3. Create the Monitors from the generated file, each notifying the Action");
  console.log("  4. Fire a test event and confirm the alert actually arrives");
}

const invokedDirectly = require.main === module;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
