import fs from 'fs';

const p = 'src/services/market/TradingPairRegistry.ts';
let code = fs.readFileSync(p, 'utf-8');
console.log(code);
