# TruePerp: Research Note on AMM-Native Perpetual Margin

## Abstract

TruePerp studies whether a Uniswap v4 pool can be not only the execution venue
for leveraged exposure, but also the native clock and state source for a gradual
liquidation process. The proposed instrument is physically represented. In a
WETH/USDC market, a long holds WETH and owes USDC; a short holds USDC and owes
WETH. Both positions have no practical fixed expiry. For v0, the supporting
debt vaults are protocol-seeded and charge zero interest, so elapsed time does
not change debt or invalidate the fixed opening trigger geometry.

This representation is economically similar to perpetual long and short
exposure, but it is not a cash-settled perpetual swap. It is isolated margin with
continuous maturity. Profitable traders do not require a protocol balance sheet
to manufacture settlement cash: their result is already embodied in held spot
inventory. The residual solvency problem is collateralized-credit risk.

The research contribution is the v4-hook execution loop. Ordinary swaps record
pool-local observations and cross indexed risk boundaries. The hook then
converts a bounded amount of an unsafe position's collateral into its debt asset
through the same pool, donates a declared charge to the LPs that absorb the
trade, and repays the lending vault. Processing pauses when price recovers
through the stored safe-side boundary, resumes on renewed deterioration,
remains callable through a permissionless `poke`, and ends in a
slippage-bounded force-close if gradual treatment fails.

> **Status.** This note specifies the approved architecture. TruePerp remains an
> unaudited research prototype under implementation migration.

## 1. Research question

The narrow question is:

> Can ordinary activity in an AMM advance a bounded, recovery-sensitive
> liquidation of real leveraged inventory without delegating execution price and
> timing to a privileged keeper?

This separates into five testable subproblems:

1. **Representation:** can both long and short exposure be fully described by
   held inventory and debt?
2. **Detection:** can a pool-local price history and the live tick identify risk
   without an external feed?
3. **Execution:** can liquidation be divided into bounded swaps that repay debt?
4. **Liveness:** can callbacks and public pokes make progress without imposing
   unbounded work on ordinary swappers?
5. **Loss allocation:** who bears a shortfall after all collateral is converted?

The project does not claim that a pool price is manipulation-proof, that gradual
execution survives every market gap, or that leveraged spot is legally or
economically identical to a futures contract.

## 2. Position representation

Let $P$ denote quote units per base unit. For WETH/USDC, $P$ is USDC per WETH.

### 2.1 Long

A long holds $C_b$ units of base and owes $D_q$ units of quote. Its quote equity,
LTV, and price delta are

$$
Q_L(P)=PC_b-D_q,
\qquad
\ell_L(P)=\frac{D_q}{PC_b},
\qquad
\frac{\partial Q_L}{\partial P}=C_b.
$$

The demo router combines the trader's quote margin with borrowed quote and swaps
the complete amount into base. If base appreciates, the held inventory funds the
gain. If base falls, selling part of that inventory retires quote debt.

### 2.2 Short

A short holds $C_q$ quote and owes $D_b$ base. Its quote equity, LTV, and delta
are

$$
Q_S(P)=C_q-PD_b,
\qquad
\ell_S(P)=\frac{PD_b}{C_q},
\qquad
\frac{\partial Q_S}{\partial P}=-D_b.
$$

The short is constructed by borrowing base, selling it, and retaining both the
sale proceeds and the trader's quote margin. If base falls, fewer quote units
are required to repurchase the debt asset.

### 2.3 Symmetry and an important leverage convention

The balance sheets are symmetric, but common leverage labels are not. For a
long, gross base inventory includes base bought with the trader's quote margin
as well as base bought with borrowed quote. For a short, directional exposure
is the borrowed base; the quote collateral also contains the sale proceeds.
Accordingly, interfaces should display both LTV and directional exposure divided
by equity rather than relying on an ambiguous single “leverage” number.

## 3. Why physical representation changes counterparty risk

An uncapped synthetic long has claim $B(P-E)$ in quote units. As $P$ grows, that
claim is unbounded even if the counterparty vault contains finite quote cash. A
cash-settled system must hedge the exposure, cap the payout, recapitalize, or
define socialization.

The physical long instead owns $C_b$ base. Its value rises in the same asset that
causes the marked gain. The physical short owns the quote proceeds of selling
borrowed base. Its gain is the residual after buying that base back more cheaply.
The protocol need not match winners to losers or make a pool promise uncapped
cash PnL.

