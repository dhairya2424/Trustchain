#!/usr/bin/env node
/**
 * One-shot migration: make the four action contracts ERC-2771 aware.
 *
 *   node tools/add-erc2771.mjs
 *
 * Applied once and kept in the repository so the change is reviewable as a transformation
 * rather than as four large hand-edited diffs. It is idempotent — re-running it on an
 * already-migrated file is a no-op — so it can be checked rather than trusted.
 *
 * What it does, per contract:
 *
 *   1. imports ERC2771ContextUpgradeable
 *   2. adds it to the inheritance list
 *   3. gives the constructor a trustedForwarder argument
 *   4. rewrites `msg.sender` to `_msgSender()` in authorization and attribution
 *   5. passes `_msgSender()` to the audit trail as the actor
 *   6. adds the Context/ERC2771Context override trio Solidity requires
 *
 * Step 4 is the substantive one. Under ERC-2771 `_msgSender()` is the address that SIGNED
 * the request, so every permission check moves from "may the relayer do this?" to "may the
 * requester do this?" — which is what the checks were always meant to ask.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Which Context-providing bases each contract already inherits, for the override list. */
const TARGETS = [
  {
    file: "contracts/access/RoleAccessControl.sol",
    contract: "RoleAccessControl",
    bases: ["ContextUpgradeable"],
    declaration:
      "contract RoleAccessControl is Initializable, AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable {",
    newDeclaration:
      "contract RoleAccessControl is\n" +
      "    Initializable,\n" +
      "    AccessControlDefaultAdminRulesUpgradeable,\n" +
      "    ERC2771ContextUpgradeable,\n" +
      "    UUPSUpgradeable\n" +
      "{",
  },
  {
    file: "contracts/identity/DIDRegistry.sol",
    contract: "DIDRegistry",
    bases: ["ContextUpgradeable"],
  },
  {
    file: "contracts/assets/AssetRegistry.sol",
    contract: "AssetRegistry",
    bases: ["ContextUpgradeable"],
  },
  {
    file: "contracts/credentials/CredentialRegistry.sol",
    contract: "CredentialRegistry",
    bases: ["ContextUpgradeable"],
    declaration:
      "contract CredentialRegistry is Initializable, PausableUpgradeable, UUPSUpgradeable {",
    newDeclaration:
      "contract CredentialRegistry is\n" +
      "    Initializable,\n" +
      "    PausableUpgradeable,\n" +
      "    ERC2771ContextUpgradeable,\n" +
      "    UUPSUpgradeable\n" +
      "{",
  },
];

const IMPORT =
  "import {ERC2771ContextUpgradeable} from " +
  '"@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";\n' +
  'import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";\n';

const OVERRIDES = `
    // ---------------------------------------------------------------------
    // ERC-2771 context
    // ---------------------------------------------------------------------

    /**
     * @dev Resolves the request's originator.
     *
     * When the call arrives through the trusted forwarder this is the address that SIGNED
     * the request; otherwise it is \`msg.sender\` unchanged, so direct calls behave exactly
     * as before. Every authorization check and every audit entry in this contract reads
     * from here, which is what makes them attribute to the requester rather than to the
     * relayer that paid for gas.
     */
    function _msgSender()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (address)
    {
        return ERC2771ContextUpgradeable._msgSender();
    }

    function _msgData()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (bytes calldata)
    {
        return ERC2771ContextUpgradeable._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (uint256)
    {
        return ERC2771ContextUpgradeable._contextSuffixLength();
    }
`;

function migrate(target) {
  const full = path.join(root, target.file);
  let source = readFileSync(full, "utf8");

  if (source.includes("ERC2771ContextUpgradeable")) {
    console.log(`  ${target.contract}: already migrated`);
    return;
  }

  // 1 — import, placed after the last existing import.
  const lastImport = source.lastIndexOf("import {");
  const endOfLastImport = source.indexOf("\n", source.indexOf(";", lastImport)) + 1;
  source = source.slice(0, endOfLastImport) + IMPORT + source.slice(endOfLastImport);

  // 2 — inheritance list.
  if (target.declaration) {
    source = source.replace(target.declaration, target.newDeclaration);
  } else {
    // Multi-line declaration: insert before the UUPS base, keeping the existing order.
    source = source.replace(
      /\n(\s*)UUPSUpgradeable\n\{/,
      "\n$1ERC2771ContextUpgradeable,\n$1UUPSUpgradeable\n{",
    );
  }

  // 3 — constructor takes the forwarder.
  source = source.replace(
    /constructor\(\)\s*\{\s*_disableInitializers\(\);\s*\}/,
    "constructor(\n        address trustedForwarder\n    ) ERC2771ContextUpgradeable(trustedForwarder) {\n        _disableInitializers();\n    }",
  );

  // 4 — authorization and attribution read the request's originator.
  source = source.replace(/\bmsg\.sender\b/g, "_msgSender()");

  // 5 — the audit trail records that originator as the actor.
  source = source.replace(
    /auditTrail\.logAction\(didHash, actionCode, refHash\)/,
    "auditTrail.logAction(didHash, actionCode, refHash, _msgSender())",
  );

  // 6 — override trio, inserted before the final closing brace.
  const lastBrace = source.lastIndexOf("}");
  source = source.slice(0, lastBrace) + OVERRIDES + source.slice(lastBrace);

  writeFileSync(full, source);
  console.log(`  ${target.contract}: migrated`);
}

console.log("ERC-2771 migration");
for (const target of TARGETS) migrate(target);
