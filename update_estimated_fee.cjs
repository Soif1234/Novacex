const fs = require('fs');

let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

content = content.replace(`  const calculatedMargin = activePrice > 0 && parseFloat(quantityInput || '0') > 0
    ? (parseFloat(quantityInput) * activePrice) / leverage
    : 0;`, `  const calculatedMargin = activePrice > 0 && parseFloat(quantityInput || '0') > 0
    ? (parseFloat(quantityInput) * activePrice) / leverage
    : 0;
  
  const estimatedFeeResult = (parseFloat(quantityInput || '0') > 0 && activePrice > 0)
    ? futuresFeeService.getEstimatedFee(quantityInput, activePrice.toString(), orderType)
    : null;`);

content = content.replace(`          <div className="flex justify-between text-[10px] text-gray-500 mb-4 font-medium">
            <span>Avail Margin</span>
            <span className="text-gray-200">{availMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
          </div>`, `          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Avail Margin</span>
            <span className="text-gray-200">{availMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Position Notional</span>
            <span className="text-gray-200">{estimatedFeeResult ? Number(estimatedFeeResult.notional).toFixed(2) : '0.00'} USDT</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-4 font-medium">
            <span>Est. Trading Fee (DEMO)</span>
            <span className="text-gray-200">{estimatedFeeResult ? Number(estimatedFeeResult.feeAmount).toFixed(4) : '0.0000'} USDT ({estimatedFeeResult?.feeType === 'MAKER' ? 'Maker' : 'Taker'})</span>
          </div>`);

fs.writeFileSync('src/pages/Futures.tsx', content);
