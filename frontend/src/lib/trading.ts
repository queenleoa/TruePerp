import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import { deployment, UNICHAIN_SEPOLIA } from "../config";
import { previewPosition, type Direction, type PositionPreview } from "./leverage";
import { getActiveProvider } from "./wallets";
import {
  DEFAULT_SLIPPAGE_BPS,
  demoTokenAbi,
  getDemoContracts,
  getNativeEthFaucetAddress,
  MAX_ROUTER_AMOUNT,
  nativeEthFaucetAbi,
  PERP_LIQUIDATION_THRESHOLD_BPS,
  stateViewAbi,
  TRUE_ETH_DECIMALS,
  TRUE_USDC_DECIMALS,
  truePerpRouterAbi,
  v4QuoterAbi,
  type DemoPoolKey,
} from "./contracts";

export const unichainSepolia = defineChain({
  id: UNICHAIN_SEPOLIA.id,
  name: UNICHAIN_SEPOLIA.name,
  nativeCurrency: UNICHAIN_SEPOLIA.nativeCurrency,
  rpcUrls: {
    default: { http: [UNICHAIN_SEPOLIA.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Uniscan", url: UNICHAIN_SEPOLIA.explorerUrl },
  },
  testnet: true,
});

export const truePerpPublicClient = createPublicClient({
  chain: unichainSepolia,
  transport: http(UNICHAIN_SEPOLIA.rpcUrl),
});

// The hook's hard admission limit is 95% × 95% = 90.25%. The frontend plans
// against 90.00% at current spot, leaving 25 bps for oracle conservatism and
// rounding, then validates the exact call before it asks for the open signature.
export const SAFE_EXPECTED_OPEN_LTV_BPS = 9_000;
const Q96 = 1n << 96n;

export type DemoToken = "trueEth" | "trueUsdc";
export type DemoFaucetAsset = DemoToken | "nativeEth";

export interface WalletSnapshot {
  nativeBalance: bigint;
  trueEthBalance: bigint;
  trueUsdcBalance: bigint;
  trueUsdcAllowance: bigint;
  trueEthClaimed: boolean;
  trueUsdcClaimed: boolean;
  trueEthFaucetAmount: bigint;
  trueUsdcFaucetAmount: bigint;
  nativeEthFaucetAvailable: boolean;
  nativeEthClaimed: boolean;
  nativeEthClaimAmount: bigint;
  nativeEthRemainingClaims: bigint;
  formatted: {
    nativeBalance: string;
    trueEthBalance: string;
    trueUsdcBalance: string;
    trueUsdcAllowance: string;
    trueEthFaucetAmount: string;
    trueUsdcFaucetAmount: string;
    nativeEthClaimAmount: string;
  };
}

export interface TradeRequest {
  direction: Direction;
  /** Quote-denominated tUSDC margin. Prefer passing the input string verbatim. */
  margin: string | number;
  leverage: number;
  /** 100 = 1%. Constrained to 1–2,000 bps for the demo. */
  slippageBps?: number;
  /** Defaults to 20 minutes and is evaluated immediately before submission. */
  deadlineSeconds?: number;
}

export interface TradePlan {
  direction: Direction;
  margin: bigint;
  borrowAmount: bigint;
  swapInput: bigint;
  zeroForOne: boolean;
  inputDecimals: number;
  outputDecimals: number;
  inputSymbol: "tUSDC" | "tETH";
  outputSymbol: "tUSDC" | "tETH";
  slippageBps: number;
  deadlineSeconds: number;
  preview: PositionPreview;
  poolKey: DemoPoolKey;
}

export interface LiveTradeQuote extends TradePlan {
  requestedBorrowAmount: bigint;
  amountOut: bigint;
  minSwapOutput: bigint;
  gasEstimate: bigint;
  blockNumber: bigint;
  quotedAt: number;
  expectedCollateralValue: bigint;
  expectedDebtValue: bigint;
  expectedEquityValue: bigint;
  expectedOpeningLtvBps: number;
  expectedLeverageBps: number;
  spotPriceQuotePerBase: string;
  borrowWasAdjusted: boolean;
  formatted: {
    margin: string;
    borrowAmount: string;
    swapInput: string;
    amountOut: string;
    minSwapOutput: string;
  };
}

export type TransactionStage =
  | "checking"
  | "approving"
  | "approved"
  | "quoting"
  | "opening"
  | "confirmed";

export interface TransactionProgress {
  stage: TransactionStage;
  message: string;
  hash?: Hash;
}

export interface FaucetReceipt {
  token: DemoFaucetAsset;
  hash: Hash;
  blockNumber: bigint;
}

export interface ApprovalReceipt {
  hash: Hash;
  blockNumber: bigint;
  amount: bigint;
}

export interface OpenTradeReceipt {
  hash: Hash;
  approvalHash?: Hash;
  blockNumber: bigint;
  positionId: Hex;
  quote: LiveTradeQuote;
}

function decimalInput(value: string | number, decimals: number): string {
  const normalized =
    typeof value === "number" ? value.toFixed(decimals) : value.trim().replaceAll(",", "");
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
    throw new Error("Margin must be a positive decimal amount.");
  }
  return normalized;
}

function decimalFromNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("The selected leverage does not produce a positive borrow amount.");
  }
  // toFixed prevents scientific notation, which parseUnits intentionally rejects.
  return value.toFixed(decimals);
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 2_000) {
    throw new Error("Slippage must be between 1 and 2,000 basis points (0.01%–20%).");
  }
  const minimum = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minimum === 0n) throw new Error("The quoted output is too small for slippage protection.");
  return minimum;
}

