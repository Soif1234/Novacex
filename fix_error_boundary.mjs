import fs from 'fs';

const p = 'src/components/ErrorBoundary.tsx';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace("export class ErrorBoundary extends Component<Props, State> {", "export class ErrorBoundary extends React.Component<Props, State> {\n  public state: State = { hasError: false };");

fs.writeFileSync(p, code);
console.log("Fixed ErrorBoundary");
