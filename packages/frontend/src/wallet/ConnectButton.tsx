import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

import { ConnectModal } from "./ConnectModal";
import { truncateAddress } from "./config";

/**
 * Connect / connected control for the header.
 *
 * The connected state shows a truncated address rather than the full one. Not for secrecy —
 * an address is public — but because a 42-character string wrecks a header layout on a
 * phone, and the full value is available on hover and to a screen reader through the title.
 */
export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        type="button"
        className="btn btn--ghost account-chip"
        onClick={() => disconnect()}
        title={`${address} — click to disconnect`}
        data-testid="account-chip"
      >
        <span className="account-dot" aria-hidden="true" />
        <span className="mono">{truncateAddress(address)}</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => setOpen(true)}
        data-testid="connect-button"
      >
        Connect Wallet
      </button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