export function assertRouterAmountBounds(margin: bigint, borrowAmount: bigint): void {
  if (
    borrowAmount > MAX_ROUTER_AMOUNT ||
    margin > MAX_ROUTER_AMOUNT - borrowAmount
  ) {
    throw new Error("Trade size is outside the router's supported signed swap range.");
  }
}

export function buildTradePlan(request: TradeRequest): TradePlan {
  const contracts = getDemoContracts();
  const marginText = decimalInput(request.margin, TRUE_USDC_DECIMALS);
  const marginNumber = Number(marginText);
  if (!Number.isFinite(marginNumber) || marginNumber <= 0) {
    throw new Error("Margin must be greater than zero.");
  }

  const margin = parseUnits(marginText, TRUE_USDC_DECIMALS);
  if (margin === 0n) throw new Error("Margin is below the smallest tUSDC unit.");

  const preview = previewPosition(request.direction, marginNumber, request.leverage);
  const borrowDecimals = request.direction === "long" ? TRUE_USDC_DECIMALS : TRUE_ETH_DECIMALS;
  const borrowValue = request.direction === "long" ? preview.borrowValue : preview.debtBase;
  const borrowAmount = parseUnits(decimalFromNumber(borrowValue, borrowDecimals), borrowDecimals);
  const swapInput = request.direction === "long" ? margin + borrowAmount : borrowAmount;
  if (borrowAmount === 0n) {
    throw new Error("The selected leverage does not produce a positive borrow amount.");
  }
  assertRouterAmountBounds(margin, borrowAmount);

  const slippageBps = request.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  // Validate before an RPC call is attempted.
  applySlippage(1_000_000n, slippageBps);

  const deadlineSeconds = request.deadlineSeconds ?? 20 * 60;
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 60 || deadlineSeconds > 60 * 60) {
    throw new Error("Transaction deadline must be between 60 seconds and one hour.");
  }

  const isLong = request.direction === "long";
  return {
    direction: request.direction,
    margin,
    borrowAmount,
    swapInput,
    zeroForOne: isLong,
    inputDecimals: isLong ? TRUE_USDC_DECIMALS : TRUE_ETH_DECIMALS,
    outputDecimals: isLong ? TRUE_ETH_DECIMALS : TRUE_USDC_DECIMALS,
    inputSymbol: isLong ? "tUSDC" : "tETH",
    outputSymbol: isLong ? "tETH" : "tUSDC",
    slippageBps,
    deadlineSeconds,
    preview,
    poolKey: contracts.poolKey,
  };
}

interface CandidateQuote {
  plan: TradePlan;
  amountOut: bigint;
  gasEstimate: bigint;
  expectedCollateralValue: bigint;
  expectedDebtValue: bigint;
  expectedEquityValue: bigint;
  expectedOpeningLtvBps: number;
  expectedLeverageBps: number;
}

export function baseToQuoteAtSqrtPrice(baseAmount: bigint, sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) throw new Error("The TruePerp pool is not initialized.");
  // Mirrors LiqRangeMath.convertAtSqrtPrice(amount, sqrtP, false): currency1
  // (tETH) into currency0 (tUSDC), including the tokens' raw decimal units.
  return (((baseAmount * Q96) / sqrtPriceX96) * Q96) / sqrtPriceX96;
}

