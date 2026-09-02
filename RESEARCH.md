# TruePerp: Research Note

## Abstract

TruePerp asks whether a perpetual market can use a Uniswap v4 spot pool as its native price reference while liquidating positions without selling an underlying asset. The proposed market is **pool-referenced**, **externally-oracle-free**, and **cash-settled**.

Each market trades only the base/cash pair attached to its hook. The `v0.1` code interprets `currency0` as base and `currency1` as cash; `v0.2-demo` should store the economic orientation explicitly because Uniswap orders currencies by address. An ETH/USDC market therefore supports an ETH perpetual quoted and settled in USDC; it does not support arbitrary synthetic assets.

The spot pool and the risk pool have separate roles. Uniswap supplies an observable price path and a swap-driven clock. A market-specific PerpVault supplies counterparty capital. Liquidation reduces synthetic exposure through cash accounting, so it creates no forced spot order.

The current `v0.1` contracts demonstrate this state machine but not a complete economic design. Instantaneous LP entry and exit, net and uncapped PnL accounting, removable spot depth, insufficient winner reserves, and the funding ledger invalidate stronger security claims. A coherent `v0.2-demo` should instead demonstrate one bounded, fully specified market with locked reference liquidity and committed vault capital.

> **Research status.** TruePerp is a mechanism prototype, not a production-ready exchange. This note distinguishes properties demonstrated by the code from safeguards proposed for `v0.2-demo`.

## 1. Research question

The central question is:

> Can a spot AMM provide the reference price and liquidation clock for a separate cash-settled perpetual market, without an external oracle or forced spot sales?

This question contains three subproblems:

1. **Price reference:** what observable state defines entry, exit, margin, and liquidation?
2. **Counterparty risk:** who pays a profitable trader, and under what solvency constraint?
3. **Liquidation:** how is unsafe exposure reduced without creating a reflexive market order?

TruePerp does not attempt to provide cross-margin, arbitrary index listing, an order book, or a guarantee that a thin AMM is a reliable market. It tests a particular decomposition—spot venue, accounting hook, and isolated risk vault—and makes the resulting tradeoffs explicit.

### 1.1 Terminology

“Oracleless” is convenient but imprecise. The protocol still reads and filters prices; it derives them from the attached pool rather than an external reporter network. This note therefore uses **externally-oracle-free** or **pool-referenced**.

“Underlying” means the base asset in the attached pair, not an asset selected independently by a trader. In an ETH/USDC market:

- the traded exposure is ETH;
- position size is measured in ETH units;
- margin, fees, profit, and loss are measured in USDC; and
- the ETH/USDC pool price is the market reference.

Supporting BTC, SOL, or another asset requires another base/cash pool and another PerpVault. Supporting an arbitrary off-pool index would require an index adapter or oracle and would be a different protocol design.

## 2. System decomposition

![TruePerp system architecture](docs/assets/architecture.png)

| Component | Holds | Function | Does not do |
|---|---|---|---|
| Uniswap v4 pool | base and cash liquidity | establishes the spot tick and produces observations on swaps | guarantee trader PnL |
| TruePerp hook | trader cash margin and position state | opens, marks, funds, deleverages, and closes positions | hold base for every synthetic position |
| PerpVault | isolated cash capital | takes counterparty exposure and pays realized wins | set the reference price |
| Traders | posted cash margin | choose long or short synthetic exposure | own a claim on spot-pool reserves |

The Uniswap LP pool is **not** the counterparty. PerpVault LPs are the economic house; spot LPs provide ordinary swap liquidity and the market state against which the derivative is measured.

This differs from a GMX-style market, where the pool holding long and short backing assets is itself the counterparty to traders [1]. TruePerp isolates price formation from risk underwriting. That produces a legible balance sheet, but safe open interest then depends on two independent resources: vault capital and persistent spot depth.

### 2.1 Why not make spot LPs the house?

Spot reserves are already committed to market making. Their token composition changes with swaps, concentrated ranges can become inactive, and LPs can withdraw independently of perp positions. Treating the same reserves as freely available for both spot execution and derivative payouts would create ambiguous seniority.

An isolated vault gives the derivative an explicit loss-bearing balance sheet and prevents one market's deficit from consuming another market's cash. Its weakness is equally explicit: a cash-only vault has no natural hedge when traders are net long, so finite cash cannot support an unlimited long payoff.

### 2.2 Comparison with adjacent designs

