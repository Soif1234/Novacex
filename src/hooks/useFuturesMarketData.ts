import { useState, useEffect } from 'react';
import { FuturesMarket } from '../types/futures';
import { futuresMarketService } from '../services/futures/FuturesMarketService';
import { futuresOrderService } from '../services/futures/FuturesOrderService';

let globalData: FuturesMarket[] = [];
let globalLastUpdated: Date | null = null;
let globalError: string | null = null;
let globalIsLoading = false;
let isFetching = false;
let timeoutId: number | null = null;

const subscribers = new Set<() => void>();

const notify = () => subscribers.forEach(fn => fn());

const poll = async (intervalMs: number) => {
  if (isFetching) return;
  
  isFetching = true;
  if (globalData.length === 0) globalIsLoading = true;
  notify();

  try {
    const newData = await futuresMarketService.getMarkets();
    globalData = newData;
    futuresOrderService.updateMarkPrices(newData);
    // We also need to run risk check, we can do it via futuresOrderService if it's there, but actually futuresOrderService has access to positions.
    globalLastUpdated = new Date();
    globalError = null;
  } catch (err) {
    globalError = err instanceof Error ? err.message : 'An error occurred';
  } finally {
    globalIsLoading = false;
    isFetching = false;
    notify();

    if (subscribers.size > 0) {
      timeoutId = setTimeout(() => poll(intervalMs), intervalMs) as unknown as number;
    } else {
      timeoutId = null;
    }
  }
};

export function updateMarketPriceLocally(symbol: string, newPrice: string) {
  const market = globalData.find(m => m.symbol === symbol);
  if (market) {
    market.lastPrice = newPrice;
    market.markPrice = newPrice;
    // We can also let the futuresOrderService know about the new mark prices for risk checks
    futuresOrderService.updateMarkPrices(globalData);
    notify();
  }
}

export function useFuturesMarketData(pollingIntervalMs: number = 5000) {
  const [state, setState] = useState({
    data: globalData,
    loading: globalIsLoading || (globalData.length === 0 && !globalError),
    isRefreshing: isFetching,
    error: globalError,
    lastUpdated: globalLastUpdated
  });

  useEffect(() => {
    const handleUpdate = () => {
      setState({
        data: globalData,
        loading: globalIsLoading || (globalData.length === 0 && !globalError),
        isRefreshing: isFetching,
        error: globalError,
        lastUpdated: globalLastUpdated
      });
    };

    subscribers.add(handleUpdate);
    
    // Start polling if not already active and we have subscribers
    if (timeoutId === null && !isFetching) {
      poll(pollingIntervalMs);
    } else {
      // If data exists, immediately sync local state
      handleUpdate();
    }

    return () => {
      subscribers.delete(handleUpdate);
      if (subscribers.size === 0 && timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
  }, [pollingIntervalMs]);

  return state;
}
