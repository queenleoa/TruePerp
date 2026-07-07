# TruePerp: Oracleless Perpetual Futures with AMM-Native Gradual Deleveraging

**Version 0.1 · July 2026**

---

## Abstract

Perpetual futures dominate crypto trading volume, and every major implementation rests on the same two pillars: an external price oracle — consumed continuously by the index, the funding anchor, the liquidation trigger, and settlement — and liquidation as a discrete *event*, backstopped by insurance funds or by force-closing profitable bystanders. Both pillars have failed publicly: zero-impact oracle pricing let a trader extract $565k from GMX's LPs by manipulating the feed's thin sources; a backstop vault that inherits liquidated positions let an attacker hand Hyperliquid's HLP a $13.5M unrealized loss and forced a validator vote to settle it. TruePerp removes both pillars. Built as a Uniswap v4 hook on an ordinary spot pool, it settles positions against the pool's own tick — mark and index are the same number by construction — prices funding from open-interest skew rather than an index premium, and replaces the liquidation event with a **gradual, reversible, cash-settled deleveraging process**: while the tick sits inside a position's margin-derived liquidation range, the position's notional is reduced in small paced chunks that realize losses against margin; the process pauses on price recovery and, provably, terminates on its own once equity again covers maintenance on the reduced size. Because deleveraging is pure bookkeeping — nothing is sold — it exerts zero market impact, closing the reflexive channel behind liquidation cascades. We show that active deleveraging is the *only* mechanism class available to an oracle-free margin system on a constant-function market maker, present the complete protocol built around it — LP counterparty vault with a declared loss waterfall, manipulation-hardened pricing at entry and exit, skew funding with the imbalance residual accruing to LPs — and derive its safety condition, a maintenance-margin inequality with no execution-cost term. The protocol reuses, unchanged, the liquidation kernel of TrueLend (the oracleless lending protocol this work extends), and is implemented and tested (10 scenarios), pending parameterization and audit.

---

## 1. Introduction

A perpetual future must answer one question continuously — *what is the price?* — and one question occasionally: *what happens when a trader's margin no longer covers their losses?* The dominant designs answer the first with an external oracle and the second with an event.

**The oracle half** is consumed in four places, which is why it cannot be patched out locally: the index defines truth; the funding rate taxes the gap between the venue's mark and that index, continuously; margin checks value positions at it; and forced closes settle at it. Each consumption point inherits the feed's latency, its manipulation surface — located at its *sources*, outside the protocol entirely — and its listing bottleneck. The failures are not hypothetical, and they bracket the design space. In September 2022, a trader ran five cycles of ~$4–5M positions through GMX's zero-slippage, oracle-priced entry while pushing the AVAX price on the comparatively thin exchanges feeding the oracle, extracting ~$565k from the protocol's LPs [1, 2]. One month later, Mango Markets showed the same surface at protocol-killing scale: self-traded MNGO perpetual positions plus thirty minutes of spot buying on the three exchanges feeding the oracle moved the reported price ~13×, and the protocol — which treated *unrealized* perp PnL at oracle prices as withdrawable collateral — let the attacker borrow out ~$116M of user deposits [17, 18]. The lessons generalize: **an oracle-priced door with no price impact converts source manipulation into a free option against whoever takes the other side, and paper PnL spendable at a mark is a loaded weapon.** Nor does pricing off the venue's own TWAP escape the problem: post-merge, multi-block proposers manipulate TWAPs at studied, modest cost in thin pools, and an average is stale against honest fast moves in both directions — while the liquidation *event* downstream remains untouched [19, 20].

