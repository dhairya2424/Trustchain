import { env } from "./config/env";
import { NetworkBadge } from "./components/NetworkBadge";

/** Skeleton shell. Real routes and UI arrive in Phase 3. */
export default function App() {
  return (
    <main>
      <h1>TrustChain</h1>
      <p>Decentralized identity, on-chain RBAC and NFT-based asset ownership.</p>
      {/*
        The active network is shown on every screen, not tucked into a settings page: it
        determines whether anything recorded here can be independently verified, and a user
        should never have to go looking for that.
      */}
      <NetworkBadge />
      <p data-testid="api-url">API: {env.VITE_PUBLIC_API_URL}</p>
    </main>
  );
}
