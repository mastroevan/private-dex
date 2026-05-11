// ─────────────────────────────────────────────────────────────
// Network MUST be set first
// ─────────────────────────────────────────────────────────────
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
setNetworkId("preprod");

// ─────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────
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
import * as ledger from "@midnight-ntwrk/ledger-v8";
import * as fs from "fs";
import { deployContract } from "@midnight-ntwrk/midnight-js/contracts";
import * as HelloWorld from "../contracts/managed/hello-world/contract/index.js";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const INDEXER_HTTP =
  "https://indexer.preprod.midnight.network/api/v3/graphql";
const INDEXER_WS =
  "wss://indexer.preprod.midnight.network/api/v3/graphql/ws";

const PROOF_SERVER = "http://127.0.0.1:6300";
const RELAY = "wss://rpc.preprod.midnight.network";

const SYNC_TIMEOUT_MS = 60_000;

// ─────────────────────────────────────────────────────────────
// WALLET CREATION (PURE, NO SYNC HERE)
// ─────────────────────────────────────────────────────────────
async function createWallet(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));

  if (hd.type !== "seedOk") {
    throw new Error("Invalid seed");
  }

  const derivation = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivation.type !== "keysDerived") {
    throw new Error(`Key derivation failed: ${derivation.type}`);
  }

  const keys = derivation.keys;
  const networkId = "preprod";

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(
    keys[Roles.Zswap]
  );
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    keys[Roles.NightExternal],
    networkId
  );

  const wallet = await WalletFacade.init({
    configuration: {
      networkId,
      indexerClientConnection: {
        indexerHttpUrl: INDEXER_HTTP,
        indexerWsUrl: INDEXER_WS,
      },
      provingServerUrl: new URL(PROOF_SERVER),
      relayURL: new URL(RELAY),
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
// LIGHTWEIGHT SYNC (NO FULL STATE BLOCKING)
// ─────────────────────────────────────────────────────────────
async function warmWallet(wallet: any) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SYNC_TIMEOUT")), SYNC_TIMEOUT_MS)
  );

  try {
    await Promise.race([
      wallet.waitForSyncedState(),
      timeout,
    ]);
  } catch {
    console.log("⚠️ Sync timeout hit — continuing with partial state");
  }
}

// ─────────────────────────────────────────────────────────────
// PROVIDERS (LAZY SAFE)
// ─────────────────────────────────────────────────────────────
async function createProviders(ctx: any) {
  const state = await ctx.wallet.getState?.().catch(() => undefined);

  return {
    walletProvider: {
      getCoinPublicKey: () =>
        state?.shielded?.coinPublicKey?.toHexString?.() ?? "",

      getEncryptionPublicKey: () =>
        state?.shielded?.encryptionPublicKey?.toHexString?.() ?? "",

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

        const signed = await ctx.wallet.signRecipe(
          recipe,
          (payload: any) => ctx.unshieldedKeystore.signData(payload)
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
║      Deploy private-dex (production-safe)                   ║
╚══════════════════════════════════════════════════════════════╝
`);

  const seedHex = fs.readFileSync(".midnight-seed", "utf-8").trim();

  console.log("🔄 Creating wallet...");
  const ctx = await createWallet(seedHex);

  console.log("⚡ Warming wallet (non-blocking sync)...");
  await warmWallet(ctx.wallet);

  const address = ctx.unshieldedKeystore.getBech32Address();
  console.log(`\n✔ Wallet: ${address}`);

  // ── CONTRACT ────────────────────────────────────────────────
  console.log("\n📦 Preparing contract...");

  const compiledContract = CompiledContract.make(
    "hello-world",
    HelloWorld.Contract
  );

  const providers = await createProviders(ctx);

  console.log("\n🚀 Deploying contract...");

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: [],
  });

  const contractAddress =
    deployed.deployTxData.public.contractAddress;

  console.log("\n✅ Deployed!");
  console.log("📍", contractAddress);

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
  } catch {}

  console.log("\n🎉 Done. CLI ready.");
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("\n❌ Fatal error:\n", err);
  process.exit(1);
});