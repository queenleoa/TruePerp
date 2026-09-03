# TruePerp: Parameter and Mathematical Framework

## Document status

This document parameterizes TruePerp's approved physical architecture: an
expiry-free WETH long holds WETH and owes USDC; an expiry-free WETH short holds
USDC and owes WETH. Entry, exit, gradual liquidation, and terminal close use
actual WETH/USDC pool swaps. The v0 supporting vaults are protocol-seeded and
charge zero borrow interest. There is no marked cash-PnL liability, borrow
carry, or long-short funding ledger.

Leverage is the primary product parameter. For WETH/USDC, the recommended
major-asset policy sets the liquidation threshold to 95%. Together with the
implemented 95% opening headroom, this caps admission at 90.25% LTV: 10.26x
theoretical long leverage and 9.26x theoretical directional-short leverage
before execution costs. The user-facing summary is **up to 10x ETH leverage**;
the direction-specific figures remain normative for quotes and tests.

Values marked **prototype** are inherited from the current TrueLend liquidation
kernel or fixed by `PerpLendingVaultFactory`. Values marked **illustrative** are
useful for a hackathon trace but are not empirically calibrated production
recommendations.

## 1. Units and orientation

Let `base` be WETH and `quote` be USDC. The human-readable price is

$$
P=\frac{\text{quote units}}{\text{base unit}}.
$$

Uniswap orders currencies by address, not by economic meaning. Every conversion
must therefore use an explicit `baseIsCurrency0` flag and normalize native token
decimals before displaying prices or comparing value. Raw sqrt-price and tick
math remains in native units.

## 2. Symbols

| Symbol | Meaning |
|---|---|
| $P$ | quote per base at the chosen risk point |
| $C_b$ | WETH held by a long |
| $D_q$ | outstanding USDC debt of a long |
| $C_q$ | USDC held by a short |
| $D_b$ | outstanding WETH debt of a short |
| $Q_L,Q_S$ | long and short equity in quote units |
| $\ell_L,\ell_S$ | long and short loan-to-value ratio |
| $\mathrm{LT}$ | soft-liquidation LTV threshold |
| $h_o$ | opening headroom applied to $\mathrm{LT}$ |
| $H=h_o\mathrm{LT}$ | maximum opening LTV |
| $\lambda_L,\lambda_S$ | long and short directional leverage |
| $\ell_a$ | analytical LTV benchmark used to estimate cumulative reduction |
| $t_s,t_f$ | soft-start and far-boundary ticks |
| $C$ | remaining collateral in its native token for a generic position |
| $D$ | current debt in its native token for a generic position |
| $p$ | debt-token units per collateral-token unit |
| $x$ | collateral-token input requested for one liquidation chunk |
| $y(x)$ | actual debt-token output returned by the pool |
| $u(x)$ | debt-token amount repaid after donation and reward |
| $N$ | target number of base chunks |
| $\tau$ | minimum interval between chunks for one position |
| $d$ | normalized depth through the liquidation range |
| $D_{range}$ | rough whole-range liquidity proxy in collateral units |
| $\eta$ | maximum chunk as a fraction of $D_{range}$ |
| $\pi$ | liquidation charge as a fraction of output |
| $\rho$ | caller reward as a fraction of output, with $0\le\rho\le\pi$ |
| $I_a$ | WAD-scaled debt index of lending vault asset $a$ |
| $u_a$ | utilization of lending vault asset $a$ |

## 3. Position equations

### 3.1 Long

The router accepts quote margin $M_q$, combines it with borrowed quote $D_q$,
and swaps the complete input through the pool. If the actual output is $C_b$,
then

$$
Q_L(P)=PC_b-D_q,
\qquad
\ell_L(P)=\frac{D_q}{PC_b}.
$$

The executed output, rather than $(M_q+D_q)/P$, is recorded. Pool fees and price
impact therefore reduce opening equity immediately and cannot become fictitious
collateral.

### 3.2 Short

The router accepts quote margin $M_q$, borrows $D_b$ base, and sells the base
through the pool for actual quote output $Y_q$. Held collateral is

$$
C_q=M_q+Y_q.
$$

The position has

$$
Q_S(P)=C_q-PD_b,
\qquad
\ell_S(P)=\frac{PD_b}{C_q}.
$$

### 3.3 Directional leverage

The UI should define leverage as absolute price delta times price divided by
equity:

$$
\lambda_L=\frac{PC_b}{Q_L},
\qquad
\lambda_S=\frac{PD_b}{Q_S}.
$$

