/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_TRUEPERP_ROUTER?: string;
  readonly VITE_TRUEPERP_HOOK?: string;
  readonly VITE_POOL_MANAGER?: string;
  readonly VITE_POOL_ID?: string;
  readonly VITE_WETH_ADDRESS?: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_DEPLOYMENT_TX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