function planWithBorrow(plan: TradePlan, borrowAmount: bigint): TradePlan {
  if (borrowAmount <= 0n) throw new Error("Live quote solver produced zero debt.");
  const swapInput = plan.direction === "long" ? plan.margin + borrowAmount : borrowAmount;
  assertRouterAmountBounds(plan.margin, borrowAmount);
  return { ...plan, borrowAmount, swapInput };
}

async function quoteCandidate(
  basePlan: TradePlan,
  borrowAmount: bigint,
  sqrtPriceX96: bigint,
  blockNumber: bigint,
  account?: Address,
): Promise<CandidateQuote> {
  const contracts = getDemoContracts();
  const plan = planWithBorrow(basePlan, borrowAmount);
  const quoteCall = () => truePerpPublicClient.simulateContract({
      account,
      address: contracts.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: plan.poolKey,
          zeroForOne: plan.zeroForOne,
          exactAmount: plan.swapInput,
          hookData: "0x",
        },
      ],
      blockNumber,
    });
  let simulation: Awaited<ReturnType<typeof quoteCall>>;
  try {
    simulation = await quoteCall();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (!/returned no data|HTTP request failed|429|timed? out/i.test(message)) throw caught;
    // Public testnet endpoints occasionally return an empty response under a
    // short burst. One immediate retry is enough without hiding real reverts.
    simulation = await quoteCall();
  }
  const { result } = simulation;
  const [amountOut, gasEstimate] = result;

  const expectedDebtValue =
    plan.direction === "long"
      ? plan.borrowAmount
      : baseToQuoteAtSqrtPrice(plan.borrowAmount, sqrtPriceX96);
  const expectedCollateralValue =
    plan.direction === "long"
      ? baseToQuoteAtSqrtPrice(amountOut, sqrtPriceX96)
      : plan.margin + amountOut;
  const expectedEquityValue =
    expectedCollateralValue > expectedDebtValue
      ? expectedCollateralValue - expectedDebtValue
      : 0n;
  const expectedOpeningLtvBps =
    expectedCollateralValue > 0n
      ? Number((expectedDebtValue * 10_000n) / expectedCollateralValue)
      : 10_000;
  const directionalNotional =
    plan.direction === "long" ? expectedCollateralValue : expectedDebtValue;
  const expectedLeverageBps =
    expectedEquityValue > 0n
      ? Number((directionalNotional * 10_000n) / expectedEquityValue)
      : Number.MAX_SAFE_INTEGER;

  return {
    plan,
    amountOut,
    gasEstimate,
    expectedCollateralValue,
    expectedDebtValue,
    expectedEquityValue,
    expectedOpeningLtvBps,
    expectedLeverageBps,
  };
}

