const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// Add states for closing UI
if (!code.includes("const [closingPositionId, setClosingPositionId] = useState")) {
  code = code.replace(
    "const [historyTab, setHistoryTab] = useState",
    `const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [closeType, setCloseType] = useState<'MARKET'|'LIMIT'>('MARKET');
  const [closePrice, setClosePrice] = useState('');
  const [closeQuantity, setCloseQuantity] = useState('');\n  const [historyTab, setHistoryTab] = useState`
  );
}

// Add state for orders
if (!code.includes("const [orders, setOrders] = useState<FuturesOrder[]>([]);")) {
  code = code.replace(
    "const [positions, setPositions] = useState<any[]>([]);",
    "const [positions, setPositions] = useState<any[]>([]);\n  const [orders, setOrders] = useState<any[]>([]);"
  );
  code = code.replace(
    "setPositions(futuresOrderService.getPositions('test-acc'));",
    "setPositions(futuresOrderService.getPositions('test-acc'));\n      setOrders(futuresOrderService.getOrders('test-acc'));"
  );
}

// Implement historyTab logic
const openOrdersTable = `        {historyTab === 'open' && (
          <div className="overflow-x-auto">
            {orders.filter(o => o.status === 'PENDING').length > 0 ? (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 border-b border-gray-800">
                  <tr>
                    <th className="pb-3 font-medium">Pair</th>
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Side</th>
                    <th className="pb-3 font-medium">Price</th>
                    <th className="pb-3 font-medium">Amount</th>
                    <th className="pb-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {orders.filter(o => o.status === 'PENDING').map(order => (
                    <tr key={order.id} className="hover:bg-gray-800/50">
                      <td className="py-3 font-medium text-white">{order.symbol}</td>
                      <td className="py-3 text-gray-400">{new Date(order.createdAt).toLocaleString()}</td>
                      <td className="py-3 text-gray-300">
                        {order.type} {order.reduceOnly ? <span className="text-xs bg-yellow-900/50 text-yellow-500 px-1 rounded ml-1">Reduce-Only</span> : ''}
                      </td>
                      <td className="py-3">
                        <span className={order.side === 'BUY' ? 'text-green-500 font-bold' : 'text-red-500 font-bold'}>{order.side}</span>
                      </td>
                      <td className="py-3 text-gray-300">{order.price || 'Market'}</td>
                      <td className="py-3 text-gray-300">{order.quantity}</td>
                      <td className="py-3 text-right">
                        <Button variant="secondary" size="sm" onClick={() => futuresOrderService.cancelOrder(order.id)}>Cancel</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-8 flex flex-col items-center justify-center text-gray-500">
                 <p className="text-sm">No open orders</p>
              </div>
            )}
          </div>
        )}
        
        {historyTab === 'history' && (
          <div className="overflow-x-auto">
            {orders.filter(o => o.status !== 'PENDING').length > 0 ? (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 border-b border-gray-800">
                  <tr>
                    <th className="pb-3 font-medium">Pair</th>
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Side</th>
                    <th className="pb-3 font-medium">Price</th>
                    <th className="pb-3 font-medium">Amount</th>
                    <th className="pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {orders.filter(o => o.status !== 'PENDING').sort((a,b) => b.createdAt - a.createdAt).map(order => (
                    <tr key={order.id} className="hover:bg-gray-800/50">
                      <td className="py-3 font-medium text-white">{order.symbol}</td>
                      <td className="py-3 text-gray-400">{new Date(order.createdAt).toLocaleString()}</td>
                      <td className="py-3 text-gray-300">
                        {order.type} {order.reduceOnly ? <span className="text-xs bg-yellow-900/50 text-yellow-500 px-1 rounded ml-1">Reduce-Only</span> : ''}
                      </td>
                      <td className="py-3">
                        <span className={order.side === 'BUY' ? 'text-green-500 font-bold' : 'text-red-500 font-bold'}>{order.side}</span>
                      </td>
                      <td className="py-3 text-gray-300">{order.price || 'Market'}</td>
                      <td className="py-3 text-gray-300">{order.quantity}</td>
                      <td className="py-3">
                        <span className={
                          order.status === 'FILLED' ? 'text-green-500' : 
                          order.status === 'CANCELLED' ? 'text-gray-500' : 
                          'text-red-500'
                        }>{order.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-8 flex flex-col items-center justify-center text-gray-500">
                 <p className="text-sm">No order history</p>
              </div>
            )}
          </div>
        )}`;

code = code.replace(
  "      </div>\n    </div>\n  );\n}",
  openOrdersTable + "\n      </div>\n    </div>\n  );\n}"
);

// Replace Open Orders count
code = code.replace(
  "Open Orders (0)",
  "Open Orders ({orders.filter(o => o.status === 'PENDING').length})"
);

