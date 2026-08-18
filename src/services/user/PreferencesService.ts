export const preferencesService = {
  getPreferences: () => ({ defaultMarket: 'BTCUSDT', defaultTimeframe: '15m' }),
  updatePreferences: () => {},
  getChartConfig: () => ({ defaultTimeframe: '15m' }),
};
