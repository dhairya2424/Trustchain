import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import { config as loadEnv } from "dotenv";
import path from "node:path";

/**
 * Load this package's own .env before anything reads process.env.
 *
 * DEPLOY.md has always told the operator to put AMOY_RPC_URL, DEPLOYER_PRIVATE_KEY and
 * POLYGONSCAN_API_KEY in `packages/contracts/.env` — but nothing here ever read that file,
 * so every one of them resolved to "" and `--network amoy` died on `HH117: Empty string for
 * network URL`. Local work never noticed, because the localhost URL is hardcoded and needs
 * no key; the gap only appears the first time someone actually deploys to a public chain.
 *
 * The path is explicit rather than dotenv's default cwd lookup: hardhat is run from the
 * repo root as often as from this package, and a config that silently finds no variables
 * depending on which directory you started in is worse than one that fails.
 *
 * `quiet` suppresses dotenv v17's startup banner, which would otherwise print on every
 * compile and test run.
 */
loadEnv({ path: path.resolve(__dirname, ".env"), quiet: true });

const AMOY_RPC_URL = process.env.AMOY_RPC_URL ?? "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin v5.6 emits the `mcopy` opcode, which is Cancun-only.
      // Polygon Amoy and the local Hardhat network both support Cancun.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    amoy: {
      url: AMOY_RPC_URL,
      chainId: 80002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { polygonAmoy: POLYGONSCAN_API_KEY },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    noColors: true,
    excludeContracts: ["mocks/"],
    outputFile: process.env.GAS_REPORT_FILE,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
