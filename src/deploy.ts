/**
 * Deploy private-dex contract to Midnight Preprod network
 *
 * Dependency pinning strategy (critical):
 *
 *  wallet-sdk-facade@3.0.0 internally depends on wallet-sdk-shielded@^2.1.0
 *  and wallet-sdk-unshielded-wallet@^2.1.0.  Without pinning, npm would
 *  install @3.0.0 of those packages at the top level, which have incompatible
 *  types.  The "overrides" field in package.json forces both to 2.1.0 so every
 *  import site resolves the same build that the facade expects.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// ── Midnight SDK ─────────────────────────────────────────────────────────────
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import * as ledger from '@midnight-ntwrk/ledger-v8';

// ── Wallet SDK ────────────────────────────────────────────────────────────────
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';

// Pinned to 2.1.0 via "overrides" in package.json — the exact versions
// wallet-sdk-facade@3.0.0 depends on, so types are fully compatible.
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// ── Compact contract ──────────────────────────────────────────────────────────
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as HelloWorldContract from
  '../contracts/managed/hello-world/contract/index.js';

// ── Safety guards ─────────────────────────────────────────────

const MAX_MEMORY_MB = 3500;

setInterval(() => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (mb > 200 || mb % 200 < 5) {
    console.log(`🧠 Memory: ${mb.toFixed(2)} MB`);
  }
  console.log(`🧠 Memory: ${mb.toFixed(2)} MB`);

  if (mb > MAX_MEMORY_MB) {
    console.log("❌ Memory limit exceeded — exiting safely");
    process.exit(1);
  }
}, 5000);

async function safeRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`🔄 ${label} (attempt ${attempt}/${maxAttempts})`);

      const result = await fn();

      console.log(`✅ ${label} completed`);
      return result;
    } catch (err) {
      console.log(`⚠️ ${label} failed:`, err);

      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error(`❌ ${label} failed after ${maxAttempts} attempts`);
}

function startSyncHeartbeat() {
  let lastUpdate = Date.now();

  const interval = setInterval(() => {
    const delta = Date.now() - lastUpdate;
    console.log(`⏳ Sync alive (${Math.floor(delta / 1000)}s since update)`);
  }, 5000);

  return {
    touch: () => (lastUpdate = Date.now()),
    stop: () => clearInterval(interval),
  };
}

async function safeSync<T>(syncFn: () => Promise<T>): Promise<T> {
  let attempts = 0;

  while (attempts < 5) {
    try {
      attempts++;
      console.log(`🔄 Sync attempt ${attempts}`);

      const result = await syncFn();

      console.log("✅ Sync completed");
      return result;
    } catch (e) {
      console.log("⚠️ Sync failed, retrying...", e);
      await new Promise(r => setTimeout(r, 2000 * attempts));
    }
  }

  throw new Error("❌ Sync failed after max retries");
}

// ── Network WebSocket fix ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = WebSocket;

// ── Config ────────────────────────────────────────────────────────────────────
setNetworkId('preprod');

const CONFIG = {
  indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  faucetUrl: 'https://faucet.preprod.midnight.network/',
};

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'hello-world');

// ── Compiled contract ─────────────────────────────────────────────────────────
// pipe() is the Effect-style combinator — call withVacantWitnesses then withCompiledFileAssets
const compiledContract = CompiledContract.withCompiledFileAssets(
  CompiledContract.withVacantWitnesses(
    CompiledContract.make('hello-world', HelloWorldContract.Contract as any)
  ),
  zkConfigPath
);

// ── Proof server health check ─────────────────────────────────────────────────
async function waitForProofServer(maxAttempts = 30, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(CONFIG.proofServer, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// ── Key derivation ────────────────────────────────────────────────────────────
function deriveKeys(seedHex: string) {
  const result = HDWallet.fromSeed(new Uint8Array(Buffer.from(seedHex, 'hex')));
  if (result.type !== 'seedOk') throw new Error('Invalid seed');

  const derived = result.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);

  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  result.hdWallet.clear();
  return derived.keys;
}

// ── Wallet factory ────────────────────────────────────────────────────────────
async function createWallet(seedHex: string) {
  const keys = deriveKeys(seedHex);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    keys[Roles.NightExternal] as Uint8Array,
    networkId,
  );

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL('wss://rpc.preprod.midnight.network/'),
    // InMemoryTransactionHistoryStorage from the facade's nested 2.1.0 copy
    // satisfies the TransactionHistoryStorage interface the facade requires.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
  };

  const wallet = await WalletFacade.init({
    configuration,
    shielded: c => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: c => UnshieldedWallet(c).startWithPublicKey(
      PublicKey.fromKeyStore(unshieldedKeystore)
    ),
    dust: c => DustWallet(c).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust,
    ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ── Provider factory ──────────────────────────────────────────────────────────
async function createProviders(
  ctx: Awaited<ReturnType<typeof createWallet>>,
  state: any
) {

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),

    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await ctx.wallet.signRecipe(
        recipe,
        (p: Uint8Array) => ctx.unshieldedKeystore.signData(p),
      );
      return ctx.wallet.finalizeRecipe(signed);
    },

    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx),
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = ctx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'hello-world-state',
      accountId,
      privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD || 'development',
    }),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}



async function syncWithReset(seedHex: string): Promise<any> {
  let attempts = 0;

  while (attempts < 5) {
    attempts++;

    console.log(`🔄 Full wallet restart attempt ${attempts}`);

    const ctx = await createWallet(seedHex);

    const heartbeat = startSyncHeartbeat();

    try {
      const syncedState = await Promise.race([
        ctx.wallet.waitForSyncedState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("sync timeout")), 120000)
        ),
      ]);

      heartbeat.stop();

      console.log("✅ Sync successful");

      return { ctx, syncedState };
    } catch (e) {
      heartbeat.stop();

      console.log("⚠️ Sync failed, resetting wallet context...");

      try {
        await ctx.wallet.stop();
      } catch {}

      await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error("❌ Wallet sync failed after retries");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║      Deploy private-dex to Midnight Preprod                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Seed ──────────────────────────────────────────────────────────────────
  let seedHex: string;
  if (fs.existsSync('.midnight-seed')) {
    seedHex = fs.readFileSync('.midnight-seed', 'utf8').trim();
    console.log('  Using saved wallet seed from .midnight-seed');
  } else {
    seedHex = toHex(generateRandomSeed());
    fs.writeFileSync('.midnight-seed', seedHex, { mode: 0o600 });
    console.log('  Generated new wallet seed → saved to .midnight-seed');
  }

  // ── Wallet + sync ─────────────────────────────────────────────────────────
  console.log("  Syncing with network (safe mode)...");

  const heartbeat = startSyncHeartbeat();

  const { ctx: safeCtx, syncedState } = await syncWithReset(seedHex);
  const ctx = safeCtx;

  heartbeat.stop();

  console.log("  ✓ Synced");

  const address = ctx.unshieldedKeystore.getBech32Address();
  console.log(`  ✓ Synced\n  Wallet: ${address}\n`);

  const nightBalance = syncedState.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
  if (nightBalance === 0n) {
    console.log(`  ⚠  Balance is 0 tNight. Fund via ${CONFIG.faucetUrl}`);
    console.log(`     Address: ${address}\n`);
  }

  // ── Proof server ──────────────────────────────────────────────────────────
  console.log('  Checking proof server...');
  if (!(await waitForProofServer())) {
    console.error('\n  ❌ Proof server not responding at', CONFIG.proofServer);
    console.error('  Run:  docker compose up -d\n');
    await ctx.wallet.stop();
    process.exit(1);
  }
  console.log('  ✓ Proof server ready\n');

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log('  Deploying contract...\n');
  const providers = await createProviders(ctx, syncedState);

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: [],
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`  ✅ Contract deployed!\n  Address: ${contractAddress}\n`);

  fs.writeFileSync('deployment.json', JSON.stringify({
    contractAddress,
    network: 'preprod',
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log('  Saved to deployment.json\n');

  await ctx.wallet.stop();
  console.log('  Done. Run  npm run cli  to interact with the contract.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});