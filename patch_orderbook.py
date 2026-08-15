import re

with open('src/pages/SpotTrading.tsx', 'r', newline='') as f:
    content = f.read()

# Replace asks
content = re.sub(
    r'\{\[\.\.\.Array\(6\)\].map\(\(_, i\) => \{.*?\n\s+const askPrice = .*?return \(\s*<div.*?\n\s*key=\{`ask-\$\{i\}`\}.*?\n.*?<div.*?Math\.random\(\).*?\n.*?<span.*?askPrice\.toLocaleString.*?\n.*?<span.*?Math\.random\(\).*?</div>\s*\)\}\)\}',
    r'''{orderBook.asks.map((ask, i) => (
            <div 
              key={`ask-${i}`} 
              className="flex justify-between relative text-red-500 py-[2px] cursor-pointer hover:bg-gray-900/50"
              onClick={() => { if (orderType === 'LIMIT') setPriceInput(ask.price.toFixed(4)); }}
            >
              <div className="absolute right-0 top-0 bottom-0 bg-red-500/10 z-0" style={{ width: `${(ask.total / maxTotal) * 100}%` }}></div>
              <span className="z-10 relative font-bold">{ask.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
              <span className="text-gray-300 z-10 relative">{ask.quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
            </div>
          ))}''',
    content,
    flags=re.DOTALL
)

# Replace bids
content = re.sub(
    r'\{\[\.\.\.Array\(6\)\].map\(\(_, i\) => \{.*?\n\s+const bidPrice = .*?return \(\s*<div.*?\n\s*key=\{`bid-\$\{i\}`\}.*?\n.*?<div.*?Math\.random\(\).*?\n.*?<span.*?bidPrice\.toLocaleString.*?\n.*?<span.*?Math\.random\(\).*?</div>\s*\)\}\)\}',
    r'''{orderBook.bids.map((bid, i) => (
            <div 
              key={`bid-${i}`} 
              className="flex justify-between relative text-emerald-500 py-[2px] cursor-pointer hover:bg-gray-900/50"
              onClick={() => { if (orderType === 'LIMIT') setPriceInput(bid.price.toFixed(4)); }}
            >
              <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 z-0" style={{ width: `${(bid.total / maxTotal) * 100}%` }}></div>
              <span className="z-10 relative font-bold">{bid.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
              <span className="text-gray-300 z-10 relative">{bid.quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
            </div>
          ))}''',
    content,
    flags=re.DOTALL
)

content = re.sub(
    r'\{/\* Right Col: Order Book \*/\}\s*<div className="w-\[40%\] flex flex-col text-\[11px\] font-medium">\s*<div className="flex justify-between text-gray-500 mb-2 font-medium">',
    r'''{/* Right Col: Order Book */}
      <div className="w-[40%] flex flex-col text-[11px] font-medium relative">
        <div className="absolute top-0 right-0 p-1 opacity-50 z-10 pointer-events-none mt-[-24px]">
          <div className="text-[9px] font-bold text-blue-400 px-1 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 shadow-sm">
            DEMO BOOK
          </div>
        </div>
        <div className="flex justify-between text-gray-500 mb-2 font-medium">''',
    content
)

with open('src/pages/SpotTrading.tsx', 'w', newline='') as f:
    f.write(content)
print("Regex replace applied")
