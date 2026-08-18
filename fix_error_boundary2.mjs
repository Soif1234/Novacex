import fs from 'fs';

const p = 'src/components/ErrorBoundary.tsx';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace("public state: State = { hasError: false };", "public state: State = { hasError: false };\n  public declare props: Props;");

fs.writeFileSync(p, code);
console.log("Fixed ErrorBoundary 2");
