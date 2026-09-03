# TruePerp demonstration deployment

This guide deploys the complete TruePerp demonstration market to Unichain
Sepolia. The deployment is intentionally self-contained: it creates capped
mock assets, deploys the TruePerp contracts, initializes one Uniswap v4 pool,
mints a standard PositionManager liquidity NFT, capitalizes two isolated debt
vaults, and activates the market in the product router.

The resulting market demonstrates protocol mechanics. It does not create an
economically backed ETH/USD market.

![TruePerp architecture](docs/assets/trueperp-architecture.svg)

## Demonstration assets

The contracts use semantic `BASE` and `QUOTE` roles rather than assuming that
either asset will be `currency0`. Uniswap sorts currencies by address when it
constructs a `PoolKey`.

| Asset | Role | Decimals | Initial treasury supply | Hard cap | One-time faucet |
|---|---|---:|---:|---:|---:|
| TrueETH (`tETH`) | unbacked ETH-like ERC-20 base asset | 18 | 10,000 | 20,000 | 5 per address |
| TrueUSDC (`tUSDC`) | quote, margin, and accounting asset | 6 | 20,000,000 | 40,000,000 | 10,000 per address |

Both tokens are unbacked test assets. Neither token is redeemable for ETH,
USDC, dollars, or any other asset, and neither is intended to preserve an
external market price. The caps bound the mock supply; they do not constitute
reserves. `claim()` is a convenience for a public testnet demonstration,
not a production distribution mechanism.

## Initial capital allocation

`Deploy.s.sol` assigns treasury inventory to two economically different
destinations:

| Destination | TrueETH | TrueUSDC | Economic function |
|---|---:|---:|---|
| Uniswap v4 LP NFT | up to 1,000 | up to 2,000,000 | Executes entry, exit, and liquidation swaps |
| Base lending vault | 1,000 | — | Lends TrueETH to short positions |
| Quote lending vault | — | 2,000,000 | Lends TrueUSDC to long positions |
| Deployer demo reserve | at least 8,000 | at least 16,000,000 | Demonstration inventory outside the protocol |

Pool liquidity and lending-vault capital are not interchangeable. Depositing
tokens into the PositionManager position improves swap depth but does not make
them borrowable. Depositing tokens into a lending vault funds debt legs but
does not provide Uniswap liquidity or earn pool fees.

The pool is initialized with a 0.30% fee, tick spacing 60, a wide-range
position, and a nominal price of 2,000 TrueUSDC per TrueETH. The script retains
a small input buffer when deriving liquidity, so the LP row reports maximum
token budgets rather than guaranteed exact consumption. The starting price is
an AMM state only; it is not an oracle claim about real ETH.

## Deployed demonstration market

