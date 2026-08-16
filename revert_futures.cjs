const fs = require('fs');

let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

// Remove FuturesActivityCenter import
content = content.replace(/import \{ FuturesActivityCenter \} from '\.\.\/components\/futures\/history\/FuturesActivityCenter';\n/, '');

// Replace <FuturesActivityCenter accountId="test-acc" /> with the original JSX chunk
const replacement = `        <div className="px-4 mt-2">
          <div className="flex gap-4 border-b border-gray-900 mb-2">
            <button className={\`pb-2 text-xs font-bold \${historyTab === 'positions' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}\`} onClick={() => setHistoryTab('positions')}>Positions</button>
            <button className={\`pb-2 text-xs font-bold \${historyTab === 'open' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}\`} onClick={() => setHistoryTab('open')}>Open Orders</button>
            <button className={\`pb-2 text-xs font-bold \${historyTab === 'history' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}\`} onClick={() => setHistoryTab('history')}>Order History</button>
            <button className={\`pb-2 text-xs font-bold \${historyTab === 'funding' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}\`} onClick={() => setHistoryTab('funding')}>Funding</button>
            <button className={\`pb-2 text-xs font-bold \${historyTab === 'fees' ? 'text-white border-b-2 border-emerald-500' : 'text-gray-500'}\`} onClick={() => setHistoryTab('fees')}>Fees</button>
          </div>

          <div className="flex flex-col gap-2">
            {historyTab === 'positions' && positions.map(pos => (
              <div key={pos.positionId} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={\`font-bold text-sm \${pos.side === 'LONG' ? 'text-emerald-500' : 'text-red-500'}\`}>{pos.symbol}</span>
                    <span className={\`text-[10px] font-bold px-1 rounded \${pos.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-red-500/20 text-red-500'}\`}>{pos.side} {pos.leverage}x</span>
                  </div>
                  <span className="text-gray-400 text-xs">Margin: {parseFloat(pos.initialMargin).toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <div className="flex flex-col">
                    <span className="text-gray-500">Size</span>
                    <span className="text-gray-200">{pos.quantity}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-gray-500">Entry Price</span>
                    <span className="text-gray-200">{parseFloat(pos.entryPrice).toFixed(2)}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-gray-500">Mark Price</span>
                    <span className="text-gray-200">{parseFloat(pos.markPrice).toFixed(2)}</span>
                  </div>
                </div>
                <div className="flex justify-between items-center text-xs">
                   <div className="flex flex-col">
                      <span className="text-gray-500">Liq. Price</span>
                      <span className="text-orange-500">{parseFloat(pos.liquidationPrice).toFixed(2)}</span>
                   </div>
                   <div className="flex flex-col text-right">
                      <span className="text-gray-500">PNL (ROE%)</span>
                      <span className={parseFloat(pos.unrealizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                         {parseFloat(pos.unrealizedPnl).toFixed(2)} ({((parseFloat(pos.unrealizedPnl) / parseFloat(pos.initialMargin)) * 100).toFixed(2)}%)
                      </span>
                   </div>
                </div>
                <div className="flex justify-between items-center text-xs">
                   <div className="flex flex-col">
                      <span className="text-gray-500">Realized PNL</span>
                      <span className={parseFloat(pos.realizedPnl) >= 0 ? 'text-emerald-500' : 'text-red-500'}>{parseFloat(pos.realizedPnl).toFixed(2)}</span>
                   </div>
                   <div className="flex flex-col text-right">
                      <span className="text-gray-500">Cum. Fee / Funding</span>
                      <span className="text-gray-300">-{parseFloat(pos.cumulativeFee || '0').toFixed(4)} / {parseFloat(pos.cumulativeFunding || '0').toFixed(4)}</span>
                   </div>
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <Button size="sm" variant="outline" className="text-[10px] py-1 h-auto" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('ADD_MARGIN'); }}>Add Margin</Button>
                  <Button size="sm" variant="outline" className="text-[10px] py-1 h-auto" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('REMOVE_MARGIN'); }}>Rem Margin</Button>
                  <Button size="sm" className="text-[10px] py-1 h-auto bg-gray-700 hover:bg-gray-600" onClick={() => { setActionPositionId(pos.positionId); setPositionAction('CLOSE'); setCloseQuantity(pos.quantity); setClosePrice(market?.lastPrice || ''); }}>Close</Button>
                </div>
              </div>
            ))}
            
            {historyTab === 'open' && orders.filter(o => o.status === 'NEW' || o.status === 'PENDING').map(o => (
               <div key={o.id} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{o.symbol}</span>
                     <span>{o.side} {o.type}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Price: {o.price || 'Market'}</span>
                     <span>Qty: {o.quantity}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Status: {o.status}</span>
                     <Button size="sm" variant="outline" className="text-[10px] py-0 h-5" onClick={() => futuresOrderService.cancelOrder(o.accountId, o.id).then(() => setOrders(futuresOrderService.getOrders('test-acc')))}>Cancel</Button>
                  </div>
               </div>
            ))}

            {historyTab === 'history' && orders.filter(o => o.status !== 'NEW' && o.status !== 'PENDING').map(o => (
               <div key={o.id} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{o.symbol}</span>
                     <span>{o.side} {o.type}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Price: {o.price || 'Market'}</span>
                     <span>Qty: {o.quantity}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Status: {o.status}</span>
                     <span>{new Date(o.createdAt).toLocaleString()}</span>
                  </div>
               </div>
            ))}

            {historyTab === 'funding' && futuresFundingService.getHistory('test-acc').map(f => (
               <div key={f.id} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{f.symbol} {f.side}</span>
                     <span>Rate: {(parseFloat(f.fundingRate) * 100).toFixed(4)}%</span>
                  </div>
                  <div className="flex justify-between">
                     <span>{f.payerReceiver === 'RECEIVER' ? 'Received' : 'Paid'}</span>
                     <span className={f.payerReceiver === 'RECEIVER' ? 'text-emerald-500' : 'text-red-500'}>{parseFloat(f.fundingAmount).toFixed(4)} USDT</span>
                  </div>
               </div>
            ))}

            {historyTab === 'fees' && trades.filter(t => parseFloat(t.fee) > 0).map(t => (
               <div key={t.id + '_fee'} className="bg-gray-900 p-3 rounded-lg flex flex-col gap-2 border border-gray-800 text-xs text-gray-300">
                  <div className="flex justify-between">
                     <span className="font-bold text-white">{t.symbol}</span>
                     <span>Role: {t.feeType}</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Rate: {(parseFloat(t.feeRate) * 100).toFixed(4)}%</span>
                     <span className="text-red-400">-{parseFloat(t.fee).toFixed(4)} USDT</span>
                  </div>
               </div>
            ))}

          </div>
        </div>

      {actionPositionId && positionAction === 'CLOSE' && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl p-4 w-full max-w-sm border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-4">Close Position</h3>
            
            <div className="flex gap-2 mb-4">
              <Button size="sm" variant={closeType === 'MARKET' ? 'primary' : 'outline'} className="flex-1" onClick={() => setCloseType('MARKET')}>Market</Button>
              <Button size="sm" variant={closeType === 'LIMIT' ? 'primary' : 'outline'} className="flex-1" onClick={() => setCloseType('LIMIT')}>Limit</Button>
            </div>
            
            {closeType === 'LIMIT' && (
              <div className="mb-4">
                <label className="block text-xs text-gray-400 mb-1">Price</label>
                <input 
                  type="number" 
                  value={closePrice} 
                  onChange={e => setClosePrice(e.target.value)} 
                  className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
                />
              </div>
            )}
            
            <div className="mb-6">
              <label className="block text-xs text-gray-400 mb-1">Quantity</label>
              <input 
                type="number" 
                value={closeQuantity} 
                onChange={e => setCloseQuantity(e.target.value)} 
                className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
              />
            </div>
            
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setActionPositionId(null)}>Cancel</Button>
              <Button 
                className="flex-1 bg-emerald-600 hover:bg-emerald-500" 
                onClick={async () => {
                   const pos = positions.find(p => p.positionId === actionPositionId);
                   if (pos) {
                      if (closeType === 'MARKET') {
                         await handleClosePosition(pos, closeQuantity);
                      } else {
                         try {
                            await futuresOrderService.placeOrder({
                              accountId: 'test-acc',
                              symbol: pos.symbol,
                              side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                              positionSide: pos.side,
                              type: 'LIMIT',
                              price: closePrice,
                              quantity: closeQuantity,
                              leverage: pos.leverage,
                              marginMode: pos.marginMode,
                              reduceOnly: true
                            });
                         } catch (e: any) { alert(e.message); }
                      }
                      setActionPositionId(null);
                      setPositions(futuresOrderService.getPositions('test-acc'));
                   }
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      {actionPositionId && (positionAction === 'ADD_MARGIN' || positionAction === 'REMOVE_MARGIN') && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl p-4 w-full max-w-sm border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-4">{positionAction === 'ADD_MARGIN' ? 'Add Margin' : 'Remove Margin'}</h3>
            <div className="mb-6">
              <label className="block text-xs text-gray-400 mb-1">Amount (USDT)</label>
              <input 
                type="number" 
                value={marginAmount} 
                onChange={e => setMarginAmount(e.target.value)} 
                className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-white text-sm"
              />
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setActionPositionId(null)}>Cancel</Button>
              <Button 
                className="flex-1 bg-emerald-600 hover:bg-emerald-500" 
                onClick={() => {
                   const pos = positions.find(p => p.positionId === actionPositionId);
                   if (pos) {
                      try {
                          if (positionAction === 'ADD_MARGIN') {
                              futuresRiskService.addMargin(pos.positionId, marginAmount);
                          } else {
                              futuresRiskService.removeMargin(pos.positionId, marginAmount);
                          }
                          setActionPositionId(null);
                          setPositions(futuresOrderService.getPositions('test-acc'));
                      } catch (e: any) {
                          alert(e.message);
                      }
                   }
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}`;

content = content.replace(/<FuturesActivityCenter accountId="test-acc" \/>/, replacement);
fs.writeFileSync('src/pages/Futures.tsx', content);
