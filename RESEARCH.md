# TruePerp — Research Report

This report is the background for [DESIGN.md](DESIGN.md): the reasoning that selected TruePerp's mechanism over every alternative. It asks what an oracle actually *does* for a perpetual-futures protocol (§1), shows that removing it forces active — and here, purely bookkept — deleveraging (§2), maps the design space that forcing creates (§3), reads the major perp architectures and their documented failures for what each teaches (§4), works the manipulation economics against those precedents (§5), and closes with the mathematics the implementation stands on (§6). It is the perp companion to [TrueLend's RESEARCH.md](https://github.com/queenleoa/TrueLend/blob/main/RESEARCH.md), whose impossibility argument it inherits; overlapping material is restated so this repository reads alone. Sources are linked inline and collected in §7.

---

## 1. What the oracle is doing in a perp, exactly

A perpetual future is a derivative: a cash-settled side bet on a price. The conventional stack uses an external index oracle for **four distinct jobs**, and it pays to separate them, because they fail differently and are replaced differently:

1. **The index** — what is the "true" price of the underlying? A feed aggregating CEX prints.
2. **The mark anchor** — the venue's own traded price (orderbook mid, vAMM state) drifts from the index; a **funding rate** proportional to (mark − index) taxes whichever side pushes the drift, arbitraging mark back toward index. The anchor consumes the index continuously — [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs), representative of the state of the art, computes funding from an oracle-referenced premium on a short cycle with a hard cap (4%/hour).
3. **The liquidation trigger** — margin checks value positions at the index or a mark/index blend, so the trigger inherits every property of the feed: latency, manipulation surface at the *sources*, and the listing bottleneck (no feed, no market).
4. **Settlement** — closes and forced deleveraging realize PnL at oracle-derived prices.

Now observe what happens when the venue's price *is* a real, arbitraged spot market — a Uniswap pool holding the actual asset. Jobs 1 and 2 collapse: **mark ≡ index by construction.** There is no separate perp price to drift, because positions settle against the spot pool itself, and the spot pool is tethered to the global market by ordinary cross-venue arbitrage in the underlying — a mechanism with years of daily practice behind it, not a protocol assumption. The mark–index apparatus, and the funding term that polices it, become unnecessary *for their original purpose*.

What remains is jobs 3 and 4 — trigger and settlement — plus one question funding must still answer: **who carries the imbalance?** If longs outweigh shorts, someone is short the difference; in TruePerp that someone is the LP vault, and funding's surviving role is to price *that* — a skew-proportional rate paid by the crowded side (§6.3). This is the [Synthetix perps](https://docs.synthetix.io/exchange/perps-basics/funding) lineage — funding from skew rather than from an index premium — with the oracle underneath it deleted rather than consulted. The trigger and settlement problems are exactly the problems TrueLend solved for lending — a manipulation-hardened read of the pool's own tick, and a liquidation the protocol itself performs gradually — which is why a perp is buildable as a sibling rather than a new research program.

The honest cost, stated up front: a venue-native perp is a derivative *of that pool*. Its integrity is bounded by the pool's arbitrage tightness, and its manipulation-resistant filter imposes a ~9-minute confirmation lag on profit-taking (§5). These are real trade-offs, priced consciously.

---

## 2. Why deleveraging cannot be passive — and why cash settlement makes it free

The seductive idea — for lending it was "inverse range orders," for perps it is "park the margin as pool liquidity across the liquidation band and let trading unwind it" — dies on the same theorem.

A Uniswap position $(L, [P_a, P_b])$ holds, as a function of price, more of whichever token the market is selling: as price falls, in-range liquidity **buys** the falling token; as price rises, it **sells** the rising one. Passive liquidity is structurally the mean-reversion side of every trade — as an order type it offers a take-profit and a buy-limit, and nothing else. Now write down what closing a losing position requires:

| Position | Sours when | Unwinding requires | Passive liquidity does |
|---|---|---|---|
| long base | base **falls** | **sell** base as it falls | *buys* it ✗ |
| short base | base **rises** | **buy** base as it rises | *sells* it ✗ |

Liquidation — of loan collateral or of perp margin, identically — is always the stop-side trade, the one trade passive liquidity cannot express. (TrueLend's RESEARCH §1 develops this fully, including why v4's return-delta hooks cannot fake negative liquidity.) Every oracle-free design must therefore *execute*: some code path must actively reduce the position.

For perps the conclusion then takes a sharper form. TrueLend's execution is real — chunks sell collateral into the pool, paying fees and impact ($s$ in its parameter model). A cash-settled perp's "execution" is **marking a slice of exposure to the current price and setting off the cash**: no trade occurs, no liquidity is consumed, no impact is caused. The active-liquidation requirement is satisfied by bookkeeping. Three consequences:

1. **The execution-cost term vanishes.** TrueLend's buffer inequality charges $s \approx$ half the chunk-depth cap plus fees; TruePerp's charges zero (§6.5, PARAMETERS §4).
2. **ADL adds no sell pressure to the price being watched.** The reflexive channel — liquidation flow moving the price that triggers more liquidation, the dynamic behind every major perp cascade — is not merely rate-limited, as in TrueLend; for the deleveraging itself it is *absent*.
3. **Depth still matters, but as a governor, not a constraint.** The chunk cap keyed to measured in-range depth survives as the natural way to scale deleveraging speed to how consequential the market's own move was — thin books move ticks cheaply, so per-tick-crossing intervention should be smaller.

---

## 3. The design space, mapped

Every perp architecture answers the four §1 jobs somewhere. The matrix that matters, populated from the protocols' own documentation and post-mortems (§4):

| | index source | mark source | funding driver | liq. trigger | liq. execution | bad-debt path |
|---|---|---|---|---|---|---|
| dYdX v4 | oracle | own book | mark − index | oracle | event (book) | insurance fund → deleveraging |
| GMX v1/v2 | oracle (Chainlink) | = index, zero-impact | v2: skew (borrow fee + price impact) | oracle | event (vs pool) | LP pool (GLP/GM) |
| Perpetual v1 (vAMM) | oracle | virtual AMM | mark − index, **paid by insurance under skew** | oracle+mark | event (vAMM) | insurance fund (drained; halted May 2022) |
| Synthetix perps v2 | oracle | index + skew impact | **skew velocity** | oracle | event | stakers (pooled) |
| Hyperliquid | oracle blend | own book | premium vs oracle, capped 4%/h | mark/oracle | event → HLP backstop → **socialized ADL** | HLP, then winning traders |
| Contango ("cPerps") | inherited from money markets | spot pools | money-market rates | inherited oracles | inherited (loan liquidation) | underlying market's path |
| InfinityPools | **none** | spot (Uni v3) | rental rate on borrowed LP ranges | **none (pre-funded)** | none — worst case bought upfront | none (by construction; capital-heavy) |
| Numoen | **none** | own PMMP curve | convexity funding | **none** | none (fully collateralized options) | none (option premium) |
| **TruePerp** | **the spot pool itself** | ≡ index | **skew** (imbalance carry to LPs) | **the tick** | **gradual, chunked, cash-settled, self-terminating** | **declared LP shortfall, floor at zero** |

Reading the columns: the oracle-consuming rows all liquidate in *events* and back-stop with either insurance funds (opaque, exhaustible) or pooled counterparties; the oracle-free rows before TruePerp avoid liquidation by **pre-paying the worst case** — InfinityPools buys the exit liquidity upfront (hence "no oracles, no liquidations," at the documented cost of capital efficiency and scaling), Numoen sells fully-collateralized convexity, Contango outsources the whole problem to oracle-based money markets. The bottom row is the previously empty cell: index = venue, trigger = venue, and an execution column that §2 says had to be active — made cheap by cash settlement, made *gradual* by TrueLend's kernel.

---

## 4. Prior art, organized by what it teaches

**GMX teaches what zero-impact oracle pricing costs.** GMX v1 filled any size at the Chainlink price with no slippage — and on September 18, 2022 a trader ran five cycles of ~$4–5M zero-impact AVAX positions on GMX while pushing the comparatively thin AVAX market on CEXes (the *sources* of the feed), extracting ~$565k from GLP holders; GMX responded by capping open interest on the market ([Cointelegraph](https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit), [Neptune Mutual analysis](https://neptunemutual.com/blog/decoding-gmxs-price-manipulation-exploit/)). The structural lesson: an oracle-priced door with no impact converts source manipulation into a free option against the LP pool. TruePerp's doors are the opposite construction — worse-of against the opener/closer, over the venue's *own* filtered history — so there is no zero-impact door, and the only price an attacker can influence is one they must pay fees and arbitrage bleed to move (§5). GMX v2's own evolution (borrowing fees and price impact keyed to skew) is convergent evidence that skew-priced carry is the natural funding form when mark-pegging is not the job.

**Hyperliquid teaches both how good the event paradigm gets, and where it breaks.** Its documented waterfall is the genre's cleanest: attempt an orderbook close at mark; below ⅔ of maintenance margin, the **HLP backstop vault inherits the position**; if even that fails, **socialized ADL** force-closes the *most profitable opposite-side traders* against the bankrupt account, ranked by a PnL-and-leverage index ([Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/auto-deleveraging), [OtterSec's reverse-engineering](https://osec.io/blog/hyperliquid-risk-engine/); a recent [formal treatment of ADL's impossibility trade-offs](https://arxiv.org/html/2512.01112v2) confirms socialized deleveraging cannot be made fair to winners). Then March 26, 2025: a trader opened a ~$4–5M JELLY short, deliberately self-liquidated so **HLP inherited it**, and pumped JELLY's price on external venues — HLP's unrealized loss reached ~$13.5M, and the validator set voted to delist the market and force-settle at $0.0095 against a ~$0.50 market price, turning the vault's loss into a $703k gain and igniting a decentralization controversy ([CoinDesk](https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle), [OAK Research](https://oakresearch.io/en/analyses/investigations/hyperliquid-jelly-attack-context-vulnerability-team-solution), [Halborn](https://www.halborn.com/blog/post/explained-the-hyperliquid-hack-march-2025)). Three legs made the attack: the backstop *inherits positions* (so the house can be handed a bomb), settlement referenced prices *from venues other than where the position lived* (so the bomb could be inflated elsewhere), and the real backstop turned out to be *governance*. §5 walks through why TruePerp's shape removes each leg; the incident is this design's most instructive precedent.

**Perpetual Protocol v1 teaches that funding must have a natural payer.** In its vAMM, liquidity was virtual and fixed; under sustained one-sided demand the protocol's insurance fund became the counterparty paying funding to the crowded side, draining continuously, until a chaotic CREAM liquidation on May 15, 2022 added $2M+ of bad debt and the team halted trading; v2 rebuilt on *real* Uniswap v3 liquidity ([Perp support docs](https://support.perp.com/), [The Problem With vAMM Perpetuals](https://wesl.ee/The_Problem_With_vAMM_Perpetuals/)). Two lessons imported directly: the mark must be a market with real, arbitrageable inventory (TruePerp's is the spot pool itself), and funding must flow between parties who exist — in TruePerp the crowded side pays the thin side, and the *residual* of the imbalance flows **to** the LP vault, never from it.

**Synthetix perps v2 teaches skew management as a discipline.** Its funding rate *velocity* is proportional to skew — the rate drifts higher for as long as the book stays imbalanced — and its execution price carries a skew-scaled impact premium, the two together keeping markets near-neutral so LPs "sit back and collect fees" rather than warehouse direction ([SIP-279](https://github.com/Synthetixio/SIPs/blob/master/content/sips/sip-279.md), [Synthetix docs](https://docs.synthetix.io/exchange/perps-basics/funding), [dynamic funding rates](https://blog.synthetix.io/synthetix-perps-dynamic-funding-rates/)). TruePerp v0.1 ships the simpler rate-∝-skew form; velocity funding is the documented upgrade path (PARAMETERS §5) and skew-scaled open fees are its impact analog.

**The oracle-free family teaches the price of avoidance.** [InfinityPools](https://messari.io/report/infinitypools-new-leverage-mechanics) achieves genuinely oracle-free, liquidation-free leverage by *borrowing Uniswap v3 LP ranges* — the exit liquidity for the worst case is acquired upfront, so nothing ever needs to be triggered; the documented cost is capital: the protocol pre-funds tail scenarios competitors leave at risk, bounding efficiency and scale. [Numoen](https://medium.com/numoen/perpetual-options-for-defi-821351c0a24f) sells fully-collateralized perpetual options against LP-token collateral — no oracle, no liquidation, with convexity priced by funding; leverage is bounded by the option form. [Contango](https://medium.com/contango-xyz/contango-the-looping-layer-of-defi-8183bf8ae045) synthesizes "cPerps" by looping borrow → spot-swap → lend across money markets — no book or pool of its own, which is elegant, but the oracle and the liquidation *event* are inherited wholesale from the underlying lending protocols (Contango is, in effect, TrueLend's LeverageRouter industrialized over oracle-based money markets). TruePerp completes the family's empty corner: liquidation neither avoided by pre-payment nor inherited from an oracle venue, but performed — gradually, in cash, by the venue itself.

**The v4 hook space itself** is young: perp and leverage hooks exist as hackathon and early-stage projects (a perp-trading hook, auction-managed leverage, LP-recycling margin designs) catalogued in the [awesome-v4-hooks lists](https://github.com/fewwwww/awesome-uniswap-hooks), none yet with a production liquidation mechanism. The kernel TruePerp reuses — deployed, tested, parameter-modelled, and historically replayed on the lending side — is precisely the piece that space is missing.

**LLAMMA and Panoptic**, the gradual-conversion and internal-median ancestors, arrive here through TrueLend's kernel; its RESEARCH.md covers both in depth.

What none of the prior art has: a liquidation trigger that is *definitionally* correct (the tick crossing the maintenance price is not an estimate of distress in some other venue — it is the settlement venue itself saying so), and a deleveraging that cannot cascade because it trades nothing.

---

## 5. Manipulation economics

Assume the post-merge adversary: a proposer of consecutive blocks can set the pool's spot price at the end of one block and restore it at the top of the next, exposed to no arbitrage, paying only swap fees. The design assumes spot can lie for a block or two, and asks what each lie buys. The JELLY incident (§4) supplies the test suite.

**Cheap entries / rich exits — blocked at both doors.** Entries price at the worse-of {truncated median, spot, recent raw extremes} against the opener; exits mirror against the closer. A one-block dip does not lower a long's entry; a one-block pump does not raise its exit. The filter's truncation (±9,116 ticks per minute-observation), median-of-9, and widen-only extremes mean a lie must be *held* across many arbitrage-bleeding minutes to enter the record — at which point it is not a lie but a price. The symmetric cost: genuine fast moves pay the same ~9-minute confirmation before they can be banked — the design's honest tax, charged to manipulation and momentum alike. Contrast GMX v1, where the door itself was zero-impact at an external price.

**Replaying JELLY against this design.** The attack needed three properties; TruePerp has none of them. *The backstop never inherits a position*: ADL and the force-close realize a bankrupt position's PnL in cash against the vault and delete it — there is no live bomb to hand to the house, and LP exposure to any single position is bounded by that position's remaining notional, shrinking every chunk. *Settlement and manipulation are the same venue*: JELLY's short was settled against prices formed on other exchanges while the position sat on Hyperliquid; TruePerp's positions settle against the pool they live on, so "pump it elsewhere" moves nothing until arbitrage moves *this* pool — at which point the move is real, was paid for through this pool's fees and depth, and the worse-of doors and OI cap have already priced it. *The backstop is code, not a committee*: the waterfall ends in a recorded LP shortfall with a hard trader floor at zero; there is no validator vote to force-settle at a chosen price, which also means there is no such vote to rely on — LPs underwrite the declared tail and nothing else.

**Forcing a victim's ADL.** Push spot into someone's range for a block: at most `MAX_CHUNKS_PER_SWAP` bounded chunks of their position mark to the pushed price — a few percent of one position, penalties flowing to LPs, fully pausable the moment price restores, and the attacker gains nothing directly (a chunk is a cash transfer between victim and vault, not a purchasable asset; contrast the event paradigm, where triggering a whole-position market order into one's own bid is the payoff). Pushing all the way through a runway to force a backstop requires moving a real spot market by the full maintenance margin *and holding it* against arbitrage — the §6.4 cost bound — to capture, at most, a shortfall that lands on LPs rather than the attacker's book.

**Funding farming.** Open the thin side to harvest funding from the crowded side? The rate is priced on the *filtered* price, and the farmer improves the very skew they are paid for carrying — that is the mechanism working, not leaking. Flipping skew violently with size runs into the OI cap (notional ≤ a configured fraction of LP equity) and open fees. The known residual — funding-rate games around large positions, as seen in the pre-JELLY [Hyperliquid whale episodes](https://www.theblock.co/post/348314/hyperliquid-delists-jellyjelly-memecoin-amid-whale-manipulation-fiasco) — is bounded here by the cap's *proportionality to LP equity*: the book cannot outgrow its absorber.

**Timing the LP door.** Vault deposits and redemptions price at equity marked at the *median*, and redemptions are additionally bounded by physical cash — unrealized trader losses cannot be exited through before they realize. A one-block spot push moves LP share price not at all.

**The venue-native residual risk, named plainly.** Everything above bounds *price lies*. A capitalized adversary can move the *true* price of a thin pool, sustained, and TruePerp will faithfully settle against that reality — as JELLY's spot pump was, in the end, a real price that Binance's listing sent 560% higher still. The defenses are the venue's own: depth, arbitrage, and an OI cap that keeps the perp book small relative to what the pool can absorb. A venue-native protocol inherits its venue's quality; PARAMETERS.md §6 turns that inheritance into a sizing rule rather than a hope.

---

## 6. Mathematical reference

**6.1 Equity and the runway.** For a long of size $B$ (base), entry $E$, margin $M$, define per-base margin $\mu = M/B$ and bankruptcy $P_{bk} = E - \mu$ (short: $E + \mu$). Then equity at price $P$ is
$$
\mathrm{Eq}(P) = M + (P-E)B = (P - P_{bk})\,B \equiv \delta B ,
$$
linear in the distance-to-bankruptcy $\delta$. Maintenance requires $\mathrm{Eq} \geq m P B$, giving the range start $P_{start} = P_{bk}/(1-m)$ (short: $P_{bk}/(1+m)$) and a runway of relative width $\approx m$.

**6.2 The equity-invariance lemma and self-termination.** Closing a chunk $c$ at price $P$ (realize $(E-P)c$ against margin) yields new per-base margin and bankruptcy such that
$$
\mathrm{Eq}' = (B-c)\,\delta' = B\,\delta = \mathrm{Eq}:
$$
marking exposure to market conserves equity; only penalties and funding consume it. The maintenance requirement $mP(B-c)$ falls with every chunk, so health $h = \mathrm{Eq}/(mPB_{rem})$ rises monotonically at constant price and reaches 1 after shedding the fraction
$$
r^\* \;=\; 1 - \frac{\delta}{mP} \;=\; d \quad (\text{depth into the runway}),
$$
up to a penalty correction of order $\pi \cdot d / m$. Corollaries: (i) ADL terminates without external help — the engine checks $h \geq 1$ before every chunk and pauses; (ii) ranges fixed at open are conservative, since deleveraging only moves the true $P_{start}$ away from the registered trigger; (iii) the trader's mechanism cost for an episode of depth $d$ is $\Sigma\,\text{penalties} \lesssim \frac{m}{4}\cdot d \cdot \text{notional}$ — the quarter-gap penalty cap inherited from TrueLend's parameter model, applied with $m$ in the LT-gap role.

**6.3 Funding.** With open interest $L, S$ (base units) and filtered price $p$:
$$
\dot f = p \cdot k \cdot \frac{L-S}{L+S}, \qquad
\mathrm{cum}_{long} \mathrel{+}= \dot f\,dt, \quad \mathrm{cum}_{short} \mathrel{-}= \dot f\,dt,
$$
settled lazily per position against a snapshot. Longs pay $\dot f L$, shorts receive $\dot f S$ (signs flip with skew); the residual $\dot f\,|L-S|$ — the carry on the exposure nobody on the trader side offsets — accrues to the vault. This is rate-∝-skew (Synthetix v1-perps form); the v2 refinement (rate *velocity* ∝ skew) is the documented upgrade path. At $k = 100\%/\mathrm{yr}$ and full skew the rate is ~0.011%/hour — inside the band CEX conventions occupy (baseline interest ~0.01%/8h; Hyperliquid caps its premium-based rate at 4%/hour).

**6.4 Cost to force a backstop.** To push a position of runway width $m$ from health to bankruptcy, an attacker must move the pool price by $\approx mP$ and *hold* it against arbitrage long enough that pacing cannot outrun the move or the filter confirms it. Against constant in-range liquidity of one-sided depth $X$ (base units), the capital committed is $\approx X \cdot m/2$ base-equivalents held at risk, plus fees, plus arbitrage bleed for the holding period — while the direct capture is zero (the shortfall lands on the vault; the victim's margin has already gone there). Manipulation pays only through an offsetting position, which the OI cap bounds relative to the equity absorbing it.

**6.5 The maintenance-margin inequality (perp buffer inequality).** An episode entered at depth $d$ self-terminates after $T(d) \approx \frac{N\tau}{\bar\lambda}\ln\frac{1}{1-d}$ (pacing $N, \tau$; mean chunk multiplier $\bar\lambda$). Over $T$, adverse 99th-percentile drift must not traverse the remaining runway, and penalties-plus-funding must fit inside equity:
$$
(1-d)\,m \;\gtrsim\; z_{99}\,\sigma\sqrt{T(d)} + \pi(T)\,d + f\,T(d)
\qquad \text{for all } d \in (0,1),
$$
with **no execution term** — the $s$ that dominates TrueLend's stable-tier budget is structurally zero here. Worked per-tier numbers, and the leverage ceilings $\lambda_{max} = 1/\mathrm{im} \leq 1/(2m)$ they imply, are PARAMETERS.md §4.

---

## 7. Sources

**Incidents and post-mortems.** GMX AVAX manipulation: [Cointelegraph](https://cointelegraph.com/news/decentralized-exchange-gmx-suffers-565k-price-manipulation-exploit) · [Neptune Mutual](https://neptunemutual.com/blog/decoding-gmxs-price-manipulation-exploit/) · [CoinDesk](https://www.coindesk.com/markets/2022/09/19/defi-trader-nets-over-500k-by-using-dex-gmx-to-manipulate-avalanche-token). Hyperliquid JELLY: [CoinDesk](https://www.coindesk.com/markets/2025/03/26/hyperliquid-delists-jellyjelly-after-vault-squeezed-in-usd13m-tussle) · [OAK Research](https://oakresearch.io/en/analyses/investigations/hyperliquid-jelly-attack-context-vulnerability-team-solution) · [Halborn](https://www.halborn.com/blog/post/explained-the-hyperliquid-hack-march-2025) · [Arkham](https://info.arkm.com/research/jellyjelly-exploit-on-hyperliquid) · [The Block](https://www.theblock.co/post/348314/hyperliquid-delists-jellyjelly-memecoin-amid-whale-manipulation-fiasco) · [Hyperliquid incident note](https://hyperliquid-co.gitbook.io/community-docs/introduction/roadmap/2025-26-03_incident). Perpetual Protocol v1: [Perp support docs](https://support.perp.com/) · [The Problem With vAMM Perpetuals](https://wesl.ee/The_Problem_With_vAMM_Perpetuals/) · [FinanceFeeds vAMM failure modes](https://financefeeds.com/vamm-model-perpetual-futures-virtual-liquidity/).

**Mechanism documentation.** Hyperliquid liquidations/ADL/funding: [official docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/auto-deleveraging) · [OtterSec risk-engine analysis](https://osec.io/blog/hyperliquid-risk-engine/) · [HLP vault analysis (CoinGecko)](https://www.coingecko.com/learn/hyperliquid-hlp-vault-analysis). Synthetix perps v2: [funding docs](https://docs.synthetix.io/exchange/perps-basics/funding) · [SIP-279](https://github.com/Synthetixio/SIPs/blob/master/content/sips/sip-279.md) · [dynamic funding](https://blog.synthetix.io/synthetix-perps-dynamic-funding-rates/) · [price impact](https://blog.synthetix.io/price-impact-function-synthetix-perps/). ADL theory: [Autodeleveraging: Impossibilities and Optimization (arXiv, 2025)](https://arxiv.org/html/2512.01112v2).

**Oracle-free family.** [InfinityPools (Messari)](https://messari.io/report/infinitypools-new-leverage-mechanics) · [Numoen perpetual options](https://medium.com/numoen/perpetual-options-for-defi-821351c0a24f) · [Contango looping layer](https://medium.com/contango-xyz/contango-the-looping-layer-of-defi-8183bf8ae045) · [Three Sigma perp landscape](https://threesigma.xyz/blog/options/defi-perpetuals-landscape-guide) (the oracle/oracleless × P2P/P2Pool taxonomy).

**Venue and kernel.** [Uniswap v4 hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks) · [awesome-v4-hooks](https://github.com/fewwwww/awesome-uniswap-hooks) (the nascent perp-hook space) · [TrueLend RESEARCH.md / PARAMETERS.md / BACKTEST.md](https://github.com/queenleoa/TrueLend) (impossibility proof, truncated-oracle filter, kernel, calibration, historical replay) · Curve LLAMMA and Panoptic lineages, covered there.

---

## Appendix — What is reused from TrueLend, exactly

| Kernel piece | Role there | Role here | Changed? |
|---|---|---|---|
| `ChunkMath.chunkSize` | paces collateral sales | paces notional reduction | no |
| `ChunkMath.penaltyBps` | time-scaled penalty, capped at ¼ of the LT gap | same, with $1{-}m$ passed in the LT role → cap $= m/4$ | no |
| `LiqRangeMath` (convert, inRange, pastRange, depthBps, rangeDepthTokens) | range placement & valuation | price conversion, range tests, depth governor | no; range *endpoints* computed by the hook from margin arithmetic instead of `liquidationRange` |
| `TruncatedOracle` | worse-of at origination | worse-of at both doors; median for funding, LP equity, reason-2 | no |
| `TriggerIndex` | boundary bitmap, 32-per-tick cap | identical | no |
| `VaultFactory` device | vault creation code out of the hook | `PerpVaultFactory` | pattern reused |
| audit rules (reward carved from penalty; config validation; walk budgets) | — | adopted as invariants from day one | — |

The reuse is at the address level on deployed networks (linked external libraries are on-chain singletons), which is the concrete payoff of TrueLend's core/periphery discipline: the liquidation kernel was built once and is now consumed by a second protocol without a line of it changing.
