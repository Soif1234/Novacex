import { useState, useEffect } from 'react';
import { marketStore } from '../store/marketStore';

export function useSelectedSymbol() {
  const [selectedSymbol, setSelectedSymbolState] = useState(marketStore.getSelectedSymbol());

  useEffect(() => {
    const unsubscribe = marketStore.subscribe((symbol) => {
      setSelectedSymbolState(symbol);
    });
    return unsubscribe;
  }, []);

  return {
    selectedSymbol,
    setSelectedSymbol: (symbol: string) => marketStore.setSelectedSymbol(symbol)
  };
}
