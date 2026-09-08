import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

import { Button } from "@/components/ui/button";
import { truncateAddress } from "@/lib/utils";
import { ConnectModal } from "./ConnectModal";

/**
 * Connect / connected control for the header.
 *
 * The connected state shows a truncated address in monospace with tabular figures, so the
 * chip does not change width as the characters change. Truncation is for layout, not
 * secrecy — an address is public — and the full value stays available through the title.
 */
export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => disconnect()}
        title={`${address} — click to disconnect`}
        data-testid="account-chip"
        className="gap-2"
      >
        <span className="size-1.5 rounded-full bg-verified" aria-hidden="true" />
        <span className="font-mono tabular text-[13px]">{truncateAddress(address)}</span>
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="connect-button">
        Connect Wallet
      </Button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
