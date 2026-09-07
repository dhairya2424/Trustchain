# Matches the Node major used on the host. A different npm major inside the image resolves
# the dependency tree differently and then rejects the host-generated lockfile with
# "Missing: <pkg> from lock file" for a package that is genuinely absent from it.
FROM node:24-alpine

WORKDIR /app

# Every workspace manifest, not just the contracts one.
#
# `npm ci` reconciles the lockfile against the WHOLE workspace graph, so with sibling
# manifests missing it cannot resolve hoisted transitive dependencies and fails with
# "Missing: <pkg> from lock file" — a message that points at the lockfile rather than at
# the real cause, which is the incomplete copy. Copying all four costs nothing: they are
# small, and they change far less often than the sources below, so the install layer still
# caches well.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspace @trustchain/contracts --include-workspace-root

COPY packages/contracts ./packages/contracts
COPY infra/healthcheck.mjs ./infra/healthcheck.mjs

WORKDIR /app/packages/contracts

EXPOSE 8545

CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0"]
