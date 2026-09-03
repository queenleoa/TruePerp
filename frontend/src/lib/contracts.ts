import { getAddress, isAddress, type Address, type Hex } from "viem";
import { deployment } from "../config";

export const TRUE_ETH_DECIMALS = 18;
export const TRUE_USDC_DECIMALS = 6;
export const DEMO_POOL_FEE = 3_000;
export const DEMO_TICK_SPACING = 60;
export const PERP_LIQUIDATION_THRESHOLD_BPS = 9_500;
export const DEFAULT_SLIPPAGE_BPS = 100;
// PoolManager represents exact-input swaps as a negative int128. The router
// also requires margin + debt to fit this bound, including for shorts.
export const MAX_ROUTER_AMOUNT = (1n << 127n) - 1n;

export interface DemoPoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface DemoContracts {
  router: Address;
  hook: Address;
  poolManager: Address;
  stateView: Address;
  v4Quoter: Address;
  trueEth: Address;
  trueUsdc: Address;
  poolId: Hex;
  poolKey: DemoPoolKey;
}

function configuredAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${label} is not configured with a valid non-zero address.`);
  }
  return getAddress(value);
}

export function getDemoContracts(): DemoContracts {
  const trueEth = configuredAddress(deployment.baseToken, "TrueETH");
  const trueUsdc = configuredAddress(deployment.quoteToken, "TrueUSDC");
  const hook = configuredAddress(deployment.hook, "TruePerp hook");

  // The deployed PoolKey is currency0=TrueUSDC and currency1=TrueETH. Do not
  // infer direction from the semantic BASE/QUOTE labels when encoding v4 calls.
  if (BigInt(trueUsdc) >= BigInt(trueEth)) {
    throw new Error("Configured demo tokens do not match the deployed v4 PoolKey ordering.");
  }

  if (!/^0x[0-9a-f]{64}$/i.test(deployment.poolId)) {
    throw new Error("TruePerp pool id is not configured as bytes32.");
  }

  return {
    router: configuredAddress(deployment.router, "TruePerp router"),
    hook,
    poolManager: configuredAddress(deployment.poolManager, "Uniswap PoolManager"),
    stateView: configuredAddress(deployment.stateView, "Uniswap StateView"),
    v4Quoter: configuredAddress(deployment.v4Quoter, "Uniswap v4 quoter"),
    trueEth,
    trueUsdc,
    poolId: deployment.poolId as Hex,
    poolKey: {
      currency0: trueUsdc,
      currency1: trueEth,
      fee: DEMO_POOL_FEE,
      tickSpacing: DEMO_TICK_SPACING,
      hooks: hook,
    },
  };
}

/** Returns null while the optional native-gas faucet is not deployed. */
export function getNativeEthFaucetAddress(): Address | null {
  const value = deployment.nativeEthFaucet.trim();
  if (!value || /^0x0{40}$/i.test(value)) return null;
  if (!isAddress(value, { strict: false })) {
    throw new Error("Native ETH faucet is configured with an invalid address.");
  }
  return getAddress(value);
}

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const demoTokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "allowance", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "claimed", type: "bool" }],
  },
  {
    type: "function",
    name: "faucetAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "approved", type: "bool" }],
  },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "FaucetExhausted", inputs: [] },
] as const;

export const nativeEthFaucetAbi = [
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "claimed", type: "bool" }],
  },
  {
    type: "function",
    name: "claimAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "remainingClaims",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "NativeTransferFailed", inputs: [] },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      { name: "available", type: "uint256" },
      { name: "required", type: "uint256" },
    ],
  },
] as const;

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: poolKeyComponents },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

export const truePerpRouterAbi = [
  {
    type: "function",
    name: "openPosition",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "key", type: "tuple", components: poolKeyComponents },
          { name: "isLong", type: "bool" },
          { name: "margin", type: "uint256" },
          { name: "borrowAmount", type: "uint256" },
          { name: "liquidationThresholdBps", type: "uint16" },
          { name: "minSwapOutput", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "positionId", type: "bytes32" }],
  },
  {
    type: "event",
    name: "PerpetualOpened",
    anonymous: false,
    inputs: [
      { name: "positionId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "isLong", type: "bool", indexed: true },
      { name: "margin", type: "uint256", indexed: false },
      { name: "borrowed", type: "uint256", indexed: false },
      { name: "physicalCollateral", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "DeadlineExpired", inputs: [] },
  { type: "error", name: "MarketNotActive", inputs: [] },
  { type: "error", name: "MissingSlippageProtection", inputs: [] },
  { type: "error", name: "TooLittleSwapOutput", inputs: [] },
  { type: "error", name: "LtExceedsPerpetualMarketPolicy", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  // Errors can bubble up from the hook during router simulation. Including
  // their selectors lets viem surface a useful name to the demo interface.
  { type: "error", name: "GapTooSmall", inputs: [] },
  { type: "error", name: "LtvTooHigh", inputs: [] },
  { type: "error", name: "OracleNotReady", inputs: [] },
] as const;
