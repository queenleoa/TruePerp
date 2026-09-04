import { useCallback, useEffect, useMemo, useState } from "react";
import { UNICHAIN_SEPOLIA } from "../config";
import {
  DiscoveredWallet,
  EIP1193ProviderLike,
  getActiveProvider,
  getDiscoveredWallets,
  setActiveWallet,
  subscribeWallets,
} from "../lib/wallets";

export function useWallet() {
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [walletOptions, setWalletOptions] = useState<DiscoveredWallet[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [provider, setProvider] = useState<EIP1193ProviderLike | undefined>(undefined);

  useEffect(() => {
    setWalletOptions(getDiscoveredWallets());
    return subscribeWallets(() => setWalletOptions(getDiscoveredWallets()));
  }, []);

  useEffect(() => {
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
  }, [provider]);

  const connectWithProvider = useCallback(async (selected: EIP1193ProviderLike) => {
    setPending(true);
    setError("");
    try {
      const accounts = await selected.request<string[]>({
        method: "eth_requestAccounts",
      });
      const currentChain = await selected.request<string>({
        method: "eth_chainId",
      });
      setProvider(selected);
      setAddress(accounts[0] || "");
      setChainId(currentChain);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wallet connection failed");
    } finally {
      setPending(false);
    }
  }, []);

  const connect = useCallback(async () => {
    const options = getDiscoveredWallets();
    if (options.length > 1) {
      setPickerOpen(true);
      return;
    }
    if (options.length === 1) {
      setActiveWallet(options[0].uuid);
      await connectWithProvider(options[0].provider);
      return;
    }
    const fallback = getActiveProvider();
    if (!fallback) {
      setError("No browser wallet detected. Install MetaMask or another wallet extension.");
      return;
    }
    await connectWithProvider(fallback);
  }, [connectWithProvider]);

  const selectWallet = useCallback(
    async (uuid: string) => {
      setPickerOpen(false);
      const selected = setActiveWallet(uuid);
      if (selected) await connectWithProvider(selected);
    },
    [connectWithProvider],
  );

  const closePicker = useCallback(() => setPickerOpen(false), []);

  const switchNetwork = useCallback(async () => {
    const active = provider ?? getActiveProvider();
    if (!active) {
      setError("No browser wallet detected");
      return;
    }
    setPending(true);
    setError("");
    try {
      await active.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: UNICHAIN_SEPOLIA.hexId }],
      });
      setChainId(UNICHAIN_SEPOLIA.hexId);
    } catch (caught) {
      const code = (caught as { code?: number })?.code;
      if (code === 4902) {
        try {
          await active.request({
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
  }, [provider]);

  return useMemo(
    () => ({
      address,
      chainId,
      pending,
      error,
      hasProvider:
        walletOptions.length > 0 ||
        (typeof window !== "undefined" && Boolean(getActiveProvider())),
      isCorrectChain: chainId.toLowerCase() === UNICHAIN_SEPOLIA.hexId,
      walletOptions,
      pickerOpen,
      connect,
      selectWallet,
      closePicker,
      switchNetwork,
    }),
    [
      address,
      chainId,
      pending,
      error,
      walletOptions,
      pickerOpen,
      connect,
      selectWallet,
      closePicker,
      switchNetwork,
    ],
  );
}
