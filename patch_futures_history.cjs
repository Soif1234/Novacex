const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

if (!code.includes("historyTab === 'funding'")) {
    // Add tab button
    const oldTabs = `<button 
              onClick={() => setHistoryTab('history')}
              className={\`pb-2 \${historyTab === 'history' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Order History
            </button>
          </div>`;
          
    const newTabs = `<button 
              onClick={() => setHistoryTab('history')}
              className={\`pb-2 \${historyTab === 'history' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Order History
            </button>
            <button 
              onClick={() => setHistoryTab('funding')}
              className={\`pb-2 \${historyTab === 'funding' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}\`}
            >
              Funding History
            </button>
          </div>`;
          
    code = code.replace(oldTabs, newTabs);
    
    // Add tab content
    const contentToInsert = `
        {historyTab === 'funding' && (
          <div className="overflow-x-auto">
            {futuresFundingService.getHistory('test-acc').length > 0 ? (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 border-b border-gray-800">
                  <tr>
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Pair</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Funding Rate</th>
                    <th className="pb-3 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {futuresFundingService.getHistory('test-acc').sort((a,b) => b.timestamp - a.timestamp).map(hist => (
                    <tr key={hist.id + hist.positionId} className="hover:bg-gray-800/50">
                      <td className="py-3 text-gray-400">{new Date(hist.timestamp).toLocaleString()}</td>
                      <td className="py-3 font-medium text-white">{hist.symbol}</td>
                      <td className="py-3 text-gray-300">{hist.payerReceiver === 'PAYER' ? 'Paid' : 'Received'}</td>
                      <td className="py-3 text-gray-300">{(Number(hist.fundingRate) * 100).toFixed(4)}%</td>
                      <td className={\`py-3 font-bold \${hist.payerReceiver === 'PAYER' ? 'text-red-500' : 'text-green-500'}\`}>
                        {hist.payerReceiver === 'PAYER' ? '-' : '+'}{Number(hist.fundingAmount).toFixed(4)} USDT
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-gray-500">
                <p className="text-sm">No funding history</p>
              </div>
            )}
          </div>
        )}`;
        
    const lastTabEnd = `              </div>
            )}
          </div>
        )}`;
    const newLastTabEnd = `              </div>
            )}
          </div>
        )}
${contentToInsert}`;
    
    code = code.replace(lastTabEnd, newLastTabEnd);
    fs.writeFileSync('src/pages/Futures.tsx', code);
}
