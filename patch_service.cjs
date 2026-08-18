const fs = require('fs');
let content = fs.readFileSync('src/services/orders/OrderCoreService.ts', 'utf8');

content = content.replace(
  "public getOrders(): Order[] {",
  "public getOrders(userId?: string): Order[] {"
);

content = content.replace(
  "return [...this.orders];",
  "return userId ? this.orders.filter(o => o.userId === userId || o.userId === undefined) : [...this.orders];"
);

fs.writeFileSync('src/services/orders/OrderCoreService.ts', content, 'utf8');
