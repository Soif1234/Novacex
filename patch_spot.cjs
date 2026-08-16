const fs = require('fs');
let code = fs.readFileSync('src/pages/SpotTrading.tsx', 'utf8');

code = code.replace(
    "export function SpotTrading({ selectedSymbol = 'BTC' }: { selectedSymbol?: string }) {",
    "import { useSelectedSymbol } from '../hooks/useSelectedSymbol';\nexport function SpotTrading({ selectedSymbol: initialSymbol = 'BTCUSDT' }: { selectedSymbol?: string }) {"
);

code = code.replace(
    "const [internalSymbol, setInternalSymbol] = useState(selectedSymbol);",
    "const { selectedSymbol, setSelectedSymbol } = useSelectedSymbol();\n  const [internalSymbol, setInternalSymbol] = useState(selectedSymbol.replace('USDT', ''));"
);

code = code.replace(
    "if (selectedSymbol) setInternalSymbol(selectedSymbol);",
    "if (selectedSymbol) setInternalSymbol(selectedSymbol.replace('USDT', ''));"
);

code = code.replace(
    "setInternalSymbol(pair.baseAsset);",
    "setInternalSymbol(pair.baseAsset);\nsetSelectedSymbol(`${pair.baseAsset}USDT`);"
);

fs.writeFileSync('src/pages/SpotTrading.tsx', code);
