import { Placeholder } from "./Placeholder";

/**
 * The three authenticated and utility routes beyond the landing page.
 *
 * Kept together because they are currently the same component with different copy. They
 * split into real pages as each phase lands, and doing that split now would be three files
 * of ceremony around no behaviour.
 */

export function Dashboard() {
  return (
    <Placeholder
      phase="Phase 3.2"
      title="Dashboard"
      lead="Your identity, your assets, and what you are permitted to do with them."
      requiresWallet
      contents={[
        "Your DID and its on-chain anchor, with the roles currently granted to your address",
        "Assets you own, read from the token contract with provenance from the audit trail",
        "Credentials issued to you, and their live revocation status",
        "Actions you are authorized to take, derived from on-chain permissions rather than from a UI flag",
      ]}
    />
  );
}

export function Admin() {
  return (
    <Placeholder
      phase="Phase 3.3"
      title="Administration"
      lead="Role management and the audit trail, for ADMIN and AUDITOR."
      requiresWallet
      contents={[
        "Grant and revoke ADMIN, MANAGER, AUDITOR and USER, each a transaction you sign",
        "The audit trail with filtering by actor, action and date, paginated by cursor",
        "CSV export, itself an audited action available only to ADMIN",
        "Live network status, including whether writes are landing on Amoy or the local fallback",
      ]}
    />
  );
}

export function Verify() {
  return (
    <Placeholder
      phase="Phase 3.4"
      title="Verify a credential"
      lead="Public. No wallet, no account, no sign-in — anyone can check a credential against the chain."
      contents={[
        "Paste a credential or its hash and see whether it is valid, expired or revoked",
        "The issuer's DID and the on-chain anchor the proof is checked against",
        "The exact block and transaction that recorded it, linked to a public explorer when running on Amoy",
      ]}
    />
  );
}
