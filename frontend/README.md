# TruePerp interface

This directory contains the hackathon trading interface. It deliberately starts
in a safe, non-transactional demo mode: the chart is simulated, leverage values
are illustrative, and no calldata is encoded or submitted.

The screen is split around the demo story:

- the left side is an ETH/USDC chart and a direction-aware long/short ticket;
- the right side shows the physical collateral-and-debt construction and the
  swap/poke-driven gradual-liquidation path; and
- 10x long and 9x short targets use different fee-adjusted borrow formulas,
  matching the protocol's directional leverage convention.

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

## Environment

`VITE_TRUEPERP_ROUTER`, `VITE_TRUEPERP_HOOK`, `VITE_POOL_ID`, and
`VITE_USDC_ADDRESS` intentionally ship empty. Supplying address-shaped strings
changes the banner, but does **not** prove a deployment is valid. Before enabling
transactions, a real client must verify bytecode, router/hook relationships,
pool initialization, market activation, vault funding, and chain ID on-chain.

The checked-in Unichain Sepolia PoolManager is the address listed in the
[official Uniswap v4 deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments).
Network ID, explorer, and RPC details come from the
[official Unichain network reference](https://developers.uniswap.org/docs/unichain/technical-information/network-information).
The public RPC is suitable for development, not production hosting; configure a
managed RPC through `VITE_RPC_URL` for a public demo.

## Host it

For Vercel or Netlify, import the repository and use:

| Setting | Value |
|---|---|
| Root/base directory | `frontend` |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

Copy only verified deployment values into the host's environment settings. The
checked-in `vercel.json` and `netlify.toml` pin the build output, and Netlify's
configuration includes a single-page-app fallback. Vite uses relative asset
paths, so the bundle also works from a static subdirectory.
Every `VITE_*` value is public in the browser bundle; never put a private key or
deployment signer secret there.

## What remains before live trading

The UI is intentionally a presentation-quality simulator, not a partially safe
transaction client. A live integration still needs:

1. an executable Uniswap quote and price-impact model;
2. direction-specific solving from target leverage to `borrowAmount`;
3. a `minSwapOutput`, deadline, and direction-correct sqrt-price limit;
4. wallet approvals and `TruePerpRouter.openPosition` ABI encoding;
5. post-transaction reconciliation with `getPositionMetrics`; and
6. explicit handling for reverts, vault capacity, and market state.

The preview already accounts for a 30 bp pool fee, but deliberately excludes
price impact. It must not be treated as a guaranteed quote.
