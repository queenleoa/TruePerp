# TruePerp: Pool-Referenced Perpetuals with Progressive Cash-Settled Deleveraging

**Research note · hackathon prototype · September 2026**

## Abstract

TruePerp studies whether a perpetual-futures market can use a Uniswap v4 pool as its native price reference without relying on an external oracle. Each TruePerp market is tied to one spot pair. An ETH/USDC pool therefore supports one synthetic ETH perpetual quoted, margined, and settled in USDC; it does not support arbitrary underlyings. The Uniswap pool supplies the price history and an activity clock, but it does not take trader risk. A separate, cash-funded PerpVault is the counterparty, in the same broad sense that an LP-backed perpetual venue places trader profit and loss against a shared liquidity pool.

The proposed mechanism replaces an all-at-once liquidation with progressive deleveraging. When a position falls below maintenance margin, the protocol closes bounded slices of synthetic exposure and realizes each slice in cash. No base asset is sold into the spot pool. Consequently, the liquidation mechanism itself creates no forced spot order and no direct price impact. This is the central contribution of the prototype.

The checked-in `v0.1` contracts demonstrate this mechanism, but they do not establish production safety. In particular, current vault withdrawals, liability accounting, funding settlement, raw-spot deleveraging, and liquidation re-triggering admit important failure modes. The recommended `v0.2-demo` bounds counterparty liability at entry: each position selects a maximum cash profit below a market ceiling, the vault reserves that amount, and the position closes—or stops accruing profit—at the corresponding take-profit bound. This paper separates that design from `v0.1` and adds one curated market, a fixed vault epoch, locked reference liquidity, free-cash and depth-aware exposure limits, bounded settlement prices, re-triggerable liquidation, and a catastrophic payout-shortfall procedure. Funding is disabled in the base demo.

## 1. Research question and scope

A perpetual market must determine a reference price, maintain collateral, transfer profit and loss, and resolve insolvent positions. Conventional systems often obtain the reference price from an external feed and close distressed positions in a discrete transaction [5]. TruePerp asks a narrower question:

> Can a perpetual use the price of its associated spot pool and reduce distressed exposure progressively, without forcing a trade in that pool?

The proposed answer is an **externally-oracle-free, pool-referenced, cash-settled perpetual**. “Externally-oracle-free” is intentionally narrower than “oracle-free.” The design still makes an oracle-like judgment: it derives a reference from the current and historical states of one Uniswap pool. It removes dependence on a separate feed, but it inherits the quality, manipulation resistance, and liveness of the selected pool.

This is a proof of mechanism for a hackathon. It is not an audited exchange, a complete risk engine, or a claim that price manipulation has been eliminated.

## 2. Market definition

### 2.1 One spot pair defines one perpetual

A TruePerp market is identified by a specific Uniswap v4 pool and a base/cash interpretation of its two currencies:

| Component | ETH/USDC example |
|---|---|
| Spot reference | one designated ETH/USDC Uniswap v4 pool |
| Perpetual underlying | synthetic ETH exposure |
| Quote and margin asset | USDC |
| Settlement asset | USDC |
| Risk-taking liquidity | a separate USDC PerpVault |

If the designated pool price is 2,500 USDC per ETH, a 1 ETH long has 2,500 USDC of notional. The trader does not receive ETH, and opening the perpetual does not buy ETH from Uniswap. Profit and loss are cash ledger entries settled in USDC.

The pool cannot support “anything.” A BTC perpetual requires an appropriate BTC/cash pool and a distinct market; an equity or an off-chain index would require another trusted price source and would no longer satisfy this design’s central premise. Pool identity, fee tier, hook, and token orientation are therefore part of the instrument definition, not incidental implementation details.

The present `v0.1` code treats `currency0` as base and `currency1` as cash. Because Uniswap orders currencies by address, `v0.2-demo` should record the economic orientation explicitly rather than imply general listing support.

### 2.2 The two pools have different roles

![TruePerp market architecture: the Uniswap pool supplies price and activity, while the PerpVault supplies counterparty capital](docs/assets/architecture.png)

The word “pool” otherwise creates an important ambiguity:

- The **Uniswap pool** holds base and cash for spot swaps. It supplies price observations, observable depth, and swap callbacks.
- The **PerpVault** holds cash contributed by vault LPs. It pays trader gains and receives trader losses, fees, penalties, and eligible funding flows.
- The **hook** holds trader margin and maintains positions. It reads the spot pool and transfers cash between traders and the PerpVault.

