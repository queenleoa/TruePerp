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
npm ci
npm test
npm run dev
```

No local environment file is required for the checked-in hackathon deployment:
its public addresses are safe defaults in `src/config.ts`. Copy `.env.example`
to `.env.local` only when overriding the RPC or targeting another deployment.

Build and inspect the same static bundle that a host will serve:

```bash
npm run build
npm run preview
```

The production output is `frontend/dist/`.
The checked-in `.env.production` supplies only the public, verified Unichain
Sepolia demo addresses, so a production build links to the deployed market by
default. Hosting-provider variables may override these values.

## Judge walkthrough

The demo writes to the deployed Unichain Sepolia market. The price chart is a
simulated presentation series; faucet claims, token approvals, quotes, and
position opens use the live testnet contracts.

1. Open the application and click **Connect wallet**. Approve the MetaMask
   request. If prompted, click **Switch to Unichain Sepolia**; the application
   asks MetaMask to add the network when it is not already configured.
2. Obtain a small amount of native Unichain Sepolia ETH for gas from a provider
   listed in the [official Unichain faucet directory](https://developers.uniswap.org/docs/unichain/tools/faucets).
   Native ETH pays transaction fees. TrueETH (`tETH`) is an ERC-20 demo asset
   and cannot pay gas.
3. In **Demo assets**, claim **5 tETH** and **10,000 tUSDC**. Each button sends
   a real testnet transaction and requires a wallet confirmation. Each token
   can be claimed only once by a given wallet, and a claim can eventually fail
   if that token's hard supply cap has been reached.
4. Choose **Long** or **Short**, enter the tUSDC margin, choose leverage and
   slippage, then review the live Uniswap v4 quote. Both directions post tUSDC
   margin: the quote vault lends tUSDC for a long, while the base vault lends
   tETH for a short. The router and hook admission path is preflighted after a
   fresh quote, immediately before the open transaction is offered for signing.
5. If the router's existing tUSDC allowance is too small, approve the exact
   margin shown in the review. The interface does not request an unlimited
   token approval. Confirm the subsequent **Open position** transaction.
6. After confirmation, use the transaction link in the interface to inspect
   the receipt and `PerpetualOpened` event on
   [Uniscan](https://sepolia.uniscan.xyz/).

The leverage slider is a target, not a promise of execution at the simulated
chart price. The client solves the direction-specific debt leg, queries the
deployed v4 pool, and applies the selected minimum-output tolerance. Near the
limit it may slightly reduce the borrow leg—for example, a nominal 10× choice
may quote near 9.95×—to preserve the hook's opening-LTV headroom after price
impact. MetaMask may still show a revert if the quote changes, pool liquidity
is insufficient, the lending vault lacks capacity, or an on-chain preflight
condition changes before execution.

The deployed mock-token addresses are:

| Token | Address | Decimals | Per-wallet claim |
|---|---|---:|---:|
| TrueETH (`tETH`) | `0x88b49b8292a9e3174d77c5824dc96E177A56365D` | 18 | 5 tETH |
| TrueUSDC (`tUSDC`) | `0x1949280616D7Aad370C4fF0BcC2C5a351B90D9e0` | 6 | 10,000 tUSDC |

These addresses can also be imported into MetaMask to make the balances
visible in the wallet. Both assets are capped, unbacked test tokens with no
redemption right or external price guarantee.

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
| `VITE_STATE_VIEW` | Canonical Uniswap v4 StateView used to read the live pool mark |
| `VITE_V4_QUOTER` | Canonical Uniswap v4 Quoter used for executable entry estimates |
| `VITE_POOL_ID` | TrueETH/TrueUSDC hook-pool identifier |
| `VITE_DEPLOYMENT_TX` | Optional explorer link target |

`BASE` and `QUOTE` do not imply `currency0` and `currency1`. In this checked-in
deployment, the recorded `PoolKey` is `currency0=tUSDC` and `currency1=tETH`,
and the client validates that exact ordering. A future deployment with the
opposite address order must update the PoolKey construction while preserving
the semantic roles above.

The checked-in defaults and example contain the public Unichain Sepolia demo
addresses recorded in
[`deployments/unichain-sepolia.json`](../deployments/unichain-sepolia.json).
Address shape alone does **not** prove a replacement deployment is valid. A
transactional client must still verify bytecode, router/hook relationships,
pool initialization, market activation, vault funding, oracle readiness, and
chain ID on-chain.

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

The transaction layer connects through the browser's injected wallet, reads
mock-token balances and claim state, checks the market and admission oracle,
obtains an executable quote from the deployed Uniswap v4 Quoter, submits an
exact tUSDC margin approval when needed, and calls
`TruePerpRouter.openPosition`. Opening therefore asks for at most two wallet
confirmations: the approval, if needed, followed by the position transaction.
The router performs the entry swap and opens the physical
collateral-and-debt position atomically.

The screen still separates demonstration data from chain data. In particular,
the candlestick chart and its displayed 2,000 tUSDC/tETH reference price are
simulated; they are not an external ETH/USD feed or the protocol's pool-local
oracle. A live quote is time-sensitive, and transaction execution remains
subject to slippage, vault capacity, oracle readiness, and the opening-LTV
policy. See the root [deployment guide](../DEPLOYMENT.md) for mock-token supply,
LP initialization, lending-vault capitalization, and oracle warm-up.

The current hackathon interface opens positions but does not yet provide a
close-position screen. A confirmed open returns both its transaction hash and
position ID so the on-chain result can be inspected independently.
