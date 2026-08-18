const fs = require('fs');
let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

if (!content.includes("import { OpenOrders }")) {
  content = content.replace(
    "import { FuturesChart } from '../components/futures/FuturesChart';",
    "import { FuturesChart } from '../components/futures/FuturesChart';\nimport { OpenOrders } from '../components/orders/OpenOrders';\nimport { OrderHistory } from '../components/orders/OrderHistory';"
  );
}

// Replace Open Orders tab content
content = content.replace(
  /\{historyTab === 'open' && orders\.filter\(o => o\.status === 'NEW' \|\| o\.status === 'PENDING' \|\| o\.status === 'PARTIALLY_FILLED'\)\.filter\(o => o\.symbol === selectedSymbol\)\.map\(o => \([\s\S]*?\)\)\}/,
  "{historyTab === 'open' && <OpenOrders symbol={selectedSymbol} />}"
);

// Replace Order History tab content
content = content.replace(
  /\{historyTab === 'history' && orders\.filter\(o => o\.status !== 'NEW' && o\.status !== 'PENDING' && o\.symbol === selectedSymbol\)\.map\(o => \([\s\S]*?\)\)\}/,
  "{historyTab === 'history' && <OrderHistory />}"
);

fs.writeFileSync('src/pages/Futures.tsx', content, 'utf8');
