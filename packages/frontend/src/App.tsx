import { env } from "./config/env";

/** Skeleton shell. Real routes and UI arrive in Phase 3. */
export default function App() {
  return (
    <main>
      <h1>TrustChain</h1>
      <p>Decentralized identity, on-chain RBAC and NFT-based asset ownership.</p>
      <p data-testid="api-url">API: {env.VITE_PUBLIC_API_URL}</p>
    </main>
  );
}
