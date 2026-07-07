# TruePerp — Design Specification

TruePerp turns a Uniswap v4 spot pool into a cash-settled perpetual market with no external oracle and no liquidation events. It is the second protocol built on the liquidation kernel TrueLend introduced — the design rationale, impossibility argument, and manipulation economics live in [TrueLend's RESEARCH.md](https://github.com/queenleoa/TrueLend/blob/main/RESEARCH.md) (the perp appendix derives this exact architecture as "path 2"); this document specifies what is different here.

## 1. Roles and flows

Three parties, one pool:

- **Traders** post cash margin (custodied by the hook) and take long or short base exposure. No borrowing, no token flow at position changes beyond margin and settlement — positions are bookkeeping against the vault.
- **LPs** deposit cash into the **PerpVault** and are the collective counterparty: they earn open/close fees, ADL penalties, and the funding-skew residual; they pay trader wins; they absorb bankruptcies past the backstop as a recorded shortfall (`totalShortfall`) — the same declared-waterfall stance as TrueLend's lending vaults.
- **The spot pool** contributes three things and is touched for none: its tick is the price, its swaps are the pacing clock (`afterSwap` drives ADL, `poke` backstops quiet markets for a reward), and its recent history feeds the truncated-median filter. The hook never swaps — settlement is pure cash transfer between hook-held margin and the vault — so, unlike TrueLend, no PoolManager unlock is ever needed outside the pool's own callbacks.

## 2. Entries and exits: worse-of on both doors

TrueLend prices collateral at the worse of spot and its truncated filter once, at origination. A perp has two price-critical moments, so TruePerp applies the filter at both, directionally: **longs enter at the highest of {median, spot, recent extremes} and exit at the lowest; shorts mirror.** A flash spike can therefore neither cheapen an entry nor inflate an exit — the cost of manipulation-resistance is that profit-taking needs the filter (≈9 minutes of history) to catch up with a genuine move, which is the intended behavior, not a limitation.

## 3. The ADL range: margin arithmetic, not configuration

A loan's range starts where LTV = LT because the borrower chose LT. A perp position's range needs no choice — it falls out of margin arithmetic. For a long with entry $E$, base size $B$, margin $M$ (per-base $\mu = M/B$) and maintenance ratio $m$:

$$
P_{bk} = E - \mu \qquad\text{(equity} = 0\text{)}, \qquad
P_{start} = \frac{P_{bk}}{1-m} \qquad\text{(equity} = m \cdot \text{notional)},
$$

and shorts mirror upward ($P_{bk} = E + \mu$, $P_{start} = P_{bk}/(1+m)$). The range is registered in the tick bitmap (`TriggerIndex`) exactly like a loan's; its width is not a config knob but the position's own distance from maintenance to bankruptcy — higher leverage, narrower band, faster obligatory pacing. A position whose margin covers its whole notional has no liquidation price and is rejected (`FullyBackedPosition`): leverage below 1 belongs in spot.

Ranges are fixed at open (v0.1). This is conservative in the correct direction: deleveraging strictly *improves* health, so the true maintenance price only migrates further below the registered trigger; the engine re-checks exact health before every chunk and pauses when the arithmetic says healthy, so early triggering costs nothing but a bitmap lookup.

## 4. Chunked auto-deleveraging

While the tick is inside a position's range, each swap's `afterSwap` (or `poke`, paid from the penalty flow) executes one paced step through the same `ChunkMath` formula as TrueLend — time-catch-up × range-depth × position-vs-book-pressure, capped per chunk at a fraction of measured in-range base depth. The chunk **closes notional, it does not sell anything**: the loss on the closed slice (entry vs. current price) and a time-scaled penalty move from margin to the vault; aggregates (`baseLong/Short`, cost bases) shrink; the executor's reward is carved from the penalty, never charged on top (the TrueLend audit finding, inherited as design law).

Termination is the perp-shaped one. A loan's decay ends at debt = 0; ADL ends at **health restored**: since each chunk removes $m$-weighted notional faster than it burns margin, equity eventually covers maintenance on the remainder, and the engine pauses the episode exactly as it does on price recovery. The trader ends with a smaller, healthy position — gradual, reversible, minimal — rather than dust or a stump forced closed. Margin exhausted mid-decay short-circuits to the backstop (§5).

## 5. Backstops and the waterfall

Two reasons make a position closable by anyone, for a reward carved from the penalty:

1. **Bankruptcy boundary crossed** — the price gapped past the range end;
2. **Equity gone at the filtered price** — funding or a partial gap consumed margin faster than pacing could deleverage.

The close settles at the worse-of exit price; margin absorbs what it can; the remainder is recorded (`PerpVault.recordShortfall`) and borne by LPs. There are no negative trader balances and no socialized clawbacks from other traders — the hard floor at zero is a feature of full collateralization, and the LP tail is declared so it can be priced, exactly as in TrueLend.

## 6. Funding without a funding oracle

Every state-touching call first accrues funding. With long/short open interest $L, S$ (base units), filtered price $p$, and annualized full-skew rate $k$:

$$
\Delta = p \cdot k \cdot \frac{L - S}{L + S} \cdot \frac{dt}{\text{year}}
\quad\text{per unit base:}\quad
\text{cum}_{long} \mathrel{+}= \Delta, \quad \text{cum}_{short} \mathrel{-}= \Delta .
$$

The crowded side pays, the thin side receives, and the imbalance residual $|\Delta| \cdot |L-S|$ transfers to the vault — LPs are compensated for carrying the net exposure the thin side doesn't offset. Per-position settlement is lazy (on chunk, close, or force-close) against a snapshot, LLAMMA-index style. The filtered price (not spot) prices funding, so skew manipulation cannot be amplified by a same-block price push.

## 7. Accounting invariants

- Hook cash balance = Σ live position margins (funding residuals and realized flows leave immediately; every close routes the whole margin through the vault and pays sinks from there — conservation by construction).
- Vault cash = LP deposits + fees + penalties + realized trader losses + funding residual − trader wins − reward payouts.
- LP equity = vault cash − `unrealizedOwed` (net trader PnL at the filtered price), floored at zero for share pricing; redemptions additionally bounded by physical cash, so unrealized losses must realize before LPs can exit through them.
- Open interest ≤ `oiCapBps` × LP equity at every open.

## 8. Parameters (defaults; owner-set per pool, validated)

| Parameter | Default | Role |
|---|---|---|
| `maintenanceMarginBps` | 200 (2%) | range start; LT-98 analog — the penalty cap reuses TrueLend's quarter-gap rule against it |
| `initialMarginBps` | 500 (20× max) | validated ≥ 2× maintenance |
| `targetChunks` / `chunkInterval` / `timeCapX` | 100 / 60 s / 5× | TrueLend pacing, unchanged |
| `maxChunkDepthBps` | 100 | per-chunk cap vs measured in-range base depth |
| `basePenaltyBps` | 50 | time-scaled per chunk; executor reward (10 bps) carved from it |
| `openFeeBps` / `closeFeeBps` | 10 / 10 | to the vault |
| `fundingKBps` | 10,000 (100%/yr at full skew) | ≈ 0.011%/hour at full skew |
| `oiCapBps` | 5,000 | open notional ≤ 50% of LP equity |

Perp-profile values (tighter maintenance, higher leverage) must re-clear the [TrueLend parameter model](https://github.com/queenleoa/TrueLend/blob/main/PARAMETERS.md) with a leverage axis before production; the episode engine and backtest harness apply unchanged (an ADL episode is an episode).

## 9. v0.1 scope, honestly

Full-close only (no partial close, no margin top-up); one position per (trader, open) — no netting; funding residual transfers assume hook-held margins cover transient imbalances between lazy settlements; `unrealizedOwed` prices LP equity at the filtered median (9-minute lag is the manipulation trade-off); not audited; not deployed. The mechanism — margin-derived ranges, chunked self-terminating ADL, skew funding, declared LP tail — is complete and tested (10 scenarios).
