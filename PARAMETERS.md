# TruePerp: Parameter Framework

## Document status

This note defines a reproducible parameter-selection method for the proposed
`v0.2-demo` design. Values labelled **illustrative** are chosen to make a
hackathon demonstration legible; they are not estimates of production safety.
No parameter in this document substitutes for simulation, historical replay, or
an external review.

## 1. Parameter objectives

The parameters serve three separate constraints:

1. **Trader solvency:** unsafe exposure should be reduced before margin is
   exhausted.
2. **Vault solvency:** aggregate winning claims must remain payable from vault
   cash under the declared position caps.
3. **Price integrity:** the value transferable through the perpetual must be
   small relative to the cost of moving the reference pool.

These constraints cannot be represented by a single open-interest percentage.
The design therefore separates margin, price, capacity, and LP-liquidity
parameters.

## 2. Definitions

| Symbol | Definition |
|---|---|
| $B$ | Remaining base exposure |
| $E$ | Entry price in cash per base |
| $P$ | Guarded settlement mark |
| $M$ | Remaining trader margin |
| $F$ | Signed funding owed by the trader |
| $Q$ | Position equity, $M+sB(P-E)-F$ |
| $m$ | Maintenance-margin ratio |
| $h$ | Post-reduction target margin ratio, $h\ge m$ |
| $\pi$ | Penalty rate on reduced notional |
| $C$ | Physical vault cash |
| $R_o$ | Other obligations already backed by vault cash |
| $K$ | Aggregate reserved maximum profit, $\sum_i K_i$ |
| $C_{free}$ | Unencumbered cash, $\max(C-K-R_o,0)$ |
| $V$ | Limited-liability-aware reporting NAV |
| $D_{lock,\delta}$ | Locked executable base depth within price band $\delta$ |

Long direction is $s=+1$ and short direction is $s=-1$.

## 3. Illustrative demo configuration

The proposed demo deliberately uses one curated ETH/USDC market and conservative
limits. The values below are chosen for presentation and testing.

| Parameter | Illustrative value | Purpose |
|---|---:|---|
| Initial margin | 10% | Maximum displayed leverage of 10× |
| Maintenance margin $m$ | 5% | Material runway visible in the demo |
| Target margin $h$ | 7.5% | Restores headroom after reduction |
| Reduction penalty $\pi$ | 0.10% | Small relative to maintenance |
| Market profit-cap ceiling | 100% of post-fee initial margin | Upper bound from which the trader selects $K_i$ |
| Maximum encumbered-cash share $\rho$ | 80% of vault cash | Leaves operating liquidity |
| Unconfirmed price deviation $\delta$ | 1% | Bounds one-transaction forced settlement |
| Vault-capital factor $\alpha$ | 20% | Gross OI no greater than 0.2× free cash |
| Spot-depth factor $\beta$ | 5% | OI small relative to locked venue depth |
| Per-position share of market cap | 10% | Prevents one position dominating the book |
| Observation interval | 30 seconds | Makes filter behavior visible in a demo |
| Observation count | 5 | Short, explicit confirmation window |
| Vault risk epoch | Fixed while OI is live | No active share entry or exit during the epoch |
| Reference-liquidity lock | Complete vault epoch | Makes the depth budget durable |
| Funding rate | 0 in base demo | Isolates the liquidation contribution |

The checked-in `v0.1` defaults—2% maintenance, 20× maximum leverage, 100
target chunks, and 100%-annualized funding at full skew—remain implementation
facts, not recommendations. Its scenario tests use two 18-decimal mock assets;
real-token decimal normalization and base/cash orientation are `v0.2-demo`
requirements, not calibrated parameters.

## 4. Margin geometry

Ignoring funding and fees at opening, long equity is

$$
Q(P)=M+B(P-E).
$$

The long bankruptcy and maintenance prices are

$$
P_{bk}=E-\frac{M}{B},
\qquad
P_{maint}=\frac{P_{bk}}{1-m}.
$$

For a short,

$$
P_{bk}=E+\frac{M}{B},
\qquad
P_{maint}=\frac{P_{bk}}{1+m}.
$$

Margin primarily determines how far the intervention region lies from entry;
$m$ primarily determines the relative width between maintenance and bankruptcy.
Higher leverage moves both boundaries closer to entry. It does not give a
meaningfully narrower maintenance-to-bankruptcy percentage band.

Opening fees must be deducted before testing initial margin and deriving these
boundaries.

## 5. Required partial reduction

