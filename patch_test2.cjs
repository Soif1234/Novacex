const fs = require('fs');
let content = fs.readFileSync('src/components/orders/OrderHistory.test.tsx', 'utf8');

content = content.replace(
  "fireEvent.click(screen.getByText('ord1'));",
  "fireEvent.click(screen.getByText('ID: ord1'));"
);

fs.writeFileSync('src/components/orders/OrderHistory.test.tsx', content, 'utf8');