async function solveBorrowForLiveLtv(
  plan: TradePlan,
  sqrtPriceX96: bigint,
  blockNumber: bigint,
  account?: Address,
): Promise<CandidateQuote> {
  // A 5 bp haircut from the requested LTV makes a nominal 10x request target
  // 89.95%, while the absolute cap stays below the hook's 90.25% admission cap.
  const requestedLtvBps = Math.floor(plan.preview.openingLtv * 10_000);
  const targetLtvBps = Math.max(
    1,
    Math.min(SAFE_EXPECTED_OPEN_LTV_BPS, requestedLtvBps - 5),
  );
  const target = BigInt(targetLtvBps);
  const requested = await quoteCandidate(
    plan,
    plan.borrowAmount,
    sqrtPriceX96,
    blockNumber,
    account,
  );

  if (
    requested.expectedOpeningLtvBps <= targetLtvBps &&
    targetLtvBps - requested.expectedOpeningLtvBps <= 2
  ) return requested;

  let bestSafe: CandidateQuote | null =
    requested.expectedOpeningLtvBps <= targetLtvBps ? requested : null;
  let unsafeBorrow: bigint | null =
    requested.expectedOpeningLtvBps > targetLtvBps ? requested.plan.borrowAmount : null;

  const register = (candidate: CandidateQuote) => {
    if (candidate.expectedOpeningLtvBps <= targetLtvBps) {
      if (!bestSafe || candidate.plan.borrowAmount > bestSafe.plan.borrowAmount) {
        bestSafe = candidate;
      }
    } else if (unsafeBorrow === null || candidate.plan.borrowAmount < unsafeBorrow) {
      unsafeBorrow = candidate.plan.borrowAmount;
    }
  };

  // LTV is close to linear in debt over the narrow correction range. One
  // proportional correction normally lands within 1–2 bps and avoids a long
  // sequence of public-RPC calls at the 10x end of the slider.
  const scaledBorrow =
    (requested.plan.borrowAmount * target) /
    BigInt(Math.max(1, requested.expectedOpeningLtvBps));
  if (scaledBorrow > 0n && scaledBorrow !== requested.plan.borrowAmount) {
    const scaled = await quoteCandidate(
      plan,
      scaledBorrow,
      sqrtPriceX96,
      blockNumber,
      account,
    );
    register(scaled);
    if (
      scaled.expectedOpeningLtvBps <= targetLtvBps &&
      targetLtvBps - scaled.expectedOpeningLtvBps <= 2
    ) return scaled;
  }

  // Establish a bracket only when the proportional correction did not do so.
  if (!bestSafe) {
    let probe = (unsafeBorrow ?? requested.plan.borrowAmount) / 2n;
    for (let i = 0; i < 4 && probe > 0n; i += 1) {
      const candidate = await quoteCandidate(plan, probe, sqrtPriceX96, blockNumber, account);
      register(candidate);
      if (bestSafe) break;
      probe /= 2n;
    }
  }
  if (!bestSafe) throw new Error("Could not find a borrow amount below the safe opening LTV.");

  if (unsafeBorrow === null) {
    let probe = bestSafe.plan.borrowAmount * 2n;
    for (let i = 0; i < 3; i += 1) {
      try {
        const candidate = await quoteCandidate(plan, probe, sqrtPriceX96, blockNumber, account);
        register(candidate);
        if (unsafeBorrow !== null) break;
        probe *= 2n;
      } catch {
        unsafeBorrow = probe;
        break;
      }
    }
  }
  if (unsafeBorrow === null) return bestSafe;

  // Monotonic in this single full-range demo pool. Six bounded refinements are
  // ample after the proportional correction, with an early exit at 2 bps.
  let best = bestSafe;
  let highBorrow: bigint = unsafeBorrow;
  for (
    let i = 0;
    i < 6 && highBorrow - best.plan.borrowAmount > 1n;
    i += 1
  ) {
    const middle: bigint = (best.plan.borrowAmount + highBorrow) / 2n;
    try {
      const candidate = await quoteCandidate(plan, middle, sqrtPriceX96, blockNumber, account);
      if (candidate.expectedOpeningLtvBps <= targetLtvBps) {
        best = candidate;
        if (targetLtvBps - candidate.expectedOpeningLtvBps <= 2) return candidate;
      } else {
        highBorrow = middle;
      }
    } catch {
      highBorrow = middle;
    }
  }
  return best;
}

export async function quoteTrade(
  request: TradeRequest,
  account?: Address,
): Promise<LiveTradeQuote> {
  const contracts = getDemoContracts();
  const plan = buildTradePlan(request);
  const blockNumber = await truePerpPublicClient.getBlockNumber();
  const [sqrtPriceX96] = await truePerpPublicClient.readContract({
    address: contracts.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [contracts.poolId],
    blockNumber,
  });
  const solved = await solveBorrowForLiveLtv(
    plan,
    sqrtPriceX96,
    blockNumber,
    account,
  );
  const minSwapOutput = applySlippage(solved.amountOut, plan.slippageBps);
  const spotPrice = baseToQuoteAtSqrtPrice(
    parseUnits("1", TRUE_ETH_DECIMALS),
    sqrtPriceX96,
  );

  return {
    ...solved.plan,
    requestedBorrowAmount: plan.borrowAmount,
    amountOut: solved.amountOut,
    minSwapOutput,
    gasEstimate: solved.gasEstimate,
    blockNumber,
    quotedAt: Date.now(),
    expectedCollateralValue: solved.expectedCollateralValue,
    expectedDebtValue: solved.expectedDebtValue,
    expectedEquityValue: solved.expectedEquityValue,
    expectedOpeningLtvBps: solved.expectedOpeningLtvBps,
    expectedLeverageBps: solved.expectedLeverageBps,
    spotPriceQuotePerBase: formatUnits(spotPrice, TRUE_USDC_DECIMALS),
    borrowWasAdjusted: solved.plan.borrowAmount !== plan.borrowAmount,
    formatted: {
      margin: formatUnits(plan.margin, TRUE_USDC_DECIMALS),
      borrowAmount: formatUnits(
        solved.plan.borrowAmount,
        plan.direction === "long" ? TRUE_USDC_DECIMALS : TRUE_ETH_DECIMALS,
      ),
      swapInput: formatUnits(solved.plan.swapInput, plan.inputDecimals),
      amountOut: formatUnits(solved.amountOut, plan.outputDecimals),
      minSwapOutput: formatUnits(minSwapOutput, plan.outputDecimals),
    },
  };
}