A perfectly hedged synthetic counterparty would converge on the same inventory:
backing a long requires buying and reserving base, while backing a short requires
selling borrowed base and retaining quote. Recording the spot-plus-debt position
directly removes hedge-basis, rebalance, withdrawal-seniority, and derivative-
ledger divergence from the core design.

This does not remove insolvency. It changes its form. If execution is delayed or
the pool gaps, collateral may buy less than the outstanding debt. The
protocol-seeded vault for that debt asset then bears the residual credit loss.

## 4. Why the AMM must execute actively

Passive concentrated liquidity cannot perform the required liquidation trade.
When WETH falls, an LP position naturally acquires WETH, whereas an unsafe long
must sell WETH. When WETH rises, an LP position naturally sells WETH, whereas an
unsafe short must buy WETH. In both directions, liquidation runs with the adverse
price move and passive AMM inventory runs against it.

An oracle-free range order therefore cannot simply make the position “liquidate
itself.” Active execution is necessary. TruePerp's proposal is to make that
execution native to the pool hook, with requested input kept small relative to
a conservative liquidity proxy and paced over time rather than delegated as a
one-shot discounted transfer.

## 5. Price roles

The design distinguishes three price roles:

- **Admission price.** A truncated history of pre-swap ticks is combined with
  live state conservatively so an opening transaction cannot create its own
  borrowing power.
- **Trigger price.** The actual pool tick determines whether a registered
  liquidation boundary has been crossed.
- **Execution price.** PoolManager balance deltas from the actual swap determine
  collateral consumed, debt-token output, donation, and repayment.

These roles must not be collapsed into a fictitious settlement mark. The filter
can reject unsafe origination; it cannot guarantee the proceeds of a future
liquidation. Solvency depends on executable liquidity at that future time.

## 6. Callback-driven liquidation

### 6.1 Ordinary-swap path

The intended transaction sequence is:

1. `beforeSwap` records the pre-swap tick when a new observation is due.
2. The ordinary user's swap executes and may move the live tick.
3. `afterSwap` walks registered boundaries crossed since the prior tick and
   refreshes only affected positions.
4. The driver selects a bounded number of active, due positions.
5. For each selected position, the hook calls a real exact-input swap in the
   already-open PoolManager context.
6. The hook settles collateral input, takes debt-asset output, donates the
   ordinary-callback charge to in-range LPs, and sends net output to the debt
   vault. The ordinary callback pays no caller reward; `poke` and `forceClose`
   carve their caller reward from the same total charge.
7. Debt shares and collateral are updated from actual results, after which the
   driver refreshes fixed-range membership at the hook-generated tick.

The local Uniswap v4 `Hooks.sol` library skips `beforeSwap` and `afterSwap` when
`msg.sender` is the hook itself. A liquidation swap initiated by the hook
therefore does not recursively invoke its callbacks. Trigger walking and queue
processing still require explicit per-call caps and persisted cursors;
otherwise an attacker could make ordinary swaps exceed the block gas limit by
opening many dust positions at one boundary.

### 6.2 Directional flows

For a long chunk, the hook sells WETH for USDC and repays the USDC vault. For a
short chunk, it spends USDC to buy WETH and repays the WETH vault. In both cases
the position's held balance and debt decline together.

Unlike the earlier cash-accounting model, these are genuine AMM trades. A long
liquidation exerts sell pressure and a short liquidation exerts buy pressure.
The implementation bounds requested input, not realized price impact: ordinary
chunks do not have a local sqrt-price limit.

### 6.3 Recovery pause

Completed chunks are irreversible. Nevertheless, the process is pausable. If
the tick reverses through the safe-side boundary of the stored range, the active
flag is cleared and no further chunk is due. The trader retains all unsold
collateral and its associated exposure. A later adverse crossing re-enqueues the
position. The compact demo does not dynamically move its trigger ticks after
repayment.

### 6.4 Permissionless poke

Swap cadence is not a reliable liveness guarantee. `poke(pool)` therefore enters
a PoolManager accounting context and invokes the same bounded trigger walk and
queue driver. A caller may receive a reward, but only from the liquidation
charge generated by real output. The poke path must not use a different price,
size rule, or accounting rule from the callback path. Because v0 debt does not
grow with time, there is no interest-only deterioration path. `poke` does not
relocate the position's fixed range.

## 7. Pacing and market feedback

