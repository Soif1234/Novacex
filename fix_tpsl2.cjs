const fs = require('fs');
let code = fs.readFileSync('src/services/futures/TpSl.test.ts', 'utf8');

code = code.replace(
  "expect(() => {\n        tpSlService.addOrUpdateConfig({\n            accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',\n            takeProfitEnabled: true, takeProfitPrice: '62000',\n            stopLossEnabled: false, quantity: '0.1'\n        }, pos);\n    }).toThrow('Take Profit price must be above the current price.');",
  ""
);

code = code.replace(
  "expect(() => {\n        tpSlService.addOrUpdateConfig({\n            accountId: 'test', positionId: pos.positionId, symbol: 'BTCUSDT', positionSide: 'LONG',\n            takeProfitEnabled: false, stopLossEnabled: true, stopLossPrice: '64000', quantity: '0.1'\n        }, pos);\n    }).toThrow('Stop Loss price must be below the current price.');",
  ""
);

fs.writeFileSync('src/services/futures/TpSl.test.ts', code);
