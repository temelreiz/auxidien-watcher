import { ethers } from "ethers";
import dotenv from "dotenv";
import OracleAbi from "./abi/AuxidienOracle.json";

dotenv.config();

/* ═══════════════════════════════════════════════
   ENV CHECK
═══════════════════════════════════════════════ */
const REQUIRED_ENVS = ["RPC_URL", "ORACLE_ADDRESS", "PRIVATE_KEY", "GOLDAPI_KEY"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`❌ Missing env var: ${k}`);
    process.exit(1);
  }
}

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */
const RPC_URL = process.env.RPC_URL!;
const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const GOLDAPI_KEY = process.env.GOLDAPI_KEY!;

const WATCHER_INTERVAL = parseInt(process.env.WATCHER_INTERVAL || "3600000", 10); // 1 hour
const GOLDAPI_REQUEST_DELAY_MS = parseInt(process.env.GOLDAPI_REQUEST_DELAY_MS || "300", 10);
const GOLDAPI_CACHE_TTL_MS = parseInt(process.env.GOLDAPI_CACHE_TTL_MS || "60000", 10);
const ORACLE_MAX_STEP_BPS = parseInt(process.env.ORACLE_MAX_STEP_BPS || "300", 10); // 3%

const OUNCE_TO_GRAM = 31.1035;
const WEIGHT_DENOMINATOR = 10_000n;

/* ═══════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════ */
type MetalSymbol = "XAU" | "XAG" | "XPT" | "XPD";

interface RawSignals {
  XAU: { priceUsdPerOz: number };
  XAG: { priceUsdPerOz: number };
  XPT: { priceUsdPerOz: number };
  XPD: { priceUsdPerOz: number };
}

interface OnChainWeights {
  goldBps: bigint;
  silverBps: bigint;
  platinumBps: bigint;
  palladiumBps: bigint;
}

interface OracleContract extends ethers.BaseContract {
  setPriceWithMetals: (
    newPricePerOzE6: bigint,
    goldPrice: bigint,
    silverPrice: bigint,
    platinumPrice: bigint,
    palladiumPrice: bigint,
  ) => Promise<ethers.ContractTransactionResponse>;
  getPricePerOzE6: () => Promise<bigint>;
  getWeights: () => Promise<[bigint, bigint, bigint, bigint]>;
}

