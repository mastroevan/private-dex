import { CompiledContract } from "@midnight-ntwrk/compact-js";
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
import fs from "fs";
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import * as HelloWorld from "../contracts/managed/hello-world/contract/index.js";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const MAX_MEMORY_MB = 3500;

// ─────────────────────────────────────────────────────────────
// MEMORY GUARD (debug only, keep it)
// ─────────────────────────────────────────────────────────────

setInterval(() => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`🧠 Memory: ${mb.toFixed(2)} MB`);

  if (mb > MAX_MEMORY_MB) {
    console.log("❌ Memory limit exceeded — exiting safely");
    process.exit(1);
  }
}, 5000);

// ─────────────────────────────────────────────────────────────
// WALLET SYNC (SINGLE ATTEMPT - NO LOOPS)
// ─────────────────────────────────────────────────────────────

async function syncWalletOnce(seedHex: string) {
  console.log("🔄 Creating wallet...");

  const ctx = await createWallet(seedHex);

  console.log("🔄 Syncing with network (max 2 min)...");

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SYNC_TIMEOUT")), 120000)
  );

  const syncedState = await Promise.race([
    ctx.wallet.waitForSyncedState(),
    timeout,
  ]) as Awaited<ReturnType<typeof ctx.wallet.waitForSyncedState>>;

  console.log("✅ Wallet synced");

  return { ctx, syncedState };
}

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
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const wallet = await WalletFacade.init({
    configuration: {
      networkId,
      indexerClientConnection: {
        indexerHttpUrl: "https://indexer.preprod.midnight.network/api/v3/graphql",
        indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
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

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

async function createProviders(ctx: any, syncedState: any) {
  return {
    walletProvider: {
      getCoinPublicKey: () =>
        syncedState.shielded.coinPublicKey.toHexString(),
      getEncryptionPublicKey: () =>
        syncedState.shielded.encryptionPublicKey.toHexString(),

      async balanceTx(tx: any, ttl?: Date) {
        const recipe = await ctx.wallet.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: ctx.shieldedSecretKeys,
            dustSecretKey: ctx.dustSecretKey,
          },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) }
        );

        const signed = await ctx.wallet.signRecipe(recipe, (payload: any) => ctx.unshieldedKeystore.signData(payload));

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
║      Deploy private-dex to Midnight Preprod                 ║
╚══════════════════════════════════════════════════════════════╝
`);

  const seedHex = fs.readFileSync(".midnight-seed", "utf-8").trim();

  // ── WALLET + SYNC ───────────────────────────────────────────
  const { ctx, syncedState } = await syncWalletOnce(seedHex);

  const address = ctx.unshieldedKeystore.getBech32Address();
  console.log(`\n✔ Wallet: ${address}`);

  const balance =
    syncedState.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;

  if (balance === 0n) {
    console.log(`⚠️  Balance is 0 — fund via faucet before deploying`);
  }

  // ── CONTRACT SETUP ──────────────────────────────────────────
  console.log("\n📦 Preparing contract deployment...");

  // TODO: keep your existing compile output reference here
  const compiledContract = CompiledContract.make(
    "hello-world",
    HelloWorld.Contract
  );

  const providers = await createProviders(ctx, syncedState);

  // ── DEPLOY ───────────────────────────────────────────────────
  console.log("\n🚀 Deploying contract...");

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: [],
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;

  console.log("\n✅ Contract deployed!");
  console.log(`📍 Address: ${contractAddress}`);

  // ── SAVE RESULT ──────────────────────────────────────────────
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

  console.log("\n💾 Saved to deployment.json");

  // ── CLEAN EXIT ───────────────────────────────────────────────
  try {
    await ctx.wallet.stop();
    console.log("🧹 Wallet closed cleanly");
  } catch { }

  console.log("\n🎉 Done. Run npm run cli to interact with contract.");
}

// ─────────────────────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n❌ Fatal error:\n", err);
  process.exit(1);
});