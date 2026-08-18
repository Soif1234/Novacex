import fs from 'fs';

const p = 'src/services/market/TickerService.test.ts';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace(
  "tickerService.connectWs('api', 'dummy_url', ['BNBUSDT']);",
  "tickerService.connectWs('api', 'dummy_url', ['BNBUSDT'], [{symbol: 'BNBUSDT', apiSymbol: 'BNBUSDT'}]);"
);
fs.writeFileSync(p, code);
