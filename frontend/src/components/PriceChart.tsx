import { useMemo, useState } from "react";
import { CandlestickChart, ChevronDown, Expand, Plus } from "lucide-react";
import { ENTRY_PRICE, formatNumber } from "../lib/leverage";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D"] as const;

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeCandles(seedOffset: number): Candle[] {
  let price = 1_940 + seedOffset * 3;
  let seed = 91 + seedOffset;
  const candles: Candle[] = [];

  for (let index = 0; index < 48; index += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const noise = seed / 233280 - 0.43;
    const drift = index < 15 ? 5.4 : index < 27 ? -2.2 : 4.1;
    const open = price;
    const close = open + drift + noise * 33;
    seed = (seed * 9301 + 49297) % 233280;
    const wick = 7 + (seed / 233280) * 22;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick * 0.75;
    price = close;
    candles.push({ open, high, low, close, volume: 28 + (seed % 58) });
  }

  const delta = ENTRY_PRICE - candles[candles.length - 1].close;
  return candles.map((candle) => ({
    ...candle,
    open: candle.open + delta,
    high: candle.high + delta,
    low: candle.low + delta,
    close: candle.close + delta,
  }));
}

export function PriceChart() {
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>("15m");
  const [showInfo, setShowInfo] = useState(false);
  const candles = useMemo(() => makeCandles(TIMEFRAMES.indexOf(timeframe) * 13), [timeframe]);

  const width = 760;
  const height = 342;
  const plotTop = 22;
  const plotBottom = 286;
  const volumeTop = 300;
  const minimum = Math.min(...candles.map((candle) => candle.low));
  const maximum = Math.max(...candles.map((candle) => candle.high));
  const priceRange = maximum - minimum;
  const xStep = width / candles.length;
  const y = (price: number) =>
    plotTop + ((maximum - price) / priceRange) * (plotBottom - plotTop);
  const latest = candles[candles.length - 1];
  const first = candles[0];
  const change = ((latest.close - first.open) / first.open) * 100;

  return (
    <section className="chart-panel" aria-label="Illustrative TrueETH TrueUSDC price chart">
      <div className="chart-heading">
        <div>
          <button className="market-select" type="button" onClick={() => setShowInfo((value) => !value)}>
            <span className="token-pair" aria-hidden="true">
              <span className="eth-mark">tΞ</span>
              <span className="usdc-mark">t$</span>
            </span>
            <span>
              <strong>TrueETH / TrueUSDC</strong>
              <small>Uniswap v4 · demo tokens</small>
            </span>
            <ChevronDown size={16} strokeWidth={1.8} />
          </button>
          {showInfo && (
            <div className="market-popover">
              <span>Prototype market</span>
              <strong>TrueETH / TrueUSDC · 30 bps</strong>
              <small>Unbacked mock assets; the chart is not an ETH/USD feed.</small>
            </div>
          )}
        </div>
        <div className="price-cluster">
          <strong>{formatNumber(ENTRY_PRICE, 2)} tUSDC</strong>
          <span>+{change.toFixed(2)}%</span>
          <small>illustrative</small>
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="timeframe-list" aria-label="Chart timeframe">
          {TIMEFRAMES.map((item) => (
            <button
              className={timeframe === item ? "active" : ""}
              key={item}
              onClick={() => setTimeframe(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
        <div className="chart-tools">
          <button className="icon-button active" title="Candlestick chart" type="button">
            <CandlestickChart size={16} />
          </button>
          <button className="icon-button" title="Add indicator (demo)" type="button">
            <Plus size={16} />
          </button>
          <button className="icon-button" title="Expand chart" type="button">
            <Expand size={16} />
          </button>
        </div>
      </div>

      <div className="chart-wrap">
        <svg
          className="candle-chart"
          role="img"
          aria-label={`Simulated ${timeframe} candlestick chart for TrueETH TrueUSDC`}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          {[0, 1, 2, 3, 4].map((line) => {
            const lineY = plotTop + ((plotBottom - plotTop) / 4) * line;
            const label = maximum - (priceRange / 4) * line;
            return (
              <g key={line}>
                <line className="grid-line" x1="0" x2={width} y1={lineY} y2={lineY} />
                <text className="axis-label" x={width - 6} y={lineY - 6} textAnchor="end">
                  {formatNumber(label, 0)}
                </text>
              </g>
            );
          })}

          {[1, 2, 3, 4, 5].map((line) => {
            const lineX = (width / 6) * line;
            return (
              <line
                className="grid-line vertical"
                key={line}
                x1={lineX}
                x2={lineX}
                y1={plotTop}
                y2={height}
              />
            );
          })}

          {candles.map((candle, index) => {
            const candleX = index * xStep + xStep / 2;
            const candleWidth = Math.max(3.4, xStep * 0.54);
            const bullish = candle.close >= candle.open;
            const bodyTop = y(Math.max(candle.open, candle.close));
            const bodyBottom = y(Math.min(candle.open, candle.close));
            const bodyHeight = Math.max(1.6, bodyBottom - bodyTop);
            const volumeHeight = (candle.volume / 86) * 31;
            return (
              <g className={bullish ? "candle positive" : "candle negative"} key={index}>
                <line x1={candleX} x2={candleX} y1={y(candle.high)} y2={y(candle.low)} />
                <rect x={candleX - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} />
                <rect
                  className="volume"
                  x={candleX - candleWidth / 2}
                  y={height - volumeHeight}
                  width={candleWidth}
                  height={volumeHeight}
                />
              </g>
            );
          })}

          <line
            className="current-price-line"
            x1="0"
            x2={width}
            y1={y(latest.close)}
            y2={y(latest.close)}
          />
          <g className="current-price-label" transform={`translate(${width - 66}, ${y(latest.close) - 10})`}>
            <rect width="66" height="20" rx="2" />
            <text x="33" y="14" textAnchor="middle">{formatNumber(latest.close, 2)}</text>
          </g>
        </svg>
        <div className="chart-watermark">
          <span>TRUEPERP</span>
          <small>simulated market data</small>
        </div>
      </div>

      <div className="market-stats">
        <div><span>Demo 24h high</span><strong>2,034.4 tUSDC</strong></div>
        <div><span>Demo 24h low</span><strong>1,971.2 tUSDC</strong></div>
        <div><span>LP deposits</span><strong>1k tETH + 2m tUSDC</strong></div>
        <div><span>Open interest</span><strong>Demo</strong></div>
      </div>
    </section>
  );
}
