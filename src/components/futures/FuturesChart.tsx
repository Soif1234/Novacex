import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, ColorType } from 'lightweight-charts';
import { FuturesMarket } from '../../types/futures';
import { updateMarketPriceLocally } from '../../hooks/useFuturesMarketData';
import { preferencesService } from '../../services/user/PreferencesService';
import { apiClient } from '../../services/api/client';
import { wsClient } from '../../services/websocket/wsClient';
import { tradingPairRegistry } from '../../services/market/TradingPairRegistry';

interface FuturesChartProps {
  market: FuturesMarket;
}

// Maps UI timeframe labels to backend-supported kline intervals (1m/5m/1h/1d).
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '1H': '1h',
  '1D': '1d',
};

const TIMEFRAMES = ['1m', '5m', '1H', '1D'];

export function FuturesChart({ market }: FuturesChartProps) {
  const pair = tradingPairRegistry.getPair(market.symbol || (market as any).id);
  const apiSym = pair ? pair.apiSymbol || pair.symbol : (market.symbol || (market as any).id);
  const marketType = pair ? pair.marketType : 'FUTURES';
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const prefTimeframe = preferencesService.getPreferences().defaultTimeframe || '5m';
  const [timeframe, setTimeframe] = useState(TIMEFRAMES.includes(prefTimeframe) ? prefTimeframe : '5m');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const symbol = market?.symbol;
  const interval = INTERVAL_MAP[timeframe] || '1m';

  // Initialization and Resize
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: 'rgba(31, 41, 55, 0.1)' },
        horzLines: { color: 'rgba(31, 41, 55, 0.1)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(31, 41, 55, 1)',
      },
      rightPriceScale: {
        borderColor: 'rgba(31, 41, 55, 1)',
      },
      crosshair: {
        mode: 1, // Normal mode
        vertLine: {
            color: '#6b7280',
            labelBackgroundColor: '#1f2937'
        },
        horzLine: {
            color: '#6b7280',
            labelBackgroundColor: '#1f2937'
        }
      },
    });

    chartInstanceRef.current = chart;

    const series = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    seriesRef.current = series;

    // Resize Observer for iframe/container elasticity
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && chartContainerRef.current) {
      resizeObserver = new ResizeObserver(entries => {
        if (!entries || entries.length === 0 || !chartInstanceRef.current) return;
        const entry = entries[0];
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width > 0 && height > 0) {
          chartInstanceRef.current.applyOptions({ width, height });
        }
      });
      resizeObserver.observe(chartContainerRef.current);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      chart.remove();
    };
  }, []); // Only run once on mount

  // Fetch historical data (backend REST) and subscribe to backend WS for live updates.
  useEffect(() => {
    if (!symbol || !seriesRef.current || !chartInstanceRef.current) return;

    let isMounted = true;
    // Backend kline channel matches kline.service publisher: kline:<market>:<symbol>:<interval>
    const channel = `kline:${String(marketType).toLowerCase()}:${String(apiSym).toLowerCase()}:${interval}`;
    let unsubscribe: (() => void) | null = null;

    const mapCandle = (k: any): CandlestickData<Time> | null => {
      if (!k) return null;
      const rawTime = k.openTime ?? k.time;
      const timeSec = (typeof rawTime === 'number' && rawTime > 10000000000) ? Math.floor(rawTime / 1000) : rawTime;
      const candle: CandlestickData<Time> = {
        time: timeSec as Time,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
      };
      if (
        isNaN(candle.open) || isNaN(candle.high) || isNaN(candle.low) || isNaN(candle.close) ||
        candle.high < candle.low || candle.open < 0 || candle.close < 0
      ) {
        return null;
      }
      return candle;
    };

    const loadDataAndConnect = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // 1. Historical candles from the authoritative backend ONLY (no external source).
        const backendKlines = await apiClient.get<any[]>('/market/klines', {
          symbol: apiSym,
          market: marketType,
          interval,
          limit: 500,
        });

        if (!isMounted) return;

        const validData = (Array.isArray(backendKlines) ? backendKlines : [])
          .map(mapCandle)
          .filter((c): c is CandlestickData<Time> => c !== null);

        // De-duplicate and order ascending by time.
        validData.sort((a, b) => (a.time as number) - (b.time as number));
        const uniqueData: CandlestickData<Time>[] = [];
        let lastTime = 0;
        for (const candle of validData) {
          if ((candle.time as number) > lastTime) {
            uniqueData.push(candle);
            lastTime = candle.time as number;
          }
        }

        seriesRef.current?.setData(uniqueData);
        chartInstanceRef.current?.timeScale().fitContent();

        // 2. Live updates via the backend WebSocket kline channel.
        unsubscribe = wsClient.subscribe(channel, (data: any) => {
          if (!isMounted) return;
          const candle = mapCandle(data);
          if (candle) {
            seriesRef.current?.update(candle);
            updateMarketPriceLocally(symbol, String(data.close));
          }
        });
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || 'Error loading chart data');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadDataAndConnect();

    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [symbol, apiSym, marketType, interval]);

  if (!market) {
      return <div className="flex items-center justify-center h-full text-gray-500 text-sm">No chart data available</div>;
  }

  return (
    <div className="flex flex-col w-full h-full bg-gray-950">
        <div className="flex items-center justify-between px-3 py-1 border-b border-gray-900 text-xs">
            <div className="flex gap-4">
                <div className="flex items-center gap-1 font-bold text-gray-200">
                    {market?.symbol}
                    <span className="text-gray-500 font-normal">Perp</span>
                </div>
                <div className="flex gap-2 text-gray-400">
                    {TIMEFRAMES.map(tf => (
                        <button
                            key={tf}
                            className={`hover:text-gray-200 ${timeframe === tf ? 'text-emerald-500 font-bold' : ''}`}
                            onClick={() => setTimeframe(tf)}
                        >
                            {tf}
                        </button>
                    ))}
                </div>
            </div>
            {isLoading && <div className="text-gray-500">Loading...</div>}
            {error && <div className="text-red-500">{error}</div>}
        </div>
        <div className="flex-1 relative" ref={chartContainerRef} />
    </div>
  );
}
