import { ethers } from "ethers";
import dotenv from "dotenv";

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
const GOLDAPI_REQUEST_DELAY_MS = parseInt(process.env.GOLDAPI_REQUEST_DELAY_MS || "300", 10); // 300ms between requests
const GOLDAPI_CACHE_TTL_MS = parseInt(process.env.GOLDAPI_CACHE_TTL_MS || "60000", 10); // 1 min cache
const ORACLE_MAX_STEP_BPS = parseInt(process.env.ORACLE_MAX_STEP_BPS || "300", 10); // %3

const OUNCE_TO_GRAM = 31.1035;

/* ═══════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════ */
type MetalSymbol = "XAU" | "XAG" | "XPT" | "XPD";

interface RawSignals {
  XAU: { priceUsdPerG: number };
  XAG: { priceUsdPerG: number };
  XPT: { priceUsdPerG: number };
  XPD: { priceUsdPerG: number };
}

type Weights = Record<MetalSymbol, number>;

interface OracleContract extends ethers.BaseContract {
  setPricePerOzE6: (newPricePerOzE6: bigint) => Promise<any>;
  getPricePerOzE6: () => Promise<bigint>;
}

/* ═══════════════════════════════════════════════
   WEIGHTS
═══════════════════════════════════════════════ */
const CURRENT_WEIGHTS: Weights = {
  XAU: 0.55,
  XAG: 0.20,
  XPT: 0.17,
  XPD: 0.08,
};

/* ═══════════════════════════════════════════════
   GOLDAPI FETCH (RATE-LIMIT SAFE)
═══════════════════════════════════════════════ */
let lastFetchAt = 0;
let cachedData: RawSignals | null = null;

// Helper: wait between requests
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
  return json.price / OUNCE_TO_GRAM; // USD/g
}

async function fetchRawSignals(): Promise<RawSignals> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (cachedData && now - lastFetchAt < GOLDAPI_CACHE_TTL_MS) {
    console.log("📦 Using cached price data");
    return cachedData;
  }

  console.log("🌐 Fetching fresh prices from GoldAPI...");
  
  // Fetch metals sequentially with delay between each request
  // This prevents rate limiting (max 5 req/sec)
  const metals: MetalSymbol[] = ["XAU", "XAG", "XPT", "XPD"];
  const prices: Partial<RawSignals> = {};

  for (const metal of metals) {
    try {
      prices[metal] = { priceUsdPerG: await fetchMetal(metal) };
      console.log(`   ✓ ${metal}: $${prices[metal]!.priceUsdPerG.toFixed(4)}/g`);
      
      // Wait between requests to avoid rate limit
      if (metal !== "XPD") { // Don't wait after last one
        await delay(GOLDAPI_REQUEST_DELAY_MS);
      }
    } catch (err: any) {
      // If we have cached data, use it for this metal
      if (cachedData && cachedData[metal]) {
        console.log(`   ⚠ ${metal} failed, using cached: $${cachedData[metal].priceUsdPerG.toFixed(4)}/g`);
        prices[metal] = cachedData[metal];
      } else {
        throw err; // No fallback available
      }
    }
  }

  cachedData = prices as RawSignals;
  lastFetchAt = Date.now();
  return cachedData;
}

/* ═══════════════════════════════════════════════
   INDEX CALCULATION (USD / gram)
═══════════════════════════════════════════════ */
function computeIndexPrice(prices: RawSignals, weights: Weights): number {
  return (
    prices.XAU.priceUsdPerG * weights.XAU +
    prices.XAG.priceUsdPerG * weights.XAG +
    prices.XPT.priceUsdPerG * weights.XPT +
    prices.XPD.priceUsdPerG * weights.XPD
  );
}

/* ═══════════════════════════════════════════════
   ORACLE STEP LOGIC
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

async function publishToOracle(
  oracle: OracleContract, 
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  indexUsdPerG: number
) {
  const targetUsdPerOz = indexUsdPerG * OUNCE_TO_GRAM;
  const targetE6 = BigInt(Math.round(targetUsdPerOz * 1_000_000));

  const currentE6 = await oracle.getPricePerOzE6();
  const nextE6 = stepLimitedE6(currentE6, targetE6, ORACLE_MAX_STEP_BPS);

  // Skip if no change needed
  if (currentE6 === nextE6) {
    console.log("⏭️  No price change needed, skipping transaction");
    return;
  }

  // Check wallet balance before sending
  const balance = await provider.getBalance(wallet.address);
  const balanceBNB = Number(balance) / 1e18;
  console.log(`💰 Wallet balance: ${balanceBNB.toFixed(6)} BNB`);

  if (balance < ethers.parseEther("0.001")) {
    console.error(`❌ Insufficient BNB! Need at least 0.001 BNB. Current: ${balanceBNB.toFixed(6)} BNB`);
    console.error(`   Wallet address: ${wallet.address}`);
    console.error(`   Please send BNB to this address to continue.`);
    return; // Skip this tick instead of failing
  }

  console.log(
    `🧾 Oracle publish | current=${currentE6} target=${targetE6} next=${nextE6} step=${ORACLE_MAX_STEP_BPS}bps`
  );

  try {
    const tx = await oracle.setPricePerOzE6(nextE6);
    console.log(`📤 TX sent: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ TX confirmed!`);
  } catch (err: any) {
    if (err.code === "INSUFFICIENT_FUNDS") {
      console.error(`❌ Insufficient funds for gas. Please add BNB to: ${wallet.address}`);
    } else {
      throw err;
    }
  }
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
  console.log(`   Wallet: ${wallet.address}`);
  console.log(`   Oracle: ${ORACLE_ADDRESS}`);
  console.log(`   Interval: ${WATCHER_INTERVAL / 1000}s`);
  console.log(`   Cache TTL: ${GOLDAPI_CACHE_TTL_MS / 1000}s`);
  console.log(`   Request delay: ${GOLDAPI_REQUEST_DELAY_MS}ms`);
  console.log("══════════════════════════════════════════════════");

  // Check initial balance
  const balance = await provider.getBalance(wallet.address);
  const balanceBNB = Number(balance) / 1e18;
  console.log(`💰 Initial balance: ${balanceBNB.toFixed(6)} BNB`);
  
  if (balanceBNB < 0.01) {
    console.warn(`⚠️  Low BNB balance! Consider adding more BNB to: ${wallet.address}`);
  }

  const oracle = new ethers.Contract(
    ORACLE_ADDRESS,
    [
      "function setPricePerOzE6(uint256 newPricePerOzE6) external",
      "function getPricePerOzE6() external view returns (uint256)",
    ],
    wallet
  ) as unknown as OracleContract;

  console.log("✅ Watcher initialized successfully!");
  console.log("   Starting price update loop...");
  console.log("══════════════════════════════════════════════════");

  while (true) {
    try {
      console.log(`\n⏰ Tick at ${new Date().toISOString()}`);
      const raw = await fetchRawSignals();
      const index = computeIndexPrice(raw, CURRENT_WEIGHTS);

      console.log(`📈 Computed index: $${index.toFixed(4)} USD/g`);
      await publishToOracle(oracle, wallet, provider, index);
    } catch (err: any) {
      console.error("❌ Tick failed:", err.message || err);
    }

    console.log(`⏳ Next tick in ${WATCHER_INTERVAL / 1000} seconds...`);
    await new Promise(r => setTimeout(r, WATCHER_INTERVAL));
  }
}

run().catch(err => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
