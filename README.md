# TruePerp — Oracleless Perpetuals with Gradual Liquidation on Uniswap v4

TruePerp is a cash-settled perpetual-futures protocol built as a Uniswap v4 hook — the sibling of [TrueLend](https://github.com/queenleoa/TrueLend), applying the same two replacements to margin trading that TrueLend applies to lending: **the pool's own tick is the only price**, and **liquidation is a gradual, reversible, chunked process**, not a one-shot event.

A position's margin defines its own liquidation range — from the maintenance boundary (equity = maintenance margin) to the bankruptcy boundary (equity = 0). While the spot price sits inside that range, the position is **auto-deleveraged in paced chunks**: each chunk closes a slice of notional at the pool's own price, realizes the loss against margin, and pays a penalty to the LP vault that takes the other side. Deleveraging shrinks notional faster than it burns margin, so the process is *self-terminating*: once equity again covers maintenance on the reduced position, ADL pauses — the trader keeps a smaller, healthy position. Price recovery pauses it too. Only past the bankruptcy boundary does a hard backstop close what's left, with any uncovered loss recorded against LPs as a declared, priced tail.

Funding needs no oracle either: open-interest skew sets the rate (the crowded side pays), and the imbalance residual accrues to LPs.

- **[DESIGN.md](DESIGN.md)** — the full specification: a position walked end-to-end, the margin-derived ranges, the ADL engine precisely, the LP vault, parameters.
- **[RESEARCH.md](RESEARCH.md)** — what an oracle does in a perp and what deleting it costs; the impossibility of passive deleveraging; every major perp architecture and its documented failures (GMX's zero-impact door, Hyperliquid's JELLY squeeze, Perpetual v1's vAMM drain) read for lessons; manipulation economics; the math.
- **[PARAMETERS.md](PARAMETERS.md)** — the risk model: the equity-invariance lemma, the maintenance-margin inequality (no execution term), per-tier first cuts and leverage ceilings, funding and OI-cap sizing, and the Monte-Carlo/replay program that gates production values.
- **[WHITEPAPER.md](WHITEPAPER.md)** — the formal paper.

## The lending → perps dictionary

| TrueLend (loans) | TruePerp (perps) |
|---|---|
| collateral | margin (cash, custodied by the hook) |
| debt | notional base exposure against the LP vault |
| LT gap | maintenance margin; range = [maintenance, bankruptcy] |
| chunked collateral sale | chunked ADL: cash-settled notional reduction, no market impact |
| decay ends at debt = 0 | ADL ends when equity again covers maintenance |
| penalty → in-range LPs | penalty → PerpVault LPs (the counterparty absorbers) |
| interest (utilization) | funding (OI skew) |
| worse-of oracle at open | worse-of at entry AND exit (longs enter high/exit low) |

## Contracts

| Contract | Role |
|---|---|
| [`TruePerpHook`](src/TruePerpHook.sol) | perp core: margin custody, entries/exits at worse-of prices, skew funding, chunked ADL driven by the spot pool's swaps (`afterSwap`) or permissionless `poke`, hard backstop |
| [`PerpVault`](src/PerpVault.sol) | LP counterparty ("the house"): earns fees, penalties, and the funding residual; pays trader wins; LP equity = cash − unrealized trader PnL at the filtered price |
| [`PerpVaultFactory`](src/PerpVaultFactory.sol) | keeps vault creation code out of the hook's bytecode (EIP-170) |

The liquidation kernel is **reused from TrueLend's deployed linked libraries** — `ChunkMath` (pacing), `LiqRangeMath` (range/price math), `TruncatedOracle` (manipulation filter), `TriggerIndex` (tick bitmap) — imported via the `lib/truelend` submodule. Base is always `currency0`, cash always `currency1` (native currencies sort to `currency0`, so the cash side is always ERC-20).

## Build & test

```bash
git clone --recursive <repo>
forge build
forge test    # 10 scenarios: margin-derived ranges, chunked ADL + self-terminating
              # health pause, bankruptcy backstop with LP shortfall, worse-of PnL
              # round trips, skew funding, LP equity accounting
```

## Status

v0.1 — mechanism complete and tested; **not audited, not deployed**. Known scope
limits (deliberate): full-close only (no partial close/margin top-up yet); ADL
ranges are fixed at open (conservative — deleveraging only moves the true
threshold further away); funding residual transfers assume trader margins cover
transient imbalances; parameters are TrueLend-model analogs pending a perp-profile
run of the [parameter model](https://github.com/queenleoa/TrueLend/blob/main/PARAMETERS.md)
with a leverage axis. See [DESIGN.md](DESIGN.md).
