# TruePerp: Design Specification

## Document status

This document specifies the proposed `v0.2-demo` design. The checked-in
contracts are `v0.1`: they prove that Uniswap v4 callbacks can drive a
cash-settled partial-liquidation engine, but they do not implement every safety
condition in this specification.

TruePerp is a hackathon research prototype. The objective is a coherent and
demonstrable mechanism, not a claim of production readiness.

## 1. Scope and terminology

TruePerp is an **externally-oracle-free, pool-referenced perpetual market**. Each
market is defined by one base asset, one cash asset, one reference pool, and one
counterparty vault.

For an ETH/USDC market:

- the underlying exposure is ETH;
- prices and PnL are quoted in USDC;
- trader margin is USDC;
- vault capital is USDC; and
- the reference price comes from the ETH/USDC Uniswap v4 pool.

The instrument is synthetic. Opening a two-ETH long records two ETH of exposure;
it does not buy or borrow two ETH. At settlement, only USDC moves.

A market cannot use ETH/USDC to price BTC, SOL, an equity, or an arbitrary index.
Those instruments require their own credible price venues or an external
oracle, which is outside this design.

## 2. System architecture

![Market architecture and security boundaries](docs/assets/security-boundaries.svg)

### 2.1 Reference pool

The Uniswap v4 pool performs three functions:

1. it holds real base/cash liquidity and discovers a spot price;
2. it supplies observations for the protocol's internal price filter; and
3. its swaps provide callbacks that can advance risk processing.

The reference pool is not the trader's counterparty and does not pay perpetual
PnL. Because a v4 pool key includes its hook, a TruePerp pool is distinct from an
otherwise identical pool without the hook; liquidity must be attracted to the
hooked pool explicitly. The demo therefore seeds a protocol-controlled,
wide-range position and locks it for the complete trading epoch. External
liquidity may improve execution, but it is not counted as durable security
unless it is subject to the same lock.

### 2.2 Risk engine

The hook records positions, custodies trader margin, computes health, and
initiates partial liquidation. It should not own discretionary risk capital.
The demo deploys one market. Its data model remains market-scoped so a future
multi-market version cannot spend one market's margin or reserves for another,
but multi-market operation is not part of the demo claim.

### 2.3 Counterparty vault

The PerpVault is the GMX-like component. Vault LPs deposit cash and collectively
take the opposite side of net trader exposure. They receive fees and realized
trader losses; they pay favorable trader PnL. Funding is disabled in the base
demo.

Spot LPs and vault LPs are different roles. A future design could combine them,
but doing so would mix price formation, inventory, and counterparty solvency and
is not required for the demo.

## 3. Market definition

Each market stores:

| Field | Meaning |
|---|---|
| `base` | Asset whose price exposure is traded |
| `cash` | Margin, settlement, and vault asset |
| `poolId` | Approved Uniswap v4 reference pool |
| `baseIsCurrency0` | Explicit orientation of the pool price |
| `vault` | Market-specific counterparty vault |
| `riskConfig` | Margin, capacity, and price-guard parameters |
| `maxProfitCapBps` | Market ceiling for a position's declared profit cap |
| `mode` | `ACTIVE`, `CLOSE_ONLY`, or `SETTLEMENT` |

The current code assumes `currency0` is base and `currency1` is cash. Token
ordering is address-dependent, so the revised design records orientation rather
than treating ordering as economic meaning.

Only an approved, standard settlement token is supported in the demo. Rebasing,
fee-on-transfer, callback-bearing, and non-standard metadata tokens are out of
scope.

## 4. Position and accounting model

For a position with base size $B$, entry price $E$, current settlement mark $P$,
and direction $s \in \{+1,-1\}$ for long and short:

$$
U = sB(P-E)
$$

is unrealized PnL in cash units. Let $M$ be remaining cash margin and $F$ be
signed funding owed by the trader. Position equity is

$$
Q = M + U - F.
$$

The position is healthy when

$$
Q \ge mPB,
$$

where $m$ is the maintenance-margin ratio. All token-decimal conversions must
be explicit at the market boundary; internal arithmetic uses a documented fixed
point representation.

Trader loss is limited by available margin. Any vault calculation must therefore
cap its receivable from a losing trader rather than treating negative PnL as an
unlimited asset.

For the bounded hackathon market, each position also declares maximum cash
profit $K_i$, measured above the return of its own remaining margin. The trader
may choose any cap up to the market ceiling; the illustrative ceiling is 100%
of post-fee initial margin. Price PnL and any future funding credit share this
single cap, while fees and penalties reduce margin. The position closes when
the guarded mark reaches its take-profit boundary. The vault reserves $K_i$
when the position opens; the reserve cannot support another position or an LP
withdrawal until the position closes and its payout settles.

## 5. Price construction

