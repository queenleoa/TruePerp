# TruePerp: Parameter and Mathematical Framework

## Document status

This document parameterizes TruePerp's approved physical architecture: an
expiry-free WETH long holds WETH and owes USDC; an expiry-free WETH short holds
USDC and owes WETH. Entry, exit, gradual liquidation, and terminal close use
actual WETH/USDC pool swaps. Debt-vault interest is carry. There is no marked
cash-PnL liability or long-short funding ledger.

Values marked **prototype** are inherited from the current TrueLend liquidation
kernel or vault factory. Values marked **illustrative** are useful for a
hackathon trace but are not empirically calibrated production recommendations.

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
| $D_q$ | current USDC debt of a long, including interest |
| $C_q$ | USDC held by a short |
| $D_b$ | current WETH debt of a short, including interest |
| $Q_L,Q_S$ | long and short equity in quote units |
| $\ell_L,\ell_S$ | long and short loan-to-value ratio |
| $\mathrm{LT}$ | soft-liquidation LTV threshold |
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
collateral and current indexed debt.

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

The last condition is part of the target risk policy and must not be claimed as
implemented until it is enforced in the contracts.

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
A separate force-close coverage check uses current collateral and indexed debt
because interest and prior chunks change the economic coverage even though they
do not move the stored range.

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

The order of operations is normative:

1. `beforeSwap` records the pre-swap observation;
2. the ordinary swap executes;
3. `afterSwap` walks crossed triggers;
4. due chunks execute as direct PoolManager swaps;
5. actual deltas settle, charge is split, and debt is repaid; and
6. trigger membership is refreshed after hook-generated price movement.

`poke` invokes the same trigger and queue driver within a PoolManager unlock.
Current indexed debt is instead used by the separate permissionless force-close
coverage check; `poke` does not dynamically relocate stored trigger ticks.

## 9. Carry and vault parameters

For vault asset $a$, debt shares $s$, WAD scale $W=10^{18}$, and borrow index
$I_a$ give

$$
D=\frac{sI_a}{W}.
$$

The current implementation accrues linearly over each update interval:

$$
I_a' = I_a\left(1+r_a(u_a)\frac{\Delta t}{365\text{ days}}\right).
$$

For lender-owned cash $L_a$ excluding reserves and total debt $D_a$,

$$
u_a=\frac{D_a}{L_a+D_a}.
$$

The **prototype** vault factory uses the kinked annual rate

$$
r(u)=
\begin{cases}
0.04\,u/0.80, & u\le0.80,\\[4pt]
0.04+1.00\,(u-0.80)/0.20, & u>0.80,
\end{cases}
$$

subject to a 400% absolute ceiling. The rate at the 90% new-borrow cap is
approximately 54% APR. Later interest accrual or cash redemptions can raise
utilization further; the default curve reaches 104% APR at 100% utilization.
Ten percent of accrued interest is assigned to protocol reserves; the remainder
increases lender share value.

Longs pay this curve in USDC. Shorts pay the independent WETH curve. There is no
requirement that the two interest flows net to zero.

### 9.1 Vault share and write-off accounting

Lender-owned vault assets are

$$
A_{LP}=\text{cash excluding reserves}+\text{performing debt}.
$$

A redemption can transfer no more than available cash; outstanding loans are not
liquid. If protocol reserves $R_v$ are fully backed by token cash when
unrecoverable debt $S$ is written off, lender assets change by

$$
A_{LP}'=A_{LP}-\max(S-R_v,0).
$$

This is the intended reserve-first waterfall, not an unconditional identity for
the current prototype. Reserves accrue as bookkeeping before borrowers pay the
interest and can exceed the vault's token balance. In that state, reducing the
reserve counter during write-off need not release cash one-for-one, so actual
lender loss must be measured from `totalAssets()` before and after the write-off.
The shortfall nevertheless remains isolated to the asset vault that originated
the debt.

## 10. Prototype liquidation configuration