async function requoteWithBorrow(
  previous: LiveTradeQuote,
  borrowAmount: bigint,
  account: Address,
): Promise<LiveTradeQuote> {
  const contracts = getDemoContracts();
  const blockNumber = await truePerpPublicClient.getBlockNumber();
  const [sqrtPriceX96] = await truePerpPublicClient.readContract({
    address: contracts.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [contracts.poolId],
    blockNumber,
  });
  const candidate = await quoteCandidate(
    previous,
    borrowAmount,
    sqrtPriceX96,
    blockNumber,
    account,
  );
  const minSwapOutput = applySlippage(candidate.amountOut, previous.slippageBps);
  const spotPrice = baseToQuoteAtSqrtPrice(
    parseUnits("1", TRUE_ETH_DECIMALS),
    sqrtPriceX96,
  );
  return {
    ...candidate.plan,
    requestedBorrowAmount: previous.requestedBorrowAmount,
    amountOut: candidate.amountOut,
    minSwapOutput,
    gasEstimate: candidate.gasEstimate,
    blockNumber,
    quotedAt: Date.now(),
    expectedCollateralValue: candidate.expectedCollateralValue,
    expectedDebtValue: candidate.expectedDebtValue,
    expectedEquityValue: candidate.expectedEquityValue,
    expectedOpeningLtvBps: candidate.expectedOpeningLtvBps,
    expectedLeverageBps: candidate.expectedLeverageBps,
    spotPriceQuotePerBase: formatUnits(spotPrice, TRUE_USDC_DECIMALS),
    borrowWasAdjusted: true,
    formatted: {
      margin: formatUnits(candidate.plan.margin, TRUE_USDC_DECIMALS),
      borrowAmount: formatUnits(
        candidate.plan.borrowAmount,
        candidate.plan.direction === "long" ? TRUE_USDC_DECIMALS : TRUE_ETH_DECIMALS,
      ),
      swapInput: formatUnits(candidate.plan.swapInput, candidate.plan.inputDecimals),
      amountOut: formatUnits(candidate.amountOut, candidate.plan.outputDecimals),
      minSwapOutput: formatUnits(minSwapOutput, candidate.plan.outputDecimals),
    },
  };
}

export async function readWalletSnapshot(account: Address): Promise<WalletSnapshot> {
  const contracts = getDemoContracts();
  const nativeEthFaucet = getNativeEthFaucetAddress();
  const normalized = getAddress(account);
  const [
    nativeBalance,
    trueEthBalance,
    trueUsdcBalance,
    trueUsdcAllowance,
    trueEthClaimed,
    trueUsdcClaimed,
    trueEthFaucetAmount,
    trueUsdcFaucetAmount,
  ] = await Promise.all([
    truePerpPublicClient.getBalance({ address: normalized }),
    truePerpPublicClient.readContract({
      address: contracts.trueEth,
      abi: demoTokenAbi,
      functionName: "balanceOf",
      args: [normalized],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "balanceOf",
      args: [normalized],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "allowance",
      args: [normalized, contracts.router],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueEth,
      abi: demoTokenAbi,
      functionName: "hasClaimed",
      args: [normalized],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "hasClaimed",
      args: [normalized],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueEth,
      abi: demoTokenAbi,
      functionName: "faucetAmount",
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "faucetAmount",
    }),
  ]);

  const [nativeEthClaimed, nativeEthClaimAmount, nativeEthRemainingClaims] =
    nativeEthFaucet
      ? await Promise.all([
          truePerpPublicClient.readContract({
            address: nativeEthFaucet,
            abi: nativeEthFaucetAbi,
            functionName: "hasClaimed",
            args: [normalized],
          }),
          truePerpPublicClient.readContract({
            address: nativeEthFaucet,
            abi: nativeEthFaucetAbi,
            functionName: "claimAmount",
          }),
          truePerpPublicClient.readContract({
            address: nativeEthFaucet,
            abi: nativeEthFaucetAbi,
            functionName: "remainingClaims",
          }),
        ])
      : [false, 0n, 0n] as const;

  return {
    nativeBalance,
    trueEthBalance,
    trueUsdcBalance,
    trueUsdcAllowance,
    trueEthClaimed,
    trueUsdcClaimed,
    trueEthFaucetAmount,
    trueUsdcFaucetAmount,
    nativeEthFaucetAvailable: nativeEthFaucet !== null,
    nativeEthClaimed,
    nativeEthClaimAmount,
    nativeEthRemainingClaims,
    formatted: {
      nativeBalance: formatEther(nativeBalance),
      trueEthBalance: formatUnits(trueEthBalance, TRUE_ETH_DECIMALS),
      trueUsdcBalance: formatUnits(trueUsdcBalance, TRUE_USDC_DECIMALS),
      trueUsdcAllowance: formatUnits(trueUsdcAllowance, TRUE_USDC_DECIMALS),
      trueEthFaucetAmount: formatUnits(trueEthFaucetAmount, TRUE_ETH_DECIMALS),
      trueUsdcFaucetAmount: formatUnits(trueUsdcFaucetAmount, TRUE_USDC_DECIMALS),
      nativeEthClaimAmount: formatEther(nativeEthClaimAmount),
    },
  };
}

