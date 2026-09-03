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

// Canonical Uniswap v4 deployment paired with the PoolManager below.
// It is configurable so a future redeployment does not require a code change.
export const DEFAULT_V4_QUOTER = "0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472";

// Public hackathon deployment defaults keep `npm run dev` immediately usable.
// Hosts can override any value with VITE_* variables; no signer secrets belong
// in either location.
export const DEFAULT_DEMO_DEPLOYMENT = {
  router: "0xCE9376A2525CFFDbb1E5f1Fb01e2b04895C1A064",
  hook: "0x71280741519FCfc4c17b3cBdAF6e589E84Ba90c0",
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
  positionManager: "0xf969Aee60879C54bAAed9F3eD26147Db216Fd664",
  stateView: "0xc199F1072a74D4e905ABa1A84d9a45E2546B6222",
  v4Quoter: DEFAULT_V4_QUOTER,
  poolId: "0xb456c2c3c600c7530c3a3b0d238198a466be1943ae5b5e3fd5cbfb831699e3d9",
  baseToken: "0x88b49b8292a9e3174d77c5824dc96E177A56365D",
  quoteToken: "0x1949280616D7Aad370C4fF0BcC2C5a351B90D9e0",
  transaction: "0x5919aded6e37bcb6040f46288e07841a16f6e694971cdefe70e9d03f21708957",
  nativeEthFaucet: "0xf886d5EDF23946103cE5dE1b0F63E242dBFcd0fa",
  nativeFaucetApi: "/api/native-faucet",
} as const;

export const deployment = {
  router: import.meta.env.VITE_TRUEPERP_ROUTER || DEFAULT_DEMO_DEPLOYMENT.router,
  hook: import.meta.env.VITE_TRUEPERP_HOOK || DEFAULT_DEMO_DEPLOYMENT.hook,
  poolManager: import.meta.env.VITE_POOL_MANAGER || DEFAULT_DEMO_DEPLOYMENT.poolManager,
  positionManager:
    import.meta.env.VITE_POSITION_MANAGER || DEFAULT_DEMO_DEPLOYMENT.positionManager,
  stateView: import.meta.env.VITE_STATE_VIEW || DEFAULT_DEMO_DEPLOYMENT.stateView,
  v4Quoter: import.meta.env.VITE_V4_QUOTER || DEFAULT_DEMO_DEPLOYMENT.v4Quoter,
  poolId: import.meta.env.VITE_POOL_ID || DEFAULT_DEMO_DEPLOYMENT.poolId,
  baseToken: import.meta.env.VITE_BASE_TOKEN_ADDRESS || DEFAULT_DEMO_DEPLOYMENT.baseToken,
  quoteToken: import.meta.env.VITE_QUOTE_TOKEN_ADDRESS || DEFAULT_DEMO_DEPLOYMENT.quoteToken,
  transaction: import.meta.env.VITE_DEPLOYMENT_TX || DEFAULT_DEMO_DEPLOYMENT.transaction,
  // These values are public. The server-only relayer key is deliberately not a
  // VITE_* variable and must never be included in the browser configuration.
  nativeEthFaucet:
    import.meta.env.VITE_NATIVE_ETH_FAUCET?.trim() || DEFAULT_DEMO_DEPLOYMENT.nativeEthFaucet,
  nativeFaucetApi:
    import.meta.env.VITE_NATIVE_FAUCET_API?.trim() || DEFAULT_DEMO_DEPLOYMENT.nativeFaucetApi,
};

export const hasNativeEthFaucetConfiguration = isAddress(deployment.nativeEthFaucet);
export const hasNativeFaucetApiConfiguration = deployment.nativeFaucetApi.length > 0;
export const hasGaslessNativeFaucetConfiguration =
  hasNativeEthFaucetConfiguration && hasNativeFaucetApiConfiguration;

// This only validates frontend input shape. It deliberately does not claim
// that bytecode, router relationships, pool initialization, or activation have
// been verified on-chain.
export const hasAddressConfiguration =
  isAddress(deployment.router) &&
  isAddress(deployment.hook) &&
  isAddress(deployment.poolManager) &&
  isAddress(deployment.positionManager) &&
  isAddress(deployment.stateView) &&
  isAddress(deployment.v4Quoter) &&
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
