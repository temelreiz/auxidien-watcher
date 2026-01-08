import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * AUXIDIEN INDEX PREPROCESSOR (Signal Processor)
 * 
 * Role: Normalize ecosystem signals and produce index inputs
 * NOT a price setter - just a signal processor
 * 
 * Architecture:
 * - Preprocessor (this) = Signal normalization & weight calculation
 * - Oracle = Final price publisher with validation
 * - Contract = Rule enforcer
 * 
 * Methodology:
 * - Inverse volatility weighting with bounded constraints
 * - Log-return based volatility (finance standard)
 * - Smooth weight transitions (no sudden shocks)
 * - Volatility regime detection
 */

// Oracle ABI (minimal)
const ORACLE_ABI = [
  "function setPricePerOzE6(uint256 newPricePerOzE6) external",
  "function setPriceWithMetals(uint256 newPricePerOzE6, uint256 goldPrice, uint256 silverPrice, uint256 platinumPrice, uint256 palladiumPrice) external",
  "function getPricePerOzE6() external view returns (uint256)",
  "function lastUpdateAt() external view returns (uint256)",
  "function minUpdateInterval() external view returns (uint256)",
];

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  oracleAddress: process.env.AUXIDIEN_ORACLE_ADDRESS || "",
  rpcUrl: process.env.RPC_URL || "https://bsc-dataseed1.binance.org/",
  privateKey: process.env.PRIVATE_KEY || "",
  updateInterval: parseInt(process.env.WATCHER_INTERVAL || "300000"), // 5 minutes for data collection
  goldApiKey: process.env.GOLDAPI_KEY || "",
  
  // Discovery Phase: Publish only at specific hours (UTC)
  // This prevents "algo peg" perception
  publishHours: [0, 12], // UTC 00:00 and 12:00 (2 times per day)
  discoveryPhase: true,  // Set to false after discovery phase
};

// Conversion constants
const OUNCE_TO_GRAM = 31.1035;

// ═══════════════════════════════════════════════════════════════
// WEIGHT BOUNDS (α + β + γ + δ = 1)
// Weights NEVER go outside these bounds
// ═══════════════════════════════════════════════════════════════

const WEIGHT_BOUNDS: Record<string, { min: number; max: number }> = {
  XAU: { min: 0.35, max: 0.55 },  // Gold: 35-55%
  XAG: { min: 0.15, max: 0.30 },  // Silver: 15-30%
  XPT: { min: 0.10, max: 0.25 },  // Platinum: 10-25%
  XPD: { min: 0.05, max: 0.15 },  // Palladium: 5-15%
};

// Smooth transition factor (λ)
// Lower = smoother, slower adaptation
// 0.05-0.1 recommended for stability
const LAMBDA = 0.08;

// ═══════════════════════════════════════════════════════════════
// RISK MODERATION LAYER CONSTANTS
// ═══════════════════════════════════════════════════════════════

const DRAW_DOWN_THRESHOLD = 0.05;      // 5% drawdown triggers caution
const STABILITY_THRESHOLD = 0.7;        // Correlation stability minimum
const LIQUIDITY_THRESHOLD = 0.8;        // Liquidity stress threshold
const DISPERSION_MIN = 0.15;            // Minimum weight dispersion
const MIN_REGIME_DURATION = 6;          // Minimum ticks before regime change

// ═══════════════════════════════════════════════════════════════
// VOLATILITY REGIMES
// ═══════════════════════════════════════════════════════════════

enum VolatilityRegime {
  LOW = "LOW",           // σ < 1% - Normal market
  MEDIUM = "MEDIUM",     // 1-3% - Elevated activity
  HIGH = "HIGH",         // 3-6% - High volatility
  EXTREME = "EXTREME",   // > 6% - Crisis mode
}

// Daily/Weekly drift caps by regime (must be after enum definition)
const DRIFT_CAPS: Record<VolatilityRegime, { daily: number; weekly: number }> = {
  [VolatilityRegime.LOW]: { daily: 0.03, weekly: 0.08 },      // 3% daily, 8% weekly
  [VolatilityRegime.MEDIUM]: { daily: 0.02, weekly: 0.05 },   // 2% daily, 5% weekly
  [VolatilityRegime.HIGH]: { daily: 0.015, weekly: 0.04 },    // 1.5% daily, 4% weekly
  [VolatilityRegime.EXTREME]: { daily: 0.01, weekly: 0.025 }, // 1% daily, 2.5% weekly
};

interface RegimeConfig {
  maxPriceChange: number;  // Max allowed price change per update
  updateMultiplier: number; // Adjustment to update frequency
  description: string;
}

