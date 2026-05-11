// ─────────────────────────────────────────────────────────────
// MUST BE FIRST — network config before any SDK import usage
// ─────────────────────────────────────────────────────────────
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
setNetworkId("preprod");

// ─────────────────────────────────────────────────────────────
// Core imports
// ─────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import * as ledger from "@midnight-ntwrk/ledger-v8";

import { deployContract } from "@midnight-ntwrk/midnight-js/contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";

import * as HelloWorld from "../contracts/managed/hello-world/contract/index.js";

// Wallet SDK
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const MAX_MEMORY_MB = 3500;

// Memory monitor (safe debug only)
setInterval(() => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`🧠 Memory: ${mb.toFixed(2)} MB`);

  if (mb > MAX_MEMORY_MB) {
    console.log("❌ Memory limit exceeded — exiting safely");
    process.exit(1);
  }
}, 8000);

// ─────────────────────────────────────────────────────────────
// WALLET CREATION
// ─────────────────────────────────────────────────────────────
async function createWallet(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));

  if (hdWallet.type !== "seedOk") {
    throw new Error("Invalid seed");
  }

  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivation.type !== "keysDerived") {
    throw new Error(`Key derivation failed: ${derivation.type}`);
  }

  const keys = derivation.keys;
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    keys[Roles.NightExternal],
    networkId
  );

  const wallet = await WalletFacade.init({
    configuration: {
      networkId,
      indexerClientConnection: {
        indexerHttpUrl:
          "https://indexer.preprod.midnight.network/api/v3/graphql",
        indexerWsUrl:
          "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
      },
      provingServerUrl: new URL("http://127.0.0.1:6300"),
      relayURL: new URL("wss://rpc.preprod.midnight.network"),
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
      costParameters: {
        additionalFeeOverhead: 300_000_000_000_000n,
        feeBlocksMargin: 5,
      },
    },
    shielded: async (c) =>
      ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (c) =>
      UnshieldedWallet(c).startWithPublicKey(
        PublicKey.fromKeyStore(unshieldedKeystore)
      ),
    dust: async (c) =>
      DustWallet(c).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust
      ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
  };
}

// ─────────────────────────────────────────────────────────────
// FULL SYNC (NO TIMEOUT — CRITICAL FIX)
// ─────────────────────────────────────────────────────────────
async function syncWallet(ctx: any) {
  console.log("⏳ Syncing wallet (this may take a few minutes)...");

  let lastLog = Date.now();

  const ticker = setInterval(() => {
    if (Date.now() - lastLog > 8000) {
      console.log("⏳ still syncing...");
      lastLog = Date.now();
    }
  }, 5000);

  const syncedState = await ctx.wallet.waitForSyncedState();

  clearInterval(ticker);

  // HARD GUARD — prevents your Bech32 crash
  if (!syncedState?.shielded?.coinPublicKey) {
    throw new Error("Wallet sync incomplete: missing coinPublicKey");
  }

  console.log("✅ Wallet fully synced");

  return syncedState;
}

// ─────────────────────────────────────────────────────────────
// PROVIDERS
// ─────────────────────────────────────────────────────────────
function createProviders(ctx: any, state: any) {
  return {
    walletProvider: {
      getCoinPublicKey: () =>
        state.shielded.coinPublicKey.toHexString(),

      getEncryptionPublicKey: () =>
        state.shielded.encryptionPublicKey.toHexString(),

      async balanceTx(tx: any, ttl?: Date) {
        const recipe = await ctx.wallet.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: ctx.shieldedSecretKeys,
            dustSecretKey: ctx.dustSecretKey,
          },
          {
            ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000),
          }
        );

        const signed = await ctx.wallet.signRecipe(recipe, (payload: any) =>
          ctx.unshieldedKeystore.signData(payload)
        );

        return ctx.wallet.finalizeRecipe(signed);
      },

      submitTx: (tx: any) => ctx.wallet.submitTransaction(tx),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║      Deploy private-dex (stable production version)         ║
╚══════════════════════════════════════════════════════════════╝
`);

  const seedHex = fs.readFileSync(".midnight-seed", "utf-8").trim();

  // WALLET
  const ctx = await createWallet(seedHex);

  // SYNC (FIXED)
  const syncedState = await syncWallet(ctx);

  const address = ctx.unshieldedKeystore.getBech32Address();
  console.log(`\n✔ Wallet: ${address}`);

  const balance =
    syncedState.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;

  if (balance === 0n) {
    console.log("⚠️ Balance is 0 — fund wallet before deploying");
  }

  // CONTRACT
  console.log("\n📦 Preparing contract...");

  const compiledContract = CompiledContract.make(
    "hello-world",
    HelloWorld.Contract
  );

  const providers = createProviders(ctx, syncedState);

  console.log("\n🚀 Deploying contract...");

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: [],
  });

  const contractAddress =
    deployed.deployTxData.public.contractAddress;

  console.log("\n✅ Contract deployed!");
  console.log(`📍 ${contractAddress}`);

  fs.writeFileSync(
    "deployment.json",
    JSON.stringify(
      {
        contractAddress,
        network: "preprod",
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log("\n💾 Saved deployment.json");

  try {
    await ctx.wallet.stop();
    console.log("🧹 Wallet closed cleanly");
  } catch {}

  console.log("\n🎉 Done.");
}

// ─────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("\n❌ Fatal error:\n", err);
  process.exit(1);
});