**The event half** creates reflexivity and an unpriceable tail, and its ledger is long. A one-shot liquidation dumps a position at the worst moment; the sale moves the price; the move breaches the next trader. On October 10, 2025, that dynamic produced the largest liquidation day in the asset class's history — over $19B of leveraged positions destroyed, roughly nine times any prior single-day record, $3.21B of it in one minute [21]. Behind the event sit backstops of last resort, each invented as a patch for the previous one's failure: insurance funds (Perpetual Protocol v1's drained under sustained skew and a single chaotic liquidation, halting the protocol [3, 4]); socialized auto-deleveraging, in which the *most profitable opposite-side traders* are force-closed against the bankrupt account — formalized recently as unavoidably unfair to winners [5]; and, at the ladder's true bottom, clawbacks — OKEx in 2018 socialized a single failed $416M long across every profitable trader on the platform at 17.7% [22]. Hyperliquid's March 2025 JELLY incident showed the two halves failing together: its backstop vault *inherits* liquidated positions, so an attacker self-liquidated a $4–5M short into it, pumped the token on external venues, and put the house $13.5M underwater — resolved only by a validator vote to delist and force-settle at a chosen price [6, 7]. When the backstop of last resort turns out to be governance, the tail was never priced; it was postponed.

TruePerp is a redesign of both halves at once, made possible by Uniswap v4's hook architecture — a perp that lives *inside* the spot market of its underlying — and by a liquidation kernel introduced by its sibling protocol, TrueLend [8], for oracleless lending.

**Contributions.**

1. **A decomposition that collapses the oracle problem** (§3): when positions settle against a real, arbitraged spot pool, mark ≡ index by construction — two of the oracle's four jobs vanish, funding's surviving job is to price *open-interest imbalance*, and the remaining two jobs (trigger, settlement) reduce to problems solved for oracleless lending.
2. **The impossibility observation, extended** (§4): passive AMM liquidity can only trade against the price move, while unwinding a losing position always requires trading with it — so oracle-free deleveraging must be *active*. For a cash-settled perp, activity degenerates to bookkeeping: no trade occurs at all, eliminating the execution-cost term and the cascade channel simultaneously.
3. **A margin-derived, self-terminating deleveraging process** (§5): liquidation ranges computed from each position's own margin arithmetic (maintenance boundary to bankruptcy boundary); chunked ADL paced by time, range depth, and book pressure; and an **equity-invariance lemma** proving the process conserves equity up to penalties and terminates on its own — the trader keeps a smaller, healthy position rather than losing everything at a threshold.
4. **A fully declared solvency framework** (§6): an LP counterparty vault whose tail is explicit (a recorded shortfall counter), a hard trader floor at zero (no negative balances, no clawbacks, no socialized ADL, no discretionary settlement), and manipulation-hardened pricing at both doors.

---

## 2. Preliminaries: the venue in four facts

A Uniswap v4 pool holds two tokens and quotes their exchange rate on a logarithmic grid of **ticks** ($P = 1.0001^t$; ~100 ticks ≈ 1%). Its **liquidity is concentrated**: each provider's capital trades only inside a chosen price range, which makes a position's composition a deterministic function of price — the fact §4 leans on. A pool may name a **hook**: a contract called before and after every swap and at initialization, with permissions encoded in its address. And the hook's `beforeSwap` callback observes the *pre-swap* tick — a swap can never write its own price into any record built there.

TruePerp attaches to an ordinary spot pool. Its **base** asset is the pool's `currency0`, its **cash** (margin and settlement) the pool's `currency1` — native currencies sort to `currency0`, so cash is always an ERC-20. The hook maintains TrueLend's **truncated-median filter** over the pool's own history: observations at most once per 60 s from the pre-swap tick, each clamped to ±9,116 ticks of movement from the last, a median over the ring of nine, raw per-interval extremes that can only *worsen* the answer for whoever is acting, and a bootstrap gate (no positions until the ring fills, ~9 minutes). A price lie must survive many arbitrage-bleeding minutes to enter the record; at that point it is not a lie but a price.

One consequence of cash settlement deserves emphasis before the mechanism: **the hook never swaps.** The pool contributes its tick (the price), its swap flow (a pacing clock), and its history (the filter) — and is otherwise untouched. All settlement is ERC-20 bookkeeping between hook-custodied margin and the LP vault, so the protocol needs no PoolManager unlock outside the pool's own callbacks and adds zero flow to the market whose price it watches.

---

## 3. Deleting the oracle: what remains to be solved

Enumerate the oracle's jobs in a conventional perp: (i) define the index; (ii) anchor the mark to it via funding; (iii) trigger liquidations; (iv) price settlement. Now let the perp settle against a spot pool holding the actual asset. Jobs (i) and (ii) collapse — the settlement price *is* the venue price, and the venue is tethered to the global market by ordinary cross-venue arbitrage in the underlying, the most battle-tested convergence mechanism in the industry. There is no separate mark to drift, hence nothing for premium-based funding to police. What survives of funding is a different and simpler question: **who carries the imbalance?** If long open interest exceeds short, the LP vault is synthetically short the difference; a skew-proportional rate, paid by the crowded side (§5.4), prices that carry — the Synthetix perps lineage [9, 10], with the oracle underneath it deleted rather than consulted.

Jobs (iii) and (iv) — when to intervene, and at what price — are exactly the questions TrueLend answered for lending: the trigger is the pool's own tick crossing a boundary *in the settlement venue itself* (not an estimate of distress elsewhere — the venue saying so), and pricing is the filtered worse-of construction of §2. What is genuinely new for a perp is that *both doors* are price-critical: a manipulated entry cheapens exposure, a manipulated exit inflates realized PnL. TruePerp therefore applies the filter directionally at both: **longs enter at the highest of {median, spot, recent extremes} and exit at the lowest; shorts mirror.** The symmetric cost is that genuine fast profits wait ~9 minutes for confirmation — the design's honest tax, charged to manipulation and momentum alike.

---

## 4. Why deleveraging cannot be passive — and why here it is free

The tempting construction — deposit margin as pool liquidity across the liquidation band and let trading unwind it — fails on arithmetic. A liquidity position holds, as a function of price, more of whichever token the market is selling: passive liquidity **buys** the falling asset and **sells** the rising one, structurally the mean-reversion side of every trade. Unwinding a losing long requires *selling the base as it falls*; a losing short, *buying it as it rises* — in both configurations precisely the trade passive liquidity cannot express (the take-profit and buy-limit are the only order types it offers). TrueLend's research develops this impossibility in full, including why v4's return-delta hooks cannot synthesize the missing "negative liquidity" [8]. Every oracle-free margin system must therefore deleverage *actively*: some code path must reduce the position.

For a cash-settled perp, the conclusion sharpens into an advantage. TrueLend's active step is a real trade — chunks of collateral sold into the pool, paying fees and impact. TruePerp's active step is **marking a slice of exposure to the current tick and settling the difference in cash**: no trade, no liquidity consumed, no impact caused. Three consequences follow. The execution-cost term $s$ that dominates parts of TrueLend's risk budget is structurally zero (§7). The reflexive cascade channel — liquidation flow moving the price that triggers more liquidation — is absent for the deleveraging itself, not merely rate-limited. And market depth survives in the design only as a *governor*: chunk sizes stay proportional to measured in-range depth because thin books move ticks cheaply, so per-crossing intervention should be smaller — a pacing choice, not a solvency constraint.

---

## 5. The protocol

### 5.1 Market structure

Three parties meet at one pool. **Traders** post cash margin (custodied by the hook) and take long or short base exposure — no borrowing, no token flow beyond margin and settlement. **LPs** deposit cash into the **PerpVault** and are the collective counterparty: they earn open/close fees (10 bps), ADL penalties, and the funding residual; they pay trader wins; they absorb post-bankruptcy losses as an on-chain-recorded shortfall. **The spot pool** supplies price, clock, and history. Opens are gated by initial margin (≥ 2× maintenance; default 5%, i.e. 20× leverage), by an open-interest cap proportional to LP equity (§6), and by the filter's bootstrap.

### 5.2 Margin-derived liquidation ranges

A position's intervention band is not configured; it is implied. For a long of size $B$, entry $E$, margin $M$ (per-base $\mu = M/B$), equity at price $P$ is linear in the distance to bankruptcy:

$$
\mathrm{Eq}(P) \;=\; M + (P-E)B \;=\; \big(P - P_{bk}\big)\,B, \qquad P_{bk} = E - \mu ,
$$

and the maintenance condition $\mathrm{Eq} \geq m \cdot PB$ places the range start at $P_{start} = P_{bk}/(1-m)$; shorts mirror upward ($P_{bk} = E + \mu$, $P_{start} = P_{bk}/(1+m)$). The band $[P_{bk}, P_{start}]$ — relative width ≈ $m$ — is registered as two ticks in a per-pool bitmap, so detection costs `afterSwap` only the boundaries actually crossed (capped walks, resumable cursor, at most 32 positions per trigger tick). A position whose margin covers its notional has no liquidation price and is rejected: leverage below 1× belongs in spot.

### 5.3 Chunked auto-deleveraging, and why it terminates

While the tick sits inside a position's band, each swap (or a permissionless `poke`, rewarded from the penalty flow) advances the position's episode by one paced chunk:

$$
c \;=\; \frac{B_{\mathrm{rem}}}{N}\times \min\!\Big(\frac{\Delta t}{\tau}, 5\Big)\times (1 + \mathrm{depth})\times (1 + \mathrm{pressure}), \qquad c \;\leq\; 1\%\ \text{of in-range base depth},
$$

with $N = 100$ target chunks at $\tau = 60$ s — TrueLend's pacing formula, unchanged. The chunk **closes** $c$ of notional at the pool's price $P$: the slice's loss $|P - E|\,c$ and a time-scaled penalty (capped at $m/4$, so fees can never make recovery arithmetically impossible — a cap TrueLend's parameter model forced and this design inherits mechanically) move from margin to the vault; open-interest aggregates shrink; an executor reward is *carved from* the penalty, never charged beyond it.