function getInjectedProvider(): EIP1193Provider {
  const provider = getActiveProvider() as EIP1193Provider | undefined;
  if (!provider) {
    throw new Error("MetaMask or another injected browser wallet is required.");
  }
  return provider;
}

async function connectedWallet(expectedAccount: Address) {
  const provider = getInjectedProvider();
  const chainHex = await provider.request({ method: "eth_chainId" });
  if (Number(BigInt(String(chainHex))) !== UNICHAIN_SEPOLIA.id) {
    throw new Error(`Switch the wallet to ${UNICHAIN_SEPOLIA.name} before transacting.`);
  }

  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  const active = accounts[0] ? getAddress(accounts[0]) : undefined;
  const expected = getAddress(expectedAccount);
  if (!active) throw new Error("Connect the browser wallet before transacting.");
  if (active !== expected) {
    throw new Error("The active wallet account changed. Reconnect the interface and try again.");
  }

  return {
    account: active,
    walletClient: createWalletClient({
      account: active,
      chain: unichainSepolia,
      transport: custom(provider),
    }),
  };
}

export async function claimDemoToken(
  token: DemoToken,
  expectedAccount: Address,
): Promise<FaucetReceipt> {
  const contracts = getDemoContracts();
  const { account, walletClient } = await connectedWallet(expectedAccount);
  const tokenAddress = token === "trueEth" ? contracts.trueEth : contracts.trueUsdc;
  const alreadyClaimed = await truePerpPublicClient.readContract({
    address: tokenAddress,
    abi: demoTokenAbi,
    functionName: "hasClaimed",
    args: [account],
  });
  if (alreadyClaimed) {
    throw new Error(`${token === "trueEth" ? "TrueETH" : "TrueUSDC"} was already claimed by this wallet.`);
  }

  const { request } = await truePerpPublicClient.simulateContract({
    account,
    address: tokenAddress,
    abi: demoTokenAbi,
    functionName: "claim",
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await truePerpPublicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The faucet transaction reverted.");
  return { token, hash, blockNumber: receipt.blockNumber };
}

interface NativeFaucetApiResult {
  hash?: unknown;
  error?: unknown;
  message?: unknown;
}

/**
 * Requests a sponsored claim from the public faucet relay. No wallet
 * transaction is created here: the server's funded signer calls
 * claimFor(account), allowing an address with a zero native balance to start.
 */
export async function claimNativeEth(
  expectedAccount: Address,
): Promise<FaucetReceipt> {
  const faucetAddress = getNativeEthFaucetAddress();
  if (!faucetAddress) {
    throw new Error("The gasless native ETH faucet has not been deployed yet.");
  }
  if (!deployment.nativeFaucetApi) {
    throw new Error("The gasless native ETH faucet relay is not configured yet.");
  }

  const { account, walletClient } = await connectedWallet(expectedAccount);
  const alreadyClaimed = await truePerpPublicClient.readContract({
    address: faucetAddress,
    abi: nativeEthFaucetAbi,
    functionName: "hasClaimed",
    args: [account],
  });
  if (alreadyClaimed) {
    throw new Error("This wallet has already claimed its Unichain Sepolia gas ETH.");
  }

  const message = nativeFaucetClaimMessage(account);
  const signature = await walletClient.signMessage({ account, message });

  const response = await fetch(deployment.nativeFaucetApi, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: account, signature }),
  });
  let payload: NativeFaucetApiResult;
  try {
    payload = await response.json() as NativeFaucetApiResult;
  } catch {
    throw new Error("The gasless faucet relay returned an unreadable response.");
  }

  if (!response.ok) {
    const reason = typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string"
        ? payload.message
        : `Gasless faucet relay failed with HTTP ${response.status}.`;
    throw new Error(reason);
  }
  if (typeof payload.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(payload.hash)) {
    throw new Error("The gasless faucet relay did not return a valid transaction hash.");
  }

  const hash = payload.hash as Hash;
  const receipt = await truePerpPublicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The gasless faucet transaction reverted.");
  return { token: "nativeEth", hash, blockNumber: receipt.blockNumber };
}