“Externally oracle-free” does not mean that raw spot is trusted without a time
dimension. The market maintains a pool-local filtered price $P_f$ from periodic
pre-swap observations and reads current spot $P_s$.

Every action begins from the bounded pool mark

$$
P_g = \operatorname{clamp}\!\left(P_s,
P_f(1-\delta), P_f(1+\delta)\right),
$$

where $\delta$ is the maximum unconfirmed deviation. A larger move must persist
long enough to enter the filtered record before it can fully affect a forced
cash transfer.

The action-specific price is then:

| Action | Long | Short |
|---|---:|---:|
| Entry | $\max(P_g,P_f)$ | $\min(P_g,P_f)$ |
| Voluntary exit | $\min(P_g,P_f)$ | $\max(P_g,P_f)$ |
| Partial liquidation, backstop, take-profit, terminal snapshot | $P_g$ | $P_g$ |

The directional rules make voluntary execution adverse rather than optionality
against the filter. Entry and voluntary exit also require caller-supplied price
bounds and deadlines. Vault shares are priced only at fixed epoch boundaries,
after every claim from the ending epoch has settled.

The current `v0.1` implementation uses a worse-of combination of spot, median,
and recent extremes. That is conservative for an isolated action, but raw spot
can still be used to force a third party's loss. The guarded mark addresses this
role-composition attack.

## 6. Position lifecycle

| State | Entry condition | Permitted actions |
|---|---|---|
| Healthy | $Q \ge mPB$ | Trader close |
| At risk | $0 < Q < mPB$ | Partial liquidation toward target health |
| Take-profit | Recognized profit reaches reserved cap $K_i$ | Automatic close at $K_i$ |
| Trader bankrupt | $Q \le 0$ | Close position; apply limited-liability rule |
| Vault close-only | Vault reserve threshold breached | No new risk; closes and risk reduction only |
| Market settlement | Vault cannot meet all winning claims | Snapshot and pro-rata settlement |

Position reductions already executed are permanent. A recovery can pause future
reductions, so the process is **progressive and pausable**, not reversible.

## 7. Progressive partial liquidation

![Partial-liquidation region for a long position](docs/assets/liquidation-range.svg)

The design goal is to reduce only the exposure required to restore a target
margin ratio $h$, rather than close the entire position at the first threshold.

Closing base amount $c$ at the current mark realizes PnL but, before fees, does
not change total equity. If the liquidation penalty rate is $\pi$, the minimum
reduction that restores target health satisfies

$$
c \ge \frac{hPB-Q}{P(h-\pi)}, \qquad h>\pi.
$$

The execution amount is the smaller of that target and the per-call risk cap.
If the cap prevents full restoration, later calls continue the process.

The special case $h=m$ and range depth $d$, defined by
$Q=mPB(1-d)$, gives

$$
\frac{c}{B} \ge \frac{md}{m-\pi}.
$$

Thus the familiar approximation $c/B\approx d$ is valid only when penalties are
small relative to maintenance. If $\pi=m/4$, restoration before a full close is
possible only for $d<75\%$.

### 7.1 Retriggering rule

The boundary index is an optimization, not the source of truth. Following any
margin change or partial reduction, the engine recomputes health and the next
maintenance boundary. A position that becomes unsafe again must re-enter the
risk queue even if price never left its original range.

For the hackathon demo, correctness is preferable to an elaborate bitmap. A
bounded active-position scan or explicitly re-registered trigger is acceptable.

### 7.2 No liquidation order

Partial liquidation transfers cash between the position margin ledger and the
vault. It does not submit a spot swap. This is the central contribution: risk is
reduced without generating the forced order flow that can amplify an adverse
price move.

## 8. Funding (disabled in the base demo)

The base `v0.2-demo` sets funding to zero. This keeps the claim narrow and avoids
presenting the non-conserving `v0.1` funding ledger as part of the repaired
mechanism.

If funding is added later, it prices the net inventory carried by the vault; it
does not peg a separate perpetual mark to an external index.

The illustrative rate remains proportional to open-interest skew:

$$
\dot f = k\frac{L-S}{L+S},
$$

where $L$ and $S$ are long and short base exposure. A signed nominal obligation
must persist until processed and must be included in health checks.

The engine must not transfer a theoretical aggregate residual before it has
been collected from payer margin. Limited liability caps the amount collectible
from a payer at available margin, and the system cannot recognize the opposite
credit until that cash is collected. Any uncollectible nominal remainder is
recorded for analysis, not converted into an unfunded receivable. Margin
exhaustion moves the position into risk processing.

## 9. Vault solvency and LP shares

At mark $P_g$, define capped gross winning liability and collectible losing PnL:

$$
G = \sum_i \min\!\left(\max(U_i-F_i,0),K_i\right),
$$

$$
R = \sum_i \min\!\left(\max(-(U_i-F_i),0), M_i\right).
$$

