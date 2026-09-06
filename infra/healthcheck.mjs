// Container healthcheck: the local chain answers eth_blockNumber.
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

try {
  const res = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const json = await res.json();
  process.exit(json?.result ? 0 : 1);
} catch {
  process.exit(1);
}
