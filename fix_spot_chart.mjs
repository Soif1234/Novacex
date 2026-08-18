import fs from 'fs';

const p = 'src/pages/SpotTrading.tsx';
let code = fs.readFileSync(p, 'utf-8');

// Import FuturesChart
if (!code.includes("import { FuturesChart }")) {
  code = code.replace("import { PriceAlertModal } from '../components/alerts/PriceAlertModal';", "import { PriceAlertModal } from '../components/alerts/PriceAlertModal';\nimport { FuturesChart } from '../components/futures/FuturesChart';");
}

// Remove recharts import
code = code.replace("import { ResponsiveContainer, AreaChart, Area, YAxis, Tooltip } from 'recharts';", "");

// The chart logic is in a div after "Chart Section". We can replace the whole div.
// Note: It uses <AreaChart data={chartData}>
const chartSectionRegex = /<div className="w-full h-\[180px\] bg-gray-950 border-b border-gray-900 p-2">[\s\S]*?<\/ResponsiveContainer>\s*<\/div>/;

code = code.replace(chartSectionRegex, `<div className="w-full h-[250px] bg-gray-950 border-b border-gray-900 flex-shrink-0">
        <FuturesChart market={currentMarket!} />
      </div>`);

fs.writeFileSync(p, code);
console.log("Updated SpotTrading.tsx chart");