Let $C$ be remaining collateral in its native token, $N$ a target chunk count,
$\tau$ the nominal interval, $d$ normalized depth through the liquidation range,
and $\varrho$ position size relative to a range-depth proxy. A generic desired
chunk is

$$
x_{des}=\frac{C}{N}
\min\!\left(\left\lfloor\frac{\Delta t}{\tau}\right\rfloor,a_{max}\right)
(1+d)(1+\min(\varrho,1)).
$$

Actual input is bounded by remaining collateral and a fraction $\eta$ of the
proxy $D_{range}$:

$$
x=\min(x_{des},\eta D_{range},C).
$$

The current kernel computes this proxy by extending the pool's current active
liquidity over the full position range; it does not traverse initialized ticks.
If $\Delta t<\tau$ or $D_{range}=0$, the chunk is zero. A smaller proxy increases
position pressure but reduces the absolute input cap. This bounds order size but
does not prove that the amount is executable at low impact.

Liquidation is endogenous order flow. It can push the pool farther into the
risk range and activate other positions. The parameter problem is therefore a
feedback-control problem: cadence must retire debt quickly enough to protect
lenders, while each trade must remain small enough not to create the cascade it
is meant to prevent.

## 8. Zero-carry scope and the absence of synthetic funding

The current `PerpLendingVaultFactory` sets the base rate, both rate slopes,
reserve factor, and rate ceiling to zero. If $I_a$ is the inherited WAD-scaled
index, $W=10^{18}$, and $s_i$ is a position's debt shares, then

$$
I_a(t)=W,
\qquad
D_i(t)=\frac{s_iI_a(t)}{W}=s_i
$$

until repayment or write-off changes the shares. Utilization still constrains
new borrowing and withdrawals, but it does not price carry. The protocol-seeded
vault capital earns no interest and no interest-funded reserve grows.

This is not equivalent to disabling an essential perpetual-price anchor. A
cash-settled perpetual creates a separate derivative price and commonly uses
long-short funding to pull that price toward an external index. TruePerp creates
no derivative mark: it holds WETH or USDC, owes the other asset, and executes
entry, exit, and liquidation in the WETH/USDC spot pool. Arbitrage between that
pool and external venues is the relevant price-alignment mechanism.

Zero carry makes the v0 fixed trigger range temporally coherent. Nonzero borrow
interest could make a position unsafe without crossing its opening tick. A
production carry design therefore requires dynamic, debt-aware trigger
re-registration with bounded work and explicit liveness guarantees. That work
is intentionally deferred.

The prototype encodes “no scheduled expiry” as the maximum 32-bit term,
approximately 136 years. Reaching it is an actual force-close reason, but it is
a finite implementation sentinel rather than a practical product maturity.

## 9. Force-close and bad debt

Gradual processing is no longer appropriate after the position reaches its far
risk boundary, conservative collateral coverage fails, or the finite horizon
sentinel is reached. `forceClose` is then permissionless.

The function attempts to swap remaining collateral into the debt asset under a
hard price-impact limit. It uses actual PoolManager deltas. A thin or drained
pool may fill only part of the requested input; unfilled collateral is restored
to the position and the position remains eligible for retry. This is preferable
to selling through arbitrary impact, but it creates explicit liveness risk.

The liquidation charge is deducted from gross output before net debt repayment.
Surplus belongs to the trader. If collateral is fully consumed and debt remains,
the shortfall is denominated in the borrowed asset. The inherited write-off path
checks reserves first, but the v0 factory neither seeds nor grows a reserve
balance, so the expected loss falls directly on the protocol-seeded capital in
that asset vault. A USDC shortfall from a long cannot be silently charged to
WETH capital, and vice versa.

There is no practical scheduled product maturity. Nevertheless, reaching the
prototype's maximum-32-bit horizon—approximately 136 years—is an actual third
force-close reason. It is a finite encoding artifact, not literal infinity.

## 10. Relation to adjacent market structures

| System | Price source | Position backing | Carry | Liquidation |
|---|---|---|---|---|
| Cash-settled perpetual | external index or venue mark | counterparty/insurance balance sheet | long-short funding | close or transfer a derivative position |
| Conventional isolated margin | exchange or oracle | held spot plus borrowed asset | borrow interest | discrete collateral sale |
| Gradual oracle lending | oracle or internal bands | collateral plus debt | borrow interest | repeated or banded conversion |
| TruePerp v0 | attached AMM and pool-local history | held spot plus opposing-asset debt | zero; production borrow carry deferred | callback-driven, paced swaps in the same AMM |