Thus, TruePerp is GMX-like only at the counterparty layer: shared LP capital stands opposite aggregate trader profit and loss. It is not correct to say that the ETH/USDC Uniswap LPs are the house. Unless the same person separately deposits into the PerpVault, those LPs do not underwrite the perpetual.

## 3. Accounting model

Let $B>0$ be base size, $E$ entry price, $P$ settlement price, and $M$ remaining cash margin. Ignoring fees and funding, unrealized profit and loss is

$$
\operatorname{PnL}_{long}=B(P-E), \qquad \operatorname{PnL}_{short}=B(E-P).
$$

If $F$ is cumulative funding owed by the position, its equity is

$$
Q=M+\operatorname{PnL}-F.
$$

The position is healthy when

$$
Q \ge mPB,
$$

where $m$ is the maintenance-margin ratio. Opening must use post-fee margin, not the pre-fee deposit, when checking initial margin.

With funding fixed at zero, as in the base demo, the long zero-equity and
maintenance prices are

$$
P_{bk}=E-\frac{M}{B}, \qquad P_{maint}=\frac{P_{bk}}{1-m}.
$$

For a short under the same assumption, the corresponding prices are

$$
P_{bk}=E+\frac{M}{B}, \qquad P_{maint}=\frac{P_{bk}}{1+m}.
$$

These equations define a position-specific intervention range. They do not guarantee that the vault can pay the profitable side; position health and counterparty solvency are separate properties.

### 3.1 Capped claims and conservative vault accounting

`v0.1` uses net, uncapped PnL to value vault shares. This is unsafe because a
large losing position may be unable to pay its theoretical loss, while a winner
may close first. `v0.2-demo` instead requires position $i$ to select $K_i$, its
maximum profit above the return of its own remaining margin, no greater than a
market ceiling. Let $X_i=U_i-F_i$ be price PnL less a future collected funding
debit; $F_i=0$ in the base demo. Capped gross winning claims are

$$
G(P)=\sum_i\min\!\left(\max(X_i(P),0),K_i\right).
$$

Losses collectible from trader margin are capped separately:

$$
R(P)=\sum_i \min\!\left(\max(-X_i(P),0),M_i\right).
$$

For physical vault cash $C$ and other funded obligations $R_o$, conservative
reporting NAV and spendable free cash are

$$
V(P)=C+R(P)-G(P)-R_o,
\qquad
C_{free}=\max(C-K-R_o,0),\qquad K=\sum_iK_i.
$$

The cap in $R(P)$ is essential: a bankrupt trader is not an unlimited
receivable. Gross winning claims remain visible even when losing positions
appear to offset them. Because $R(P)$ is not collected cash, $V(P)$ is a
reporting quantity; only post-admission $C_{free}$ may support additional risk.

At admission, the vault locks $K_i$ from free cash without netting longs against
shorts. The illustrative market ceiling is 100% of post-fee initial margin.
Fees and penalties reduce margin or payout and cannot enlarge the reserved
claim. Ignoring fees, the take-profit price is $E+K_i/B$ for a long and
$E-K_i/B$ for a short; admission must keep the short-side bound positive. At
the bound the position auto-closes. If processing is delayed, its claim remains
capped at $K_i$. Settlement releases the reserve.

## 4. Price construction

The spot pool is observable but manipulable. A one-block spot price is responsive and cheap to move in a shallow pool; a historical statistic is harder to move but reacts slowly to genuine jumps [3, 4]. TruePerp therefore cannot obtain both instant responsiveness and strong manipulation resistance merely by renaming the pool price an oracle.

`v0.1` records pre-swap observations and uses a truncated median with directional, adverse prices for entry and voluntary exit. Progressive deleveraging, however, realizes against raw spot. Combined with immediate vault entry and exit, this leaves an economically meaningful manipulation path.

For `v0.2-demo`, every value-transferring action begins from

$$
P_g=\operatorname{clamp}\!\left(P_s,P_f(1-\delta),P_f(1+\delta)\right),
$$

where $P_s$ is spot, $P_f$ is the pool-derived filtered price, and $\delta$ is
the maximum unconfirmed deviation. Long entries use $\max(P_g,P_f)$ and short
entries use $\min(P_g,P_f)$; voluntary exits reverse those choices. Partial
liquidation, backstop, take-profit, and terminal settlement use $P_g$. Voluntary
actions also include a deadline and an acceptable price bound.

