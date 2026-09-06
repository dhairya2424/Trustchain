FROM node:20-alpine

WORKDIR /app

# Install only what the contracts workspace needs, using the root lockfile.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
RUN npm ci --workspace @trustchain/contracts --include-workspace-root

COPY packages/contracts ./packages/contracts
COPY infra/healthcheck.mjs ./infra/healthcheck.mjs

WORKDIR /app/packages/contracts

EXPOSE 8545

CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0"]