| Property | Conventional oracle perp | GMX-style pool counterparty | TruePerp research design |
|---|---|---|---|
| Reference | external feed or exchange index | external feed | attached spot pool and its history |
| Counterparty | book, AMM, or backstop | multi-asset market pool | separate cash PerpVault |
| Tradable asset | any supported index | indexes backed by the pool | only the pool's base/cash pair |
| Execution | book, AMM, or oracle-derived quote | oracle quote plus impact rules | guarded pool-referenced accounting price |
| Liquidation | sale, transfer, or event close | event close against the pool | partial cash settlement; no spot trade |
| Main dependency | oracle integrity and execution liquidity | oracle integrity and pool solvency | pool depth/history and vault solvency |
| Long-side hedge | venue-dependent | base asset held by the pool | none in a cash-only vault |

This is a structural comparison, not a claim that one design dominates. An external-oracle design would permit arbitrary indexes but would abandon the research question. A GMX-like asset pool provides a natural base/cash hedge but combines market-making and counterparty capital. A virtual AMM would create a separate derivative price that must be anchored. GMX documentation, for example, describes WETH and USDC as the backing assets for an ETH/USD market [1]. TruePerp chooses the pool-referenced, separate-vault alternative to study a smaller, isolated mechanism.

## 3. Position and cash-flow model

Let a position have base size $B$, entry price $E$, reference price $P$, and cash margin $M$. Ignoring fees and funding:

$$
\operatorname{Eq}_{long}(P)=M+(P-E)B,
\qquad
\operatorname{Eq}_{short}(P)=M+(E-P)B.
$$

The trader has limited liability: realized losses cannot exceed posted margin. The vault receives collected losses and fees and pays realized profits. Those two directions are not symmetric:

- when theoretical trader loss exceeds margin, the vault fails to collect part of an expected gain; but
- when trader profit exceeds vault cash, the protocol cannot honor an actual payment obligation.

The current code's `totalShortfall` records the first case. It does not solve the second case, which is **winner insolvency**.

A finite cash vault cannot guarantee an uncapped long payoff over an unbounded price domain. For a long, $(P-E)B$ grows without bound as $P$ rises. An entry-time open-interest cap limits initial notional but not the later claim.

A coherent market must therefore do at least one of the following:

1. hedge net exposure with base assets or an external venue;
2. recapitalize or socialize losses after vault exhaustion;
3. cap each position's maximum profit and reserve that amount; or
4. state that payouts are undercollateralized and define a loss waterfall.

For `v0.2-demo`, option 3 is the clearest hackathon choice. Each position selects a maximum counterparty profit $K_i$ no greater than the market ceiling, closes automatically at that bound, and reserves the same amount of vault cash until its payout settles. The profit cap excludes the return of the trader's own remaining margin; fees and penalties can reduce payout but cannot enlarge the vault claim. For physical cash $C$, aggregate caps $K=\sum_iK_i$, and other funded obligations $R_o$, the only unencumbered admission capital is $C_{free}=\max(C-K-R_o,0)$. Neither uncollected trader losses nor unused portions of an existing reserve may be reused. The result is capital-inefficient, but payout coverage becomes a testable invariant instead of an assumption.

## 4. Why liquidation is cash-settled and partial

A conventional liquidation sells collateral, transfers a live position, or closes it through a book. That execution can move the same market whose price triggered it. During stress, liquidation flow can therefore worsen the price and trigger further liquidation.

TruePerp positions are synthetic and already denominated in cash. The hook can reduce a position from $B$ to $B-c$, realize PnL on chunk $c$, and transfer only cash between trader margin and the vault. No base token is bought or sold.

At a fixed price, closing a chunk preserves pre-penalty equity:

$$
M' = M + \operatorname{PnL}(c),
\qquad
\operatorname{Eq}'(P)=\operatorname{Eq}(P).
$$

The maintenance requirement falls because remaining notional is smaller. If maintenance is $mPB$, repeated reductions can restore health even when price is unchanged. This is the useful property of gradual auto-deleveraging (ADL): reduce the requirement rather than sell an asset to rebuild collateral.

The process is not reversible in the strict sense. An executed chunk permanently removes exposure and realizes PnL. The **episode** is pausable: if price recovers and the remainder becomes healthy, further chunks can stop.

