import fs from 'fs';

const p = 'src/pages/Assets.tsx';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace("await demoTransactionService.createDeposit(userId, asset, amount);", "await demoTransactionService.createDeposit(asset, amount);");
code = code.replace("await demoTransactionService.createWithdrawal(userId, asset, address, amount);", "await demoTransactionService.createWithdrawal(asset, address, amount);");

fs.writeFileSync(p, code);
console.log("Fixed Assets.tsx");