In the frictionless opening approximation, both can be written from LTV:

$$
\lambda_L=\frac{1}{1-\ell_L},
\qquad
\lambda_S=\frac{\ell_S}{1-\ell_S}.
$$

The difference is real. A long's held base includes its own margin-financed base;
a short's directional base exposure is only its base debt. At 80% LTV, the long
has 5× delta leverage and the short has 4× delta leverage. A 5× short requires
approximately 83.33% LTV before execution cost.

Ignoring execution costs, quote margin $M_q$ maps a selected directional
leverage to debt as follows:

$$
D_q=(\lambda_L-1)M_q,
\qquad
P D_b=\lambda_S M_q.
$$

Thus a 10x long borrows approximately 9 units of USDC for each unit of USDC
margin. A 9x short borrows WETH worth approximately 9 units of USDC for each
unit of margin. The asymmetry is why the router or frontend should solve from a
target leverage and direction rather than reuse one borrow-to-margin ratio for
both.

## 4. Admission

Let $P_f$ be the pool-local filtered price and $P_s$ live spot. Admission uses
the borrower-adverse side:

$$
P_{adm,L}=\min(P_s,P_f),
\qquad
P_{adm,S}=\max(P_s,P_f).
$$

A lower price makes long collateral worth less; a higher price makes short debt
worth more. The route then repeats its health check from the actual post-swap
collateral and outstanding debt.

For configured headroom $h_o\in(0,1)$,

$$
\ell_{open}\le h_o\,\mathrm{LT}.
$$

The inherited prototype uses $h_o=95\%$ and also requires the range start to be
at least 100 ticks away from the post-route spot tick. Admission must additionally
satisfy:

- the appropriate vault's hard utilization cap;
- user `deadline` and `minSwapOutput` constraints;
- a nonzero minimum debt amount; and
- a position-size cap against robustly measured executable pool depth.

The final condition is part of the target risk policy and must not be claimed as
implemented until it is enforced in the contracts. The preceding debt minimum
is also only nominal in the shipped defaults: `minBorrow` is zero, so the hard
check rejects zero but accepts one raw token unit.

For the recommended WETH/USDC major-asset profile,

$$
H=h_o\mathrm{LT}=0.95(0.95)=0.9025.
$$

The resulting leverage limits are

$$
\lambda_{L,max}=\frac{1}{1-H}=10.2564\times,
\qquad
\lambda_{S,max}=\frac{H}{1-H}=9.2564\times.
$$

At $H=90.25\%$ and $\mathrm{LT}=95\%$, the adverse price distance from opening
to soft liquidation is

$$
1-\frac{H}{\mathrm{LT}}=5\%
$$

for a long, and

$$
\frac{\mathrm{LT}}{H}-1\approx5.2632\%
$$

for a short. These are frictionless geometric distances at the cap. An
execution-buffered position opens farther from the boundary.

| LT configuration | Opening LTV cap $H$ | Long limit | Directional-short limit | Interpretation |
|---:|---:|---:|---:|---|
| 90% | 85.50% | 6.90x | 5.90x | lower-risk illustrative profile |
| **95%** | **90.25%** | **10.26x** | **9.26x** | recommended WETH/USDC major-asset profile |
| 99% | 94.05% | 16.81x | 15.81x | kernel default ceiling; not recommended for ETH |
| 99.5% | 94.525% | 18.26x | 17.26x | inherited absolute bound; not a product tier |

The canonical TruePerp router caps every WETH/USDC opening at LT 95%, even if an
administrator later raises the generic hook configuration. The larger inherited
kernel values describe generic configurability, not advertised ETH leverage.
The lower-level inherited `hook.open` remains public in this prototype and can
bypass the router policy; it is explicitly outside the canonical product path.

### 4.1 Execution-adjusted borrowing

The limits above are post-trade LTV identities. They do not mean a frictionless
borrow formula will survive real execution. Let $k\le1$ be actual swap-output
value at the admission price divided by swap-input value. For a deposit $M_q$
and opening cap $H$, the maximum held long notional and short borrowed notional
per unit of deposited margin are

$$
\frac{V_{long}}{M_q}\le\frac{k}{1-Hk},
\qquad
\frac{P D_b}{M_q}\le\frac{H}{1-Hk}.
$$

