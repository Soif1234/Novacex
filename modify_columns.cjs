const fs = require('fs');

let content = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

content = content.replace(
`<th className="pb-3 font-medium text-yellow-500/80">Est. Funding</th>
                    <th className="pb-3 font-medium">Unrealized PNL (ROE%)</th>
                    <th className="pb-3 font-medium">Realized PNL</th>`,
`<th className="pb-3 font-medium text-yellow-500/80">Est. Funding</th>
                    <th className="pb-3 font-medium text-purple-400">DEMO Fees / Funding</th>
                    <th className="pb-3 font-medium">Gross PNL (DEMO)</th>
                    <th className="pb-3 font-medium text-blue-400">Net PNL (ROE%)</th>`
);

content = content.replace(
`<td className="py-3 text-yellow-500/80">
                           {Number(futuresFundingService.calculateEstimatedFunding(pos, pos.markPrice)).toFixed(4)}
                        </td>
                        <td className={"py-3 font-medium " + upnlColor}>
                          {upnlNum > 0 ? '+' : ''}{upnlNum.toFixed(2)} <br/>
                          <span className="text-xs">({Number(roe).toFixed(2)}%)</span>
                        </td>
                        <td className="py-3 text-gray-300">{Number(pos.realizedPnl).toFixed(2)}</td>`,
`<td className="py-3 text-yellow-500/80">
                           {Number(futuresFundingService.calculateEstimatedFunding(pos, pos.markPrice)).toFixed(4)}
                        </td>
                        <td className="py-3 text-purple-400">
                           <div className="flex flex-col">
                             <span className="text-xs">F: {Number(pos.cumulativeFee || 0).toFixed(4)}</span>
                             <span className="text-xs">Fun: {Number(pos.cumulativeFunding || 0).toFixed(4)}</span>
                           </div>
                        </td>
                        <td className={"py-3 font-medium " + upnlColor}>
                          {(upnlNum + Number(pos.realizedPnl)) > 0 ? '+' : ''}{(upnlNum + Number(pos.realizedPnl)).toFixed(2)}
                        </td>
                        <td className={"py-3 font-medium " + (Number(futuresRiskService.calculateNetPnl(pos, pos.markPrice)) > 0 ? 'text-green-500' : Number(futuresRiskService.calculateNetPnl(pos, pos.markPrice)) < 0 ? 'text-red-500' : 'text-gray-300')}>
                          {Number(futuresRiskService.calculateNetPnl(pos, pos.markPrice)) > 0 ? '+' : ''}{Number(futuresRiskService.calculateNetPnl(pos, pos.markPrice)).toFixed(2)} <br/>
                          <span className="text-xs">({Number(roe).toFixed(2)}%)</span>
                        </td>`
);

content = content.replace(`colSpan={11}`, `colSpan={13}`);

fs.writeFileSync('src/pages/Futures.tsx', content);