This rule limits the value transferable by a short-lived distortion; it does not make a thin pool secure against sustained manipulation. The deviation bound $\delta$ limits price movement recognized in one window, while $K_i$ independently limits a position's total counterparty claim. Market admission and exposure caps therefore depend on locked executable spot depth as well as free vault cash.

## 5. Progressive deleveraging

![A position moves from healthy operation into a maintenance-to-bankruptcy range, where bounded cash-settled chunks reduce exposure](docs/assets/liquidation-range.svg)

When equity falls below maintenance, the engine closes a bounded amount $\Delta B$ of synthetic exposure. A general pacing rule is

$$
c^*=\max\!\left(0,\frac{hP_gB-Q}{P_g(h-\pi)}\right),
\qquad h>\pi,
$$

$$
\Delta B=\min\!\left(c^*,\frac{B}{N}g(\Delta t,d,\ell),
\eta D_{lock},B\right),
$$

where $c^*$ is the amount required to restore target margin ratio $h$, $N$ is a
target chunk count, $g$ responds to elapsed time, range depth $d$, and position
pressure $\ell$, $D_{lock}$ is locked in-range spot depth, and $\eta$ is a
conservative depth fraction. The pacing structure is adapted from TrueLend’s
liquidation kernel [1]. Depth governs how much risk may be processed at one
price observation; it is not consumed by the close.

At price $P_g$, closing a slice realizes its PnL against margin and reduces $B$. The hook sends no swap to Uniswap. This gives the mechanism its principal property:

> Progressive liquidation creates no forced spot order; it changes cash balances and synthetic open interest only.

The property removes liquidation-induced spot impact, not economic loss. Losses still move from trader margin to the PerpVault, and profitable traders remain claims on finite vault cash.

### 5.1 Health restoration and the penalty correction

At a fixed price and with no fee, realizing a slice preserves equity while reducing required maintenance. If the position closes fraction $r$ of its notional and pays penalty rate $\pi$ on that slice, define maintenance deficit depth as

$$
d=1-\frac{Q}{mPB}.
$$

The minimum fraction required to restore health at the same price is

$$
r \ge \frac{md}{m-\pi}, \qquad \pi<m.
$$

The often-used approximation $r\approx d$ is valid only when the penalty is negligible. At $\pi=m/4$, the requirement is $r\ge4d/3$; a sufficiently deep position cannot recover through partial reduction alone. Adverse price movement and funding during the episode increase the required reduction further.

Accordingly, the engine should be described as **progressive and pausable**, not reversible or universally self-terminating. Completed chunks are final. If price recovers, processing pauses; if health later deteriorates, processing must restart. If equity is exhausted or recovery is impossible, the protocol enters its explicit terminal-resolution path.

### 5.2 Re-triggerable state

`v0.1` registers fixed maintenance and bankruptcy ticks and can clear an active episode after health is restored. A later deterioration inside the original range need not cross another registered boundary, so processing may fail to restart. Funding can also change health without any tick crossing.

`v0.2-demo` should make health, rather than a one-time boundary crossing, authoritative. After every chunk or margin change it should recompute the next trigger, preserve an active watch state while the price remains in the range, and allow a permissionless poke to re-enqueue any unhealthy position. Queue capacity and per-tick registration must be protected against dust-position exhaustion.

## 6. Funding and open-interest control

The base `v0.2-demo` sets funding to zero. That isolates the liquidation claim and
avoids presenting `v0.1`'s non-conserving implementation as repaired. If funding
is added later, its purpose is to price inventory imbalance rather than a
mark-index premium [2]. For long and short base open interest $L$ and $S$, a
candidate skew measure is

$$
z=\frac{L-S}{L+S}.
$$

A simple model charges the crowded side at a rate proportional to $kz$. Because unmatched exposure is carried by the PerpVault, any residual belongs to that vault only after it has actually been collected.

Any future ledger must conserve cash. A nominal payer obligation remains recorded
until processed, but limited liability caps the collectible amount at available
margin. A recipient credit is recognized only after that cash is collected and
shares the position's existing $K_i$ cap. An uncollectible remainder is a
recorded shortfall, not an asset or an unfunded credit.

Open interest must satisfy both a free-cash constraint and a locked-spot-depth
constraint, evaluated after the proposed reserve is included. The first limits
the PnL that LP capital may have to pay; the second limits how much value can be
settled from a manipulable reference. A per-position cap prevents one account
from consuming the complete market budget.

## 7. Counterparty solvency and terminal resolution