At $H=90.25\%$, a 30-basis-point cost with negligible additional impact
($k=0.997$) gives approximately 9.95 units of long inventory or 9.01 units of
short borrowed notional per unit of deposited margin. Larger trades receive a
pool-dependent result. The route must therefore quote actual execution, apply
the borrower-adverse admission price, and leave a buffer below the theoretical
boundary. A fixed `borrowAmount` is not equivalent to guaranteed leverage.

The implemented router view reports current spot-marked leverage and LTV from
actual position balances. It is suitable for display after entry, but it is not
the admission calculation: opening safety continues to use the hook's
borrower-adverse pool-local price.

## 5. Liquidation boundaries

Let $D_{q,0}$ and $D_{b,0}$ be opening debt principal. For a chosen soft
threshold $\mathrm{LT}<1$, the fixed long range begins at

$$
P_{start,L}=\frac{D_{q,0}}{\mathrm{LT}\,C_b},
$$

and zero-cost bankruptcy is

$$
P_{bank,L}=\frac{D_{q,0}}{C_b}.
$$

Short liquidation begins at

$$
P_{start,S}=\frac{\mathrm{LT}\,C_q}{D_{b,0}},
$$

with zero-cost bankruptcy at

$$
P_{bank,S}=\frac{C_q}{D_{b,0}}.
$$

Long danger lies below spot and short danger above it. Start ticks are aligned
toward earlier intervention. Both range ticks remain fixed in the compact demo.
A separate force-close coverage check uses current collateral and outstanding
debt because price, charges, and prior chunks can change economic coverage even
though they do not move the stored range. Time alone does not change v0 debt.

For a configured coverage buffer $b$, define

$$
b_{eff}=\min\!\left(b,\frac{1-\mathrm{LT}}{2}\right).
$$

A conservative coverage breach exists when collateral value in debt units $V_D$
satisfies

$$
V_D(1-b_{eff})<D.
$$

This prevents a fixed buffer wider than the position's own LT gap from
pre-empting the complete gradual range.

## 6. One liquidation chunk

Let $C$ be collateral units, $D$ debt units, and $p$ debt units per collateral
unit at the reference point. For a long, $p=P$; for a short, $p=1/P$.

An exact-input swap requests $x$ collateral units and returns actual debt-token
output $y(x)$. Let $\pi$ be the total charge fraction and let the caller receive
$\rho y$, where $0\le\rho\le\pi$. The remaining $(\pi-\rho)y$ is donated to
in-range LPs, and repayment is

$$
u(x)=\min\!\left(D,\ y(x)(1-\pi)\right).
$$

The reward is carved from the charge. It is not added on top of it.

Using actual collateral consumed $x_{fill}\le x$,

$$
C'=C-x_{fill},
\qquad
D'=D-u(x_{fill}).
$$

Any requested but unfilled input remains collateral. If debt reaches zero,
excess output and remaining collateral belong to the trader.

At a fixed reference $p$, define generic debt-token equity as
$Q_D=pC-D$. Its change equals the value of execution drag:

$$
Q_D'-Q_D=-(p x_{fill}-u(x_{fill})).
$$

LTV improves if and only if

$$
\frac{u(x_{fill})}{x_{fill}}>\frac{D}{C}.
$$

This condition is important: a swap can repay debt and still worsen coverage if
price impact and charges make its output sufficiently poor.

### 6.1 Idealized cumulative reduction

Suppose price is constant and net repayment is approximately
$u(x)=(1-\pi)px$, with the caller reward already included inside $\pi$. The
collateral conversion required to reach an analytical LTV benchmark $\ell_a$ is

$$
x^*=\max\!\left(
0,
\frac{D-\ell_a pC}
{p(1-\pi-\ell_a)}
\right),
$$

which is feasible only if

$$
1-\pi>\ell_a.
$$

This is an analytical planning quantity, not a protocol target or settlement
formula. A concentrated-liquidity swap has nonlinear output and changes the
pool tick. The engine caps each chunk and uses actual deltas, but the compact
demo continues or pauses from membership in its fixed opening range.

## 7. Pacing function

Let

$$
a=\min\!\left(\left\lfloor\frac{\Delta t}{\tau}\right\rfloor,a_{max}\right),
\qquad
\varrho=\min\!\left(\frac{C}{D_{range}},1\right).
$$

The inherited chunk kernel computes a desired amount of the form

$$
x_{des}=\frac{C}{N}\,a(1+d)(1+\varrho),
$$

then applies

$$
x=\min(x_{des},\eta D_{range},C).
$$

