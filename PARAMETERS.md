# TruePerp — Parameter Modelling

This document does for TruePerp what [TrueLend's PARAMETERS.md](https://github.com/queenleoa/TrueLend/blob/main/PARAMETERS.md) does for lending: state *what* is being chosen and what "correct" means (§1–2), build the risk model and derive closed-form first cuts with worked numbers (§3–6), and specify the Monte-Carlo and historical-replay program that turns first cuts into production values (§7). The methodology, calibration data, episode engine, and replay harness are TrueLend's — an ADL episode is an episode — so this document is short where that one is long, and derives only what is genuinely different: the geometry of margin-defined ranges, the disappearance of the execution term, and the funding and open-interest knobs a perp adds.

---

## 1. What is being chosen, and who bears what

| Parameter | Bears the consequence | Failure mode if wrong |
|---|---|---|
| `maintenanceMarginBps` (m) — the runway width | LPs (too small → gap-through shortfalls) and traders (too large → early forced deleveraging) | the load-bearing choice; everything below feeds it |
| `initialMarginBps` (≥ 2m) — max leverage 1/im | traders | positions born too close to their runway |
| pacing (`targetChunks`, `chunkInterval`, `timeCapX`, `maxChunkDepthBps`) | both | too slow: drift outruns deleveraging → backstops; too fast: needless churn penalties |
| `basePenaltyBps` (kernel-capped at m/4) | traders → LPs | mispriced compensation for the absorbers |
| `fundingKBps` | crowded side → thin side + LPs | skew persists (too low) or books empty (too high) |
| `oiCapBps` | LPs | the house carries a book its equity cannot absorb |
| open/close fees | traders → LPs | LP yield floor |

Two structural simplifications against the lending problem, both consequences of cash settlement: there is **no execution-cost term** (chunks trade nothing — RESEARCH §2), and there is **no interest-rate model** (funding replaces it, priced by skew rather than utilization).

## 2. Objectives and tolerances

Over a stress-calibrated distribution of ADL episodes, per volatility tier, a parameter set is **accepted** iff:

- **LP shortfall frequency** ≤ 1% of episodes and **conditional severity** ≤ 5% of the position's notional (ε₁, ε₂ — the vault analog of lender loss);
- **backstop frequency** ≤ 0.5% of episodes (ε₃ — gradualism must almost always suffice);
- preferred among accepted sets by **lowest median trader episode cost** (penalties + funding during the episode; adverse price movement is market risk, not mechanism cost) and **highest self-termination fraction** (episodes ending in restored health or recovery rather than any close).

The tolerances are inherited from TrueLend §2 deliberately: the LP vault underwrites the same kind of tail the lender vaults do, and should be held to the same standard.

## 3. Risk model and calibration

Price dynamics, tiers, and data are TrueLend's, unchanged and shared: jump-diffusion with tier calibration from [`calibration.json`](https://github.com/queenleoa/TrueLend/blob/main/notebooks/calibration.json) (99th-percentile 30-day realized vol since 2020, threshold-detected jumps reflected adverse, live on-chain depth), plus the six-crash-week 1-minute replay library. The perp adds one axis: **leverage** — equivalently the runway width m — swept per tier. Depth enters only as the chunk-size governor (the cap keyed to measured in-range base depth), not as a slippage source.

| Tier | σ (99th-pct ann., static / calibrated) | jump profile | example |
|---|---|---|---|
| Stable | 2% / 38% (depeg months) | rare, depeg tail | USDC/USDT |
| Major | 80% / 182% | 72/yr, μ −3.5% | ETH/USDC |
| Long-tail | 150% / 286% | 65/yr, μ −6.4% | PEPE/WETH |

## 4. The geometry: how wide must the runway be?

### 4.1 Episode duration from the self-termination lemma

RESEARCH §6.2: an episode entered at depth $d$ into the runway must shed fraction $r^\* \approx d$ of its notional to restore health. Chunks remove a fraction $\bar\lambda/N$ of the *remaining* size per interval $\tau$ (mean pacing multiplier $\bar\lambda \approx (1+\bar d)(1+\text{pressure}) \approx 2$ for a mid-range episode), so the shedding time is

$$
T(d) \;\approx\; \frac{N\,\tau}{\bar\lambda}\,\ln\!\frac{1}{1-d}.
$$

At defaults ($N{=}100$, $\tau{=}60$ s, $\bar\lambda{=}2$): $T(0.5) \approx 35$ min, $T(0.8) \approx 80$ min. Faster pacing buys time linearly; this is the same $\sqrt{T}$-vs-pacing trade TrueLend's model optimizes, minus the execution cost that used to push back.

### 4.2 The maintenance-margin inequality

While the engine sheds, the price must not traverse the *remaining* runway $(1-d)\,m$, and penalties must fit inside remaining equity. For all $d \in (0,1)$:

$$
(1-d)\,m \;\gtrsim\; \underbrace{z_{99}\,\sigma\sqrt{T(d)}}_{\text{drift }\mu} \;+\; \underbrace{\pi(T)\,d}_{\text{penalties, } \pi \le m/4} \;+\; \underbrace{f\,T(d)}_{\text{funding, negligible at episode scale}} .
$$

No $s$: the term that dominates TrueLend's stable tier — half the chunk-depth cap plus pool fees per churned unit — is structurally zero. The binding scenario is deep entry ($d \approx 0.5{-}0.8$, where drift has had time to matter and little runway remains); jumps are handled as in TrueLend §5: a jump larger than $(1-d)m$ gaps to the backstop, and its expected cost prices into the LP tolerance rather than the runway.

### 4.3 First cuts, worked

Solving the inequality at the worst $d$ (defaults; $z_{99}=2.33$; penalty at its 50 bps base):

| Tier | σ used | worst-case μ over T(0.8) | **m first cut** | im = 2m | **λ_max = 1/im** |
|---|---|---|---|---|---|
| Stable | 2% | 0.05% | **0.5%** (penalty/funding-floored) | 1% | **100×** (offer 50×) |
| Major | 80% static | 1.9% | **4%** | 8% | **12.5×** |
| Major | 182% calibrated | 4.4% | **8%** → 5–6% at N=50, τ=30 s | 10–12% | **8–10×** |
| Long-tail | 286% calibrated | 6.9% | **10–12%** | 20–25% | **4–5×** |

Two cross-checks, both landing where they should:

- **Against TrueLend's validated tiers.** A runway of width m plays exactly the role of the LT gap $(1-\mathrm{LT})$: major-tier lending cleared LT 95 (5% gap) ex-ante and ex-post in the historical replay — and the perp first cut says majors want m ≈ 4–6%. Same market, same kernel, same answer by a different derivation.
- **Against the looped construction.** TrueLend's LeverageRouter reaches $\lambda = 1/(1-\mathrm{LTV}) \Rightarrow$ 10.3× on majors; the direct-margin perp reaches $1/\mathrm{im} \approx$ 8–12.5×. The numbers agree on risk while differing in form for a real reason: looped leverage compounds through borrowing capacity (and pays interest), while perp leverage is bookkept against the vault (and pays funding) — the ceilings converge because the *runway*, not the construction, is what volatility constrains.

The default config ships m = 2% (20×): correct for the stable tier with margin to spare, aggressive for majors under stress calibration. **Per-tier `setConfig` before listing volatile markets is not optional**, exactly as TrueLend's maxLtBps tiers are not.

## 5. Funding: sizing k

Funding's job here is not mark-pegging (RESEARCH §1) but pricing the **net exposure LPs carry**: at skew $s$, LPs are synthetically short $s \cdot \mathrm{OI}$ of base to the trader side. The rate at full skew, $k$, should cover what delta-hedging that exposure costs — the borrow/carry rate of the base asset, for which TrueLend's own vault curve (≈ 4–54% APR across utilization) and CEX conventions bracket the market: the standard baseline interest component is 0.01% per 8 hours (~11%/yr), market-wide funding ran ~10% → ~30% annualized in the levered week before the October 2025 cascade before collapsing to bear-market lows ([CoinGecko](https://www.coingecko.com/learn/october-10-crypto-crash-explained)), and Hyperliquid's 4%/hour cap on its premium-based rate marks the extreme ([docs](https://hyperliquid.gitbook.io/hyperliquid-docs)). Default $k = 100\%/\mathrm{yr}$ at *full* skew sits inside the observed band: a typical 20–40% skew prices at 20–40%/yr — above hedge cost, so LPs are net-paid for imbalance and traders are incented to balance the book. Perpetual Protocol v1 is the cautionary bound in the other direction: a vAMM has no natural funding payer, so its insurance fund paid the crowded side under sustained skew and drained (RESEARCH §4) — here the residual flows **to** the vault by construction, never from it. Sweep $k \in$ 50–300%/yr in the model with skew half-life vs trader-cost as the metric; Synthetix v2's skew-*velocity* funding (the rate drifts while imbalance persists, [SIP-279](https://github.com/Synthetixio/SIPs/blob/master/content/sips/sip-279.md)) is the documented refinement to evaluate in the same sweep.

## 6. Open-interest cap, penalties, fees

**OI cap.** LP equity must absorb the tail of net trader PnL between rebalancing opportunities. With net OI ≤ $c \cdot E$ (cap fraction $c$) the one-day 99th-percentile LP drawdown is $\approx c \cdot z_{99} \sigma \sqrt{1/365}$ of equity — at $c = 50\%$ and major-tier σ = 80%, ≈ 4.9%. Choose $c$ per tier from a target daily drawdown (2–5%): $c \le \text{target}/(z_{99}\sigma\sqrt{1/365})$ — the default 50% suits majors; stables tolerate far more, long-tail far less. The Hyperliquid JELLY incident (RESEARCH §4–5) is the empirical case for making this cap *structural* rather than advisory: a book allowed to grow to ~27× the eventual squeeze loss forced a governance intervention; a cap proportional to LP equity keeps the worst position the house can face inside what the house has visibly staked.

**Penalty and reward.** Base 50 bps time-scaled ×1→×5, kernel-capped at m/4 so an episode can never be made unrecoverable by its own fees (TrueLend's parameter-model finding, inherited mechanically by passing $1{-}m$ into `ChunkMath.penaltyBps`). The executor reward (10 bps) is carved from the penalty — the audited rule. Note the cap binds early at low m: at m = 2%, the 50 bps base *is* the cap, so the time escalation is inert; at m = 5% it has room. The model should report realized penalty income per tier as the LP-compensation line item it is.

**Fees.** 10/10 bps open/close are floor income for LPs and a spam brake; they are not risk parameters and are swept only for the trader-cost metric.

## 7. Monte-Carlo and replay specification — status: specified, pending run

Everything reuses [TrueLend's model stack](https://github.com/queenleoa/TrueLend/tree/main/notebooks): the antithetic jump-diffusion path generator, the calibration pipeline, and the six-crash-week 1-minute replay library with both pool orientations (a pump liquidates shorts). What the perp run needs, concretely:

1. **A perp episode variant in `engine.py`** (~40 lines beside `run_episodes`): margin ledger instead of collateral sale — chunk realizes $|P-E|\cdot c$ + penalty against margin, no proceeds/slippage leg, health-restoration termination ($\mathrm{Eq} \ge m \cdot \text{notional}$) alongside recovery/backstop exits, funding drag as a constant per-step drain at the episode's skew.
2. **Grid**: tier × m ∈ {0.5, 1, 2, 4, 6, 10}% × leverage-at-entry λ ∈ {5, 10, 20, 50} (entry depth follows from im), pacing (N, τ) ∈ {(100, 60), (50, 30)}, k ∈ {50, 100, 300}%/yr; 4,000 antithetic paths per point at 12 s steps.
3. **Metrics**: ε-acceptance per §2; median/95th trader episode cost; self-termination fraction; LP shortfall exceedance curves; funding-residual income.
4. **Replay**: hypothetical positions opened hourly at each λ through the crash weeks, walk-forward re-acceptance on trailing-180-day calibration — the identical protocol that validated TrueLend's major tier ex-ante and ex-post, applied to (m, λ) pairs.
5. **Deliverables**: `notebooks/` mirror of TrueLend's (parameters run, RESULTS, BACKTEST), and the §4.3 table's "first cut" column replaced by simulated values.

Until that run lands, the §4.3 first cuts plus TrueLend's replay-validated tier gaps are the operative recommendations, and the shipped default (m = 2%, 20×) should be treated as stable-tier-only.

## 8. Summary of first-cut recommendations

| Parameter | Stable | Major | Long-tail |
|---|---|---|---|
| `maintenanceMarginBps` | 50–100 | **400–600** | 1000–1200 |
| `initialMarginBps` (λ_max) | 100–200 (50–100×) | 800–1200 (8–12×) | 2000–2500 (4–5×) |
| pacing | 100 / 60 s | **50 / 30–60 s** | 100 / 60 s |
| `basePenaltyBps` | 25 | 50 | 75–100 |
| `fundingKBps` | 5,000 | 10,000 | 20,000 |
| `oiCapBps` (vs LP equity) | 10,000+ | 5,000 | 2,000 |

The one-line takeaway mirrors TrueLend's: **the runway is drift-dominated** — with execution costs gone, everything reduces to whether paced deleveraging outruns $z_{99}\sigma\sqrt{T}$ inside a band of width m. Faster pacing, deeper pools, and active poking all buy leverage headroom; the model's job is to sit on the right side of that race per tier, and the kernel already knows how to run it.
