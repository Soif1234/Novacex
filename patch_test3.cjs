const fs = require('fs');
let content = fs.readFileSync('src/components/orders/OrderHistory.test.tsx', 'utf8');

// Replace all queryByText for symbols with queryByText for IDs
content = content.replace(/expect\(screen\.queryByText\('ETHUSDT'\)\)\.toBeNull\(\);/g, "expect(screen.queryByText('ID: ord2')).toBeNull();");
content = content.replace(/expect\(screen\.queryByText\('BTCUSDT'\)\)\.toBeNull\(\);/g, "expect(screen.queryByText('ID: ord1')).toBeNull();");
content = content.replace(/expect\(screen\.queryByText\('SOLUSDT'\)\)\.toBeNull\(\);/g, "expect(screen.queryByText('ID: ord3')).toBeNull();");

// Also replace the getAllByText lengths checks
content = content.replace(/expect\(screen\.getAllByText\('BTCUSDT'\)\.length\)\.toBeGreaterThan\(0\);/g, "expect(screen.getByText('ID: ord1')).toBeDefined();");
content = content.replace(/expect\(screen\.getAllByText\('ETHUSDT'\)\.length\)\.toBeGreaterThan\(0\);/g, "expect(screen.getByText('ID: ord2')).toBeDefined();");

fs.writeFileSync('src/components/orders/OrderHistory.test.tsx', content, 'utf8');
