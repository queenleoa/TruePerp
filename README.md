# TruePerp

**A pool-referenced, cash-settled perpetual-futures prototype for Uniswap v4.**

![TruePerp separates the price-setting spot pool from the cash counterparty vault](docs/assets/architecture.png)

TruePerp studies a narrow question: can a perpetual market use the price of its
own Uniswap v4 pool and reduce unsafe positions without sending liquidation
orders back through that pool?

The prototype answers with a split architecture. A Uniswap pool supplies price
observations and swap callbacks. A separate cash vault acts as counterparty to
traders. Position reductions are cash-settled bookkeeping operations, so they do
not create forced spot sales.

This repository is a hackathon research prototype. The contracts demonstrate
the mechanism; they are not production-ready and should not hold real funds.

## What does an ETH/USDC market trade?

An ETH/USDC TruePerp market trades one instrument: a **synthetic ETH perpetual
quoted and settled in USDC**.

- `ETH` is the base asset whose price exposure the trader takes.
- `USDC` is margin, settlement currency, and vault capital.
- A long gains when the ETH price rises; a short gains when it falls.
- No ETH changes hands when a position opens or closes.

The same pool cannot price an unrelated BTC or SOL perpetual. Each underlying
requires its own approved base/cash market, such as BTC/USDC or SOL/USDC. Without
an external oracle, TruePerp can only list an asset that has a sufficiently
credible spot pool of its own.

> **Implementation note:** `v0.1` hard-codes `currency0` as base and assumes
> 18-decimal base units; its tests use two 18-decimal mock tokens. The
> `v0.2-demo` design records pool orientation and normalizes token decimals
> before claiming compatibility with an actual WETH/USDC pair.

## Is the Uniswap pool the counterparty?

No. The design contains two economically distinct pools:

![TruePerp market structure](docs/assets/security-boundaries.svg)

| Component | Function | Bears trader PnL? |
|---|---|---|
| Uniswap v4 base/cash pool | Price discovery, observation history, callback clock | No |
| `TruePerpHook` | Margin custody, positions, funding, risk checks, partial liquidation | No equity capital of its own |
| `PerpVault` | Cash liquidity that pays wins and receives losses and fees | Yes |

The `PerpVault` is therefore the GMX-like part of the design. The important
difference is that GMX integrates pricing and a multi-asset liquidity pool into
its own market system, whereas TruePerp reads one specific Uniswap spot pool and
uses a separate, single-currency counterparty vault.

That separation creates a hard constraint. A cash-only USDC vault cannot
guarantee an unlimited ETH-long profit if ETH can rise without bound. A fully
backed design would need to hold or hedge ETH, as well as USDC. For the
hackathon, the simpler coherent choice is a **bounded perpetual**: each position
chooses a maximum profit below a market ceiling, and the vault reserves that
amount before the position opens.

## Mechanism

1. A trader deposits cash margin and chooses long or short exposure.
2. Entry is recorded at a price derived from the pool's current tick and recent
   observations. The trade is synthetic: the hook does not swap the base asset.
3. The current prototype accrues skew funding. The redesigned base demo sets it
   to zero; a future version may restore it only with collection-backed
   accounting.
4. When equity falls below maintenance, the protocol reduces part of the
   position and realizes that slice in cash.
5. Further reductions pause if health recovers. Already executed reductions are
   permanent; the mechanism is **pausable**, not reversible.
6. A defined backstop handles exhausted trader margin or an insolvent vault.

The current v0.1 contracts implement steps 1–5 and a losing-trader shortfall
record. The audit of the prototype identified missing protections around vault
withdrawals, winning-trader payouts, funding conservation, price manipulation,
and liquidation retriggering. Those findings define the proposed demo revision.

## Recommended hackathon scope

The strongest demo is intentionally narrow:

- one curated ETH/USDC market;
- standard test ERC-20 assets and isolated USDC accounting;
- a fixed vault epoch: capital enters before trading and cannot enter or leave
  while any position or payout claim from that epoch remains unsettled;
- a protocol-seeded, wide-range spot-liquidity position locked for the epoch;
- a trader-selected maximum profit below a market ceiling, fully reserved from
  vault cash;
- position and OI limits based on unreserved vault cash and locked spot depth;
- user-supplied price limits and deadlines;
- a guarded settlement price that bounds one-transaction spot moves;
- funding disabled so the demo isolates the liquidation mechanism;
- partial liquidation that can retrigger whenever health falls again;
- an explicit close-only state, with pro-rata payout only as a catastrophic
  fallback if a reserved claim cannot be honored.

This scope preserves the contribution worth demonstrating: **partial,
cash-settled liquidation driven by a venue-native price, without liquidation
sell pressure**. It does not pretend that a hackathon prototype has solved
permissionless market listing or general LP-vault solvency.

## Documentation

- [Design specification](DESIGN.md) — components, state transitions, accounting,
  and the proposed demo revision.
- [Research note](RESEARCH.md) — design alternatives, relation to GMX, and the
  security argument.
- [Parameter framework](PARAMETERS.md) — equations, illustrative demo values,
  and the evaluation plan.
- [Whitepaper](WHITEPAPER.md) — concise academic presentation of the proposal.

## Repository

| Contract | Purpose |
|---|---|
| [`TruePerpHook`](src/TruePerpHook.sol) | Position and margin ledger, pool observations, funding, and liquidation |
| [`PerpVault`](src/PerpVault.sol) | Cash counterparty and LP-share accounting |
| [`PerpVaultFactory`](src/PerpVaultFactory.sol) | Per-market vault deployment |

TruePerp imports its tick-indexing, price-filter, range, and chunk-sizing
libraries from the TrueLend submodule.

```bash
git clone --recursive https://github.com/queenleoa/TruePerp.git
cd TruePerp
forge build
forge test --offline
```

Current verification: 10 TruePerp scenario tests pass; the hook runtime is
22,726 bytes. The root suite does not yet include adversarial solvency or
invariant tests.

## Status

`v0.1` is an implemented proof of mechanism. `v0.2-demo` is the design target
documented in this repository. Neither version is audited or deployed.