The complete market was deployed on Unichain Sepolia on 2026-09-03. The
sanitized, machine-readable record is
[`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json).

| Component | Address or identifier |
|---|---|
| TrueETH | `0x88b49b8292a9e3174d77c5824dc96E177A56365D` |
| TrueUSDC | `0x1949280616D7Aad370C4fF0BcC2C5a351B90D9e0` |
| TruePerpHook | `0x71280741519FCfc4c17b3cBdAF6e589E84Ba90c0` |
| TruePerpRouter | `0xCE9376A2525CFFDbb1E5f1Fb01e2b04895C1A064` |
| Pool ID | `0xb456c2c3c600c7530c3a3b0d238198a466be1943ae5b5e3fd5cbfb831699e3d9` |
| Base vault | `0x2aC5081BEE73d6d8F49d5238E593af65a6FaE8E9` |
| Quote vault | `0x133A4EAbA992695614bE5545126d67244C51851D` |
| PositionManager LP NFT | token ID `7913` |
| Admission oracle | ready, 9 of 9 observations |

The deployment transactions and exact raw-unit balances are retained in the
manifest; private-key material and signed transaction payloads are not. The
eight time-spaced bootstrap swaps are complete, so the deployed market has
passed its initial oracle-readiness gate.

## Network and official infrastructure

The target is Unichain Sepolia, chain ID 1301. The following public contracts
are the current official Uniswap v4 testnet deployments:

| Contract | Address |
|---|---|
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` |
| PositionManager | `0xf969aee60879c54baaed9f3ed26147db216fd664` |
| PoolSwapTest | `0x9140a78c1a137c7ff1c151ec8231272af78a99a4` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |

Confirm these values against the
[official Uniswap v4 deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments)
before a fresh deployment. The public RPC and explorer are listed in the
[official Unichain network reference](https://developers.uniswap.org/docs/unichain/technical-information/network-information).

## 1. Prepare the signer

Keep deployment credentials in the ignored root `.env` file:

```dotenv
WALLET_ADDRESS=0x...
WALLET_PRIVATE_KEY=0x...
```

`Deploy.s.sol` reads the key internally and verifies that it derives
`WALLET_ADDRESS`. Do not place either value in `frontend/.env.local`; every
`VITE_*` variable is embedded in the public browser bundle.

Set the public RPC URL in the shell that will run Foundry:

```bash
export UNICHAIN_RPC_URL=https://sepolia.unichain.org
```

The official endpoint is rate-limited and is not intended for production
hosting. A managed RPC is preferable for a live hackathon demo.

## 2. Build and test

```bash
forge build --sizes
forge test --offline
forge test --root lib/truelend --offline
```

The size check is material: `TruePerpHook` is close to the EIP-170 runtime-code
limit. Do not broadcast a build whose hook exceeds that limit.

## 3. Simulate the complete deployment

Run the script without `--broadcast` first. This executes the same deployment
sequence against the selected RPC state without publishing transactions:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$UNICHAIN_RPC_URL" \
  --always-use-create-2-factory \
  -vvvv
```

The CREATE2 flag is required because the hook address is mined for its Uniswap
v4 permission bits. A successful simulation should complete all of the
following operations:

1. deploy TrueETH and TrueUSDC;
2. deploy the vault factory, mined hook, and router;
3. initialize the sorted TrueETH/TrueUSDC `PoolKey` at 2,000 quote per base;
4. configure the perpetual and activate it in the router;
5. mint the wide-range liquidity position through the official
   PositionManager, producing a standard ERC-721 LP position;
6. deposit separate support capital into the base and quote lending vaults; and
7. print the public contract addresses, pool ID, vault addresses, and LP token
   ID.

## 4. Broadcast

After reviewing the simulation output and signer balance, publish the same
script:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$UNICHAIN_RPC_URL" \
  --always-use-create-2-factory \
  --broadcast \
  --slow \
  -vvvv
```

Record only public deployment data. In particular, save the following values
for oracle warm-up and frontend configuration:

```dotenv
TRUE_ETH=0x...
TRUE_USDC=0x...
TRUEPERP_HOOK=0x...
TRUEPERP_ROUTER=0x...
TRUEPERP_POOL_ID=0x...
```

Do not copy Foundry's signed transaction payloads into documentation or the
frontend. A sanitized deployment manifest should contain contract addresses,
the pool ID, LP token ID, chain ID, and public transaction hashes only.

## 5. Warm the pool-local oracle

Pool initialization creates the first observation. TruePerp admission requires
nine usable observations, so the new market needs eight additional successful
swaps. Observations are time-gated: consecutive warm-up swaps must be separated
by at least 60 seconds according to block timestamps.

After adding `TRUE_ETH`, `TRUE_USDC`, and `TRUEPERP_HOOK` to the root `.env`, run:

```bash
forge script script/WarmOracle.s.sol:WarmOracle \
  --rpc-url "$UNICHAIN_RPC_URL" \
  --broadcast \
  --slow \
  -vv
```

`WarmOracle.s.sol` submits one tiny swap per invocation and selects the
direction that steers the tick toward its launch value. Run it eight times,
waiting at least 60 seconds after each successful transaction before submitting
the next one. A reverted or same-window call does not advance the observation
count. Very small swaps may leave the integer tick unchanged; that is valid and
keeps cumulative price drift negligible.

Do not open a leveraged position until the ninth observation is present.
Warming the oracle is a deployment bootstrap step, not a privileged keeper
loop: after bootstrap, ordinary pool swaps record observations and ordinary
flow or permissionless `poke` calls can advance liquidation.

## Adding or changing pool liquidity

The initial position is a standard Uniswap v4 PositionManager NFT owned by the
deployment wallet. It is not liquidity held by the TruePerp hook, a public test
router, or either lending vault.

To add liquidity after deployment, use the official PositionManager and either:

- increase liquidity on the recorded LP token ID; or
- mint another position for the same `PoolKey` and a tick range aligned to tick
  spacing 60.

For ERC-20 settlement, approve Permit2 for both assets and grant the
PositionManager the required Permit2 allowances before calling
`modifyLiquidities`. Bound both token inputs and use a deadline. The
PositionManager action sequence should settle both currencies and mint or
increase the position; direct transfers to PoolManager do not create
liquidity.

Wide liquidity makes the mechanism easy to demonstrate. Concentrated
liquidity is more capital-efficient but can disappear outside its selected
range, so it changes liquidation depth and should be treated as a risk
parameter rather than a cosmetic LP choice.

## Frontend configuration

Copy verified **public** values into `frontend/.env.local` using semantic roles:

```dotenv
VITE_RPC_URL=https://sepolia.unichain.org
VITE_TRUEPERP_ROUTER=0x...
VITE_TRUEPERP_HOOK=0x...
VITE_POOL_MANAGER=0x00b036B58a818B1BC34d502D3fE730Db729e62AC
VITE_POSITION_MANAGER=0xF969Aee60879C54bAAed9F3eD26147Db216Fd664
VITE_POOL_ID=0x...
VITE_BASE_TOKEN_ADDRESS=0x...
VITE_QUOTE_TOKEN_ADDRESS=0x...
VITE_DEPLOYMENT_TX=0x...
```

Then build the static application:

```bash
cd frontend
npm ci
npm test
npm run build
```

Providing addresses does not enable trading. The current frontend is explicitly
preview-only: it neither verifies live protocol state nor creates approvals or
TruePerp transactions. See [frontend/README.md](frontend/README.md) for the
remaining client work.