The inherited kernel currently exposes the following defaults. They are useful
for reproducibility, not endorsements:

| Parameter | Prototype value | Interpretation |
|---|---:|---|
| range width | 3,466 ticks | about a $\sqrt{2}$ price factor |
| minimum admission gap | 100 ticks | about 1% from post-route spot |
| default maximum selectable LT | 99% | initialization default, not demo recommendation |
| hard configurable LT upper bound | 99.5% | enforced by `setConfig` |
| base liquidation charge | 50 bps | scaled by LT and time in liquidation |
| coverage/slippage buffer | 200 bps | capped by half the position's LT gap |
| max chunk/proxy fraction $\eta$ | 1% | absolute input bound against rough range-depth proxy |
| target chunks $N$ | 100 | 1% base cadence before multipliers |
| chunk interval $\tau$ | 60 seconds | earliest ordinary cadence |
| catch-up cap $a_{max}$ | 5× | limits elapsed-time acceleration |
| `poke`/force-close caller reward | 10 bps of output | carved from the liquidation charge |
| force-close tick limit | 1,000 ticks | roughly 10% adverse price movement |
| perpetual horizon sentinel | `uint32.max` seconds | no practical scheduled expiry; finite encoding |

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

The examples explain why “3–5× leverage” must name the direction and leverage
definition.

## 12. Illustrative long liquidation

Continue the long example at $P=2{,}150$. Before further interest,

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
   $V_D(1-b_{eff})<D$ after current interest accrual; and
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

If collateral becomes zero before debt does, remaining debt is written off to
vault reserves and then lenders. Because reward and donation precede repayment
in the current kernel, their caps are part of lender-solvency calibration.

## 14. Recommended demo profile

For an understandable demonstration, use:

- one curated WETH/USDC pool with visible, persistent wide-range liquidity;
- both debt vaults prefunded well below their 90% utilization cap;
- a 90% soft LT with opening LTV near 80%, rather than the 99% default maximum;
- explicit display of long and short directional leverage;
- 60-second base chunk cadence, 100 target chunks, and a 1% depth cap;
- deadlines and strict output/price bounds for trader routes;
- the inherited pool-local observation filter warmed before admission; and
- deliberate scenarios for recovery pause, quiet-market poke, and partial
  force-close.

This profile is illustrative. It must be changed if measured pool depth, gas
cost, volatility, or interest utilization makes the chosen values unsafe.

## 15. Acceptance and calibration plan

### 15.1 Conservation invariants

Tests must establish:

1. Hook balances cover aggregate position collateral token by token.
2. Position debt shares sum to each vault's attributed debt shares.
3. Pool input consumed equals collateral reduction; unfilled input remains.
4. Output equals repayment plus donation, reward, and trader surplus.
5. Long chunks repay only USDC debt and short chunks repay only WETH debt.
6. Interest never creates debt assets without the corresponding index/share
   liability.
7. A write-off reduces only the originating vault after reserves.

### 15.2 State-machine cases

Exercise ordinary callback activation, bounded work, cursor resume, price-
recovery pause, re-entry, interest-only force-close eligibility, per-chunk
`poke`/callback parity despite different work and reward budgets, zero
range-depth proxy, far-boundary force-close, price-limited partial fill, retry,
collateral exhaustion, and lender loss.

### 15.3 Adversarial cases

Vary token order, 6/18 decimal pairs, one-block and multi-block price pushes,
liquidity removal, exact trigger congestion, swap ordering around pokes,
utilization shocks, and adverse base/quote interest paths.

### 15.4 Empirical selection

For each candidate pool and parameter set, report:

- debt retired per chunk and per unit of induced price movement;
- total liquidation duration and callback gas;
- retained trader exposure after recovery;
- execution drag and LP donation;
- poke reward relative to transaction cost;
- frequency of force-close and partial retries; and
- reserve use and lender loss under gap scenarios.

No LT, range width, or leverage tier is production-ready until those results are
evaluated out of sample.