Let $R_o$ denote other obligations backed by cash. If physical vault cash is
$C$, a limited-liability-aware reporting NAV is

$$
V = C + R - G - R_o.
$$

Gross liabilities remain visible even when an unrelated losing position appears
to offset them. This avoids settlement-order dependence. Because $R$ is not yet
collected, reporting NAV is never used as spendable admission capital.

Let $K=\sum_i K_i$ be total reserved maximum profit. Define free cash as

$$
C_{free}=\max(C-K-R_o,0).
$$

After a proposed position is included, admission requires
$K+R_o\le\rho C$ for a configured $\rho<1$. The new $K_i$ is locked
one-for-one, and only post-admission $C_{free}$ may support additional risk.
This is capital-inefficient but gives the hackathon market a testable
winner-coverage invariant without adding a hedge engine.

For `v0.2-demo`:

- vault capital is committed before the trading epoch starts;
- no deposit mints active shares while the epoch has live positions;
- no redemption executes until every position and claim in the epoch settles;
- queued deposits participate only in the next epoch; and
- the sole demo market owns a segregated cash ledger.

These rules are intentionally conservative and easy to demonstrate.

## 10. Capacity controls

Vault capital alone does not measure the reliability of the price source. Let
$D_{lock,\delta}$ be executable base depth, inside a configured band around the
filtered price, supplied by positions locked for the complete epoch. After the
proposed position and its reserve are included, market capacity is

$$
\mathrm{maxOI}=\min(\alpha C_{free},\;\beta P_gD_{lock,\delta}),
$$

where $\alpha$ limits counterparty exposure and $\beta$ limits exposure relative
to the cost of moving the reference venue. A smaller version of the same limit
applies per position.

New risk is rejected if locked active liquidity or observation freshness falls
below a minimum. Unlocked external liquidity is monitored but does not increase
the configured capacity. Unexpected loss of the locked depth moves the market
to `CLOSE_ONLY`; it must not silently make liquidation a no-op.

## 11. Insolvency outcome

A complete design must specify both limited trader liability and limited vault
capital.

If physical cash falls to aggregate profit reserves plus other funded
obligations, the market enters `CLOSE_ONLY`. Under the bounded design, reserved
cash should cover every recognized winning claim. If that invariant nevertheless fails because of an
implementation error, token failure, or accounting mismatch, the market
snapshots positions at one guarded settlement mark, returns segregated trader
margin after valid charges, and distributes available counterparty cash pro
rata across recognized positive PnL claims. Any unpaid amount is recorded
explicitly.

This is a socialized winning-PnL haircut. It is undesirable, but it is more
coherent than reverting profitable closes indefinitely. The demo should name
this tail rather than claiming it does not exist.

## 12. Administration and operating assumptions

The demo supports one allowlisted market, one fixed vault epoch, and a fixed
configuration. Production governance, if ever pursued, would require delayed configuration changes,
events, pause controls, and position-level parameter snapshots.

The mechanism assumes:

- the reference pool has independent arbitrage and protocol-seeded depth locked
  for the epoch;
- the cash token behaves as a standard ERC-20;
- keepers or swaps call risk processing often enough;
- the configured price guard is suitable for the market's volatility; and
- the vault accepts directional market risk.

## 13. Implementation status

| Capability | `v0.1` contracts | `v0.2-demo` target |
|---|---:|---:|
| Synthetic long/short positions | Implemented | Retain |
| Explicit base/cash orientation and decimal scaling | Missing | Required |
| Separate cash counterparty vault | Implemented | Retain with isolation |
| Pool-local price observations | Implemented | Retain with guarded settlement |
| Cash-settled chunk reductions | Implemented | Replace with target-health reduction |
| Funding accumulator | Implemented but non-conserving | Disabled in base demo |
| Price/deadline bounds | Missing | Required |
| Depth-linked exposure caps | Missing | Required |
| LP entry/exit epochs | Missing | Required |
| Limited-liability-aware NAV | Missing | Required |
| Reserved per-position profit cap | Missing | Required |
| Reliable liquidation retrigger | Missing | Required |
| Winner-insolvency settlement | Missing | Required |

## 14. Demonstration sequence

The recommended demo tells one complete story:

1. initialize a curated ETH/USDC pool and lock wide-range spot liquidity;
2. capitalize and start one fixed USDC vault epoch;
3. open a five-times ETH long, reserve its profit cap, and show its live equity;
4. move the spot price below maintenance;
5. call risk processing and show that only the required exposure is removed;
6. show the vault cash transfer and the absence of a hook-initiated spot swap;
7. recover price and show that further reduction pauses; and
8. display the capacity and solvency metrics that prevent new unsafe risk.

That sequence demonstrates the novel mechanism without claiming a general,
permissionless perpetual exchange.
