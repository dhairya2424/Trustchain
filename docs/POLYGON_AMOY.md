# Polygon Amoy: what to do, and what everyone sees

This is the practical guide. It answers two questions:

1. **What do I actually do** to put TrustChain on Polygon Amoy?
2. **Once it is there, what changes** for a visitor, a user, an auditor, a manager and an
   admin?

It is deliberately the simple document. The deeper references are:

| Document                     | Answers                                                   |
| ---------------------------- | --------------------------------------------------------- |
| [NETWORKS.md](./NETWORKS.md) | How the platform decides which chain to use               |
| [RELAYER.md](./RELAYER.md)   | How the signing service works and where its key lives     |
| [DEPLOY.md](./DEPLOY.md)     | The full production runbook, including the admin handover |

---

## 0. Why Amoy at all

Everything the platform does works on the local Hardhat chain. So why bother?

**Because "verifiable" only means something if a stranger can do the verifying.**

On the local chain, a verifier who checks a credential is trusting _our server_ to report
what _our chain_ says. Both are ours. The claim "this credential is genuine" reduces to
"we say so", which is precisely the centralized-database problem the whole project exists
to replace.

On Amoy, the record is on a public testnet. A verifier can open
[amoy.polygonscan.com](https://amoy.polygonscan.com), find the transaction, and read the
event themselves — without our API, without our permission, and without trusting us at
all. Nothing else about the product changes. That single difference is the point.

The platform never blurs the two. Every screen and every API response says which chain it
is on and what that chain is worth:

| Network       | Label           | What we claim                                 |
| ------------- | --------------- | --------------------------------------------- |
| Polygon Amoy  | `POLYGON AMOY`  | `Public Testnet / Publicly Verifiable`        |
| Local Hardhat | `LOCAL HARDHAT` | `Local Development/Demo / Locally Verifiable` |

---

## 1. Where the system is right now

Ask it. The backend reports its own state honestly:

```bash
curl -s http://localhost:4000/network | jq '.candidates[] | {id, usable, checks}'
```

At the time of writing, the real answer is:

```
[amoy]    usable=false   chainId=80002
   PASS  rpc        — reachable, chain id 80002
   FAIL  contracts  — no deployment record at amoy.json

[hardhat] usable=true    chainId=31337
   PASS  rpc        — reachable, chain id 31337
   PASS  contracts  — all 6 contracts have bytecode
   PASS  relayer    — signer 0x29da…234a
   PASS  balance    — signer holds 9.998361
```

Read that carefully, because it is the whole to-do list:

- **The Amoy RPC already works.** The endpoint answers and reports chain id 80002. The
  connection is configured correctly.
- **The contracts are not deployed there.** That is the only thing standing between the
  platform and a public testnet.

So the work below is not "integrate Amoy". The integration is done. The work is
**deploy, delegate, and fund**.

---

## 2. The four gates

Before the platform will use a network, four things must be true. They are checked in
order, and the first failure stops the rest — which is why the report above shows nothing
about Amoy's relayer or balance yet.

| #   | Gate          | Plain meaning                                             | Fails when                            |
| --- | ------------- | --------------------------------------------------------- | ------------------------------------- |
| 1   | **rpc**       | The endpoint answers and is really chain 80002            | Wrong URL, dead key, wrong network    |
| 2   | **contracts** | All six contracts have **real bytecode** at their address | Never deployed, or deployed elsewhere |
| 3   | **relayer**   | The signing service has an Amoy relayer with an address   | Relayer not configured for Amoy       |
| 4   | **balance**   | That signer holds ≥ 0.02 POL                              | Nobody has visited the faucet         |

Two of these are worth understanding rather than just satisfying.

**Gate 2 checks bytecode, not the deployment file.** A deployment record is a file on
disk. It survives `hardhat node` restarting, which wipes the chain entirely. Trusting the
file would mean confidently sending transactions to an address where nothing lives. So the
check asks the chain.

**Gate 4 exists because "configured" ≠ "usable".** An unfunded signer is the normal state
until someone visits a faucet. Without this gate the platform would select Amoy, accept a
user's request, and only fail at the final step — after the user believed it had worked.
Failing over cleanly _before_ accepting the request is the honest behaviour.

---

## 3. What to do

### Prerequisites

You need three things. None of them go in source code, ever.

| Thing           | Where it goes             | How to get it                                                  |
| --------------- | ------------------------- | -------------------------------------------------------------- |
| An Amoy RPC URL | `packages/contracts/.env` | Alchemy / Infura / any Amoy provider                           |
| A deployer key  | `packages/contracts/.env` | Generated locally — see below                                  |
| Test POL        | The faucet                | [faucet.polygon.technology](https://faucet.polygon.technology) |

> **Secrets rule, without exception.** Real values live only in gitignored `.env` files.
> `.env.example` gets placeholders only. Never paste a private key into a chat, a ticket,
> or a commit. `npm run security:secrets` fails the build if a real-looking credential
> reaches a tracked file.

Generate the deployer key locally so it never travels:

```bash
node tools/gen-deployer-key.mjs     # writes to packages/contracts/.env, prints only the address
```

### Step 1 — Deploy the contracts

```bash
npm run deploy:amoy --workspace @trustchain/contracts
```

This writes `packages/contracts/deployments/amoy.json` — the record gate 2 looks for, and
whose bytecode it then confirms on chain.

### Step 2 — Verify the source on Polygonscan

```bash
npm run verify:amoy --workspace @trustchain/contracts
```

Skipping this still leaves a working system, but it defeats the purpose. Unverified
contracts are bytecode a stranger cannot read — they would have to trust your description
of what the code does, which puts you right back where you started.

### Step 3 — Point the relayer at Amoy

The relayer is a separate service that pays gas and submits transactions. Its signing key
lives inside that service and is declared in `infra/relayer/config.json` — never in the
application, and never in `.env`.

Follow [RELAYER.md §4](./RELAYER.md), which renders the config with the Amoy RPC URL
injected and prints the relayer's **signer address**. Copy that address; the next two steps
both need it.

### Step 4 — Fund the signer

Send test POL to the signer address from Step 3 using the
[Polygon faucet](https://faucet.polygon.technology). The floor is 0.02 POL; ask for more,
because a signer that runs dry mid-demo fails every write at once.

### Step 5 — Give the signer the MANAGER role, and seed

```bash
npm run seed:amoy --workspace @trustchain/contracts
```

This is the step people forget, and the failure it causes is confusing rather than
obvious: the relayer will submit transactions perfectly happily and the _contract_ will
reject them, because paying for a transaction is not the same as being allowed to perform
it. See §5 — that separation is a security property, not an inconvenience.

### Step 6 — Confirm the switch

Selection is cached for 60 seconds, so the platform will adopt Amoy on its own. To not
wait:

```bash
curl -X POST http://localhost:4000/network/refresh
curl -s http://localhost:4000/network | jq '.active.label'
```

You want `"POLYGON AMOY"`. The badge in the UI header changes to match, the amber
_Fallback_ sentence disappears, and every transaction hash becomes a Polygonscan link.

**There is no code change and no redeploy of the app.** The switch is a property of the
environment, discovered by probing.

---

## 4. What each person experiences

This is the part worth reading before a demo. The short version: **the workflow is
identical on both chains — what changes is whether an outsider can independently check the
result.**

### Anonymous visitor / verifier — _no account, no wallet, no sign-in_

The most important role, and the one with the least friction.

|                              | On Hardhat              | On Amoy                         |
| ---------------------------- | ----------------------- | ------------------------------- |
| Open `/verify`, paste a hash | Works                   | Works                           |
| Get a verdict                | Works                   | Works                           |
| **Check it themselves**      | ✗ Must trust our server | ✓ Polygonscan link, independent |

The verifier pastes a credential hash (or scans a QR code) and gets one of five verdicts:
**authentic**, **tampered**, **revoked**, **expired**, or **unregistered**. The page states
exactly what it did and did not check — pasting a bare hash checks the chain record, while
pasting the full credential also checks its signature, and the UI says which one happened
rather than implying both.

On Amoy the proof panel carries a live explorer link. That link is the entire product
claim: the verifier stops taking our word for it. A shared verification link re-runs the
check against the chain when opened — it carries the question, never a cached answer.

### A user holding an identity — the `USER` role

Connects a wallet and signs in with SIWE (Sign-In With Ethereum). No password exists.

Their dashboard shows their DID, the roles they hold, their credentials and their assets.
On Amoy, each record links to Polygonscan.

Two guarantees hold on both chains and are worth stating plainly to a judge:

- **Their key never leaves their device.** The platform never asks for it. It asks for a
  _signature_, which proves control of the key without revealing it.
- **No personal data is ever written to the chain.** Only hashes and commitments — values
  that prove a claim without disclosing it. A public testnet makes this rule matter more,
  not less: on Amoy, anything written is permanently readable by everyone. So nothing
  personal is written.

### An auditor — the `AUDITOR` role

Reads the audit trail: every grant, revocation, mint and issuance, each one an on-chain
event.

Each entry names **two** parties, and the distinction is the subtle part:

- **actor** — the identity that asked for the action
- **executor** — the address that submitted and paid for it (the relayer)

Who did it and who paid for it are different questions, and the trail answers both
separately. On Amoy an auditor can reconstruct the entire history from Polygonscan alone,
with our API switched off entirely.

### A manager — the `MANAGER` role

Issues credentials and mints asset NFTs through the admin console.

The flow is a **two-phase signature**, and it is the security centrepiece:

1. The manager fills in the form; the backend _prepares_ an EIP-712 typed request.
2. Their wallet shows the exact structured data and they sign it.
3. The signed request goes to the relayer, which pays the gas and submits it.

The relayer pays, but the _contract_ recovers the manager's address from their signature
and authorizes against that. A relayer that submits a transaction holds **no power to act
as anyone**. Gas payment and authority are fully separated. On Amoy, gas is real (test)
POL, so this stops being a diagram and starts being an actual economic actor.

NFT metadata goes to IPFS; the chain stores only the pointer.

### An admin — the `ADMIN` role

Grants and revokes roles. There are exactly four: `ADMIN`, `MANAGER`, `AUDITOR`, `USER`.

Role changes go through the same two-phase signing, and — critically — **roles attach to a
DID, not to a raw address**. The API accepts a role _name_ from the fixed list, never a raw
`bytes32`, so `DEFAULT_ADMIN_ROLE` cannot be requested through it even by someone who knows
it exists. The actor is always taken from the server-side session and never from anything
the browser sends.

On Amoy every grant and revocation is a permanent public event. Authority cannot be edited
behind the audit trail's back, because changing authority _is_ an entry in it.

For production, admin control transfers to a Safe multisig so no single key holds it —
[DEPLOY.md](./DEPLOY.md) steps 4 through 7, including the step that proves no EOA retains
control.

---

## 5. Paying is not permission

The single most important idea in the system, and the one most often misread:

> The relayer pays for transactions. The relayer cannot perform them.

Three separate mechanisms enforce this:

1. **ERC-2771 meta-transactions.** The contract recovers the _original signer_ from the
   forwarded request, not the submitter.
2. **The forwarder verifies the signature** before anything executes.
3. **On-chain RBAC authorizes the recovered address** — the actor, never the executor.

This is why Step 5 matters. Funding the relayer lets it _pay_. Granting it MANAGER lets it
_act on its own behalf_ for platform-initiated operations. They are different powers and
are granted separately, on purpose.

It is also why the audit trail records both parties. Any system where the payer and the
actor are conflated cannot answer "who authorized this?" — only "who submitted it?"

---

## 6. When it does not work

Always start here. It names the failing gate and why:

```bash
curl -s http://localhost:4000/network | jq '.candidates[] | {id, usable, checks}'
```

| Report says                              | Cause                                       | Fix                               |
| ---------------------------------------- | ------------------------------------------- | --------------------------------- |
| `rpc — unreachable`                      | Bad URL, expired key, provider down         | Check `AMOY_RPC_URL`              |
| `rpc — chain id 1 (expected 80002)`      | Endpoint points at the wrong network        | Fix the URL — this is a hard fail |
| `contracts — no deployment record`       | Never deployed to Amoy                      | Step 1                            |
| `contracts — no bytecode at 0x…`         | Record is stale, or points at another chain | Redeploy; delete the stale record |
| `relayer — no relayer for amoy`          | Relayer not configured for Amoy             | Step 3                            |
| `balance — signer holds 0.0`             | Not funded                                  | Step 4                            |
| Everything passes, writes still rejected | Signer funded but has no MANAGER role       | Step 5 — see §5                   |

**The platform stays usable throughout.** Every failure above falls back to Hardhat and
says so in amber in the header. A broken Amoy configuration degrades the _claim_ of public
verifiability; it never takes the product down.

---

## 7. Rules that do not bend

- **Testnet only.** Do not deploy to Polygon mainnet. Amoy is the target.
- **No secrets in source or git history.** Real values in gitignored `.env` files;
  placeholders in `.env.example`. Enforced by `npm run security:secrets`.
- **No PII on chain.** Hashes and commitments only — permanently public on a testnet.
- **NFT metadata on IPFS only.** The chain holds the pointer.
- **Every critical action emits an event.** If it is not in the trail, it did not happen.
- **Never trust an actor value sent by the browser.** It comes from the session.
