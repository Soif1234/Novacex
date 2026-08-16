const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// I also need an effect that runs when leverage, price or avail margin changes to recalculate quantity if slider > 0.
const newEffect = `
  useEffect(() => {
    // If the slider is actively controlling the quantity, re-calculate when inputs change.
    if (sliderPercentage > 0) {
       const activePrice = parseFloat((orderType === 'LIMIT' && priceInput) ? priceInput : market?.lastPrice || '0');
       if (activePrice > 0) {
           const allocatedMargin = availMargin * (sliderPercentage / 100);
           const targetNotional = allocatedMargin * leverage;
           const qty = targetNotional / activePrice;
           setQuantityInput(parseFloat(qty.toFixed(market?.quantityPrecision || 3)).toString());
       }
    }
  }, [sliderPercentage, leverage, availMargin, priceInput, orderType, market]);
`;

code = code.replace(
  "  useEffect(() => {\n    setPriceInput('');\n    setQuantityInput('');\n  }, [selectedSymbol, orderType]);",
  "  useEffect(() => {\n    setPriceInput('');\n    setQuantityInput('');\n    setSliderPercentage(0);\n  }, [selectedSymbol, orderType]);\n" + newEffect
);

fs.writeFileSync('src/pages/Futures.tsx', code);