export function nativeFaucetClaimMessage(account: Address): string {
  return [
    "TruePerp native gas faucet",
    `Chain ID: ${UNICHAIN_SEPOLIA.id}`,
    `Recipient: ${getAddress(account)}`,
    "Amount: 0.05 ETH",
  ].join("\n");
}

export async function approveTrueUsdcMargin(
  expectedAccount: Address,
  margin: bigint,
): Promise<ApprovalReceipt> {
  if (margin <= 0n) throw new Error("Approval amount must be greater than zero.");
  const contracts = getDemoContracts();
  const { account, walletClient } = await connectedWallet(expectedAccount);
  const { request } = await truePerpPublicClient.simulateContract({
    account,
    address: contracts.trueUsdc,
    abi: demoTokenAbi,
    functionName: "approve",
    args: [contracts.router, margin],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await truePerpPublicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The tUSDC approval transaction reverted.");
  return { hash, blockNumber: receipt.blockNumber, amount: margin };
}

function openPositionArgs(quote: LiveTradeQuote) {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + quote.deadlineSeconds);
  return [
    {
      key: quote.poolKey,
      isLong: quote.direction === "long",
      margin: quote.margin,
      borrowAmount: quote.borrowAmount,
      liquidationThresholdBps: PERP_LIQUIDATION_THRESHOLD_BPS,
      minSwapOutput: quote.minSwapOutput,
      sqrtPriceLimitX96: 0n,
      deadline,
    },
  ] as const;
}

/** Full eth_call of the router path, including the hook's oracle admission. */
export async function preflightQuotedTrade(
  expectedAccount: Address,
  quote: LiveTradeQuote,
): Promise<void> {
  const contracts = getDemoContracts();
  const { account } = await connectedWallet(expectedAccount);
  await truePerpPublicClient.simulateContract({
    account,
    address: contracts.router,
    abi: truePerpRouterAbi,
    functionName: "openPosition",
    args: openPositionArgs(quote),
  });
}

export async function submitQuotedTrade(
  expectedAccount: Address,
  quote: LiveTradeQuote,
): Promise<Omit<OpenTradeReceipt, "approvalHash">> {
  const contracts = getDemoContracts();
  const { account, walletClient } = await connectedWallet(expectedAccount);
  const { request } = await truePerpPublicClient.simulateContract({
    account,
    address: contracts.router,
    abi: truePerpRouterAbi,
    functionName: "openPosition",
    args: openPositionArgs(quote),
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await truePerpPublicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The TruePerp open transaction reverted.");

  const opened = parseEventLogs({
    abi: truePerpRouterAbi,
    eventName: "PerpetualOpened",
    logs: receipt.logs,
    strict: true,
  }).find((log) => getAddress(log.args.trader) === account);
  if (!opened) throw new Error("Trade confirmed, but its PerpetualOpened event could not be decoded.");

  return {
    hash,
    blockNumber: receipt.blockNumber,
    positionId: opened.args.positionId,
    quote,
  };
}

/**
 * Complete two-confirmation flow: exact approval when required, a fresh live
 * v4 quote, then router.openPosition. Approval is never unlimited.
 */
export async function executeTrade(
  expectedAccount: Address,
  request: TradeRequest,
  onProgress?: (progress: TransactionProgress) => void,
): Promise<OpenTradeReceipt> {
  const contracts = getDemoContracts();
  const account = getAddress(expectedAccount);
  const plan = buildTradePlan(request);
  onProgress?.({ stage: "checking", message: "Checking tUSDC balance and allowance…" });

  const [balance, allowance] = await Promise.all([
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "balanceOf",
      args: [account],
    }),
    truePerpPublicClient.readContract({
      address: contracts.trueUsdc,
      abi: demoTokenAbi,
      functionName: "allowance",
      args: [account, contracts.router],
    }),
  ]);
  if (balance < plan.margin) {
    throw new Error("Not enough tUSDC margin. Claim the TrueUSDC demo faucet first.");
  }

  let approvalHash: Hash | undefined;
  if (allowance < plan.margin) {
    onProgress?.({
      stage: "approving",
      message: `Approve exactly ${formatUnits(plan.margin, TRUE_USDC_DECIMALS)} tUSDC as margin…`,
    });
    const approval = await approveTrueUsdcMargin(account, plan.margin);
    approvalHash = approval.hash;
    onProgress?.({ stage: "approved", message: "Margin approval confirmed.", hash: approval.hash });
  }

  // Quote after approval because the pool can move while the first transaction confirms.
  onProgress?.({ stage: "quoting", message: "Getting a fresh Uniswap v4 execution quote…" });
  let quote = await quoteTrade(request, account);
  // Current-spot solving is intentionally followed by a full router simulation,
  // because hook admission uses a borrower-adverse oracle. If that stricter view
  // rejects the candidate, shave debt and re-quote without asking the wallet to
  // sign a transaction that is known to revert.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await preflightQuotedTrade(account, quote);
      break;
    } catch (caught) {
      if (!isAdmissionError(caught) || attempt === 4) throw caught;
      const saferBorrow = (quote.borrowAmount * 9_950n) / 10_000n;
      onProgress?.({
        stage: "quoting",
        message: "Oracle admission is stricter than spot; reducing debt and re-quoting…",
      });
      quote = await requoteWithBorrow(quote, saferBorrow, account);
    }
  }
  onProgress?.({ stage: "opening", message: "Confirm the leveraged position in MetaMask…" });
  const opened = await submitQuotedTrade(account, quote);
  onProgress?.({ stage: "confirmed", message: "Leveraged position opened on-chain.", hash: opened.hash });
  return { ...opened, approvalHash };
}

