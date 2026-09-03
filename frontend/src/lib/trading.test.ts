import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hash,
} from "viem";
import type { LiveTradeQuote } from "./trading";

const addresses = {
  router: "0xCE9376A2525CFFDbb1E5f1Fb01e2b04895C1A064",
  hook: "0x71280741519FCfc4c17b3cBdAF6e589E84Ba90c0",
  manager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
  positionManager: "0xf969Aee60879C54bAAed9F3eD26147Db216Fd664",
  stateView: "0xc199F1072a74D4e905ABa1A84d9a45E2546B6222",
  quoter: "0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472",
  trueEth: "0x88b49b8292a9e3174d77c5824dc96E177A56365D",
  trueUsdc: "0x1949280616D7Aad370C4fF0BcC2C5a351B90D9e0",
  nativeFaucet: "0x2222222222222222222222222222222222222222",
  poolId: "0xb456c2c3c600c7530c3a3b0d238198a466be1943ae5b5e3fd5cbfb831699e3d9",
} as const;

const judge = "0x1111111111111111111111111111111111111111" as Address;
const faucetHash = `0x${"a".repeat(64)}` as Hash;
const openHash = `0x${"b".repeat(64)}` as Hash;
const positionId = `0x${"c".repeat(64)}` as Hash;
const faucetSignature = `0x${"d".repeat(130)}` as Hash;

const originalWindow = globalThis.window;

function installInjectedWallet(chainId = "0x515", account: Address = judge) {
  const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
    if (method === "eth_chainId") return chainId;
    if (method === "eth_accounts") return [account];
    if (method === "personal_sign") return faucetSignature;
    if (method === "eth_sendTransaction") return faucetHash;
    throw new Error(`Unexpected wallet request: ${method}`);
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { ethereum: { request } },
  });
  return request;
}

function liveLongQuote(): LiveTradeQuote {
  const plan = trading.buildTradePlan({
    direction: "long",
    margin: "1000",
    leverage: 5,
    slippageBps: 50,
  });
  const amountOut = parseUnits("2.49", 18);
  return {
    ...plan,
    requestedBorrowAmount: plan.borrowAmount,
    amountOut,
    minSwapOutput: (amountOut * 9_950n) / 10_000n,
    gasEstimate: 500_000n,
    blockNumber: 61_600_000n,
    quotedAt: Date.now(),
    expectedCollateralValue: parseUnits("4980", 6),
    expectedDebtValue: plan.borrowAmount,
    expectedEquityValue: parseUnits("1000", 6),
    expectedOpeningLtvBps: 7_990,
    expectedLeverageBps: 49_800,
    spotPriceQuotePerBase: "2000",
    borrowWasAdjusted: false,
    formatted: {
      margin: "1000",
      borrowAmount: "3980",
      swapInput: "4980",
      amountOut: "2.49",
      minSwapOutput: "2.47755",
    },
  };
}

type TradingModule = typeof import("./trading");
type ContractsModule = typeof import("./contracts");
let trading: TradingModule;
let contracts: ContractsModule;

beforeAll(async () => {
  vi.stubEnv("VITE_TRUEPERP_ROUTER", addresses.router);
  vi.stubEnv("VITE_TRUEPERP_HOOK", addresses.hook);
  vi.stubEnv("VITE_POOL_MANAGER", addresses.manager);
  vi.stubEnv("VITE_POSITION_MANAGER", addresses.positionManager);
  vi.stubEnv("VITE_STATE_VIEW", addresses.stateView);
  vi.stubEnv("VITE_V4_QUOTER", addresses.quoter);
  vi.stubEnv("VITE_BASE_TOKEN_ADDRESS", addresses.trueEth);
  vi.stubEnv("VITE_QUOTE_TOKEN_ADDRESS", addresses.trueUsdc);
  vi.stubEnv("VITE_POOL_ID", addresses.poolId);
  vi.stubEnv("VITE_NATIVE_ETH_FAUCET", addresses.nativeFaucet);
  vi.stubEnv("VITE_NATIVE_FAUCET_API", "/api/native-faucet");
  vi.resetModules();
  trading = await import("./trading");
  contracts = await import("./contracts");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (typeof originalWindow === "undefined") {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
  }
});