Cash settlement makes the counterparty obligation explicit. In `v0.1`, a long can earn without bound as ETH rises while the vault contains finite USDC. No open-interest percentage alone proves solvency for that payoff. `v0.2-demo` therefore does not offer unlimited profit within one position: the trader chooses a maximum cash profit below the market ceiling and accepts mandatory settlement at that bound. The trader may open a new position afterward.

The primary solvency rule is $K_i\le C_{free}$ before admission, aggregate
reserve occupancy $K+R_o\le\rho C$ after admission, and recomputation of every
limit from post-admission $C_{free}$. The reserve cannot fund another position
or an LP withdrawal until position $i$ settles. Automatic take-profit improves
liveness and releases capital; the accounting cap, rather than automation, is
what bounds the claim.

`v0.2-demo` combines that rule with:

1. A curated single market and standard, allowlisted cash token.
2. Gross reservation of every live position's declared profit cap.
3. A fixed vault epoch: capital enters before trading and cannot enter or leave while any position or payout claim remains unsettled.
4. OI and position caps tied to both free cash and protocol-seeded spot depth locked for the epoch.
5. Separate margin, fee, and vault subaccounts within the sole demo market.
6. A close-only mode when actual cash falls below aggregate reserves.

If these invariants hold, an ordinary price move cannot create an unpaid winning claim. Pro-rata settlement remains a catastrophic fallback for an accounting failure, token anomaly, or other state in which actual cash is below reserved claims. The fallback preserves unspent trader margin, sets LP share value to zero, snapshots capped claims at the bounded mark, and distributes available counterparty cash pro rata. Any unpaid amount is recorded as an explicit haircut. Batch treatment avoids rewarding the first winner to close.

This fallback is not a normal risk-management tool. It defines the final bearer of loss if the primary reservation invariant has already failed.

## 8. Implemented `v0.1` and recommended `v0.2-demo`

| Area | Checked-in `v0.1` | Recommended `v0.2-demo` |
|---|---|---|
| Listing | Any pool can initialize; code fixes `currency0` as 18-decimal base | One curated market with explicit orientation and decimal normalization |
| Spot role | Tick, history, depth, and swap callbacks | Reference and clock; protocol depth locked for epoch |
| Counterparty | Separate per-pool PerpVault | Same economic role, with explicit reserves |
| LP liquidity | Immediate deposit and redemption | Fixed epoch; no active share entry or exit while OI is live |
| Profit payout | Unbounded position profit; payment may exceed vault cash | Trader-declared cash-profit cap, fully reserved; auto-close/cap at take profit |
| Vault NAV | Net, uncapped aggregate trader PnL | Capped gross winner claims; losing PnL capped by collectible margin |
| Cash accounting | Per-pool vaults, but shared hook token custody | Enforced per-market subaccounts and conservation checks |
| Admission | OI cap relative to current vault equity | Declared profit must be fully reservable; OI, depth, and position caps also apply |
| Settlement | Filtered adverse entry/exit; raw-spot chunks | Bounded pool-derived mark plus user deadline/price limits |
| Funding | Cumulative indices with unmatched transfers | Disabled in base demo; collection-backed ledger is future work |
| Liquidation | Tick-triggered fixed range and chunk queue | Health-authoritative, re-triggerable queue and refreshed thresholds |
| Insolvency | Recorded trader shortfall; payout can revert | Reservation is primary; pro-rata capped-claim impairment is catastrophic fallback |
| Governance | Mutable live configuration | Narrow parameter surface, events, delay, and emergency pause |

The right hackathon claim is therefore not “production-ready perpetual exchange.” It is “a working demonstration of progressive, cash-settled deleveraging driven by a spot pool, accompanied by a concrete risk design for the next iteration.”

## 9. Security assumptions and attack surfaces

The concept depends on the following assumptions:

- The designated spot pool has independent arbitrage activity and a protocol-seeded, wide-range position locked for the vault epoch.
- The cash asset behaves as a conventional ERC-20 and remains suitable as a unit of account.
- Swaps or permissionless pokes occur often enough to advance liquidation state.
- Vault capital remains locked for the risk period it underwrites.
- Administrative changes cannot rewrite live-position economics without notice.

The principal adversarial cases are short-lived and sustained pool-price manipulation, just-in-time vault deposits, withdrawal runs, winner-first settlement, unexpected loss of locked depth, trigger-queue exhaustion, and zero-liquidity periods. A bounded mark reduces the first case; it does not replace economic testing of the others. Funding conservation and multi-market isolation remain future-extension requirements rather than base-demo claims.