At a fixed settlement mark, realizing a slice of PnL does not change total equity
before fees. A penalty does. To restore target ratio $h$, the minimum base
reduction is

$$
c^*=\max\!\left(0,
\frac{hPB-Q}{P(h-\pi)}\right),
\qquad h>\pi.
$$

The call executes

$$
c=\min(c^*,c_{call},B),
$$

where $c_{call}$ is a per-call safety cap. If $c<c^*$, the position stays in the
risk queue and can be processed again.

![Partial-liquidation geometry](docs/assets/liquidation-range.svg)

If depth in the maintenance runway is defined by $Q=mPB(1-d)$ and the target is
$h=m$, then

$$
\frac{c^*}{B}=\frac{md}{m-\pi}.
$$

The reduction is approximately $dB$ only when $\pi\ll m$. Restoration before a
full close requires

$$
d<1-\frac{\pi}{m}.
$$

This feasibility condition must be tested directly; a quarter-maintenance
penalty cap does not guarantee self-termination for deep episodes.

## 6. Worked ETH/USDC example

Assume ETH is 2,500 USDC. A trader posts 1,000 USDC and opens a two-ETH long, for
5,000 USDC notional and 5× leverage. With $m=5\%$:

$$
P_{bk}=2{,}500-\frac{1{,}000}{2}=2{,}000,
$$

$$
P_{maint}=\frac{2{,}000}{0.95}=2{,}105.26.
$$

At $P=2{,}050$, equity is 100 USDC and maintenance is 205 USDC. With the
configured target $h=7.5\%$ and penalty $\pi=0.10\%$:

$$
c^*=\frac{0.075(2{,}050)(2)-100}{2{,}050(0.075-0.001)}
\approx1.368\ \mathrm{ETH}.
$$

The engine therefore removes approximately 68.4% of the position rather than
closing all two ETH. A comparison target of $h=m=5\%$ would require about 1.045
ETH, but would restore no margin headroom.

This example explains the mechanism; it does not estimate the probability that
price crosses either boundary.

## 7. Price guard

Let $P_s$ be current spot and $P_f$ the filtered observation price. Every
action begins from

$$
P_g=\operatorname{clamp}(P_s,P_f(1-\delta),P_f(1+\delta)).
$$

The action-specific prices are:

| Action | Long | Short |
|---|---:|---:|
| Entry | $\max(P_g,P_f)$ | $\min(P_g,P_f)$ |
| Voluntary exit | $\min(P_g,P_f)$ | $\max(P_g,P_f)$ |
| Partial liquidation, backstop, take-profit, terminal snapshot | $P_g$ | $P_g$ |

Entry and voluntary exit additionally require a caller-supplied acceptable
price and deadline. The parameter $\delta$ creates a direct trade-off:

- a small value limits same-transaction manipulation but delays recognition of
  genuine jumps;
- a large value improves responsiveness but permits more value transfer from a
  temporary spot move.

The correct value depends on executable pool depth and observation latency. It
must not be inferred from volatility alone.

## 8. Vault NAV and reserves

For position-level marked PnL, let $X_i=U_i-F_i$, where $F_i=0$ in the base
demo and denotes a future collected funding debit if funding is later enabled.
Each trader selects $K_i$ no greater than the market ceiling. Define

$$
G=\sum_i\min(\max(X_i,0),K_i)
$$

as gross winning claims and

$$
R=\sum_i\min(\max(-X_i,0),M_i)
$$

as collectible losing PnL. For other funded obligations $R_o$, the reporting
NAV is

$$
V=C+R-G-R_o.
$$

The cap by $M_i$ is essential. A trader with 100 USDC margin cannot be recorded
as a 1,000 USDC vault asset merely because marked PnL is −1,000 USDC. Because
$R$ is not collected cash, $V$ is a reporting and share-valuation quantity, not
an admission budget.

Maximum profit is reserved when a position opens:

$$
K_{total}+R_o=\sum_i K_i+R_o\le\rho C,\qquad 0<\rho<1.
$$

Free cash after the proposed position is

$$
C_{free}=\max(C-K_{total}-R_o,0).
$$

The position closes automatically when its guarded marked profit reaches $K_i$.
This converts the unbounded long payoff into a bounded demo instrument and makes
winner coverage directly testable. It should be described as a bounded
perpetual, not silently presented as an uncapped contract. Fees and penalties
reduce trader margin or payout and therefore cannot increase the reserved claim.

For the fixed risk epoch, capital is admitted before trading begins. No deposit
mints active shares and no redemption executes while any position or payout
claim remains unsettled. Any queued deposit participates only in the next epoch,
after all claims in the current epoch settle.

