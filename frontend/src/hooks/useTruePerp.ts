import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import {
  claimDemoToken,
  claimNativeEth,
  executeTrade,
  quoteTrade,
  readWalletSnapshot,
  transactionErrorMessage,
  type DemoToken,
  type FaucetReceipt,
  type LiveTradeQuote,
  type OpenTradeReceipt,
  type TradeRequest,
  type TransactionProgress,
  type WalletSnapshot,
} from "../lib/trading";

export type TruePerpAction =
  | "refresh"
  | "claimTrueEth"
  | "claimTrueUsdc"
  | "claimNativeEth"
  | "quote"
  | "trade"
  | null;

export interface UseTruePerpOptions {
  address: string;
  isCorrectChain: boolean;
  /** Set false when a parent component owns refresh timing. */
  poll?: boolean;
}

/**
 * UI-facing state wrapper for the Unichain Sepolia demo. It deliberately takes
 * wallet identity/network state from useWallet so there is one source of truth
 * for MetaMask account and chain events.
 */
export function useTruePerp({
  address,
  isCorrectChain,
  poll = true,
}: UseTruePerpOptions) {
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [quote, setQuote] = useState<LiveTradeQuote | null>(null);
  const [lastFaucetReceipt, setLastFaucetReceipt] = useState<FaucetReceipt | null>(null);
  const [lastTrade, setLastTrade] = useState<OpenTradeReceipt | null>(null);
  const [progress, setProgress] = useState<TransactionProgress | null>(null);
  const [action, setAction] = useState<TruePerpAction>(null);
  const [error, setError] = useState("");
  const walletContextRef = useRef("");

  const account = useMemo<Address | null>(() => {
    if (!isAddress(address, { strict: false })) return null;
    return getAddress(address);
  }, [address]);
  const walletContext = `${account ?? "disconnected"}:${isCorrectChain ? "1301" : "wrong-chain"}`;
  walletContextRef.current = walletContext;

  const refresh = useCallback(async () => {
    if (!account || !isCorrectChain) {
      setSnapshot(null);
      return null;
    }
    const requestContext = `${account}:1301`;
    setAction((current) => current ?? "refresh");
    try {
      const next = await readWalletSnapshot(account);
      if (walletContextRef.current === requestContext) setSnapshot(next);
      return next;
    } catch (caught) {
      if (walletContextRef.current === requestContext) {
        setError(transactionErrorMessage(caught));
      }
      return null;
    } finally {
      setAction((current) => (current === "refresh" ? null : current));
    }
  }, [account, isCorrectChain]);

  useEffect(() => {
    setQuote(null);
    setLastTrade(null);
    setLastFaucetReceipt(null);
    setProgress(null);
    setError("");
    void refresh();
    if (!poll || !account || !isCorrectChain) return;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [account, isCorrectChain, poll, refresh]);

  const claim = useCallback(
    async (token: DemoToken) => {
      if (!account) {
        setError("Connect MetaMask before using the demo faucet.");
        return null;
      }
      if (!isCorrectChain) {
        setError("Switch MetaMask to Unichain Sepolia before using the faucet.");
        return null;
      }
      setAction(token === "trueEth" ? "claimTrueEth" : "claimTrueUsdc");
      setError("");
      try {
        const receipt = await claimDemoToken(token, account);
        setLastFaucetReceipt(receipt);
        await refresh();
        return receipt;
      } catch (caught) {
        setError(transactionErrorMessage(caught));
        return null;
      } finally {
        setAction(null);
      }
    },
    [account, isCorrectChain, refresh],
  );

  const claimGasEth = useCallback(async () => {
    if (!account) {
      setError("Connect MetaMask before requesting gas ETH.");
      return null;
    }
    if (!isCorrectChain) {
      setError("Switch MetaMask to Unichain Sepolia before requesting gas ETH.");
      return null;
    }
    setAction("claimNativeEth");
    setError("");
    try {
      const receipt = await claimNativeEth(account);
      setLastFaucetReceipt(receipt);
      await refresh();
      return receipt;
    } catch (caught) {
      setError(transactionErrorMessage(caught));
      return null;
    } finally {
      setAction(null);
    }
  }, [account, isCorrectChain, refresh]);

  const requestQuote = useCallback(
    async (request: TradeRequest) => {
      setQuote(null);
      setLastTrade(null);
      setProgress(null);
      setAction("quote");
      setError("");
      try {
        const next = await quoteTrade(request, account ?? undefined);
        setQuote(next);
        return next;
      } catch (caught) {
        setError(transactionErrorMessage(caught));
        return null;
      } finally {
        setAction(null);
      }
    },
    [account],
  );

  const open = useCallback(
    async (request: TradeRequest) => {
      if (!account) {
        setError("Connect MetaMask before opening a position.");
        return null;
      }
      if (!isCorrectChain) {
        setError("Switch MetaMask to Unichain Sepolia before opening a position.");
        return null;
      }
      setAction("trade");
      setError("");
      setProgress({ stage: "checking", message: "Preparing the on-chain position…" });
      try {
        const receipt = await executeTrade(account, request, setProgress);
        setLastTrade(receipt);
        setQuote(receipt.quote);
        await refresh();
        return receipt;
      } catch (caught) {
        setError(transactionErrorMessage(caught));
        return null;
      } finally {
        setAction(null);
      }
    },
    [account, isCorrectChain, refresh],
  );

  const clearFeedback = useCallback(() => {
    setError("");
    setProgress(null);
  }, []);

  return {
    account,
    snapshot,
    quote,
    lastFaucetReceipt,
    lastTrade,
    progress,
    action,
    error,
    isBusy: action !== null,
    refresh,
    claim,
    claimGasEth,
    requestQuote,
    open,
    clearFeedback,
  };
}
