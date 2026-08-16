import { useState, useEffect } from 'react';
import { userPreferencesStore } from '../store/userPreferencesStore';

export function useUserPreferences() {
  const [favorites, setFavorites] = useState<string[]>(userPreferencesStore.getFavorites());
  const [recentPairs, setRecentPairs] = useState<string[]>(userPreferencesStore.getRecentPairs());

  useEffect(() => {
    const unsubscribe = userPreferencesStore.subscribe(() => {
      setFavorites(userPreferencesStore.getFavorites());
      setRecentPairs(userPreferencesStore.getRecentPairs());
    });
    return unsubscribe;
  }, []);

  return {
    favorites,
    recentPairs,
    toggleFavorite: (symbol: string) => userPreferencesStore.toggleFavorite(symbol),
    isFavorite: (symbol: string) => userPreferencesStore.isFavorite(symbol),
    addRecentPair: (symbol: string) => userPreferencesStore.addRecentPair(symbol)
  };
}