The process needs no external terminator, by the **equity-invariance lemma**: closing exposure at the market price conserves equity —

$$
\mathrm{Eq}' \;=\; (B - c)\,\delta' \;=\; B\,\delta \;=\; \mathrm{Eq}
$$

— while the maintenance requirement $m P (B - c)$ *falls* with every chunk. Health therefore rises monotonically at constant price and crosses 1 after shedding the fraction $r^\* \approx d$, the position's depth into its runway. The engine checks exact health before every chunk and pauses the episode the moment the arithmetic says healthy: **a position 40% into its band sheds ~40% of its size and keeps the rest.** Price recovery pauses the episode identically; decay to zero returns residual margin; margin exhausted mid-chunk short-circuits to the backstop. The trader's mechanism cost for an episode of depth $d$ is bounded by $\tfrac{m}{4} d \cdot \mathrm{notional}$ in penalties — for a 20× major-tier position caught halfway down its band, basis points, not the 1–5%-plus-everything of an event liquidation. This self-termination is the perp analog of a TrueLend loan's decay ending at debt = 0, and it is what "liquidation as a process" means here: deleveraging *exactly as much as the price action demanded, and no more*.

Fixing each range at open is conservative by the same lemma: deleveraging only moves the true maintenance price further below the registered trigger, so the bitmap fires early and the exact health check — not the bitmap — decides whether anything happens.

