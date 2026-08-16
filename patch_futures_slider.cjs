const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// I will insert state variables for slider percentage.
if (!code.includes("const [sliderPercentage, setSliderPercentage]")) {
  code = code.replace(
    "const [quantityInput, setQuantityInput] = useState('');",
    `const [quantityInput, setQuantityInput] = useState('');
  const [sliderPercentage, setSliderPercentage] = useState(0);`
  );
}

// Ensure the effect for updating quantity runs when dependencies change
if (!code.includes("useEffect(() => { // Slider recalculation")) {
  const effectCode = `
  useEffect(() => { // Slider recalculation
    const priceStr = orderType === 'LIMIT' && priceInput ? priceInput : market?.lastPrice;
    const price = parseFloat(priceStr || '0');
    if (price <= 0 || !market) return;
    
    // Total margin allocated based on percentage
    const targetMargin = availMargin * (sliderPercentage / 100);
    // Position Notional = targetMargin * leverage
    const positionNotional = targetMargin * leverage;
    
    // BTC quantity = Position Notional / price
    const qty = positionNotional / price;
    
    // We only want to set quantity if slider is actively driving it,
    // but React's state model implies if we set slider to X, we force quantity.
    // If slider > 0, calculate and set it. (If slider == 0, we can zero out qty or leave user input alone, let's zero it).
    if (sliderPercentage >= 0) {
      if (sliderPercentage === 0 && quantityInput !== '') {
          // don't overwrite user manual input immediately with 0 if they type, but this is a slider effect.
          // Wait, better approach is a manual handler for the slider.
      }
    }
  }, [sliderPercentage, leverage, availMargin, priceInput, orderType, market]);
  `;
  // Actually, standard hook pattern: better to just calculate dynamically or use a handler. 
}

// Let's create a robust calculation block within the component body.
const calcBlock = `
  const activePrice = parseFloat((orderType === 'LIMIT' && priceInput) ? priceInput : market.lastPrice || '0');
  const maxNotional = availMargin * leverage;
  const maxQuantity = activePrice > 0 ? maxNotional / activePrice : 0;
  
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setSliderPercentage(val);
    if (val === 0) {
       setQuantityInput('');
       return;
    }
    const allocatedMargin = availMargin * (val / 100);
    const targetNotional = allocatedMargin * leverage;
    if (activePrice > 0) {
       const qty = targetNotional / activePrice;
       // Format to precision but strip trailing zeros dynamically
       let qtyStr = qty.toFixed(market.quantityPrecision);
       // Remove trailing zeros and dot if needed (or just use parseFloat to string)
       setQuantityInput(parseFloat(qtyStr).toString());
    }
  };
  
  const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
     setQuantityInput(e.target.value);
     const qty = parseFloat(e.target.value);
     if (qty > 0 && maxQuantity > 0) {
        let pct = (qty / maxQuantity) * 100;
        if (pct > 100) pct = 100;
        setSliderPercentage(Math.round(pct));
     } else {
        setSliderPercentage(0);
     }
  };

  const calculatedMargin = activePrice > 0 && parseFloat(quantityInput || '0') > 0
    ? (parseFloat(quantityInput) * activePrice) / leverage
    : 0;
`;

// Insert the calculation block before handleAction
code = code.replace("  const handleAction = async () => {", calcBlock + "\n  const handleAction = async () => {");

// Now update the UI.
const oldQtyInput = `          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex items-center px-3 py-2 mb-4">
            <input 
              type="number" 
              className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
              placeholder={\`Quantity\`}
              value={quantityInput}
              onChange={e => setQuantityInput(e.target.value)}
            />
            <span className="text-gray-500 text-xs font-medium">{market.baseAsset}</span>
          </div>`;

const newQtyInputAndSlider = `          <div className="bg-gray-900 border border-gray-800 focus-within:border-gray-600 transition-colors rounded-lg flex flex-col px-3 py-2 mb-2">
            <div className="flex items-center">
                <input 
                  type="number" 
                  className="bg-transparent flex-1 w-full text-gray-100 text-sm font-bold focus:outline-none"
                  placeholder={\`Quantity\`}
                  value={quantityInput}
                  onChange={handleQuantityChange}
                />
                <span className="text-gray-500 text-xs font-medium">{market.baseAsset}</span>
            </div>
            <div className="flex items-center mt-2 border-t border-gray-800 pt-2">
                <span className="text-gray-400 text-xs flex-1">Amount</span>
                <span className="text-gray-200 text-sm font-bold">{calculatedMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span className="text-gray-500 text-xs font-medium ml-1">USDT</span>
            </div>
          </div>
          
          <div className="px-2 mb-4 relative mt-3">
             <input 
                type="range" 
                min="0" max="100" step="1"
                value={sliderPercentage}
                onChange={handleSliderChange}
                className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
             />
             <div className="flex justify-between text-[9px] text-gray-500 font-bold mt-1">
                 <span className={sliderPercentage >= 0 ? "text-blue-500" : ""}>0%</span>
                 <span className={sliderPercentage >= 25 ? "text-blue-500" : ""}>25%</span>
                 <span className={sliderPercentage >= 50 ? "text-blue-500" : ""}>50%</span>
                 <span className={sliderPercentage >= 75 ? "text-blue-500" : ""}>75%</span>
                 <span className={sliderPercentage >= 100 ? "text-blue-500" : ""}>100%</span>
             </div>
          </div>
          
          <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-medium">
            <span>Max Qty</span>
            <span className="text-gray-300">{maxQuantity.toLocaleString(undefined, { maximumFractionDigits: market.quantityPrecision })} {market.baseAsset}</span>
          </div>`;

code = code.replace(oldQtyInput, newQtyInputAndSlider);

fs.writeFileSync('src/pages/Futures.tsx', code);