/* ═══════════════════════════════════════════════
   GOLDAPI FETCH (RATE-LIMIT SAFE)
═══════════════════════════════════════════════ */
let lastFetchAt = 0;
let cachedData: RawSignals | null = null;

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMetal(symbol: MetalSymbol): Promise<number> {
  const res = await fetch(`https://www.goldapi.io/api/${symbol}/USD`, {
    headers: {
      "x-access-token": GOLDAPI_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GoldAPI ${symbol} ${res.status}: ${txt}`);
  }

  const json: any = await res.json();
  // GoldAPI returns USD/oz directly under `price`.
  return json.price;
}

async function fetchRawSignals(): Promise<RawSignals> {
  const now = Date.now();

  if (cachedData && now - lastFetchAt < GOLDAPI_CACHE_TTL_MS) {
    console.log("📦 Using cached price data");
    return cachedData;
  }

  console.log("🌐 Fetching fresh prices from GoldAPI...");

  const metals: MetalSymbol[] = ["XAU", "XAG", "XPT", "XPD"];
  const prices: Partial<RawSignals> = {};

  for (const metal of metals) {
    try {
      prices[metal] = { priceUsdPerOz: await fetchMetal(metal) };
      console.log(`   ✓ ${metal}: $${prices[metal]!.priceUsdPerOz.toFixed(4)}/oz`);

      if (metal !== "XPD") {
        await delay(GOLDAPI_REQUEST_DELAY_MS);
      }
    } catch (err: any) {
      if (cachedData && cachedData[metal]) {
        console.log(`   ⚠ ${metal} failed, using cached: $${cachedData[metal].priceUsdPerOz.toFixed(4)}/oz`);
        prices[metal] = cachedData[metal];
      } else {
        throw err;
      }
    }
  }

  cachedData = prices as RawSignals;
  lastFetchAt = Date.now();
  return cachedData;
}

/* ═══════════════════════════════════════════════
   INDEX CALCULATION
═══════════════════════════════════════════════ */
function toE6(usdPerOz: number): bigint {
  return BigInt(Math.round(usdPerOz * 1_000_000));
}

function computeIndexE6(prices: RawSignals, weights: OnChainWeights): bigint {
  const xau = toE6(prices.XAU.priceUsdPerOz);
  const xag = toE6(prices.XAG.priceUsdPerOz);
  const xpt = toE6(prices.XPT.priceUsdPerOz);
  const xpd = toE6(prices.XPD.priceUsdPerOz);

  // weighted sum / 10000
  return (
    (xau * weights.goldBps +
      xag * weights.silverBps +
      xpt * weights.platinumBps +
      xpd * weights.palladiumBps) /
    WEIGHT_DENOMINATOR
  );
}

/* ═══════════════════════════════════════════════
   ORACLE STEP LOGIC (off-chain extra safety)
═══════════════════════════════════════════════ */
function stepLimitedE6(current: bigint, target: bigint, maxStepBps: number): bigint {
  if (current === target) return target;
  if (current === 0n) return target;

  const diff = target - current;
  const absDiff = diff >= 0n ? diff : -diff;

  let maxStep = (current * BigInt(maxStepBps)) / 10_000n;
  if (maxStep <= 0n) maxStep = 1n;

  if (absDiff <= maxStep) return target;
  return diff > 0n ? current + maxStep : current - maxStep;
}

/* ═══════════════════════════════════════════════
   PUBLISH
═══════════════════════════════════════════════ */
async function publishToOracle(
  oracle: OracleContract,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  raw: RawSignals,
  weights: OnChainWeights,
) {
  const targetE6 = computeIndexE6(raw, weights);
  const currentE6 = await oracle.getPricePerOzE6();
  const nextE6 = stepLimitedE6(currentE6, targetE6, ORACLE_MAX_STEP_BPS);

  if (currentE6 === nextE6) {
    console.log("⏭️  No price change needed, skipping transaction");
    return;
  }

  const balance = await provider.getBalance(wallet.address);
  const balanceBNB = Number(balance) / 1e18;
  console.log(`💰 Wallet balance: ${balanceBNB.toFixed(6)} BNB`);

  if (balance < ethers.parseEther("0.001")) {
    console.error(`❌ Insufficient BNB on ${wallet.address}; skipping tick`);
    return;
  }

  console.log(
    `🧾 Oracle publish | current=${currentE6} target=${targetE6} next=${nextE6} step=${ORACLE_MAX_STEP_BPS}bps`,
  );

  const goldE6 = toE6(raw.XAU.priceUsdPerOz);
  const silverE6 = toE6(raw.XAG.priceUsdPerOz);
  const platinumE6 = toE6(raw.XPT.priceUsdPerOz);
  const palladiumE6 = toE6(raw.XPD.priceUsdPerOz);

  try {
    const tx = await oracle.setPriceWithMetals(
      nextE6,
      goldE6,
      silverE6,
      platinumE6,
      palladiumE6,
    );
    console.log(`📤 TX sent: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ TX confirmed`);
  } catch (err: any) {
    if (err.code === "INSUFFICIENT_FUNDS") {
      console.error(`❌ Insufficient funds for gas on ${wallet.address}`);
    } else {
      throw err;
    }
  }
}

async function fetchWeights(oracle: OracleContract): Promise<OnChainWeights> {
  const [goldBps, silverBps, platinumBps, palladiumBps] = await oracle.getWeights();
  const sum = goldBps + silverBps + platinumBps + palladiumBps;
  if (sum !== WEIGHT_DENOMINATOR) {
    throw new Error(
      `On-chain weights do not sum to 10000: gold=${goldBps} silver=${silverBps} platinum=${platinumBps} palladium=${palladiumBps}`,
    );
  }
  return { goldBps, silverBps, platinumBps, palladiumBps };
}

/* ═══════════════════════════════════════════════
   MAIN LOOP
═══════════════════════════════════════════════ */
async function run() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("══════════════════════════════════════════════════");
  console.log("🚀 Auxidien Price Oracle Watcher");
  console.log("══════════════════════════════════════════════════");
  console.log(`   Wallet:        ${wallet.address}`);
  console.log(`   Oracle:        ${ORACLE_ADDRESS}`);
  console.log(`   Interval:      ${WATCHER_INTERVAL / 1000}s`);
  console.log(`   Cache TTL:     ${GOLDAPI_CACHE_TTL_MS / 1000}s`);
  console.log(`   Request delay: ${GOLDAPI_REQUEST_DELAY_MS}ms`);
  console.log(`   Max step:      ${ORACLE_MAX_STEP_BPS}bps`);
  console.log("══════════════════════════════════════════════════");

  const balance = await provider.getBalance(wallet.address);
  const balanceBNB = Number(balance) / 1e18;
  console.log(`💰 Initial balance: ${balanceBNB.toFixed(6)} BNB`);

  if (balanceBNB < 0.01) {
    console.warn(`⚠️  Low BNB balance! Consider topping up: ${wallet.address}`);
  }

  const oracle = new ethers.Contract(
    ORACLE_ADDRESS,
    OracleAbi as any,
    wallet,
  ) as unknown as OracleContract;

  console.log("✅ Watcher initialized; entering tick loop");
  console.log("══════════════════════════════════════════════════");

  while (true) {
    try {
      console.log(`\n⏰ Tick at ${new Date().toISOString()}`);
      const weights = await fetchWeights(oracle);
      console.log(
        `⚖️  Weights | XAU=${weights.goldBps} XAG=${weights.silverBps} XPT=${weights.platinumBps} XPD=${weights.palladiumBps}`,
      );
      const raw = await fetchRawSignals();
      await publishToOracle(oracle, wallet, provider, raw, weights);
    } catch (err: any) {
      console.error("❌ Tick failed:", err.message || err);
    }

    console.log(`⏳ Next tick in ${WATCHER_INTERVAL / 1000}s`);
    await new Promise(r => setTimeout(r, WATCHER_INTERVAL));
  }
}

run().catch(err => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