### 5.4 Funding from skew

Every state-touching call accrues funding. With open interest $L, S$ (base units) and *filtered* price $p$:

$$
\dot f = p \cdot k \cdot \frac{L - S}{L + S}, \qquad \mathrm{cum}_{long} \mathrel{+}= \dot f\,dt,\quad \mathrm{cum}_{short} \mathrel{-}= \dot f\,dt ,
$$

settled lazily per position against a snapshot. The crowded side pays, the thin side receives, and the residual $|\dot f| \cdot |L - S|$ — the carry on exposure no trader offsets — accrues to the vault that carries it. Empirics and precedent locate the default $k = 100\%/\mathrm{yr}$-at-full-skew: CEX convention brackets the range (baseline interest 0.01%/8h ≈ 11%/yr; Hyperliquid caps its premium rate at 4%/hour [11]), and observed market-wide funding ran from ~10% to ~30% annualized in the levered week before the October 2025 cascade [21] — a typical 20–40% skew priced at 20–40%/yr sits squarely in the observed band, above hedge cost. Perpetual Protocol v1 marks the failure mode this form avoids — a vAMM has no natural funding payer, so its insurance fund paid the crowded side until it drained [3]; here the residual flows *to* the house, never from it. In the classical pricing frame [23], with mark ≡ index the peg premium is identically zero and only inventory carry remains — skew is the correct and only argument. Synthetix v2's skew-*velocity* refinement (the rate drifts while imbalance persists) is the documented upgrade path [10].

