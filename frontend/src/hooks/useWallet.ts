import { useCallback, useEffect, useMemo, useState } from "react";
import { UNICHAIN_SEPOLIA } from "../config";

interface EthereumProvider {
  request<T = unknown>(args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }): Promise<T>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function useWallet() {
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!window.ethereum) return;
    const [accounts, currentChain] = await Promise.all([
      window.ethereum.request<string[]>({ method: "eth_accounts" }),
      window.ethereum.request<string>({ method: "eth_chainId" }),
    ]);
    setAddress(accounts[0] || "");
    setChainId(currentChain);
  }, []);

  useEffect(() => {
    void refresh();
    const provider = window.ethereum;
    if (!provider?.on) return;

    const handleAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setAddress(accounts?.[0] || "");
    };
    const handleChain = (...args: unknown[]) => setChainId(String(args[0] || ""));
    provider.on("accountsChanged", handleAccounts);
    provider.on("chainChanged", handleChain);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccounts);
      provider.removeListener?.("chainChanged", handleChain);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No browser wallet detected");
      return;
    }
    setPending(true);
    setError("");
    try {
      const accounts = await window.ethereum.request<string[]>({
        method: "eth_requestAccounts",
      });
      const currentChain = await window.ethereum.request<string>({
        method: "eth_chainId",
      });
      setAddress(accounts[0] || "");
      setChainId(currentChain);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wallet connection failed");
    } finally {
      setPending(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum) {
      setError("No browser wallet detected");
      return;
    }
    setPending(true);
    setError("");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: UNICHAIN_SEPOLIA.hexId }],
      });
      setChainId(UNICHAIN_SEPOLIA.hexId);
    } catch (caught) {
      const code = (caught as { code?: number })?.code;
      if (code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: UNICHAIN_SEPOLIA.hexId,
                chainName: UNICHAIN_SEPOLIA.name,
                nativeCurrency: UNICHAIN_SEPOLIA.nativeCurrency,
                rpcUrls: [UNICHAIN_SEPOLIA.rpcUrl],
                blockExplorerUrls: [UNICHAIN_SEPOLIA.explorerUrl],
              },
            ],
          });
          setChainId(UNICHAIN_SEPOLIA.hexId);
        } catch (addError) {
          setError(addError instanceof Error ? addError.message : "Could not add Unichain Sepolia");
        }
      } else {
        setError(caught instanceof Error ? caught.message : "Network switch failed");
      }
    } finally {
      setPending(false);
    }
  }, []);

  return useMemo(
    () => ({
      address,
      chainId,
      pending,
      error,
      hasProvider: typeof window !== "undefined" && Boolean(window.ethereum),
      isCorrectChain: chainId.toLowerCase() === UNICHAIN_SEPOLIA.hexId,
      connect,
      switchNetwork,
    }),
    [address, chainId, pending, error, connect, switchNetwork],
  );
}
