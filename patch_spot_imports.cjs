const fs = require('fs');
let content = fs.readFileSync('src/pages/SpotTrading.tsx', 'utf8');

if (!content.includes("import { OrderHistory }")) {
  content = content.replace(
    "import { Button } from '../components/ui/Button';",
    "import { Button } from '../components/ui/Button';\nimport { OrderHistory } from '../components/orders/OrderHistory';\nimport { OpenOrders } from '../components/orders/OpenOrders';"
  );
}

fs.writeFileSync('src/pages/SpotTrading.tsx', content, 'utf8');