### 5.5 Vault accounting and conservation

The PerpVault's share price is over **equity** = cash − net unrealized trader PnL *at the filtered price*, floored at zero; redemptions are additionally bounded by physical cash, so paper losses must realize before LPs can exit through them, and no one-block price push moves the LP door. Conservation is structural: hook cash equals the sum of live margins at all times (every close routes the entire margin through the vault and pays all sinks — trader equity, executor reward — from there), and each flow into LP equity (fees, penalties, realized losses, funding residual) and out of it (wins, shortfalls) is an observable on-chain event.

---

## 6. The solvency framework: a declared tail with a hard floor

Five layers, each catching what the previous lets through: **initial margin** (≥ 2×m) gives every position runway; **paced ADL** spends the runway gradually; **exact health checks** end episodes at the first moment recovery or deleveraging suffices; **the backstop** — past bankruptcy, or equity gone at the filtered price — lets anyone close the remainder for a carved reward; and **the declared LP tail** records whatever a gap consumed beyond margin (`totalShortfall`) against the vault that is paid, in fees, penalties, and funding residual, precisely for underwriting it.

What is deliberately absent is as load-bearing as what is present. There is **no insurance fund** to size by governance and drain in a crisis. There is **no socialized ADL**: no profitable bystander is ever force-closed — the recent impossibility results on fair auto-deleveraging [5] are avoided rather than optimized. There are **no negative balances and no clawbacks**: the trader floor is zero, a property full collateralization buys. The backstop **never inherits a position**: it realizes cash and deletes — so the JELLY construction, self-liquidating a bomb into the house and inflating it elsewhere [6, 7], has no first leg here; and because settlement and manipulation are the *same venue*, it has no second leg; and because the waterfall is code ending in a recorded LP loss, there is no discretionary settlement to force — no third leg. The open-interest cap proportional to LP equity (default 50%) completes the frame: the book the house carries is sized to what the house has visibly staked, a rule the JELLY post-mortems argue for empirically [7] and §7 derives from tail arithmetic.

---

## 7. Parameterization: the maintenance-margin inequality

Safety reduces to a race inside the runway. An episode entered at depth $d$ self-terminates after $T(d) \approx \frac{N\tau}{\bar\lambda}\ln\frac{1}{1-d}$ (mean pacing multiplier $\bar\lambda \approx 2$); over that time, 99th-percentile adverse drift must not traverse the remaining runway, and penalties and funding must fit inside equity:

$$
(1-d)\,m \;\gtrsim\; z_{99}\,\sigma\sqrt{T(d)} \;+\; \pi(T)\,d \;+\; f\,T(d) \qquad \forall\, d \in (0,1),
$$

with **no execution term** — the structural dividend of §4. Worked at TrueLend's live-calibrated tier volatilities (99th-percentile 30-day realized vol since 2020; stress-week replay library) [8], the first cuts are:

