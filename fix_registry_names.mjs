import fs from 'fs';

const code = fs.readFileSync('src/services/market/TradingPairRegistry.ts', 'utf-8');

const updatedCode = code.replace(
  'export interface TradingPair {',
  'export interface TradingPair {\n  name?: string;'
).replace(
  'const spotPair: TradingPair = {',
  `const commonNames: Record<string, string> = {
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
        
        const spotPair: TradingPair = {`
).replace(
  'categories: [\'USDT\']\n        };',
  'categories: [\'USDT\'], name\n        };'
).replace(
  'categories: [\'USDT\']\n        };',
  'categories: [\'USDT\'], name\n        };'
);

fs.writeFileSync('src/services/market/TradingPairRegistry.ts', updatedCode);
console.log("Updated TradingPairRegistry.ts with names");
