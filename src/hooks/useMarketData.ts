import { useState, useEffect } from 'react';
import { MarketPair } from '../types';
import { fetchMarketData } from '../services/marketData';
import { mockMarkets } from '../mockData';

let globalData: MarketPair[] = [];
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
    const newData = await fetchMarketData();
    globalData = newData;
    globalLastUpdated = new Date();
    globalError = null;
  } catch (err) {
    globalError = err instanceof Error ? err.message : 'An error occurred';
  } finally {
    globalIsLoading = false;
    isFetching = false;
    notify();
    if (subscribers.size > 0) {
      timeoutId = window.setTimeout(() => poll(intervalMs), intervalMs);
    } else {
      timeoutId = null;
    }
  }
};

export function useMarketData(pollingIntervalMs: number = 10000) {
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
        loading: globalIsLoading,
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
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
  }, [pollingIntervalMs]);

  return state;
}
