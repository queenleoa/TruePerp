// EIP-6963 multi-wallet discovery. Every installed wallet extension announces
// itself; the user picks one instead of getting whichever extension claimed
// window.ethereum first.

export interface EIP1193ProviderLike {
  request<T = unknown>(args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }): Promise<T>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
}

export interface DiscoveredWallet {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: EIP1193ProviderLike;
}

const wallets = new Map<string, DiscoveredWallet>();
const listeners = new Set<() => void>();
let activeProvider: EIP1193ProviderLike | null = null;
let started = false;

function notify() {
  listeners.forEach((listener) => listener());
}

function startDiscovery() {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<{
      info: { uuid: string; name: string; icon: string; rdns: string };
      provider: EIP1193ProviderLike;
    }>).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    wallets.set(detail.info.uuid, { ...detail.info, provider: detail.provider });
    notify();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function subscribeWallets(listener: () => void): () => void {
  startDiscovery();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDiscoveredWallets(): DiscoveredWallet[] {
  startDiscovery();
  return [...wallets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function setActiveWallet(uuid: string): EIP1193ProviderLike | null {
  const wallet = wallets.get(uuid);
  activeProvider = wallet?.provider ?? null;
  return activeProvider;
}

/** Selected wallet if the user picked one, otherwise the legacy injected provider. */
export function getActiveProvider(): EIP1193ProviderLike | undefined {
  if (activeProvider) return activeProvider;
  if (typeof window === "undefined") return undefined;
  return (window as typeof window & { ethereum?: EIP1193ProviderLike }).ethereum;
}
