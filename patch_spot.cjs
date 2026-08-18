const fs = require('fs');
let content = fs.readFileSync('src/pages/SpotTrading.tsx', 'utf8');

if (!content.includes("import { OrderHistory }")) {
  content = content.replace(
    "import { orderService } from '../services/OrderService';",
    "import { orderService } from '../services/OrderService';\nimport { OrderHistory } from '../components/orders/OrderHistory';\nimport { OpenOrders } from '../components/orders/OpenOrders';"
  );
}

// Replace historyTab === 'orders' content
const oldOrdersStart = "{historyTab === 'orders' && (";
const oldOrdersEnd = ") : (\n            <div className=\"flex flex-col gap-3\">\n              {orders.filter(o => o.status !== 'PENDING').map(order => (\n                <div key={order.id} className=\"bg-gray-900/50 p-3 rounded-lg border border-gray-800\">\n                  <div className=\"flex justify-between items-center mb-2\">\n                    <div className=\"flex items-center gap-2\">\n                      <span className={`text-xs font-bold ${order.side === 'BUY' ? 'text-emerald-500' : 'text-red-500'}`}>{order.side}</span>\n                      <span className=\"font-bold text-sm text-gray-200\">{order.symbol}</span>\n                      <span className=\"text-xs text-gray-500 bg-gray-800 px-1 rounded\">{order.type}</span>\n                    </div>\n                    <span className={`text-xs font-bold ${\n                      order.status === 'FILLED' ? 'text-emerald-500' : \n                      order.status === 'CANCELLED' ? 'text-gray-400' : 'text-red-500'\n                    }`}>\n                      {order.status}\n                    </span>\n                  </div>\n                  <div className=\"text-xs text-gray-400 grid grid-cols-2 gap-x-4 gap-y-1\">\n                    <div>Price: <span className=\"text-gray-200\">{order.price || 'Market'}</span></div>\n                    <div>Amount: <span className=\"text-gray-200\">{order.quantity}</span></div>\n                    <div>Date: <span className=\"text-gray-200\">{new Date(order.createdAt).toLocaleString()}</span></div>\n                  </div>\n                </div>\n              ))}\n            </div>\n          )\n        )}";

// Instead of matching the exact huge string, we can use regex to replace it
content = content.replace(
  /\{historyTab === 'orders' && \([\s\S]*?\n\s*\)\n\s*\)\}/,
  "{historyTab === 'orders' && <OrderHistory />}"
);

// Replace Open Orders
content = content.replace(
  /\{historyTab === 'open' && \([\s\S]*?\{historyTab === 'orders' &&/m,
  "{historyTab === 'open' && <OpenOrders symbol={selectedSymbol} />}\n        \n        {historyTab === 'orders' &&"
);


fs.writeFileSync('src/pages/SpotTrading.tsx', content, 'utf8');
