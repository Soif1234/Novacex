const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// Add import
if (!code.includes("import { futuresFundingService }")) {
    code = code.replace(
        "import { futuresPositionService } from '../services/futures/FuturesPositionService';",
        "import { futuresPositionService } from '../services/futures/FuturesPositionService';\nimport { futuresFundingService } from '../services/futures/FuturesFundingService';"
    );
}

// Add state for nextFundingTime
if (!code.includes("const [nextFundingStr, setNextFundingStr] = useState(")) {
    code = code.replace(
        "const [orders, setOrders] = useState<any[]>([]);",
        "const [orders, setOrders] = useState<any[]>([]);\n  const [nextFundingStr, setNextFundingStr] = useState<string>('');\n  const [fundingRate, setFundingRate] = useState<string>(futuresFundingService.getFundingRate());"
    );
}

// Add effect for countdown
if (!code.includes("const updateCountdown = () => {")) {
    code = code.replace(
        "const [showPairs, setShowPairs] = useState(false);",
        `const [showPairs, setShowPairs] = useState(false);

  useEffect(() => {
    const updateCountdown = () => {
      const timeUntil = futuresFundingService.getTimeUntilNextFunding();
      if (timeUntil <= 0) {
         setNextFundingStr('00:00:00');
         futuresFundingService.settleFunding(futuresOrderService.getPositions('test-acc'), {});
      } else {
         const h = Math.floor(timeUntil / (1000 * 60 * 60)).toString().padStart(2, '0');
         const m = Math.floor((timeUntil % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
         const s = Math.floor((timeUntil % (1000 * 60)) / 1000).toString().padStart(2, '0');
         setNextFundingStr(\`\${h}:\${m}:\${s}\`);
      }
    };
    
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    
    const unsub = futuresFundingService.subscribe(() => {
       setFundingRate(futuresFundingService.getFundingRate());
    });
    
    return () => {
       clearInterval(interval);
       unsub();
    };
  }, []);`
    );
}

// Add stats to header
const oldStats = `<div className="text-gray-500">24h Vol</div>
            <div className="text-gray-300">{parseFloat(market.volume24h).toLocaleString(undefined, { maximumFractionDigits: 0 })} {market.baseAsset}</div>
          </div>`;
          
const newStats = `<div className="text-gray-500">24h Vol</div>
            <div className="text-gray-300">{parseFloat(market.volume24h).toLocaleString(undefined, { maximumFractionDigits: 0 })} {market.baseAsset}</div>
            <div className="text-gray-500 text-yellow-500/80">Funding / Next</div>
            <div className="text-gray-300 text-yellow-500/80">
               {Number(fundingRate) > 0 ? '+' : ''}{(Number(fundingRate) * 100).toFixed(4)}% / {nextFundingStr}
            </div>
          </div>`;

code = code.replace(oldStats, newStats);

// Add estimated funding to Position Row
const oldRiskStatus = `<th className="pb-3 font-medium">Risk Status</th>
                    <th className="pb-3 font-medium">Unrealized PNL (ROE%)</th>`;
const newRiskStatus = `<th className="pb-3 font-medium">Risk Status</th>
                    <th className="pb-3 font-medium text-yellow-500/80">Est. Funding</th>
                    <th className="pb-3 font-medium">Unrealized PNL (ROE%)</th>`;

if (!code.includes("Est. Funding")) {
    code = code.replace(oldRiskStatus, newRiskStatus);
    
    const riskStatusCellEnd = `</div>
                        </td>
                        <td className={"py-3 font-medium " + upnlColor}>`;
                        
    const newRiskStatusCellEnd = `</div>
                        </td>
                        <td className="py-3 text-yellow-500/80">
                           {Number(futuresFundingService.calculateEstimatedFunding(pos, pos.markPrice)).toFixed(4)}
                        </td>
                        <td className={"py-3 font-medium " + upnlColor}>`;
                        
    code = code.replace(riskStatusCellEnd, newRiskStatusCellEnd);
}

fs.writeFileSync('src/pages/Futures.tsx', code);
