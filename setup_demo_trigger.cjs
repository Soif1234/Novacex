const fs = require('fs');

let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

if (!content.includes('checkTriggers(')) {
    // We need to periodically check triggers in the demo since it's client side
    content = content.replace(`  const [fundingRate, setFundingRate] = useState<string>(futuresFundingService.getFundingRate());`, `  const [fundingRate, setFundingRate] = useState<string>(futuresFundingService.getFundingRate());
  
  // Demo TP/SL checker loop
  useEffect(() => {
    const interval = setInterval(() => {
        const markPrices: Record<string, string> = {};
        markets.forEach(m => {
            markPrices[m.symbol] = m.markPrice;
        });
        futuresTpSlService.checkTriggers(
            positions,
            markPrices,
            async (order, price) => {
                await futuresOrderService.placeOrder(order);
                const updatedPositions = futuresOrderService.getPositions('demo-account');
                setPositions(updatedPositions);
            }
        );
    }, 1000);
    return () => clearInterval(interval);
  }, [positions, markets]);`);
    fs.writeFileSync('src/pages/Futures.tsx', content);
}