Penalties weaken the self-restoring property. If current equity ratio is $q=\operatorname{Eq}/(PB)$, maintenance is $m$, and the penalty on closed notional is $\pi<m$, the required fraction at a fixed price is

$$
r \geq \frac{m-q}{m-\pi}.
$$

Pacing, penalty, and liquidation-range width must therefore be calibrated together. A deep breach can still require a complete close.

## 5. Price construction

Using only the current tick makes valuable actions cheap to manipulate in a shallow pool. Using only a long TWAP delays legitimate price changes and can offer stale execution. TruePerp instead experiments with a truncated observation history and conservative “worse-of” prices for trader-initiated actions.

This is not manipulation-proof. Work on Uniswap oracles shows that attack cost depends strongly on wide-range liquidity, window length, and block control; multi-block manipulation remains relevant [2][3]. A filtered price exchanges responsiveness for resistance.

> A TruePerp market is only as credible as the depth, persistence, and arbitrage quality of its attached spot pool.

For `v0.2-demo`, let $P_g$ clamp spot to a configured band around the filtered price $P_f$. Long entries use $\max(P_g,P_f)$ and short entries use $\min(P_g,P_f)$; voluntary exits reverse those choices. Partial liquidation, backstop, take-profit, and terminal settlement use $P_g$. Voluntary actions also require deadlines and acceptable-price bounds. A liquidation breach should persist or receive a second confirmation before transferring material value. The filter is an experimental parameter to measure, not a substitute for an economic security budget.

## 6. Failure analysis of `v0.1`

![TruePerp security boundaries](docs/assets/security-boundaries.svg)

The `v0.1` contracts implement the happy path, but the following assumptions fail under adversarial ordering or large price moves.

| `v0.1` assumption | Failure mode | Research implication |
|---|---|---|
| LPs deposit and redeem immediately | an attacker can buy most shares, manipulate a victim into loss, then redeem a share of the transfer | commit capital before its risk cohort forms and lock it until claims expire |
| NAV subtracts net uncapped trader PnL | losers offset winners even when losses exceed margin or settle later | reserve gross positive liabilities and cap collectible loss at posted margin |
| entry OI is capped by current equity | a later long-price rise can create claims above vault cash | reserve maximum payout, hedge exposure, or define socialization |
| current in-range liquidity is durable | Uniswap LPs can remove depth while perps remain open | lock demo liquidity and halt new OI below a depth floor |
| an arbitrary token pair has the expected units | code fixes `currency0` as base and uses 18-decimal base math; tests use 18/18 mocks | record price orientation, normalize decimals, and allowlist demo tokens |
| raw spot is safe for forced settlement | a transient tick can transfer victim margin to the vault | confirm breaches and bound settlement marks |
| aggregate funding may move before collection | pooled margins can be drained while payer debt is later clipped, creating unmatched credits | settle per position and credit only collected cash |
| restored positions need no new trigger | deterioration inside stale boundaries may not restart ADL | recompute triggers and include pending funding in health |

The LP and spot-price rows combine into a direct JIT-liquidity risk: an attacker can enter the vault shortly before causing a forced transfer and later exit with part of it. A withdrawal delay raises carrying cost but does not assign PnL to the correct capital cohort. Production would need epochs or locked tranches; a demo can use a fixed, non-redeemable vault epoch.

The NAV issue is an ordering problem as well as a valuation problem. A solvent calculation must assume winners close before losing accounts pay and must treat trader losses beyond segregated margin as uncollectible. Net paper PnL is not withdrawable cash.

Reference depth is also external state. The current hook does not prevent Uniswap LPs from removing liquidity, and a v4 hook is part of a pool's key. TruePerp must seed and lock a protocol-controlled wide-range position in its own hook-enabled pool rather than assume it inherits an existing pool's depth [4]. Removable external liquidity does not increase the demo's security budget.

Funding requires a real ledger. TruePerp has no independently traded perp mark to pull toward an index, so funding's only proposed role is to price vault inventory and encourage balanced open interest. The base demo therefore sets funding to zero. A future version must retain nominal payer obligations for processing, cap collectible amounts at remaining margin, and recognize receiver credit only after cash is collected; any uncollectible remainder is a recorded shortfall, not an asset.

## 7. Proposed `v0.2-demo`

The `v0.2-demo` claim should be narrower than “permissionless oracleless perps”:

> A bounded-payout ETH perpetual, settled in USDC, that references a dedicated ETH/USDC v4 pool and reduces unsafe positions through cash-only partial deleveraging.

