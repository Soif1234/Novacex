const fs = require('fs');
let code = fs.readFileSync('src/pages/SpotTrading.tsx', 'utf8');

code = code.replace(
    "setInternalSymbol(m.baseAsset);",
    "setSelectedSymbol(`${m.baseAsset}USDT`);"
);

fs.writeFileSync('src/pages/SpotTrading.tsx', code);