const REGIME_CONFIGS: Record<VolatilityRegime, RegimeConfig> = {
  [VolatilityRegime.LOW]: {
    maxPriceChange: 0.05,    // 5%
    updateMultiplier: 1.0,
    description: "Normal market conditions",
  },
  [VolatilityRegime.MEDIUM]: {
    maxPriceChange: 0.03,    // 3%
    updateMultiplier: 1.0,
    description: "Elevated market activity",
  },
  [VolatilityRegime.HIGH]: {
    maxPriceChange: 0.02,    // 2%
    updateMultiplier: 0.5,   // Update more frequently
    description: "High volatility - increased caution",
  },
  [VolatilityRegime.EXTREME]: {
    maxPriceChange: 0.01,    // 1%
    updateMultiplier: 0.25,  // Much more frequent updates
    description: "EXTREME volatility - maximum caution",
  },
};

// ═══════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════

interface MetalData {
  symbol: string;
  price: number;
  weight: number;
}

interface PricePoint {
  timestamp: number;
  price: number;
}

interface GoldApiResponse {
  price: number;
  symbol: string;
  currency: string;
  timestamp: number;
}

// Risk Moderation Layer interfaces
interface RiskState {
  indexValue: number;
  historicalIndex: number[];
  volatility: Record<string, number>;
  correlations: number[][];
  liquidityStress: number;
  weights: Record<string, number>;
  currentRegime: VolatilityRegime;
  regimeDuration: number;
}

interface RiskAdjustedParams {
  driftCap: number;
  weightSpeed: number;
  rebalanceBias: "diversify" | "neutral" | "concentrate";
  allowRegimeChange: boolean;
}

// Price history for volatility calculation (last 24-48 hours)
const priceHistory: Record<string, PricePoint[]> = {
  XAU: [],
  XAG: [],
  XPT: [],
  XPD: [],
};

// Current weights (start with middle of bounds)
let currentWeights: Record<string, number> = {
  XAU: 0.45,  // Start at middle of 35-55%
  XAG: 0.22,  // Start at middle of 15-30%
  XPT: 0.18,  // Start at middle of 10-25%
  XPD: 0.15,  // Adjusted to sum to 1
};

// Index price history for drawdown calculation
const indexHistory: number[] = [];
const MAX_INDEX_HISTORY = 288 * 14; // 14 days at 5-min intervals

// Regime tracking
let currentRegime: VolatilityRegime = VolatilityRegime.LOW;
let regimeDuration: number = 0;
let lastRegimeChange: number = Date.now();

// Correlation matrix history (for stability measurement)
let lastCorrelations: number[][] = [
  [1, 0.7, 0.6, 0.5],
  [0.7, 1, 0.5, 0.4],
  [0.6, 0.5, 1, 0.6],
  [0.5, 0.4, 0.6, 1],
];

// Keep last 288 data points (24 hours at 5-min intervals)
const MAX_HISTORY_POINTS = 288;
const MIN_POINTS_FOR_VOLATILITY = 12;

// ═══════════════════════════════════════════════════════════════
// VOLATILITY CALCULATION (Log Return Based)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate log returns from price history
 * Log returns are standard in finance because:
 * - They're additive over time
 * - They dampen large spikes
 * - They're symmetric for gains/losses
 */
function calculateLogReturns(prices: PricePoint[]): number[] {
  const returns: number[] = [];
  
  for (let i = 1; i < prices.length; i++) {
    const prevPrice = prices[i - 1].price;
    const currPrice = prices[i].price;
    
    if (prevPrice > 0 && currPrice > 0) {
      // Log return: ln(P_t / P_{t-1})
      returns.push(Math.log(currPrice / prevPrice));
    }
  }
  
  return returns;
}

/**
 * Calculate annualized volatility from log returns
 * σ = stddev(log_returns) × √(periods_per_year)
 */
function calculateVolatility(metal: string): number {
  const history = priceHistory[metal];
  
  if (history.length < MIN_POINTS_FOR_VOLATILITY) {
    // Default volatilities based on historical data
    const defaults: Record<string, number> = {
      XAU: 0.12,  // Gold: ~12% annual
      XAG: 0.22,  // Silver: ~22%
      XPT: 0.18,  // Platinum: ~18%
      XPD: 0.30,  // Palladium: ~30%
    };
    return defaults[metal] || 0.15;
  }

  const logReturns = calculateLogReturns(history);
  
  if (logReturns.length < 5) {
    return 0.15; // Default
  }

  // Calculate mean
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  
  // Calculate variance
  const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / logReturns.length;
  
  // Standard deviation
  const stdDev = Math.sqrt(variance);

  // Annualize: multiply by sqrt(periods per year)
  // 5-min intervals = 288/day × 365 = 105,120 periods/year
  const annualizedVol = stdDev * Math.sqrt(105120);

  // Clamp to reasonable bounds (5% to 80%)
  return Math.max(0.05, Math.min(0.80, annualizedVol));
}

