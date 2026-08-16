const fs = require('fs');
let content = fs.readFileSync('src/services/futures/FuturesOrderService.test.ts', 'utf8');

const tests = `
  it('should trigger a STOP_MARKET order and execute when condition met', async () => {
    // Current price is 50000
    // We want to trigger when price >= 60000
    // So let's mock the market price to 60000 for this test
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '40000', // since price is 50000, 50000 >= 40000, it should trigger immediately
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(true);
    expect(order.status).toBe('FILLED');
  });

  it('should NOT trigger a STOP_MARKET order when condition NOT met', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '60000', // 50000 is not >= 60000
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(false);
    expect(order.status).toBe('PENDING');
  });

  it('should trigger a STOP_LIMIT order, lock margin, and wait for limit condition', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_LIMIT',
      stopPrice: '40000', // triggers immediately since 50000 >= 40000
      price: '30000',     // limit condition not met since 50000 is not <= 30000
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(true);
    expect(order.status).toBe('PENDING'); // still pending because limit condition not met
    
    const balance = ledger.getBalance('USDT');
    // Lock for 1 BTC at 30000 with 10x leverage = 3000 USDT locked
    expect(Number(balance)).toBe(7000); // 10000 - 3000
  });

  it('should prevent triggering cancelled orders', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '60000',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    await service.cancelOrder(order.id);
    await service.checkStopOrders(); // manual trigger check
    
    expect(order.isTriggered).toBe(false);
    expect(order.status).toBe('CANCELLED');
  });

  it('should reject STOP orders with invalid trigger prices', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '-1',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Invalid stop price/);
  });
`;

content = content.replace(/}\);\n$/, tests + '\n});\n');
fs.writeFileSync('src/services/futures/FuturesOrderService.test.ts', content);

