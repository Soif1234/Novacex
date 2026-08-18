import fs from 'fs';

const p = 'src/services/market/TradingPairRegistry.ts';
let code = fs.readFileSync(p, 'utf-8');

// I will remove the commonNames and name definition from where it is, and put it at the very start of the forEach.
code = code.replace(/const commonNames: Record<string, string> = \{[\s\S]*?const name = commonNames\[info\.baseAsset\] \|\| info\.baseAsset;/g, '');

const insertion = `
        const commonNames: Record<string, string> = {
          'BTC': 'Bitcoin', 'ETH': 'Ethereum', 'SOL': 'Solana', 'XRP': 'Ripple', 
          'DOGE': 'Dogecoin', 'ADA': 'Cardano', 'AVAX': 'Avalanche', 'LINK': 'Chainlink',
          'DOT': 'Polkadot', 'MATIC': 'Polygon', 'SHIB': 'Shiba Inu', 'LTC': 'Litecoin',
          'BCH': 'Bitcoin Cash', 'ATOM': 'Cosmos', 'UNI': 'Uniswap', 'XLM': 'Stellar',
          'NEAR': 'NEAR Protocol', 'APT': 'Aptos', 'ARB': 'Arbitrum', 'OP': 'Optimism',
          'FIL': 'Filecoin', 'INJ': 'Injective', 'LDO': 'Lido DAO', 'RNDR': 'Render',
          'STX': 'Stacks', 'IMX': 'Immutable', 'VET': 'VeChain', 'GRT': 'The Graph',
          'SNX': 'Synthetix', 'AAVE': 'Aave', 'MKR': 'Maker', 'ALGO': 'Algorand',
          'FTM': 'Fantom', 'SAND': 'The Sandbox', 'MANA': 'Decentraland', 'EGLD': 'MultiversX',
          'THETA': 'Theta Network', 'AXS': 'Axie Infinity', 'QNT': 'Quant', 'GALA': 'Gala'
        };
        const name = commonNames[info.baseAsset] || info.baseAsset;
`;

code = code.replace("t => {", "t => {" + insertion);
fs.writeFileSync(p, code);
console.log("Fixed TradingPairRegistry");
