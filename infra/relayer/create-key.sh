#!/usr/bin/env bash
# Generates the relayer's local encrypted signer keystore using the OFFICIAL v1.5.0 tool.
#
#   docker run --rm -v "$PWD/infra/relayer:/out" -e KEYSTORE_PASSPHRASE rust:1-slim \
#     bash /out/create-key.sh
#
# Runs inside a Rust container so no toolchain is needed on the host. It clones the pinned
# tag, builds the `create_key` helper the documentation specifies, and writes the keystore
# into the mounted directory.
#
# The passphrase arrives through the environment, never as an argument: process arguments
# are world-readable in /proc on Linux, so a passphrase on a command line is visible to
# every other process on the machine.
set -euo pipefail

RELAYER_TAG="${RELAYER_TAG:-v1.5.0}"
OUT_DIR="${OUT_DIR:-/out/config/keys}"
FILENAME="${FILENAME:-local-signer.json}"

if [[ -z "${KEYSTORE_PASSPHRASE:-}" ]]; then
  echo "KEYSTORE_PASSPHRASE is not set" >&2
  exit 1
fi

# The relayer crate builds signers for several chains, so the native dependencies of all
# of them are needed even though only the EVM signer is used here: libsodium comes from
# the Solana stack, protobuf and clang from its transitive build scripts.
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  git ca-certificates pkg-config libssl-dev libsodium-dev \
  clang cmake protobuf-compiler build-essential >/dev/null

rm -rf /src
git clone --depth 1 --branch "$RELAYER_TAG" \
  https://github.com/OpenZeppelin/openzeppelin-relayer /src
cd /src

mkdir -p "$OUT_DIR"

# `--force` so a re-run replaces a half-written file rather than failing; the caller is
# responsible for not re-running against a keystore that is already in use.
cargo run --quiet --example create_key -- \
  --password "$KEYSTORE_PASSPHRASE" \
  --output-dir "$OUT_DIR" \
  --filename "$FILENAME" \
  --force

chmod 0400 "$OUT_DIR/$FILENAME"
echo "keystore written to $OUT_DIR/$FILENAME"