| Tier | σ (static / calibrated) | maintenance $m$ | initial margin | max leverage |
|---|---|---|---|---|
| Stable | 2% / 38% | 0.5–1% | 1–2% | **50–100×** |
| Major | 80% / 182% | 4–6% | 8–12% | **8–12×** |
| Long-tail | 150% / 286% | 10–12% | 20–25% | **4–5×** |

Two independent derivations cross-check: the runway $m$ plays exactly the role of TrueLend's LT gap, whose major-tier value (5%) survived ex-ante and ex-post historical replay across six crash weeks; and the looped-leverage construction on TrueLend itself tops out at 10.3× on majors — the ceilings converge because volatility constrains the *runway*, not the construction. The open-interest cap follows from LP drawdown arithmetic ($c \le \text{target}/(z_{99}\sigma\sqrt{1/365})$), and funding $k$ from hedge-cost bracketing (§5.4). The full Monte-Carlo and historical-replay program — TrueLend's episode engine with a margin-ledger variant and a leverage axis, its calibration pipeline and crash-week library reused verbatim — is specified in PARAMETERS.md §7 and is the release gate for per-tier production values; the shipped default ($m = 2\%$, 20×) should be treated as stable-tier-only until that run lands.

---

## 8. Related work

The machinery descends from BitMEX, which invented the perpetual swap and its funding peg in 2016 and layered the insurance-fund-then-ADL ladder in front of event liquidation [24]; every venue since refines the template. dYdX and Hyperliquid hold the orderbook end (the latter's waterfall — book close, backstop-vault inheritance at ⅔ maintenance, socialized ADL ranked by profit — is the genre's cleanest [11, 12]); Jupiter and GMX the LP-pool end, filling any size at the oracle mid with zero impact against JLP/GLP [25] — the door exploited on GMX in 2022 [1, 2], with GMX v2's skew-priced fees converging toward funding-as-carry; Drift engineers four layers of mitigation (JIT auctions, backstop AMM, insurance, socialized haircut) for the single fact that positions close all at once [26]; Synthetix keeps its markets near-neutral with skew-velocity funding and impact functions [9, 10]; Perpetual Protocol v1's vAMM showed that marks need real inventory and funding needs a real payer [3, 4]. The LP-as-house empirics validate the counterparty shape TruePerp adopts — GLP earned ~$22M from net trader losses on top of $217M+ in fees; HLP ~$137M cumulative at Sharpe ratios near 2 — while locating its P&L in exactly the crash events a gradual mechanism declines to harvest [27]. Pricing the perp off the venue's own TWAP — the apparent middle path (Rage Trade, Overlay) — fails on the studied economics of post-merge multi-block TWAP manipulation and on staleness at both doors, while leaving the event untouched [19, 20]. The oracle-free family avoids liquidation by pre-paying it: InfinityPools borrows Uniswap v3 ranges so the worst case is funded upfront (oracle-free, liquidation-free, capital-heavy) [13]; Numoen sells fully-collateralized perpetual options [14]; Contango loops through money markets, inheriting their oracles and liquidation events wholesale [15]. TruePerp occupies the remaining cell: liquidation neither avoided by pre-payment nor inherited from an oracle venue, but performed — gradually, in cash, by the settlement venue itself — on the kernel introduced for oracleless lending by TrueLend [8], whose gradual-conversion ancestry (Curve's LLAMMA) and internal-median pricing (Panoptic) are documented there. Perp-oriented v4 hooks exist today as early-stage projects without production liquidation mechanisms [16]; the kernel is precisely the missing piece.

---

## 9. Implementation and status

