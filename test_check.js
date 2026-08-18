const { futuresMarketService } = require('./src/services/futures/FuturesMarketService');
futuresMarketService.getMarket('BTCUSDT').then(m => console.log(m));
