# TruePerp interface

This directory contains the hackathon interface for the TrueETH/TrueUSDC demo
market. TrueETH is an 18-decimal mock base asset and TrueUSDC is a 6-decimal
mock quote asset. Both are capped, unbacked test tokens with no redemption
right or external price guarantee. The interface therefore labels them by
their actual names instead of presenting them as WETH or USDC.

The screen is organized around the protocol mechanism:

- the left side shows a simulated TrueETH/TrueUSDC chart and a
  direction-aware long/short ticket;
- the right side traces the physical collateral-and-debt construction and the
  swap/poke-driven gradual-liquidation path; and
- 10x long and 9x short targets use different fee-adjusted borrow formulas,
  matching the protocol's directional leverage convention.

The pool starts at the demonstration convention of 2,000 TrueUSDC per TrueETH.
The chart is simulated and is not an ETH/USD feed or a protocol oracle.

## Run locally

Node.js `^20.19.0` or `>=22.12.0` is required.

```bash
cd frontend
cp .env.example .env.local
npm ci
npm test
npm run dev
```

Build and inspect the same static bundle that a host will serve:

```bash
npm run build
npm run preview
```

The production output is `frontend/dist/`.
The checked-in `.env.production` supplies only the public, verified Unichain
Sepolia demo addresses, so a production build links to the deployed market by
default. Hosting-provider variables may override these values.

## Environment

The market uses semantic token variables:

| Variable | Meaning |
|---|---|
| `VITE_BASE_TOKEN_ADDRESS` | TrueETH; 18-decimal asset whose price exposure is traded |
| `VITE_QUOTE_TOKEN_ADDRESS` | TrueUSDC; 6-decimal margin, debt, and accounting asset |
| `VITE_TRUEPERP_ROUTER` | Canonical product entry router |
| `VITE_TRUEPERP_HOOK` | Position and liquidation hook |
| `VITE_POOL_MANAGER` | Uniswap v4 PoolManager |
| `VITE_POSITION_MANAGER` | Uniswap v4 PositionManager that owns the LP NFT ledger |
| `VITE_POOL_ID` | TrueETH/TrueUSDC hook-pool identifier |
| `VITE_DEPLOYMENT_TX` | Optional explorer link target |

`BASE` and `QUOTE` do not imply `currency0` and `currency1`. Uniswap orders a
`PoolKey` by address, so either mock token may be currency0. Deployment and
client code must derive ordering from addresses while preserving the semantic
roles above.

The checked-in example contains the public Unichain Sepolia demo addresses
recorded in [`deployments/unichain-sepolia.json`](../deployments/unichain-sepolia.json).
Supplying address-shaped strings changes the banner, but the preview itself
does **not** prove a deployment is valid. A transactional client must verify
bytecode, router/hook relationships, pool initialization, market activation,
vault funding, oracle readiness, and chain ID on-chain.

The checked-in PoolManager and PositionManager values are from the
[official Uniswap v4 deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments).
Network ID, explorer, and RPC details come from the
[official Unichain network reference](https://developers.uniswap.org/docs/unichain/technical-information/network-information).
The public RPC is suitable for development, not production hosting; use a
managed RPC for a public demo.

Every `VITE_*` value is public in the browser bundle. Never place a wallet
private key, mnemonic, or deployment signer secret in a frontend environment
variable.

## Host it

For Vercel or Netlify, import the repository and use:

| Setting | Value |
|---|---|
| Root/base directory | `frontend` |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

Copy only verified public deployment values into the host's environment
settings. The checked-in `vercel.json` and `netlify.toml` pin the build output,
and Netlify's configuration includes a single-page-app fallback. Vite uses
relative asset paths, so the bundle also works from a static subdirectory.

## Transaction boundary

The current UI is a presentation-quality simulator. Wallet connection is used
only for network detection. The application does not read protocol state,
request token approvals, encode calldata, or submit transactions—even when all
deployment addresses are supplied.

A live integration still requires:

1. an executable Uniswap quote and price-impact model;
2. direction-specific solving from target leverage to `borrowAmount`;
3. `minSwapOutput`, deadline, and direction-correct square-root price limits;
4. TrueUSDC approval and `TruePerpRouter.openPosition` ABI encoding;
5. post-transaction reconciliation with `getPositionMetrics`; and
6. explicit handling for reverts, vault capacity, and market/oracle state.

The preview accounts for a 30 bp pool fee but deliberately excludes price
impact. It is not a guaranteed quote. See the root [deployment guide](../DEPLOYMENT.md)
for mock-token supply, LP initialization, lending-vault capitalization, and
oracle warm-up.