## 9. Exposure capacity

The market's post-trade gross open-interest cap is

$$
\mathrm{maxOI}=\min(\alpha C_{free},\ \beta P_gD_{lock,\delta}).
$$

The first term uses only unencumbered counterparty cash. The second connects the
value at risk to durable price-venue depth. Both quantities are recomputed after
including the proposed position and its reserve; a check using pre-trade state
would reuse capital.

The independent reserved-profit condition $K_{total}+R_o\le\rho C$ must also
hold. Open-interest capacity cannot reuse cash already reserved for winning
claims.

Each position is also capped at a fraction $\gamma$ of `maxOI`:

$$
\mathrm{positionNotional}\le\gamma\,\mathrm{maxOI}.
$$

Depth must be measured from actual initialized liquidity across the configured
price band. Only the protocol-controlled position locked for the complete epoch
contributes to $D_{lock,\delta}$; removable external depth is excluded from the
security budget. Current active liquidity multiplied by a hypothetical range is
not an adequate substitute.

## 10. Funding (disabled in the base demo)

The base `v0.2-demo` fixes funding at zero. If a later version enables it, an
illustrative rate is

$$
\dot f=k\frac{L-S}{L+S}.
$$

For elapsed time $\Delta t$, each position accrues a signed nominal obligation
based on the rate applicable during that interval. It is included in health, but
the receiving credit is recognized in $G$ only after cash is collected from the
payer. No vault residual is transferred before collection.

Required controls are:

- maximum funding rate;
- maximum accrual interval processed per call;
- forced risk processing before funding debt reaches margin;
- a persistent record of nominal unpaid debt, with the collectible amount
  capped at remaining margin;
- isolated cash accounting per market.

An uncollectible remainder is a measured funding shortfall, not an asset and not
an unfunded credit. Funding is intentionally outside the base demo's acceptance
criteria.

## 11. Statistical calibration

A production study would estimate the probability that adverse movement outruns
risk processing. If returns are approximated locally by volatility $\sigma$, a
one-sided 99th-percentile diffusion move over time $T$ is

$$
\mu_{99}=2.326\,\sigma\sqrt{T}.
$$

For the previously discussed 80-minute interval, the corresponding moves are
approximately:

| Annualized volatility | 99th-percentile diffusion move |
|---:|---:|
| 80% | 2.30% |
| 182% | 5.22% |
| 286% | 8.21% |

These figures exclude jumps, manipulation, liquidity removal, and observation
delay; they are inputs to a model, not safe maintenance ratios.

The earlier expression

$$
T(d)\approx\frac{N\tau}{\bar\lambda}\ln\frac{1}{1-d}
$$

describes an uncapped geometric chunk process. It is not valid as $d\to1$, when
depth caps bind, when the queue is congested, or when active pool liquidity is
zero. Calibration must restrict its domain and model those conditions directly.

## 12. Evaluation plan

The demo revision should be accepted only after the following properties are
tested:

1. segregated market cash always covers recorded trader margin;
2. losing positions never contribute more than collectible margin to NAV;
3. LP actions cannot reduce cash below required gross winning reserves;
4. recognized profit for every position is bounded by its reserved $K_i$;
5. a position below maintenance is eventually processed even after a prior
   health-restoration pause;
6. the same price path produces the same final balances regardless of close
   order;
7. temporary LP capital cannot capture a same-epoch liquidation transfer;
8. price displacement required to extract one unit from the vault exceeds the
   extractable value under configured depth caps.
9. loss or unlock of the configured reference depth moves the market to
   `CLOSE_ONLY` and blocks new exposure.

Scenario tests should cover long and short symmetry, abrupt gaps, sparse swaps,
all positions reaching their caps, delayed take-profit processing, multiple
positions, attempted same-epoch LP actions, locked-depth failure, and fault-
injected vault insolvency settlement. Fuzz and invariant testing should
supplement the scripted hackathon narrative. Funding conservation and
multi-market isolation are required before either feature enters a later scope;
they are not claims of the single-market base demo.

## 13. Selection rule

For the hackathon, choose parameters that make the mechanism visible and keep
all positions well inside prefunded limits. For any later deployment, select
parameters only from a joint simulation of price paths, observation behavior,
real pool depth, queue throughput, limited trader liability, and vault payout
risk. Results from the lending version of the liquidation kernel are useful
engineering evidence, but they do not validate a perpetual counterparty vault.