describe("TruePerp transaction planning", () => {
  it("applies integer slippage without ever approving an unlimited amount", () => {
    expect(trading.applySlippage(1_000_000n, 100)).toBe(990_000n);
    expect(() => trading.applySlippage(1_000_000n, 0)).toThrow(/Slippage/);
    expect(() => trading.applySlippage(1_000_000n, 2_001)).toThrow(/Slippage/);
  });

  it("builds the deployed currency0-to-currency1 long leg", () => {
    const plan = trading.buildTradePlan({
      direction: "long",
      margin: "1000",
      leverage: 10,
      slippageBps: 100,
    });

    expect(plan.margin).toBe(1_000_000_000n);
    expect(plan.borrowAmount).toBeGreaterThan(8_700_000_000n);
    expect(plan.borrowAmount).toBeLessThan(8_800_000_000n);
    expect(plan.swapInput).toBe(plan.margin + plan.borrowAmount);
    expect(plan.zeroForOne).toBe(true);
    expect(plan.poolKey.currency0.toLowerCase()).toBe(addresses.trueUsdc.toLowerCase());
    expect(plan.poolKey.currency1.toLowerCase()).toBe(addresses.trueEth.toLowerCase());
  });

  it("accepts a human-formatted margin without changing token precision", () => {
    const plan = trading.buildTradePlan({
      direction: "long",
      margin: "1,000.25",
      leverage: 2,
    });
    expect(plan.margin).toBe(parseUnits("1000.25", 6));
  });

  it("builds a short that borrows base and swaps currency1-to-currency0", () => {
    const plan = trading.buildTradePlan({
      direction: "short",
      margin: "1000",
      leverage: 9,
    });

    expect(plan.margin).toBe(parseUnits("1000", 6));
    expect(plan.borrowAmount).toBeGreaterThan(parseUnits("4.3", 18));
    expect(plan.borrowAmount).toBeLessThan(parseUnits("4.5", 18));
    expect(plan.swapInput).toBe(plan.borrowAmount);
    expect(plan.zeroForOne).toBe(false);
    expect(plan.inputSymbol).toBe("tETH");
    expect(plan.outputSymbol).toBe("tUSDC");
  });

  it("rejects sizes above the router's signed int128 settlement bound", () => {
    expect(() => trading.assertRouterAmountBounds(
      1n,
      contracts.MAX_ROUTER_AMOUNT,
    )).toThrow(/signed swap range/);
    expect(() => trading.assertRouterAmountBounds(
      1n,
      contracts.MAX_ROUTER_AMOUNT - 1n,
    )).not.toThrow();
  });

  it("matches the deployed 2,000 tUSDC/tETH sqrt-price convention", () => {
    const initialSqrtPriceX96 = 1_771_595_571_142_957_102_961_017_161_607_260n;
    const quoteRaw = trading.baseToQuoteAtSqrtPrice(
      parseUnits("1", 18),
      initialSqrtPriceX96,
    );
    expect(quoteRaw).toBeGreaterThanOrEqual(parseUnits("1999.99", 6));
    expect(quoteRaw).toBeLessThanOrEqual(parseUnits("2000.01", 6));
  });

  it("encodes the exact nested OpenParams shape expected by the router", () => {
    const plan = trading.buildTradePlan({
      direction: "long",
      margin: "250.25",
      leverage: 3,
    });
    const args = [{
      key: plan.poolKey,
      isLong: true,
      margin: plan.margin,
      borrowAmount: plan.borrowAmount,
      liquidationThresholdBps: contracts.PERP_LIQUIDATION_THRESHOLD_BPS,
      minSwapOutput: 1n,
      sqrtPriceLimitX96: 0n,
      deadline: 2_000_000_000n,
    }] as const;
    const data = encodeFunctionData({
      abi: contracts.truePerpRouterAbi,
      functionName: "openPosition",
      args,
    });
    const decoded = decodeFunctionData({ abi: contracts.truePerpRouterAbi, data });

    expect(decoded.functionName).toBe("openPosition");
    expect(decoded.args?.[0].key.fee).toBe(3_000);
    expect(decoded.args?.[0].key.tickSpacing).toBe(60);
    expect(decoded.args?.[0].liquidationThresholdBps).toBe(9_500);
    expect(decoded.args?.[0].margin).toBe(parseUnits("250.25", 6));
  });

  it("turns common wallet and gas failures into judge-facing messages", () => {
    expect(trading.transactionErrorMessage({ code: 4001 })).toMatch(/rejected/i);
    expect(trading.transactionErrorMessage(new Error("insufficient funds for gas"))).toMatch(
      /Sepolia ETH/i,
    );
  });
});

