const fs = require('fs');

let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

content = content.replace(`useState<'positions' | 'open' | 'history'>('positions');`, `useState<'positions' | 'open' | 'history' | 'funding' | 'fees'>('positions');`);

content = content.replace(`            <button 
              onClick={() => setHistoryTab('funding')}
              className={\`pb-2 \${historyTab === 'funding' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Funding History
            </button>`, `            <button 
              onClick={() => setHistoryTab('funding')}
              className={\`pb-2 \${historyTab === 'funding' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Funding History
            </button>
            <button 
              onClick={() => setHistoryTab('fees')}
              className={\`pb-2 \${historyTab === 'fees' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Fee History
            </button>`);

content = content.replace(`        {historyTab === 'history' && (
          <div className="overflow-x-auto">`, `        {historyTab === 'fees' && (
          <div className="overflow-x-auto">
            {trades.filter(t => Number(t.fee) > 0).length > 0 ? (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 border-b border-gray-800">
                  <tr>
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Symbol</th>
                    <th className="pb-3 font-medium">Order / Trade</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Exec Price</th>
                    <th className="pb-3 font-medium">Exec Qty</th>
                    <th className="pb-3 font-medium">Fee Rate</th>
                    <th className="pb-3 font-medium text-right text-red-400">Fee Amount (DEMO)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {trades.filter(t => Number(t.fee) > 0).sort((a, b) => b.timestamp - a.timestamp).map(trade => (
                    <tr key={trade.id} className="hover:bg-gray-800/50">
                      <td className="py-3 text-gray-300">{new Date(trade.timestamp).toLocaleString()}</td>
                      <td className="py-3 font-medium">{trade.symbol}</td>
                      <td className="py-3 text-gray-300 text-xs">
                        O: {trade.orderId}<br/>
                        T: {trade.id}
                      </td>
                      <td className="py-3 text-gray-300">{trade.feeType || 'TAKER'}</td>
                      <td className="py-3 text-gray-300">{Number(trade.price).toFixed(2)}</td>
                      <td className="py-3 text-gray-300">{trade.quantity}</td>
                      <td className="py-3 text-gray-300">{trade.feeRate ? (Number(trade.feeRate) * 100).toFixed(3) + '%' : '0.050%'}</td>
                      <td className="py-3 text-right text-red-400">-{Number(trade.fee).toFixed(4)} {trade.feeAsset}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-center text-gray-500 py-8">No fee history found</div>
            )}
          </div>
        )}

        {historyTab === 'history' && (
          <div className="overflow-x-auto">`);

fs.writeFileSync('src/pages/Futures.tsx', content);
