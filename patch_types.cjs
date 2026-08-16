const fs = require('fs');
let code = fs.readFileSync('src/types/futures.ts', 'utf8');

if (!code.includes('reduceOnly?: boolean;')) {
    code = code.replace(
        'type: FuturesOrderType;',
        'type: FuturesOrderType;\n  reduceOnly?: boolean;\n  closePosition?: boolean;'
    );
    fs.writeFileSync('src/types/futures.ts', code);
}