The inherited kernel obtains $D_{range}$ by extending current active liquidity
over the position's full range. It does not traverse initialized ticks, so this
quantity is only a monotone sizing proxy—not guaranteed executable depth.
Integer arithmetic also requires a dust rule: if $C/N$ rounds to zero, the base
chunk becomes the remaining collateral. No chunk is due when
$\Delta t<\tau$, and no chunk executes when the proxy is zero.

This function is a cadence and input-size bound, not a target-health or realized
price-impact guarantee. Ordinary chunks have no local sqrt-price limit. A
position may require many chunks. Processing pauses when the tick crosses back
to the safe side of the position's fixed range.

## 8. Callback and queue limits

The **prototype** kernel uses:

| Limit | Value | Purpose |
|---|---:|---|
| chunks per ordinary swap | 2 | bounds induced flow and swapper gas |
| chunks per `poke` | 10 | provides faster permissionless catch-up |
| trigger ticks per walk | 8 | bounds bitmap traversal |
| position refreshes per walk | 32 | bounds work at crowded ticks |
| positions registered at one trigger | 32 | prevents a permanently stalled cursor |

The last bound creates a finite admission resource. Because positions with the
same collateral/debt ratio and LT align to the same tick, dust positions can
fill all 32 slots and make the next opening revert. Meaningful decimal-aware
minimums, opening authorization, and a non-exhaustible or paginated per-tick
index are production requirements; the current cap is a gas-safety mechanism,
not a Sybil-resistant quota.

The order of operations is normative:

1. `beforeSwap` records the pre-swap observation;
2. the ordinary swap executes;
3. `afterSwap` walks crossed triggers;
4. due chunks execute as direct PoolManager swaps;
5. actual deltas settle, charge is split, and debt is repaid; and
6. trigger membership is refreshed after hook-generated price movement.

The vendored v4 `Hooks.sol` library skips `beforeSwap` and `afterSwap` when the
hook itself initiated the swap, so a hook-generated liquidation swap does not
recurse. `poke` invokes the same trigger and queue driver within a PoolManager
unlock. The separate permissionless force-close path uses current position
balances; `poke` does not dynamically relocate stored trigger ticks.

## 9. Zero-carry vault parameters

For vault asset $a$, debt shares $s$, WAD scale $W=10^{18}$, and borrow index
$I_a$ give

$$
D=\frac{sI_a}{W}.
$$

The v0 `PerpLendingVaultFactory` configures

$$
r_a(u)=0,\qquad
I_a(t)=W,\qquad
D(t)=s.
$$

It passes zero for the base rate, both rate slopes, reserve factor, and rate
ceiling. Debt is therefore time-invariant between repayment and write-off. No
borrow interest, lender yield, or interest-funded reserve accrues.

For vault cash $L_a$ and performing debt $D_a$, utilization remains

$$
u_a=\frac{D_a}{L_a+D_a}.
$$

The kink field remains 80% for constructor compatibility but is economically
inert when all rate coefficients are zero. The hard 90% post-borrow utilization
cap still limits new debt and preserves some cash; redemption remains limited by
cash actually present.

Zero carry is a mechanism-isolation subsidy, not sustainable production
economics. Before enabling a nonzero borrow curve, the protocol must atomically
deregister and re-register triggers from current debt, define how already-crossed
boundaries enter processing, and preserve bounded work. Merely changing the
factory's rate arguments would make the fixed trigger geometry stale.

### 9.1 Vault share and write-off accounting

Vault share assets are

$$
A_V=\text{cash}+\text{performing debt}.
$$

A redemption can transfer no more than available cash; outstanding loans are
not liquid. The inherited vault has a reserve-first write-off branch, but the v0
factory neither seeds reserves nor permits interest-driven reserve growth.
Accordingly, for unrecoverable debt $S$ in the v0 deployment,

$$
A_V'=A_V-S.
$$

The loss falls on the protocol-seeded share capital and remains isolated to the
asset vault that originated the debt. The demo does not promise yield to
compensate that capital; this is an explicit scope limitation.

## 10. Prototype liquidation configuration

The current TruePerp composition uses the following product policy and inherited
kernel defaults. They are useful for reproducibility, not endorsements:

| Parameter | Prototype value | Interpretation |
|---|---:|---|
| range width | 3,466 ticks | about a $\sqrt{2}$ price factor |
| minimum admission gap | 100 ticks | about 1% from post-route spot |
| inherited pre-specialization max LT | 99% | generic kernel initialization value |
| Canonical TruePerp WETH/USDC max LT | 95% | enforced by `TruePerpRouter` on every opening |
| generic kernel LT upper bound | 99.5% | inherited `setConfig` bound; not a TruePerp ETH tier |
| borrow rate at every utilization | 0% | fixed by `PerpLendingVaultFactory` |
| interest reserve factor | 0% | no reserve accrual in v0 |
| hard new-borrow utilization cap | 90% | remains active despite zero rate |
| base liquidation charge | 50 bps | scaled by LT and time in liquidation |
| coverage/slippage buffer | 200 bps | capped by half the position's LT gap |
| max chunk/proxy fraction $\eta$ | 1% | absolute input bound against rough range-depth proxy |
| target chunks $N$ | 100 | 1% base cadence before multipliers |
| chunk interval $\tau$ | 60 seconds | earliest ordinary cadence |
| catch-up cap $a_{max}$ | 5× | limits elapsed-time acceleration |
| `poke`/force-close caller reward | 10 bps of output | carved from the liquidation charge |
| force-close tick limit | 1,000 ticks | roughly 10% adverse price movement |
| perpetual horizon sentinel | `uint32.max` seconds | set independently by `configurePerpetual`; no practical scheduled expiry |

The observation ring also stores 32-bit timestamps. It wraps in 2106, earlier
than a position opened today reaches the term sentinel, so a long-lived
deployment would need a clock migration. The horizon signals product semantics;
it is not a promise that this prototype operates unchanged for 136 years.

The liquidation charge itself is capped relative to the LT gap by the inherited
kernel. Parameter validation must prevent zero chunk count, zero interval, zero
depth cap, invalid range direction, and an LT so close to one that charges make
deleveraging arithmetically impossible.

## 11. Illustrative opening examples

Assume $P_0=2{,}500$ USDC/WETH and ignore pool costs only for this subsection.

### 11.1 Five-times long

The trader contributes 2,500 USDC and borrows 10,000 USDC. Swapping 12,500 USDC
produces 5 WETH:

$$
C_b=5,\qquad D_q=10{,}000,\qquad Q_L=2{,}500.
$$

Therefore

$$
\ell_L=80\%,
\qquad
\lambda_L=\frac{12{,}500}{2{,}500}=5\times.
$$

At $\mathrm{LT}=90\%$,

$$
P_{start,L}=\frac{10{,}000}{0.90(5)}=2{,}222.22,
\qquad
P_{bank,L}=2{,}000.
$$

### 11.2 Four-times short at the same LTV

The trader contributes 2,500 USDC, borrows 4 WETH, and sells it for 10,000
USDC. The position holds 12,500 USDC:

$$
C_q=12{,}500,\qquad D_b=4,\qquad Q_S=2{,}500.
$$

Thus

$$
\ell_S=80\%,
\qquad
\lambda_S=\frac{10{,}000}{2{,}500}=4\times.
$$

At $\mathrm{LT}=90\%$,

$$
P_{start,S}=\frac{0.90(12{,}500)}{4}=2{,}812.50,
\qquad
P_{bank,S}=3{,}125.
$$

The examples explain why every leverage label must name the direction and
definition.

### 11.3 Up-to-10x major-market envelope

For the recommended $\mathrm{LT}=95\%$ profile, the opening cap is 90.25% LTV.
Ignoring execution costs, a 10x long with 2,500 USDC margin borrows 22,500 USDC
and holds 25,000 USDC of WETH value. Its 90% LTV lies just inside the cap:

$$
\lambda_L=10\times,
\qquad
\ell_L=\frac{22{,}500}{25{,}000}=90\%.
$$

A 9x short with the same margin borrows 22,500 USDC worth of WETH. After selling
it, the position holds 25,000 USDC and also opens at 90% LTV:

$$
\lambda_S=9\times,
\qquad
\ell_S=\frac{22{,}500}{25{,}000}=90\%.
$$

These frictionless examples leave only 25 basis points of LTV room. They are
useful for explaining the product limit but are not safe fixed router inputs:
fees and price impact can move the realized position above 90.25% and cause
admission to revert. An execution-aware quote should target a lower borrow
amount while reporting the realized post-route leverage.

## 12. Illustrative long liquidation

Continue the long example at $P=2{,}150$. With zero carry and before a chunk,

$$
Q_L=2{,}150(5)-10{,}000=750,
\qquad
\ell_L=93.02\%.
$$

Use 85% LTV as an analytical benchmark and approximate the total output charge
as $\pi=0.5\%$. The constant-price cumulative reduction estimate is

