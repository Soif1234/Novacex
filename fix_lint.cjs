const fs = require('fs');
let code = fs.readFileSync('src/components/futures/FuturesChart.test.tsx', 'utf8');

code = code.replace(/global\.WebSocket\.mock/g, '(global.WebSocket as any).mock');
code = code.replace(/this\.url = url;/g, '(this as any).url = url;');

fs.writeFileSync('src/components/futures/FuturesChart.test.tsx', code);
