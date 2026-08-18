const fs = require('fs');
let content = fs.readFileSync('src/components/orders/OpenOrders.tsx', 'utf8');

content = content.replace(
  /useEffect\(\(\) => \{\n\s*setOrders\(orderCoreService\.getOrders\(\)\);\n\s*\}, \[user\]\);/g,
  `useEffect(() => {
    const loadOrders = () => setOrders(orderCoreService.getOrders());
    loadOrders();
    const unsubscribe = orderCoreService.subscribe(loadOrders);
    return () => unsubscribe();
  }, [user]);`
);

fs.writeFileSync('src/components/orders/OpenOrders.tsx', content, 'utf8');