const revertMessages: Record<string, string> = {
  AlreadyClaimed: "This wallet has already used that token faucet.",
  FaucetExhausted: "The demo faucet has reached its capped supply.",
  Unauthorized: "The native ETH faucet rejected the relay signer.",
  NativeTransferFailed: "The native ETH faucet could not fund this wallet.",
  InsufficientBalance: "The native ETH faucet does not have enough test ETH for another claim.",
  DeadlineExpired: "The quote expired before submission. Request a fresh quote and retry.",
  MarketNotActive: "The deployed TruePerp market is not active.",
  MissingSlippageProtection: "A non-zero minimum swap output is required.",
  TooLittleSwapOutput: "Pool execution moved beyond the selected slippage tolerance. Retry with a fresh quote.",
  LtExceedsPerpetualMarketPolicy: "The position exceeds TruePerp's 95% liquidation-threshold policy.",
  ZeroAmount: "Margin and borrowed amount must both be greater than zero.",
  GapTooSmall: "The position is too close to its liquidation range at the current oracle price.",
  LtvTooHigh: "The borrow amount is above the hook's safe opening LTV.",
  OracleNotReady: "The TruePerp manipulation-resistant oracle is not ready yet.",
};

function contractRevertName(caught: unknown): string | undefined {
  if (!(caught instanceof BaseError)) return undefined;
  const reverted = caught.walk(
    (error) => error instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null;
  return reverted?.data?.errorName;
}

function isAdmissionError(caught: unknown): boolean {
  const errorName = contractRevertName(caught);
  if (errorName === "LtvTooHigh" || errorName === "GapTooSmall") return true;
  const message = caught instanceof Error ? caught.message : String(caught);
  return /LtvTooHigh|GapTooSmall/i.test(message);
}

export function transactionErrorMessage(caught: unknown): string {
  const providerError = caught as { code?: number; shortMessage?: string; message?: string };
  if (providerError?.code === 4001) return "Transaction rejected in MetaMask.";

  if (caught instanceof BaseError) {
    const errorName = contractRevertName(caught);
    if (errorName && revertMessages[errorName]) return revertMessages[errorName];
    return caught.shortMessage || "The blockchain request failed.";
  }

  const message = caught instanceof Error ? caught.message : providerError?.message;
  if (message?.toLowerCase().includes("user rejected")) return "Transaction rejected in MetaMask.";
  if (message?.toLowerCase().includes("insufficient funds")) {
    return "Not enough Unichain Sepolia ETH to pay gas. Fund the connected wallet from a testnet faucet.";
  }
  return message || "The blockchain request failed.";
}