Three contracts, ~900 lines of Solidity 0.8.26: `TruePerpHook` (market core: margin custody, doors, funding, ADL engine; 22,726 bytes), `PerpVault` (one per pool, via `PerpVaultFactory` — the creation-code-out-of-the-hook device EIP-170 forces), reusing TrueLend's linked libraries unchanged (`ChunkMath`, `LiqRangeMath`, `TruncatedOracle`, `TriggerIndex` — on deployed networks, the same on-chain singletons). Any pool initialized with the hook becomes a perp market automatically. **10 tests** cover margin-derived range placement, open guards (IM, OI cap, fully-backed rejection), in-range decay with pause-on-recovery, self-terminating health restoration, bankruptcy backstop with recorded LP shortfall, worse-of PnL round trips in both directions, skew funding with residual accrual, and LP equity accounting. Not deployed; not audited.

## 10. Limitations and future work

The 9-minute filter lag prices honesty into fast profit-taking; traders wanting instant exits at spot are choosing a different trust model. Funding is rate-∝-skew (velocity funding is the upgrade path); the residual transfer assumes hook-held margins cover transient imbalances between lazy settlements. v0.1 supports full close only — no partial close, margin top-up, or netting. ADL ranges are fixed at open (conservative, per the invariance lemma). LP equity marks at the median, so share pricing lags spot by design. A venue-native perp inherits its venue: thin pools make weak markets, and the OI cap is the honest expression of that inheritance rather than an escape from it. The perp-profile parameter run (§7) and an external audit gate any deployment; per-position size caps against measured depth — TrueLend's principal backtest finding — apply here unchanged and are the first post-run addition.

---

## References