$$
x^*=\frac{10{,}000-0.85(2{,}150)(5)}
{2{,}150(1-0.005-0.85)}
\approx2.767\ \text{WETH}.
$$

The engine must not execute this amount at once. If a permitted chunk consumes
0.05 WETH at the reference price, gross output is about 107.50 USDC and net
repayment after the 0.5% total charge is about 106.96 USDC. Ignoring additional
price impact,

$$
C_b'=4.95,
\qquad
D_q'\approx9{,}893.04,
\qquad
\ell_L'\approx92.96\%.
$$

Coverage improves only slightly, so further time-spaced chunks remain due while
the tick stays inside the stored range. A price recovery through the safe-side
boundary pauses the remaining schedule.

## 13. Force-close parameters

Force-close eligibility is the union of:

1. pool tick past the configured far boundary;
2. conservative coverage breach
   $V_D(1-b_{eff})<D$ from the live price and remaining balances; and
3. the prototype's finite horizon sentinel being reached.

The third condition is an implementation artifact used to reuse a compact
inherited position layout; the product has no practical scheduled maturity.

The close uses an exact-input collateral sale with a hard sqrt-price limit. A
partial fill updates only the collateral actually consumed and leaves the
position eligible for retry. The accounting order is:

$$
\text{gross output}
\rightarrow
\text{caller reward + LP donation}
\rightarrow
\text{net debt repayment}
\rightarrow
\text{surplus to trader}.
$$

If collateral becomes zero before debt does, the inherited write-off checks
reserves first. In v0 that balance does not grow, so the remaining loss reduces
the protocol-seeded vault capital. Because reward and donation precede
repayment, their caps are part of vault-solvency calibration.

## 14. Recommended demo profile

For an understandable demonstration, use:

- one curated WETH/USDC pool with visible, persistent wide-range liquidity;
- both debt vaults prefunded by the protocol and kept well below their 90%
  utilization cap;
- a 95% major-asset soft LT, enforced on every canonical router opening;
- an easy-to-follow 5x default position plus a separate execution-buffered
  near-limit trace supporting the up-to-10x headline;
- explicit display of realized LTV, long or short directional leverage, and the
  relevant 10.26x/9.26x theoretical limit;
- 60-second base chunk cadence, 100 target chunks, and a 1% depth cap;
- deadlines and strict output/price bounds for trader routes;
- the inherited pool-local observation filter warmed before admission; and
- deliberate scenarios for recovery pause, quiet-market poke, and partial
  force-close.

This profile is illustrative. It must be changed if measured pool depth, gas
cost, volatility, or vault utilization makes the chosen values unsafe.

## 15. Acceptance and calibration plan

### 15.1 Conservation invariants

Tests must establish:

1. Hook balances cover aggregate position collateral token by token.
2. Position debt shares sum to each vault's attributed debt shares.
3. Pool input consumed equals collateral reduction; unfilled input remains.
4. Output equals repayment plus donation, reward, and trader surplus.
5. Long chunks repay only USDC debt and short chunks repay only WETH debt.
6. Long time warps without repayment or write-off leave debt and trigger ticks
   unchanged.
7. A write-off reduces only the originating protocol-seeded vault.

### 15.2 State-machine cases

Exercise ordinary callback activation, bounded work, cursor resume, price-
recovery pause, re-entry, debt constancy across time, per-chunk
`poke`/callback parity despite different work and reward budgets, zero
range-depth proxy, far-boundary force-close, price-limited partial fill, retry,
collateral exhaustion, and lender loss.

### 15.3 Adversarial cases

Vary token order, 6/18 decimal pairs, one-block and multi-block price pushes,
liquidity removal, exact trigger congestion, swap ordering around pokes,
utilization shocks, and long time warps.

### 15.4 Empirical selection

For each candidate pool and parameter set, report:

- debt retired per chunk and per unit of induced price movement;
- total liquidation duration and callback gas;
- retained trader exposure after recovery;
- execution drag and LP donation;
- poke reward relative to transaction cost;
- frequency of force-close and partial retries; and
- protocol-seeded vault loss under gap scenarios.

No LT, range width, or leverage tier is production-ready until those results are
evaluated out of sample.

The root TruePerp suite covers leverage policy and metrics as well as the v0
composition, including constant debt under time warp. The inherited TrueLend
suite validates the reused kernel more broadly. Passing tests do not replace
the empirical calibration required above.