describe("TruePerp judge transaction boundary", () => {
  it("reads and formats both faucet assets, native gas, claim state, and allowance", async () => {
    vi.spyOn(trading.truePerpPublicClient, "getBalance").mockResolvedValue(
      parseUnits("0.0123", 18),
    );
    const readContract = vi.spyOn(trading.truePerpPublicClient, "readContract");
    readContract
      .mockResolvedValueOnce(parseUnits("1.25", 18))
      .mockResolvedValueOnce(parseUnits("1234.56", 6))
      .mockResolvedValueOnce(parseUnits("500", 6))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(parseUnits("5", 18))
      .mockResolvedValueOnce(parseUnits("10000", 6))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(parseUnits("0.05", 18))
      .mockResolvedValueOnce(19n);

    const snapshot = await trading.readWalletSnapshot(judge);

    expect(snapshot.formatted).toEqual({
      nativeBalance: "0.0123",
      trueEthBalance: "1.25",
      trueUsdcBalance: "1234.56",
      trueUsdcAllowance: "500",
      trueEthFaucetAmount: "5",
      trueUsdcFaucetAmount: "10000",
      nativeEthClaimAmount: "0.05",
    });
    expect(snapshot.trueEthClaimed).toBe(true);
    expect(snapshot.trueUsdcClaimed).toBe(false);
    expect(snapshot.nativeEthFaucetAvailable).toBe(true);
    expect(snapshot.nativeEthClaimed).toBe(false);
    expect(snapshot.nativeEthRemainingClaims).toBe(19n);
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      "balanceOf",
      "balanceOf",
      "allowance",
      "hasClaimed",
      "hasClaimed",
      "faucetAmount",
      "faucetAmount",
      "hasClaimed",
      "claimAmount",
      "remainingClaims",
    ]);
  });

  it("requests native gas through a personal signature and relayer, with no wallet transaction", async () => {
    const walletRequest = installInjectedWallet();
    vi.spyOn(trading.truePerpPublicClient, "readContract").mockResolvedValue(false);
    const relay = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hash: faucetHash }),
    } as Response);
    vi.spyOn(trading.truePerpPublicClient, "waitForTransactionReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 61_600_002n,
      logs: [],
    } as never);

    const receipt = await trading.claimNativeEth(judge);

    expect(trading.nativeFaucetClaimMessage(judge)).toBe(
      `TruePerp native gas faucet\nChain ID: 1301\nRecipient: ${judge}\nAmount: 0.05 ETH`,
    );
    expect(receipt).toEqual({
      token: "nativeEth",
      hash: faucetHash,
      blockNumber: 61_600_002n,
    });
    expect(relay).toHaveBeenCalledWith("/api/native-faucet", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ recipient: judge, signature: faucetSignature }),
    }));
    expect(walletRequest.mock.calls.map(([call]) => call.method)).toContain("personal_sign");
    expect(walletRequest.mock.calls.map(([call]) => call.method)).not.toContain(
      "eth_sendTransaction",
    );
  });

  it("submits a TrueUSDC faucet claim through the connected wallet and waits for success", async () => {
    const walletRequest = installInjectedWallet();
    vi.spyOn(trading.truePerpPublicClient, "readContract").mockResolvedValue(false);
    const simulate = vi.spyOn(trading.truePerpPublicClient, "simulateContract").mockResolvedValue({
      request: {
        account: judge,
        address: addresses.trueUsdc,
        abi: contracts.demoTokenAbi,
        functionName: "claim",
      },
      result: parseUnits("10000", 6),
    } as never);
    vi.spyOn(trading.truePerpPublicClient, "waitForTransactionReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 61_600_001n,
      logs: [],
    } as never);

    const receipt = await trading.claimDemoToken("trueUsdc", judge);

    expect(receipt).toEqual({
      token: "trueUsdc",
      hash: faucetHash,
      blockNumber: 61_600_001n,
    });
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({
      account: judge,
      address: addresses.trueUsdc,
      functionName: "claim",
    }));
    expect(walletRequest.mock.calls.map(([call]) => call.method)).toContain("eth_sendTransaction");
  });

  it("blocks a faucet write when the injected wallet is on the wrong chain", async () => {
    const walletRequest = installInjectedWallet("0x1");
    const simulate = vi.spyOn(trading.truePerpPublicClient, "simulateContract");

    await expect(trading.claimDemoToken("trueEth", judge)).rejects.toThrow(
      /Switch the wallet to Unichain Sepolia/,
    );
    expect(simulate).not.toHaveBeenCalled();
    expect(walletRequest.mock.calls.map(([call]) => call.method)).not.toContain(
      "eth_sendTransaction",
    );
  });

  it("preflights the router with the quoted debt, slippage bound, and 95% LT policy", async () => {
    installInjectedWallet();
    const quote = liveLongQuote();
    const simulate = vi.spyOn(trading.truePerpPublicClient, "simulateContract").mockResolvedValue({
      request: {} as never,
      result: positionId,
    } as never);

    await trading.preflightQuotedTrade(judge, quote);

    const call = simulate.mock.calls[0][0] as unknown as {
      account: Address;
      address: Address;
      functionName: string;
      args: [{
        key: LiveTradeQuote["poolKey"];
        isLong: boolean;
        margin: bigint;
        borrowAmount: bigint;
        liquidationThresholdBps: number;
        minSwapOutput: bigint;
        sqrtPriceLimitX96: bigint;
        deadline: bigint;
      }];
    };
    expect(call).toEqual(expect.objectContaining({
      account: judge,
      address: addresses.router,
      functionName: "openPosition",
    }));
    expect(call.args?.[0]).toEqual(expect.objectContaining({
      key: quote.poolKey,
      isLong: true,
      margin: quote.margin,
      borrowAmount: quote.borrowAmount,
      liquidationThresholdBps: 9_500,
      minSwapOutput: quote.minSwapOutput,
      sqrtPriceLimitX96: 0n,
    }));
    expect(call.args?.[0].deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1_000)));
  });

  it("decodes the confirmed PerpetualOpened event into the judge receipt", async () => {
    const walletRequest = installInjectedWallet();
    walletRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x515";
      if (method === "eth_accounts") return [judge];
      if (method === "eth_sendTransaction") return openHash;
      throw new Error(`Unexpected wallet request: ${method}`);
    });
    const quote = liveLongQuote();
    vi.spyOn(trading.truePerpPublicClient, "simulateContract").mockResolvedValue({
      request: {
        account: judge,
        address: addresses.router,
        abi: contracts.truePerpRouterAbi,
        functionName: "openPosition",
        args: [{
          key: quote.poolKey,
          isLong: true,
          margin: quote.margin,
          borrowAmount: quote.borrowAmount,
          liquidationThresholdBps: 9_500,
          minSwapOutput: quote.minSwapOutput,
          sqrtPriceLimitX96: 0n,
          deadline: 2_000_000_000n,
        }],
      } as never,
      result: positionId,
    } as never);
    const topics = encodeEventTopics({
      abi: contracts.truePerpRouterAbi,
      eventName: "PerpetualOpened",
      args: { positionId, trader: judge, isLong: true },
    });
    const data = encodeAbiParameters(
      [
        { name: "margin", type: "uint256" },
        { name: "borrowed", type: "uint256" },
        { name: "physicalCollateral", type: "uint256" },
      ],
      [quote.margin, quote.borrowAmount, quote.amountOut],
    );
    vi.spyOn(trading.truePerpPublicClient, "waitForTransactionReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 61_600_002n,
      logs: [{ address: addresses.router, data, topics }],
    } as never);

    const receipt = await trading.submitQuotedTrade(judge, quote);

    expect(receipt.hash).toBe(openHash);
    expect(receipt.positionId).toBe(positionId);
    expect(receipt.quote).toBe(quote);
  });
});