[1] Cointelegraph, [GMX suffers $565K price-manipulation exploit](https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit), Sept 2022.
[2] Neptune Mutual, [Decoding GMX's price manipulation exploit](https://neptunemutual.com/blog/decoding-gmxs-price-manipulation-exploit/), 2022.
[3] Perpetual Protocol, [About Perp v2 / v1 post-mortem material](https://support.perp.com/); wesl.ee, [The problem with vAMM perpetuals](https://wesl.ee/The_Problem_With_vAMM_Perpetuals/).
[4] FinanceFeeds, [The vAMM model and its failure modes](https://financefeeds.com/vamm-model-perpetual-futures-virtual-liquidity/), 2025.
[5] [Autodeleveraging: Impossibilities and Optimization](https://arxiv.org/html/2512.01112v2), arXiv:2512.01112, 2025.
[6] CoinDesk, [Hyperliquid delists JELLY after vault squeezed in $13M tussle](https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle), Mar 2025.
[7] OAK Research, [Hyperliquid and the JELLY attack](https://oakresearch.io/en/analyses/investigations/hyperliquid-jelly-attack-context-vulnerability-team-solution); Halborn, [Explained: the Hyperliquid hack](https://www.halborn.com/blog/post/explained-the-hyperliquid-hack-march-2025), 2025.
[8] TrueLend: [repository](https://github.com/queenleoa/TrueLend) — whitepaper (impossibility proof, truncated oracle, chunk engine), PARAMETERS.md (risk model, live calibration), BACKTEST.md (six-crash-week replay, walk-forward validation).
[9] Synthetix, [Perps funding documentation](https://docs.synthetix.io/exchange/perps-basics/funding).
[10] Synthetix, [SIP-279: Perps v2](https://github.com/Synthetixio/SIPs/blob/master/content/sips/sip-279.md); [dynamic funding rates](https://blog.synthetix.io/synthetix-perps-dynamic-funding-rates/).
[11] Hyperliquid, [documentation](https://hyperliquid.gitbook.io/hyperliquid-docs) (funding cap, liquidation waterfall, ADL).
[12] OtterSec, [Reverse-engineering the Hyperliquid risk engine](https://osec.io/blog/hyperliquid-risk-engine/), 2025.
[13] Messari, [InfinityPools: new leverage mechanics](https://messari.io/report/infinitypools-new-leverage-mechanics).
[14] Numoen, [Perpetual options for DeFi](https://medium.com/numoen/perpetual-options-for-defi-821351c0a24f).
[15] Contango, [The looping layer of DeFi](https://medium.com/contango-xyz/contango-the-looping-layer-of-defi-8183bf8ae045).
[16] [awesome-uniswap-hooks](https://github.com/fewwwww/awesome-uniswap-hooks) (curated v4 hook landscape, incl. early perp/leverage hooks).
[17] SEC, [Charges in the Mango Markets manipulation](https://www.sec.gov/newsroom/press-releases/2023-13), Jan 2023; CFTC, [parallel charges](https://www.cftc.gov/PressRoom/PressReleases/8647-23).
[18] Halborn, [Explained: the Mango Markets hack](https://www.halborn.com/blog/post/explained-the-mango-markets-and-attempted-aave-hacks-october-2022), 2022; CoinDesk, [Eisenberg convicted](https://www.coindesk.com/policy/2024/04/18/mango-markets-exploiter-avi-eisenberg-found-guilty-of-fraud-and-manipulation), 2024.
[19] Uniswap Labs, [Uniswap v3 TWAP oracles in proof of stake](https://blog.uniswap.org/uniswap-v3-oracles) (multi-block manipulation; the truncated-oracle remedy).
[20] Euler, [Uniswap v3 TWAP manipulation cost of attack](https://github.com/euler-xyz/uni-v3-twap-manipulation/blob/master/cost-of-attack.tex); Mackinga et al., [TWAP oracle attacks: easier done than said?](https://eprint.iacr.org/2022/445.pdf), ePrint 2022/445.
[21] FTI Consulting, [Crypto crash October 2025: leverage meets liquidity](https://www.fticonsulting.com/insights/articles/crypto-crash-october-2025-leverage-met-liquidity); Amberdata, [How $3.21B vanished in 60 seconds](https://blog.amberdata.io/how-3.21b-vanished-in-60-seconds-october-2025-crypto-crash-explained-through-7-charts), 2025.
[22] CoinDesk, [OKEx confirms $9M clawback after enormous Bitcoin future fails](https://www.coindesk.com/markets/2018/08/03/okex-confirms-9-million-clawback-after-enormous-bitcoin-future-fails), Aug 2018; [OKX incident notice](https://www.okx.com/en-us/help/regarding-the-forced-liquidation-incident-on-jul-31-2018).
[23] Ackerer, Hugonnier, Jermann, [Perpetual futures pricing](https://onlinelibrary.wiley.com/doi/10.1111/mafi.70018), *Mathematical Finance*, 2026; Paradigm, [Everlasting options](https://www.paradigm.xyz/2021/05/everlasting-options) and [Everything is a perp](https://www.paradigm.xyz/writing/everything-is-a-perp).
[24] BitMEX, [Perpetual contracts guide](https://www.bitmex.com/app/perpetualContractsGuide) and [insurance fund FAQ](https://www.bitmex.com/blog/bitmex-insurance-fund-your-questions-answered).
[25] Jupiter Perps / JLP mechanics ([overview](https://eco.com/support/en/articles/15083164-jupiter-perps-fees-leverage-how-jlp-works)); Blockworks, [Jupiter's risk vault vs a Hyperliquid-style attack](https://blockworks.com/news/jupiter-solana-risk-vault-hyperliquid-attack).
[26] Drift Protocol, [JIT liquidity](https://docs.drift.trade/protocol/about-v3/jit-faq) and [architecture](https://eco.com/support/en/articles/14801189-drift-protocol-perps-architecture-explained).
[27] GMX analytics ([stats.gmx.io](https://stats.gmx.io/)); OnChainTimes, [Perp DEX vaults under the hood](https://www.onchaintimes.com/perp-dex-vaults-a-look-under-the-hood/); CoinGecko, [How Hyperliquid's HLP turns market chaos into profit](https://www.coingecko.com/learn/hyperliquid-hlp-vault-analysis).