/**
 * Determine current volatility regime based on average volatility
 */
function detectVolatilityRegime(volatilities: Record<string, number>): VolatilityRegime {
  // Use gold-weighted average (gold is the anchor)
  const avgVol = volatilities.XAU * 0.5 + 
                 volatilities.XAG * 0.2 + 
                 volatilities.XPT * 0.2 + 
                 volatilities.XPD * 0.1;

  // Convert to daily volatility for regime detection
  const dailyVol = avgVol / Math.sqrt(252);

  if (dailyVol < 0.01) return VolatilityRegime.LOW;
  if (dailyVol < 0.03) return VolatilityRegime.MEDIUM;
  if (dailyVol < 0.06) return VolatilityRegime.HIGH;
  return VolatilityRegime.EXTREME;
}

// ═══════════════════════════════════════════════════════════════
// RISK MODERATION LAYER
// ═══════════════════════════════════════════════════════════════

/**
 * Get daily drift cap based on current regime
 */
function getDailyDriftCap(regime: VolatilityRegime): number {
  return DRIFT_CAPS[regime].daily;
}

/**
 * Get weekly drift cap based on current regime
 */
function getWeeklyDriftCap(regime: VolatilityRegime): number {
  return DRIFT_CAPS[regime].weekly;
}

/**
 * Calculate maximum drawdown over a lookback period
 * @param history - Array of index values
 * @param lookbackDays - Number of days to look back
 */
function calculateDrawdown(history: number[], lookbackDays: number): number {
  if (history.length < 2) return 0;
  
  // Convert days to data points (288 points per day at 5-min intervals)
  const lookbackPoints = Math.min(lookbackDays * 288, history.length);
  const recentHistory = history.slice(-lookbackPoints);
  
  let maxValue = recentHistory[0];
  let maxDrawdown = 0;
  
  for (const value of recentHistory) {
    if (value > maxValue) {
      maxValue = value;
    }
    const drawdown = (maxValue - value) / maxValue;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }
  
  return maxDrawdown;
}

/**
 * Measure correlation stability between current and historical correlations
 * Returns value between 0 (unstable) and 1 (perfectly stable)
 */
function measureCorrelationStability(correlations: number[][]): number {
  if (!lastCorrelations || correlations.length !== lastCorrelations.length) {
    return 1; // Assume stable if no history
  }
  
  let totalDiff = 0;
  let count = 0;
  
  for (let i = 0; i < correlations.length; i++) {
    for (let j = i + 1; j < correlations[i].length; j++) {
      const diff = Math.abs(correlations[i][j] - lastCorrelations[i][j]);
      totalDiff += diff;
      count++;
    }
  }
  
  const avgDiff = count > 0 ? totalDiff / count : 0;
  // Convert to stability score (lower diff = higher stability)
  return Math.max(0, 1 - avgDiff * 2);
}

/**
 * Calculate weight dispersion (entropy-based)
 * Higher dispersion = more diversified
 */