The demo should enforce and display these constraints:

1. **One allowlisted market.** Fix the base, cash token, decimals, fee tier, and hook-enabled pool.
2. **Dedicated reference liquidity.** Seed wide-range ETH/USDC liquidity and lock it for the demo period.
3. **Fixed vault epoch.** Accept USDC capital before the epoch; disallow new shares and redemption while any position or payout claim remains unsettled.
4. **Bounded payouts.** Require a profit cap or take-profit boundary and reserve every position's maximum cash claim.
5. **Gross liability accounting.** Never rely on a losing position to fund a winner; count at most posted margin as collectible.
6. **Dual capacity limit.** Bound new exposure by free vault reserves and a conservative measure of persistent spot depth.
7. **Guarded actions.** Add deadlines and price bounds; confirm liquidation breaches and bound forced-settlement marks.
8. **Correct ADL lifecycle.** Include all obligations in health and re-register boundaries after every partial liquidation or recovery.
9. **No demo funding.** Set the rate to zero; collection-backed funding is a future extension.
10. **Explicit pause state.** Stop new risk if observations, depth, or free reserves fall below configured floors while preserving closes.

These restrictions reduce composability and capital efficiency, but each corresponds to a concrete v0.1 failure. The research contribution becomes the venue/vault separation and cash-only partial liquidation—not a claim that all perpetual-market risk has disappeared.

The interface should separate realized cash, unrealized PnL, reserved winner claims, collectible trader loss, and free vault capital. That accounting story is more valuable in a research demo than a broad feature set.

## 8. Evaluation criteria

The concept should be judged by falsifiable properties rather than test count:

- **cash conservation:** every realized transfer has one debit and one credit;
- **winner coverage:** reserved claims never exceed non-withdrawable vault cash;
- **limited trader liability:** no path debits more than segregated margin;
- **cohort integrity:** later capital cannot capture an earlier position's PnL;
- **funding exclusion:** the base demo cannot accrue or transfer funding;
- **ADL liveness and pause:** an unsafe position is reduced, and a recovered position stops losing exposure;
- **trigger renewal:** deterioration after partial recovery restarts ADL;
- **depth response:** new OI stops below the persistent-liquidity floor; and
- **manipulation budget:** measured trigger cost exceeds maximum extractable value under demo parameters.

Manipulation cost must be measured on the seeded pool configuration. Headline TVL is insufficient because concentrated liquidity may be absent along the relevant price path.

## 9. Limitations and open questions

Bounded payouts are solvent only if reserves cannot be withdrawn or counted twice. The model is less capital-efficient than a hedged asset pool and is more accurately called a bounded perpetual than a general-purpose perp.

Open research questions include:

- Can epoch accounting provide useful LP liquidity without reopening the JIT attack?
- Would hedging net skew through the spot pool reintroduce liquidation-driven price impact?
- Which observation filter best balances transient manipulation and genuine gap moves?
- How should durable depth be measured across concentrated-liquidity ranges?
- Can a base/cash vault offer uncapped profit without an opaque socialized-loss path?
- Is funding necessary when capacity limits already price scarce vault capital?

These are future research directions, not features that `v0.2-demo` needs to pretend to solve.

## 10. Conclusion

TruePerp is best understood as a pool-native derivative experiment. An attached Uniswap market defines one base/cash exposure; the pool supplies reference state, while an isolated vault—not the spot LPs—underwrites PnL. Cash-settled partial liquidation is the distinguishing mechanism because it can reduce leverage without producing a forced spot trade.

Removing an external oracle does not remove the need for manipulation resistance, durable liquidity, or a solvent counterparty. `v0.1` does not yet meet those requirements. A bounded, locked, single-market `v0.2-demo` can still make a strong hackathon demonstration because its claims are narrow, its liabilities are measurable, and its central mechanism can be observed end to end.

## References

1. [GMX documentation: Providing liquidity](https://docs.gmx.io/docs/providing-liquidity/).
2. Adams, Wan, and Zinsmeister, [*Uniswap v3 TWAP Oracles in Proof of Stake*](https://blog.uniswap.org/uniswap-v3-oracles), 2022.
3. Mackinga, Nadahalli, and Wattenhofer, [*TWAP Oracle Attacks: Easier Done than Said?*](https://eprint.iacr.org/2022/445.pdf), 2022.
4. [Uniswap v4 documentation: Hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks).
