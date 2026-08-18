import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, ColorType } from 'lightweight-charts';
import { FuturesMarket } from '../../types/futures';
import { updateMarketPriceLocally } from '../../hooks/useFuturesMarketData';
import { preferencesService } from '../../services/user/PreferencesService';

interface FuturesChartProps {
  market: FuturesMarket;
}

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1H': '1h',
  '4H': '4h',
  '1D': '1d',
};

import { tradingPairRegistry } from '../../services/market/TradingPairRegistry';

export function FuturesChart({ market }: FuturesChartProps) {
  const pair = tradingPairRegistry.getPair(market.symbol || (market as any).id);
  const apiSym = pair ? pair.apiSymbol || pair.symbol : (market.symbol || (market as any).id);
  const marketType = pair ? pair.marketType : 'FUTURES';
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  
  const [timeframe, setTimeframe] = useState(preferencesService.getPreferences().defaultTimeframe || '15m');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const symbol = market?.symbol;
  const binanceInterval = INTERVAL_MAP[timeframe] || '15m';

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

  // Fetch historical data and connect WS when symbol or timeframe changes
  useEffect(() => {
    if (!symbol || !seriesRef.current || !chartInstanceRef.current) return;

    let isMounted = true;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const loadDataAndConnect = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // 1. Fetch historical data
        const res = await fetch(marketType === 'SPOT' ? `https://api.binance.com/api/v3/klines?symbol=${apiSym}&interval=${binanceInterval}&limit=500` : `https://fapi.binance.com/fapi/v1/klines?symbol=${apiSym}&interval=${binanceInterval}&limit=500`);
        if (!res.ok) throw new Error('Failed to fetch historical klines');
        
        const data = await res.json();
        
        if (!isMounted) return;

        const formattedData: CandlestickData<Time>[] = data.map((d: any) => ({
          time: (d[0] / 1000) as Time,
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
        }));

        // Filter out any invalid candles
        const validData = formattedData.filter(d => 
          !isNaN(d.open) && !isNaN(d.high) && !isNaN(d.low) && !isNaN(d.close) &&
          d.high >= d.low && d.open >= 0 && d.close >= 0
        );

        // Sort just in case, and remove duplicates
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

        // 2. Connect WebSocket for live updates
        const connectWs = () => {
          if (!isMounted) return;
          
          const streamName = `${symbol.toLowerCase()}@kline_${binanceInterval}`;
          console.log('Connecting to WS:', `wss://fstream.binance.com/ws/${streamName}`);
          ws = new WebSocket(`wss://fstream.binance.com/ws/${streamName}`);

          ws.onmessage = (event) => {
            if (!isMounted) return;
            try {
              const msg = JSON.parse(event.data);
              if (msg && msg.e === 'kline' && msg.k) {
                const k = msg.k;
                
                const candle: CandlestickData<Time> = {
                  time: (k.t / 1000) as Time,
                  open: parseFloat(k.o),
                  high: parseFloat(k.h),
                  low: parseFloat(k.l),
                  close: parseFloat(k.c),
                };

                // Validate
                if (
                  !isNaN(candle.open) && !isNaN(candle.high) && !isNaN(candle.low) && !isNaN(candle.close) &&
                  candle.high >= candle.low && candle.open >= 0 && candle.close >= 0
                ) {
                  seriesRef.current?.update(candle);
                  // Also update the global market price to keep everything in sync
                  updateMarketPriceLocally(symbol, k.c);
                }
              }
            } catch (err) {
              console.warn('Failed to parse WS candle frame safely', err);
            }
          };

          ws.onclose = () => {
            if (isMounted) {
              // Automatically reconnect
              reconnectTimeout = setTimeout(connectWs, 3000);
            }
          };

          ws.onerror = (err) => {
            console.warn('Binance WS connection warning - will auto-reconnect');
            ws?.close();
          };
        };

        connectWs();

      } catch (err: any) {
        if (isMounted) {
          setError(err.message || 'Error loading chart data');
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
      if (ws) {
        ws.close();
      }
      clearTimeout(reconnectTimeout);
    };
  }, [symbol, binanceInterval]);

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
                    {['1m', '5m', '15m', '1H', '4H', '1D'].map(tf => (
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