function calculateWeightDispersion(weights: Record<string, number>): number {
  const values = Object.values(weights);
  const n = values.length;
  
  if (n === 0) return 0;
  
  // Calculate entropy-based dispersion
  let entropy = 0;
  for (const w of values) {
    if (w > 0) {
      entropy -= w * Math.log(w);
    }
  }
  
  // Normalize by max entropy (uniform distribution)
  const maxEntropy = Math.log(n);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Adjust drift cap based on market conditions
 */
function adjustCap(baseCap: number, drawdownMode: boolean, stressedLiquidity: boolean): number {
  let adjustedCap = baseCap;
  
  if (drawdownMode) {
    adjustedCap *= 0.5; // Halve the cap during drawdowns
  }
  
  if (stressedLiquidity) {
    adjustedCap *= 0.7; // Reduce by 30% during liquidity stress
  }
  
  return Math.max(0.005, adjustedCap); // Minimum 0.5% cap
}

/**
 * Adjust weight transition speed based on conditions
 */
function adjustWeightSpeed(drawdownMode: boolean, fragmentedMarket: boolean): number {
  let speed = LAMBDA; // Base speed
  
  if (drawdownMode) {
    speed *= 0.5; // Slower during drawdowns
  }
  
  if (fragmentedMarket) {
    speed *= 0.3; // Much slower when correlations are unstable
  }
  
  return Math.max(0.01, speed); // Minimum speed
}

/**
 * Calculate simple correlation matrix from price histories
 */
function calculateCorrelations(): number[][] {
  const metals = ["XAU", "XAG", "XPT", "XPD"];
  const n = metals.length;
  const correlations: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
  
  for (let i = 0; i < n; i++) {
    correlations[i][i] = 1; // Self-correlation
    for (let j = i + 1; j < n; j++) {
      const corr = calculatePairCorrelation(metals[i], metals[j]);
      correlations[i][j] = corr;
      correlations[j][i] = corr;
    }
  }
  
  return correlations;
}

/**
 * Calculate correlation between two metals
 */
function calculatePairCorrelation(metal1: string, metal2: string): number {
  const h1 = priceHistory[metal1];
  const h2 = priceHistory[metal2];
  
  if (h1.length < 20 || h2.length < 20) {
    // Default correlations when insufficient data
    const defaults: Record<string, Record<string, number>> = {
      XAU: { XAG: 0.7, XPT: 0.6, XPD: 0.5 },
      XAG: { XAU: 0.7, XPT: 0.5, XPD: 0.4 },
      XPT: { XAU: 0.6, XAG: 0.5, XPD: 0.6 },
      XPD: { XAU: 0.5, XAG: 0.4, XPT: 0.6 },
    };
    return defaults[metal1]?.[metal2] || 0.5;
  }
  
  // Get matching time windows
  const minLen = Math.min(h1.length, h2.length, 100);
  const r1 = calculateLogReturns(h1.slice(-minLen));
  const r2 = calculateLogReturns(h2.slice(-minLen));
  
  if (r1.length < 10 || r2.length < 10) return 0.5;
  
  const len = Math.min(r1.length, r2.length);
  
  // Calculate means
  const mean1 = r1.slice(0, len).reduce((a, b) => a + b, 0) / len;
  const mean2 = r2.slice(0, len).reduce((a, b) => a + b, 0) / len;
  
  // Calculate correlation
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < len; i++) {
    const d1 = r1[i] - mean1;
    const d2 = r2[i] - mean2;
    cov += d1 * d2;
    var1 += d1 * d1;
    var2 += d2 * d2;
  }
  
  const denom = Math.sqrt(var1 * var2);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Estimate liquidity stress (bid-ask spread proxy)
 * In production, this would use actual market data
 */
function estimateLiquidityStress(): number {
  // Calculate recent volatility spike as liquidity proxy
  const vols = {
    XAU: calculateVolatility("XAU"),
    XAG: calculateVolatility("XAG"),
    XPT: calculateVolatility("XPT"),
    XPD: calculateVolatility("XPD"),
  };
  
  // Historical average volatilities
  const avgVols = { XAU: 0.12, XAG: 0.22, XPT: 0.18, XPD: 0.30 };
  
  // Calculate how much current vol exceeds historical
  let stressScore = 0;
  for (const [metal, vol] of Object.entries(vols)) {
    const ratio = vol / avgVols[metal as keyof typeof avgVols];
    if (ratio > 1.5) {
      stressScore += (ratio - 1.5) * 0.5;
    }
  }
  
  return Math.min(1, stressScore / 2); // Normalize to 0-1
}

/**
 * Main Risk Moderation function
 * Computes risk-adjusted parameters based on current market state
 */
function computeRiskAdjustedParameters(state: RiskState): RiskAdjustedParams {
  const {
    indexValue,
    historicalIndex,
    volatility,
    correlations,
    liquidityStress,
    weights,
    currentRegime,
    regimeDuration
  } = state;

  // 1. Rate limiting
  const dailyCap = getDailyDriftCap(currentRegime);
  const weeklyCap = getWeeklyDriftCap(currentRegime);

  // 2. Drawdown awareness
  const drawdown = calculateDrawdown(historicalIndex, 14);
  const drawdownMode = drawdown > DRAW_DOWN_THRESHOLD;

  // 3. Correlation stability
  const corrStability = measureCorrelationStability(correlations);
  const fragmentedMarket = corrStability < STABILITY_THRESHOLD;

  // 4. Liquidity stress proxy
  const stressedLiquidity = liquidityStress > LIQUIDITY_THRESHOLD;

  // 5. Weight dispersion
  const dispersion = calculateWeightDispersion(weights);
  const overConcentration = dispersion < DISPERSION_MIN;

  // 6. Regime persistence
  const regimeLocked = regimeDuration < MIN_REGIME_DURATION;

  // Log risk assessment
  console.log("\n🛡️  RISK ASSESSMENT");
  console.log(`   Drawdown (14d): ${(drawdown * 100).toFixed(2)}% ${drawdownMode ? "⚠️ CAUTION" : "✓"}`);
  console.log(`   Correlation Stability: ${(corrStability * 100).toFixed(1)}% ${fragmentedMarket ? "⚠️ FRAGMENTED" : "✓"}`);
  console.log(`   Liquidity Stress: ${(liquidityStress * 100).toFixed(1)}% ${stressedLiquidity ? "⚠️ STRESSED" : "✓"}`);
  console.log(`   Weight Dispersion: ${(dispersion * 100).toFixed(1)}% ${overConcentration ? "⚠️ CONCENTRATED" : "✓"}`);
  console.log(`   Regime Duration: ${regimeDuration} ticks ${regimeLocked ? "🔒 LOCKED" : "🔓"}`);

  return {
    driftCap: adjustCap(dailyCap, drawdownMode, stressedLiquidity),
    weightSpeed: adjustWeightSpeed(drawdownMode, fragmentedMarket),
    rebalanceBias: overConcentration ? "diversify" : "neutral",
    allowRegimeChange: !regimeLocked
  };
}

/**
 * Calculate target weights based on inverse volatility
 * Lower volatility = Higher weight (more stable = more influence)
 */
function calculateTargetWeights(volatilities: Record<string, number>): Record<string, number> {
  // Inverse volatility
  const inverseVols: Record<string, number> = {};
  let totalInverseVol = 0;

  for (const [metal, vol] of Object.entries(volatilities)) {
    inverseVols[metal] = 1 / vol;
    totalInverseVol += inverseVols[metal];
  }

  // Raw target weights (before bounds)
  const rawTargets: Record<string, number> = {};
  for (const [metal, invVol] of Object.entries(inverseVols)) {
    rawTargets[metal] = invVol / totalInverseVol;
  }

  // Apply bounds
  const boundedTargets: Record<string, number> = {};
  for (const [metal, target] of Object.entries(rawTargets)) {
    const bounds = WEIGHT_BOUNDS[metal];
    boundedTargets[metal] = Math.max(bounds.min, Math.min(bounds.max, target));
  }

  // Normalize to ensure sum = 1
  const sum = Object.values(boundedTargets).reduce((a, b) => a + b, 0);
  for (const metal of Object.keys(boundedTargets)) {
    boundedTargets[metal] /= sum;
  }

  return boundedTargets;
}

/**
 * Smooth transition from current weights to target weights
 * w_new = w_old × (1 - λ) + w_target × λ
 */
function smoothWeightTransition(
  current: Record<string, number>,
  target: Record<string, number>,
  lambda: number
): Record<string, number> {
  const newWeights: Record<string, number> = {};

  for (const metal of Object.keys(current)) {
    // Exponential moving average for smooth transition
    newWeights[metal] = current[metal] * (1 - lambda) + target[metal] * lambda;
    
    // Re-apply bounds after transition
    const bounds = WEIGHT_BOUNDS[metal];
    newWeights[metal] = Math.max(bounds.min, Math.min(bounds.max, newWeights[metal]));
  }

  // Normalize to ensure sum = 1
  const sum = Object.values(newWeights).reduce((a, b) => a + b, 0);
  for (const metal of Object.keys(newWeights)) {
    newWeights[metal] /= sum;
  }

  return newWeights;
}

// ═══════════════════════════════════════════════════════════════
// PRICE FETCHING
// ═══════════════════════════════════════════════════════════════

async function fetchMetalPrice(metal: string): Promise<number> {
  const url = `https://www.goldapi.io/api/${metal}/USD`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-access-token": CONFIG.goldApiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GoldAPI error for ${metal}: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as GoldApiResponse;
  return data.price;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add price to history for volatility calculation
 */
function addPriceToHistory(metal: string, price: number): void {
  if (!priceHistory[metal]) {
    priceHistory[metal] = [];
  }

  priceHistory[metal].push({
    timestamp: Date.now(),
    price: price,
  });

  // Keep only last MAX_HISTORY_POINTS
  if (priceHistory[metal].length > MAX_HISTORY_POINTS) {
    priceHistory[metal] = priceHistory[metal].slice(-MAX_HISTORY_POINTS);
  }
}

// ═══════════════════════════════════════════════════════════════
// INDEX CALCULATION
// ═══════════════════════════════════════════════════════════════

async function fetchAndProcessSignals(): Promise<{
  metals: MetalData[];
  indexPrice: number;
  regime: VolatilityRegime;
  volatilities: Record<string, number>;
  riskParams: RiskAdjustedParams;
}> {
  console.log("\n📡 SIGNAL PROCESSING");
  console.log("   Fetching raw signals from goldapi.io...");

  // Fetch prices
  const goldPriceOz = await fetchMetalPrice("XAU");
  await sleep(1500);
  const silverPriceOz = await fetchMetalPrice("XAG");
  await sleep(1500);
  const platinumPriceOz = await fetchMetalPrice("XPT");
  await sleep(1500);
  const palladiumPriceOz = await fetchMetalPrice("XPD");

  // Convert to grams
  const prices: Record<string, number> = {
    XAU: goldPriceOz / OUNCE_TO_GRAM,
    XAG: silverPriceOz / OUNCE_TO_GRAM,
    XPT: platinumPriceOz / OUNCE_TO_GRAM,
    XPD: palladiumPriceOz / OUNCE_TO_GRAM,
  };

  // Add to history
  for (const [metal, price] of Object.entries(prices)) {
    addPriceToHistory(metal, price);
  }

  // Calculate volatilities
  console.log("\n📊 VOLATILITY ANALYSIS (Log-Return Based)");
  const volatilities: Record<string, number> = {
    XAU: calculateVolatility("XAU"),
    XAG: calculateVolatility("XAG"),
    XPT: calculateVolatility("XPT"),
    XPD: calculateVolatility("XPD"),
  };

  for (const [metal, vol] of Object.entries(volatilities)) {
    const dataPoints = priceHistory[metal].length;
    console.log(`   ${metal}: σ = ${(vol * 100).toFixed(2)}% (${dataPoints} data points)`);
  }

  // Detect regime
  const detectedRegime = detectVolatilityRegime(volatilities);
  const regimeConfig = REGIME_CONFIGS[detectedRegime];
  
  // Update regime duration tracking
  if (detectedRegime !== currentRegime) {
    regimeDuration = 0;
  } else {
    regimeDuration++;
  }

  // === RISK MODERATION LAYER ===
  // Calculate correlations
  const correlations = calculateCorrelations();
  
  // Estimate liquidity stress
  const liquidityStress = estimateLiquidityStress();
  
  // Build risk state
  const riskState: RiskState = {
    indexValue: 0, // Will be calculated after weights
    historicalIndex: [...indexHistory],
    volatility: volatilities,
    correlations,
    liquidityStress,
    weights: currentWeights,
    currentRegime,
    regimeDuration
  };
  
  // Get risk-adjusted parameters
  const riskParams = computeRiskAdjustedParameters(riskState);
  
  // Apply regime change only if allowed
  const regime = riskParams.allowRegimeChange ? detectedRegime : currentRegime;
  if (riskParams.allowRegimeChange) {
    currentRegime = detectedRegime;
  }
  
  console.log(`\n🎯 VOLATILITY REGIME: ${regime}`);
  console.log(`   ${regimeConfig.description}`);
  console.log(`   Max price change: ${(regimeConfig.maxPriceChange * 100).toFixed(1)}%`);
  console.log(`   Risk-Adjusted Drift Cap: ${(riskParams.driftCap * 100).toFixed(2)}%`);

  // Calculate target weights
  const targetWeights = calculateTargetWeights(volatilities);
  
  // Apply rebalance bias if over-concentrated
  let adjustedTargets = { ...targetWeights };
  if (riskParams.rebalanceBias === "diversify") {
    console.log("\n⚠️  DIVERSIFICATION BIAS ACTIVE");
    // Push weights toward center of bounds
    for (const metal of Object.keys(adjustedTargets)) {
      const bounds = WEIGHT_BOUNDS[metal];
      const center = (bounds.min + bounds.max) / 2;
      adjustedTargets[metal] = adjustedTargets[metal] * 0.7 + center * 0.3;
    }
    // Normalize
    const sum = Object.values(adjustedTargets).reduce((a, b) => a + b, 0);
    for (const metal of Object.keys(adjustedTargets)) {
      adjustedTargets[metal] /= sum;
    }
  }

  // Smooth transition with risk-adjusted speed
  console.log("\n⚖️  WEIGHT TRANSITION");
  console.log(`   λ (base): ${LAMBDA}, Risk-adjusted: ${riskParams.weightSpeed.toFixed(4)}`);
  
  const previousWeights = { ...currentWeights };
  currentWeights = smoothWeightTransition(currentWeights, adjustedTargets, riskParams.weightSpeed);
  
  // Update correlation history
  lastCorrelations = correlations;

  console.log("\n   Metal    | Previous | Target   | New      | Bounds");
  console.log("   " + "─".repeat(55));
  for (const metal of ["XAU", "XAG", "XPT", "XPD"]) {
    const bounds = WEIGHT_BOUNDS[metal];
    console.log(
      `   ${metal}     | ${(previousWeights[metal] * 100).toFixed(2)}%   | ` +
      `${(targetWeights[metal] * 100).toFixed(2)}%   | ` +
      `${(currentWeights[metal] * 100).toFixed(2)}%   | ` +
      `[${(bounds.min * 100).toFixed(0)}%-${(bounds.max * 100).toFixed(0)}%]`
    );
  }

  // Build metal data with final weights
  const metals: MetalData[] = [
    { symbol: "XAUUSD", price: prices.XAU, weight: currentWeights.XAU },
    { symbol: "XAGUSD", price: prices.XAG, weight: currentWeights.XAG },
    { symbol: "XPTUSD", price: prices.XPT, weight: currentWeights.XPT },
    { symbol: "XPDUSD", price: prices.XPD, weight: currentWeights.XPD },
  ];

  // Calculate index price
  let indexPrice = 0;
  for (const metal of metals) {
    indexPrice += metal.weight * metal.price;
  }

  console.log("\n💎 INDEX CALCULATION");
  console.log("   " + "─".repeat(45));
  for (const metal of metals) {
    const contribution = metal.weight * metal.price;
    console.log(
      `   ${metal.symbol}: $${metal.price.toFixed(4)}/g × ${(metal.weight * 100).toFixed(2)}% = $${contribution.toFixed(4)}`
    );
  }
  console.log("   " + "─".repeat(45));
  console.log(`   AUXI INDEX: $${indexPrice.toFixed(4)}/gram`);

  // Add to index history for drawdown calculation
  indexHistory.push(indexPrice);
  if (indexHistory.length > MAX_INDEX_HISTORY) {
    indexHistory.shift(); // Remove oldest
  }

  return { metals, indexPrice, regime, volatilities, riskParams };
}

// ═══════════════════════════════════════════════════════════════
// ORACLE UPDATE
// ═══════════════════════════════════════════════════════════════

async function updateOracle(
  oracle: ethers.Contract,
  indexPrice: number,
  metals: MetalData[],
  regime: VolatilityRegime
): Promise<string | null> {
  try {
    const regimeConfig = REGIME_CONFIGS[regime];
    
    // Convert prices to 1e6 format
    const indexPriceE6 = Math.round(indexPrice * 1e6);
    const goldPriceE6 = Math.round((metals.find(m => m.symbol === "XAUUSD")?.price || 0) * 1e6);
    const silverPriceE6 = Math.round((metals.find(m => m.symbol === "XAGUSD")?.price || 0) * 1e6);
    const platinumPriceE6 = Math.round((metals.find(m => m.symbol === "XPTUSD")?.price || 0) * 1e6);
    const palladiumPriceE6 = Math.round((metals.find(m => m.symbol === "XPDUSD")?.price || 0) * 1e6);

    console.log("\n📤 PUBLISHING TO ORACLE");
    console.log(`   Regime: ${regime} (max change: ${(regimeConfig.maxPriceChange * 100).toFixed(1)}%)`);
    console.log(`   Index Price: $${indexPrice.toFixed(4)}/gram (${indexPriceE6})`);

    const tx = await oracle.setPriceWithMetals(
      indexPriceE6,
      goldPriceE6,
      silverPriceE6,
      platinumPriceE6,
      palladiumPriceE6,
      { gasLimit: 200000 }
    );

    console.log(`   TX Hash: ${tx.hash}`);
    await tx.wait();
    console.log(`   ✅ Oracle updated successfully!`);

    return tx.hash;
  } catch (error: any) {
    console.error(`   ❌ Oracle update failed: ${error.message}`);
    
    if (error.message.includes("price change too large")) {
      console.log("   ⚠️ Price change exceeded oracle's maximum allowed rate");
      console.log("   💡 This is a safety feature - gradual updates will converge");
    }
    
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

// Track last publish hour to avoid duplicate publishes
let lastPublishHour: number = -1;

/**
 * Check if we should publish to oracle right now
 * Discovery Phase: Only publish at specific hours (UTC)
 */
function shouldPublishNow(): boolean {
  if (!CONFIG.discoveryPhase) {
    return true; // Always publish if not in discovery phase
  }

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Only publish at the start of designated hours (within first 10 minutes)
  const isPublishHour = CONFIG.publishHours.includes(currentHour);
  const isFirstWindow = currentMinute < 10;
  const notYetPublishedThisHour = lastPublishHour !== currentHour;

  if (isPublishHour && isFirstWindow && notYetPublishedThisHour) {
    lastPublishHour = currentHour;
    return true;
  }

  return false;
}

async function runTick(oracle: ethers.Contract): Promise<void> {
  console.log("\n" + "═".repeat(60));
  console.log(`⏰ TICK at ${new Date().toISOString()}`);
  console.log("═".repeat(60));

  try {
    const { metals, indexPrice, regime, riskParams } = await fetchAndProcessSignals();
    
    // Log risk summary
    console.log("\n📋 RISK SUMMARY");
    console.log(`   Drift Cap: ${(riskParams.driftCap * 100).toFixed(2)}%`);
    console.log(`   Weight Speed: ${riskParams.weightSpeed.toFixed(4)}`);
    console.log(`   Rebalance Bias: ${riskParams.rebalanceBias}`);
    console.log(`   Regime Change: ${riskParams.allowRegimeChange ? "Allowed" : "Locked"}`);
    
    // Check if we should publish
    const shouldPublish = shouldPublishNow();
    
    if (shouldPublish) {
      console.log("\n🚀 PUBLISH WINDOW - Updating Oracle...");
      await updateOracle(oracle, indexPrice, metals, regime);

      // Read back oracle state
      const currentPrice = await oracle.getPricePerOzE6();
      const lastUpdate = await oracle.lastUpdateAt();
      
      console.log("\n📖 ORACLE STATE");
      console.log(`   On-chain Price: $${(Number(currentPrice) / 1e6).toFixed(4)}/gram`);
      console.log(`   Last Update: ${new Date(Number(lastUpdate) * 1000).toISOString()}`);
    } else {
      console.log("\n⏸️  DISCOVERY PHASE - Data collected, NOT publishing");
      console.log(`   Publish hours (UTC): ${CONFIG.publishHours.join(", ")}:00`);
      console.log(`   Calculated index: $${indexPrice.toFixed(4)}/gram (internal only)`);
      
      // Still show oracle state for monitoring
      try {
        const currentPrice = await oracle.getPricePerOzE6();
        console.log(`   Current on-chain: $${(Number(currentPrice) / 1e6).toFixed(4)}/gram`);
      } catch {}
    }

  } catch (error: any) {
    console.error(`\n❌ TICK FAILED: ${error.message}`);
  }
}

async function startPreprocessor(): Promise<void> {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        AUXIDIEN INDEX PREPROCESSOR (Signal Processor)      ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Validate configuration
  if (!CONFIG.oracleAddress) {
    console.error("❌ AUXIDIEN_ORACLE_ADDRESS not set");
    process.exit(1);
  }
  if (!CONFIG.privateKey) {
    console.error("❌ PRIVATE_KEY not set");
    process.exit(1);
  }
  if (!CONFIG.goldApiKey) {
    console.error("❌ GOLDAPI_KEY not set");
    process.exit(1);
  }

  console.log("⚙️  CONFIGURATION");
  console.log(`   Oracle: ${CONFIG.oracleAddress}`);
  console.log(`   RPC: ${CONFIG.rpcUrl}`);
  console.log(`   Data Collection Interval: ${CONFIG.updateInterval / 1000}s`);
  console.log(`   Smoothing Factor (λ): ${LAMBDA}`);
  console.log(`   Min Data Points: ${MIN_POINTS_FOR_VOLATILITY}`);
  
  if (CONFIG.discoveryPhase) {
    console.log("\n🔔 DISCOVERY PHASE MODE");
    console.log(`   ⚠️  Oracle publishes ONLY at UTC hours: ${CONFIG.publishHours.join(", ")}`);
    console.log(`   📊 Data collected every ${CONFIG.updateInterval / 1000}s for volatility analysis`);
    console.log(`   📌 This prevents "algo peg" perception during market observation`);
  }

  console.log("\n📊 WEIGHT BOUNDS");
  for (const [metal, bounds] of Object.entries(WEIGHT_BOUNDS)) {
    console.log(`   ${metal}: ${(bounds.min * 100).toFixed(0)}% - ${(bounds.max * 100).toFixed(0)}%`);
  }

  // Initialize provider and wallet
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const wallet = new ethers.Wallet(CONFIG.privateKey, provider);
  
  console.log(`\n💼 WALLET`);
  console.log(`   Address: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`   Balance: ${ethers.formatEther(balance)} BNB`);

  if (balance === BigInt(0)) {
    console.warn("   ⚠️ Wallet has no BNB - transactions will fail!");
  }

  // Initialize oracle
  const oracle = new ethers.Contract(CONFIG.oracleAddress, ORACLE_ABI, wallet);

  try {
    const minInterval = await oracle.minUpdateInterval();
    console.log(`\n🔮 ORACLE`);
    console.log(`   Min Update Interval: ${minInterval}s`);
  } catch (error) {
    console.error("❌ Cannot connect to oracle");
    process.exit(1);
  }

  console.log("\n✅ Preprocessor initialized!");
  console.log("   Starting signal processing loop...\n");

  // Run initial tick
  await runTick(oracle);

  // Schedule periodic updates
  setInterval(() => runTick(oracle), CONFIG.updateInterval);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down preprocessor...");
  console.log("   Final weights:", currentWeights);
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n\n👋 Shutting down preprocessor...");
  process.exit(0);
});

// Run
startPreprocessor().catch((error) => {
  console.error("❌ Startup failed:", error);
  process.exit(1);
});
