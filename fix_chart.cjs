const fs = require('fs');
let code = fs.readFileSync('src/components/futures/FuturesChart.tsx', 'utf8');
code = code.replace("ws = new WebSocket(`wss://fstream.binance.com/ws/${streamName}`);",
"console.log('Connecting to WS:', `wss://fstream.binance.com/ws/${streamName}`);\n          ws = new WebSocket(`wss://fstream.binance.com/ws/${streamName}`);");

fs.writeFileSync('src/components/futures/FuturesChart.tsx', code);
