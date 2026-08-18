import fs from 'fs';
import path from 'path';

function fixFile(filePath, prop, varName) {
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(`this.${prop} = JSON.parse(${varName});`)) {
    content = content.replace(
      `this.${prop} = JSON.parse(${varName});`,
      `const parsed = JSON.parse(${varName});\n                if (Array.isArray(parsed)) this.${prop} = parsed.filter(item => item && typeof item === 'object');`
    );
    // adjust indentation and generic fixes
    content = content.replace(/this\.[a-zA-Z]+ \= JSON\.parse\([a-zA-Z]+\);\n\s*if \(Array\.isArray/, 'const parsed = JSON.parse($&'); // lazy way, let's do precise replace
  }
}

const files = [
  { p: 'src/services/futures/FuturesFundingService.ts', search: 'this.history = JSON.parse(h);', rep: 'const parsed = JSON.parse(h);\n      if (Array.isArray(parsed)) this.history = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/futures/FuturesTpSlService.ts', search: 'this.configs = JSON.parse(stored);', rep: 'const parsed = JSON.parse(stored);\n                 if (Array.isArray(parsed)) this.configs = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/user/SecurityService.ts', search: 'this.sessions = JSON.parse(sessionsData);', rep: 'const parsedSessions = JSON.parse(sessionsData);\n          if (Array.isArray(parsedSessions)) this.sessions = parsedSessions.filter(item => item && typeof item === "object");' },
  { p: 'src/services/notifications/NotificationService.ts', search: 'this.notifications = JSON.parse(stored);', rep: 'const parsed = JSON.parse(stored);\n          if (Array.isArray(parsed)) this.notifications = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/orders/OrderCoreService.ts', search: 'this.orders = JSON.parse(data);', rep: 'const parsed = JSON.parse(data);\n                if (Array.isArray(parsed)) this.orders = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/orders/TradeFillService.ts', search: 'this.fills = JSON.parse(data);', rep: 'const parsed = JSON.parse(data);\n                if (Array.isArray(parsed)) this.fills = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/alerts/PriceAlertService.ts', search: 'this.alerts = JSON.parse(stored);', rep: 'const parsed = JSON.parse(stored);\n          if (Array.isArray(parsed)) this.alerts = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/TradeService.ts', search: 'this.trades = JSON.parse(data);', rep: 'const parsed = JSON.parse(data);\n        if (Array.isArray(parsed)) this.trades = parsed.filter(item => item && typeof item === "object");' },
  { p: 'src/services/OrderService.ts', search: 'this.orders = JSON.parse(data);', rep: 'const parsed = JSON.parse(data);\n        if (Array.isArray(parsed)) this.orders = parsed.filter(item => item && typeof item === "object");' }
];

for (const f of files) {
  let content = fs.readFileSync(f.p, 'utf-8');
  if (content.includes(f.search)) {
    fs.writeFileSync(f.p, content.replace(f.search, f.rep));
    console.log("Fixed", f.p);
  } else {
    console.log("Missed", f.p);
  }
}
