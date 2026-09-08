import { Placeholder } from "./Placeholder";

/**
 * The last scaffold route.
 *
 * Dashboard (P3.2) and Admin (P3.3) have both become real pages reading real data; only
 * public credential verification is still waiting on its phase.
 */

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
