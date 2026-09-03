export const UNICHAIN_SEPOLIA = {
  id: 1301,
  hexId: "0x515",
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrl: import.meta.env.VITE_RPC_URL || "https://sepolia.unichain.org",
  explorerUrl: "https://sepolia.uniscan.xyz",
} as const;

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const bytes32Pattern = /^0x[a-fA-F0-9]{64}$/;
const zeroAddress = `0x${"0".repeat(40)}`;

const isAddress = (value: string) =>
  addressPattern.test(value) && value.toLowerCase() !== zeroAddress;

export const deployment = {
  router: import.meta.env.VITE_TRUEPERP_ROUTER || "",
  hook: import.meta.env.VITE_TRUEPERP_HOOK || "",
  poolManager: import.meta.env.VITE_POOL_MANAGER || "",
  positionManager: import.meta.env.VITE_POSITION_MANAGER || "",
  poolId: import.meta.env.VITE_POOL_ID || "",
  baseToken: import.meta.env.VITE_BASE_TOKEN_ADDRESS || "",
  quoteToken: import.meta.env.VITE_QUOTE_TOKEN_ADDRESS || "",
  transaction: import.meta.env.VITE_DEPLOYMENT_TX || "",
};

// This only validates frontend input shape. It deliberately does not claim
// that bytecode, router relationships, pool initialization, or activation have
// been verified on-chain.
export const hasAddressConfiguration =
  isAddress(deployment.router) &&
  isAddress(deployment.hook) &&
  isAddress(deployment.poolManager) &&
  isAddress(deployment.positionManager) &&
  isAddress(deployment.baseToken) &&
  isAddress(deployment.quoteToken) &&
  bytes32Pattern.test(deployment.poolId);

export const hasDeploymentTransaction = bytes32Pattern.test(deployment.transaction);

export const explorerAddressUrl = (address: string) =>
  `${UNICHAIN_SEPOLIA.explorerUrl}/address/${address}`;

export const explorerTransactionUrl = (transaction: string) =>
  `${UNICHAIN_SEPOLIA.explorerUrl}/tx/${transaction}`;

export const formatAddress = (address: string) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not configured";
