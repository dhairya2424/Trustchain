import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { PrepareError, usePreparedAction } from "@/api/usePreparedAction";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { queryKeys } from "@/api/queries";
import type { OwnedAsset } from "@/api/queries";

/**
 * Handing an asset to another identity.
 *
 * The problem statement lists ownership transfer among the activities the ledger must
 * record, and `AssetRegistry` has recorded it from the start — `_update` is a single choke
 * point through which mint, transfer and reclaim all pass, and it writes `ASSET_TRANSFERRED`
 * with the receiving DID. What was missing was any way to *reach* it: the contract could
 * record a transfer the product had no way to initiate.
 *
 * ## Why the recipient is an address and the destination is an identity
 *
 * You type an address because that is what a person has. The API resolves it to that
 * address's identity and then to whatever key controls that identity *now* — so if the
 * recipient rotated their key since you last spoke, the asset still reaches them rather than
 * landing on a wallet they have abandoned. Assets follow identities here, and this is where
 * that stops being an architectural claim and becomes a thing you can watch happen.
 *
 * ## Refusals are specific on purpose
 *
 * Six different conditions make a transfer illegitimate, and the contract enforces every one
 * of them. Reporting all six as "transfer failed" would leave the user guessing at which. So
 * each has its own sentence, and the one that matters most is `stale_holder`: a key that no
 * longer controls the owning identity may not sell the asset. That is not a bug being
 * explained away — it is a rotated-out key being denied the power a stolen key would want.
 */

const REFUSALS: Record<string, string> = {
  asset_not_found: "That asset does not exist on this network.",
  not_asset_owner: "You no longer hold this asset, so there is nothing to send.",
  asset_is_soulbound:
    "This asset is soulbound. It is bound to its identity permanently and cannot be transferred — that is what soulbound means, not a restriction that can be lifted.",
  recipient_has_no_identity:
    "That address has no identity on this platform. Assets belong to identities here, so an administrator has to register one before it can receive anything.",
  recipient_identity_inactive: "That identity has been deactivated, so it cannot receive assets.",
  recipient_already_owns_asset:
    "That is the identity that already owns this asset. Moving it between two of your own keys is a reclaim, not a transfer.",
  stale_holder:
    "Your key no longer controls the identity this asset belongs to. A key in that position cannot pass the asset on — the identity's current controller has to reclaim it first.",
};

export function TransferDialog({
  token,
  open,
  onOpenChange,
}: {
  token: OwnedAsset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const run = usePreparedAction();

  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/.test(recipient.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!looksLikeAddress || busy) return;

    setBusy(true);
    setError(null);

    const toastId = toast.push({
      status: "pending",
      title: `Transferring asset #${token.tokenId}`,
      detail: "Sign the request in your wallet — the relayer pays, but the chain records you.",
    });

    try {
      const { forwarded } = await run(
        "/assets/prepare-transfer",
        { tokenId: token.tokenId, toAddress: recipient.trim() },
        REFUSALS,
      );

      toast.resolve(toastId, {
        status: "success",
        title: `Asset #${token.tokenId} transferred`,
        detail: "Ownership now belongs to the recipient's identity, recorded on-chain.",
        reference: forwarded.transactionHash,
      });

      // Re-read rather than removing the card optimistically. Ownership is the contract's to
      // state, and a card that vanishes before the transaction confirms would be claiming
      // something nobody has verified yet.
      await queryClient.invalidateQueries({ queryKey: queryKeys.ownedAssets });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });

      setRecipient("");
      onOpenChange(false);
    } catch (caught) {
      const message =
        caught instanceof PrepareError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "The transfer could not be prepared.";

      // Shown in the dialog, not only in a toast: the user is mid-task with the recipient
      // still on screen, and the fix is usually to that field.
      setError(message);
      toast.resolve(toastId, {
        status: "error",
        title: `Asset #${token.tokenId} was not transferred`,
        detail: message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="transfer-dialog">
        <DialogTitle className="text-base font-semibold">
          Transfer asset #{token.tokenId}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-sm leading-relaxed text-fg-muted">
          Ownership moves to the recipient&rsquo;s identity, not to the address you type. If they
          have rotated their key, the asset follows them to the new one.
        </DialogDescription>

        <form className="mt-5" onSubmit={submit}>
          <label className="block">
            <span className="mb-1.5 block eyebrow">Recipient address</span>
            <input
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value);
                setError(null);
              }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              className="w-full rounded border border-line bg-canvas px-3 py-2 font-mono text-sm"
              data-testid="transfer-recipient"
            />
          </label>

          {recipient.trim() !== "" && !looksLikeAddress && (
            <p className="mt-2 text-xs text-fallback" data-testid="transfer-malformed">
              An address is 0x followed by 40 hexadecimal characters.
            </p>
          )}

          {token.soulbound && (
            <p className="mt-3 text-sm text-fallback" data-testid="transfer-soulbound">
              This asset is soulbound and cannot be transferred. The contract will refuse it.
            </p>
          )}

          {error && (
            <p className="mt-3 text-sm leading-relaxed text-revoked" data-testid="transfer-error">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-3">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={!looksLikeAddress || busy || token.soulbound}
              data-testid="transfer-submit"
            >
              {busy ? "Awaiting signature…" : "Transfer"}
              {!busy && <ArrowRight className="size-3.5" aria-hidden="true" />}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
