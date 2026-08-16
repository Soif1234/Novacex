const fs = require('fs');
let code = fs.readFileSync('src/types/futures.ts', 'utf8');

if (!code.includes('filledQuantity?: string;')) {
    code = code.replace(
        'quantity: string;',
        'quantity: string;\n  filledQuantity?: string;\n  remainingQuantity?: string;'
    );
    fs.writeFileSync('src/types/futures.ts', code);
}