External-oracle independence also creates a basis question: if the chosen Uniswap pool diverges from the wider ETH market, TruePerp settles to the chosen pool. This is internally consistent but may surprise traders. The interface must name the exact reference pool and display the basis risk.

## 10. Evaluation plan

Evaluation should test the mechanism separately from the business claim that vault LPs will earn an adequate return.

**Contract invariants.** Property and invariant tests should establish market cash conservation, aggregate reserved cash at least equal to aggregate declared profit caps, no claim above its cap even if auto-close is delayed, correct long/short symmetry, post-fee margin admission, zero funding in the base demo, repeatable liquidation activation, queue liveness, and the absence of any hook-initiated spot swap during a chunk.

**Adversarial scenarios.** Tests should include all live positions reaching their profit caps, delayed take-profit execution, one-block and multi-block price pushes, same-epoch deposit and withdrawal attempts, winners closing before losers, unexpected locked-depth failure, empty spot liquidity, dust positions at a common trigger, and adverse transaction ordering.

**Simulation.** Historical and synthetic paths should vary volatility, gaps, pool depth, swap cadence, vault capitalization, skew, and withdrawal demand. Report time to restored health, fraction of exposure retained, reserve utilization, vault drawdown, payout deficit, and forced spot volume. Compare progressive deleveraging with an otherwise equivalent one-shot close. Parameter values should be inferred from these experiments rather than inherited from the lending analogue.

**Demo trace.** A persuasive demonstration opens an ETH/USDC long, moves the reference through maintenance with an ordinary spot swap, shows several cash-settled reductions, verifies that the hook issues no spot swap, and stops when the smaller position becomes healthy. A second trace should show the profit reserve being locked, the position capped or closed at take profit, and the reserve released. A fault-injection test—not ordinary market operation—should exercise the catastrophic pro-rata fallback.

## 11. Limitations

TruePerp does not eliminate price judgment. It replaces an external feed with one named on-chain venue and therefore inherits that venue’s liquidity, manipulation cost, and liveness. A bounded mark limits abrupt transfers but delays recognition of genuine jumps.

Cash settlement alone does not make `v0.1` fully collateralized: long profit is unbounded while PerpVault cash is finite. `v0.2-demo` obtains a bounded liability by limiting each position's net cash profit and reserving that amount. This is a deliberate product trade-off: traders give up unlimited upside and must reopen after take profit. Reservation does not remove manipulation, governance, token, or implementation risk.

The `v0.1` repository provides a small set of happy-path tests and has not been audited or deployed. It lacks several safeguards described in this paper, along with partial voluntary close, margin top-up, mature market governance, and calibrated risk parameters. Results inherited from TrueLend are motivation, not validation of a perpetual counterparty vault.

## 12. Conclusion

TruePerp’s defensible contribution is specific: a distressed synthetic position can be reduced in paced, cash-settled chunks referenced to a Uniswap pool, without sending a forced trade to that pool. In an ETH/USDC market, traders trade a synthetic ETH perpetual settled in USDC. The Uniswap pool supplies price and activity; the separate USDC PerpVault supplies counterparty capital.

For a credible hackathon demonstration, this mechanism should be presented together with its constraints. A mandatory, fully reserved profit cap is the simple primary answer to vault solvency; curated listing, a fixed LP epoch, locked reference depth, conservative liability accounting, bounded settlement, zero demo funding, re-triggerable liquidation, free-cash limits, and catastrophic shortfall resolution complete the research design. They do not make it production-safe, but they make its contribution testable and its risks legible.

## References

[1] TrueLend, [repository](https://github.com/queenleoa/TrueLend) (liquidation kernel and parameter-model antecedent).
[2] Synthetix, [perpetual funding documentation](https://docs.synthetix.io/exchange/perps-basics/funding) and [SIP-279](https://github.com/Synthetixio/SIPs/blob/master/content/sips/sip-279.md) (dynamic funding rates).
[3] Uniswap Labs, [Uniswap v3 TWAP oracles in proof of stake](https://blog.uniswap.org/uniswap-v3-oracles).
[4] Mackinga et al., [TWAP oracle attacks: easier done than said?](https://eprint.iacr.org/2022/445.pdf), ePrint 2022/445.
[5] BitMEX, [perpetual contracts guide](https://www.bitmex.com/app/perpetualContractsGuide) and [insurance fund FAQ](https://www.bitmex.com/blog/bitmex-insurance-fund-your-questions-answered).
