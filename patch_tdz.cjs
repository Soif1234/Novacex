const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// Remove original declarations
code = code.replace("  const market = markets.find(m => m.symbol === selectedSymbol) || markets[0];\n", "");
code = code.replace("  const availMargin = parseFloat(balances['USDT'] || '0');\n", "");

// Insert them right after the state declarations (e.g. before the first useEffect)
const target = "  const [positions, setPositions] = useState<any[]>([]);\n";
const insertion = `  const [positions, setPositions] = useState<any[]>([]);

  const market = markets.find(m => m.symbol === selectedSymbol) || markets[0];
  const availMargin = parseFloat(balances['USDT'] || '0');
`;

code = code.replace(target, insertion);
fs.writeFileSync('src/pages/Futures.tsx', code);