TruePerp's novelty claim should be evaluated against margin lending and gradual
liquidation, not only against perpetual exchanges. Its distinctive combination
is a symmetric long/short interface, no expiry, pool-native triggering, and
hook-executed gradual conversion with no privileged price-setting keeper.

## 11. Threat model and open questions

### 11.1 Manipulation

A manipulator may move the tick into a victim's range, cause one or more real
liquidation swaps, and restore the price. The attack pays two-way AMM costs and
receives no atomic liquidation bonus, but may profit from positioning around the
forced flow. Its economics depend on depth, chunk size, observation policy,
victim concentration, and transaction ordering. Negative expected value must be
demonstrated, not asserted.

### 11.2 Gaps and absent liquidity

A price can jump across the complete range before a callback processes enough
collateral. Liquidity can also disappear exactly when needed. The force-close
limit prevents an unbounded fire sale but cannot manufacture debt-token output.
The residual is lender risk.

### 11.3 Liveness

Markets with few swaps depend on pokes. Rewards that are too small strand work;
rewards that are too large consume recovery value. The v0 zero-rate choice
removes interest-only deterioration; production carry would have to restore
liveness for debt-driven trigger changes.

### 11.4 Shared execution venue

Liquidations change the same state used to trigger later liquidations. Internal
swaps must settle safely inside the PoolManager context, avoid callback
recursion, and refresh boundary cursors after their own price movement.

### 11.5 Credit liquidity

Vault withdrawals and new loans compete for the same lendable asset. Utilization
limits and honest withdrawal semantics remain required even at a zero rate. The
demo treats the vaults as protocol-seeded support capital, not as yield-bearing
products, and there is no marked trader-PnL transfer for a temporary depositor
to capture.

## 12. Experimental program

The central hypotheses are:

1. Debt retired per unit of pool impact is higher under paced execution than
   under an equivalent one-shot liquidation.
2. Recovery-sensitive pausing preserves materially more trader exposure after
   transient boundary crossings.
3. The combined swap and donation cost makes short-lived manipulation-induced
   liquidation uneconomic for calibrated position caps and chunk-input rules.
4. Poke rewards provide liveness in low-volume pools without dominating borrower
   recovery value.
5. Vault accounting contains each shortfall to the protocol-seeded capital for
   the borrowed asset.

Evaluation must include randomized conservation invariants and historical or
synthetic paths with volatility, jumps, liquidity withdrawal, sparse swaps,
long time warps, concentrated positions at one tick, and adversarial transaction
ordering. It must verify that time alone changes neither debt nor trigger
geometry. Report time to repay, LTV path, retained exposure, pool impact,
execution drag, LP donation, keeper reward, and bad debt.

## 13. Recommended demonstration

A credible hackathon demonstration uses one curated WETH/USDC pool and two
protocol-prefunded debt vaults. It should show:

1. atomic creation of a WETH-held/USDC-debt long and a USDC-held/WETH-debt short;
2. debt remaining constant across a long time warp, preserving the fixed
   opening trigger ticks with no funding transfer;
3. an ordinary swap crossing a long or short risk boundary;
4. the hook's real liquidation swap and the corresponding PoolManager deltas;
5. donation to in-range LPs and repayment to the correct debt vault;
6. recovery pausing later chunks while preserving remaining collateral;
7. `poke` advancing the same per-chunk engine in a quiet pool, with its larger
   work budget and charge-funded reward; and
8. a price-limited force-close that partially fills, retries, and records any
   final shortfall against the originating vault.

The appropriate claim is not “a conventional perp without an oracle.” It is:

> an AMM-native, expiry-free margin protocol in which ordinary pool activity
> advances gradual liquidation of real spot inventory against real debt.

The current repository verification passes all 14 root TruePerp tests and all
94 inherited TrueLend tests. These results validate the tested implementation
paths, not production safety or economic calibration.

## References

1. Adams et al., *Uniswap v4 Core* and *Uniswap v4 Hooks*.
2. TrueLend, repository and research notes on AMM-native gradual liquidation.
3. Egorov, *Curve Stablecoin and LLAMMA*, on banded soft liquidation.
4. Research on Uniswap time-weighted and truncated pool-price observations.