// We need to implement the Close UI in the row
const rowEnd = `                        <td className="py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="secondary" size="sm" onClick={() => handleClosePosition(pos, (Number(pos.quantity) / 2).toString())}>Close 50%</Button>
                            <Button variant="secondary" size="sm" onClick={() => handleClosePosition(pos, pos.quantity)}>Close All</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>`;

const newRowEnd = `                        <td className="py-3 text-right">
                          {closingPositionId === pos.positionId ? (
                             <Button variant="secondary" size="sm" onClick={() => setClosingPositionId(null)}>Cancel</Button>
                          ) : (
                             <Button variant="secondary" size="sm" onClick={() => {
                                 setClosingPositionId(pos.positionId);
                                 setCloseQuantity(pos.quantity);
                                 setClosePrice(pos.markPrice);
                                 setCloseType('LIMIT');
                             }}>Close</Button>
                          )}
                        </td>
                      </tr>
                      {closingPositionId === pos.positionId && (
                        <tr className="bg-gray-900/50">
                           <td colSpan={11} className="py-4 px-4">
                              <div className="flex items-end gap-4 max-w-3xl">
                                  <div className="flex flex-col gap-1 w-32">
                                     <label className="text-xs text-gray-400">Type</label>
                                     <select 
                                        className="bg-gray-800 border border-gray-700 rounded p-1.5 text-sm text-white focus:outline-none"
                                        value={closeType}
                                        onChange={e => setCloseType(e.target.value as 'MARKET'|'LIMIT')}
                                     >
                                        <option value="LIMIT">Limit</option>
                                        <option value="MARKET">Market</option>
                                     </select>
                                  </div>
                                  
                                  {closeType === 'LIMIT' && (
                                     <div className="flex flex-col gap-1 w-32">
                                        <label className="text-xs text-gray-400">Price (USDT)</label>
                                        <input 
                                           type="number"
                                           className="bg-gray-800 border border-gray-700 rounded p-1.5 text-sm text-white focus:outline-none"
                                           value={closePrice}
                                           onChange={e => setClosePrice(e.target.value)}
                                        />
                                     </div>
                                  )}
                                  
                                  <div className="flex flex-col gap-1 w-32">
                                     <label className="text-xs text-gray-400">Quantity ({pos.symbol.replace('USDT','')})</label>
                                     <input 
                                        type="number"
                                        className="bg-gray-800 border border-gray-700 rounded p-1.5 text-sm text-white focus:outline-none"
                                        value={closeQuantity}
                                        onChange={e => {
                                            const val = e.target.value;
                                            if (Number(val) > Number(pos.quantity)) {
                                                setCloseQuantity(pos.quantity);
                                            } else {
                                                setCloseQuantity(val);
                                            }
                                        }}
                                        max={pos.quantity}
                                     />
                                  </div>
                                  
                                  <div className="flex items-center gap-1 pb-1">
                                      <button className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-400 hover:text-white" onClick={() => setCloseQuantity((Number(pos.quantity) * 0.25).toString())}>25%</button>
                                      <button className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-400 hover:text-white" onClick={() => setCloseQuantity((Number(pos.quantity) * 0.50).toString())}>50%</button>
                                      <button className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-400 hover:text-white" onClick={() => setCloseQuantity((Number(pos.quantity) * 0.75).toString())}>75%</button>
                                      <button className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-400 hover:text-white" onClick={() => setCloseQuantity(pos.quantity)}>100%</button>
                                  </div>

                                  <div className="ml-auto flex flex-col gap-1 justify-end">
                                      <Button 
                                          variant="primary" 
                                          className="bg-red-500 hover:bg-red-600 text-white border-none py-1.5 px-6"
                                          onClick={() => {
                                              const qty = Number(closeQuantity);
                                              if (qty <= 0) return alert('Quantity must be greater than 0');
                                              
                                              futuresOrderService.placeOrder({
                                                  accountId: 'test-acc',
                                                  symbol: pos.symbol,
                                                  side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                                                  positionSide: pos.side,
                                                  type: closeType,
                                                  price: closeType === 'LIMIT' ? closePrice : undefined,
                                                  quantity: closeQuantity,
                                                  leverage: pos.leverage,
                                                  marginMode: pos.marginMode,
                                                  reduceOnly: true,
                                                  closePosition: true
                                              }).then(() => {
                                                  setClosingPositionId(null);
                                              }).catch(e => {
                                                  alert(e.message || 'Failed to close position');
                                              });
                                          }}
                                      >
                                          Close Position
                                      </Button>
                                  </div>
                              </div>
                           </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>`;

// Notice the Fragment wrapper needs to be added, as map returns tr currently.
code = code.replace(
  "return (\n                      <tr key={pos.positionId}",
  "return (\n                    <React.Fragment key={pos.positionId}>\n                      <tr"
);
code = code.replace(rowEnd, newRowEnd);

fs.writeFileSync('src/pages/Futures.tsx', code);
