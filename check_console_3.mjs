import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[Browser Console] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });
  
  page.on('pageerror', error => {
    console.log(`[Browser PageError] ${error.message}\n${error.stack}`);
  });

  await page.goto('http://localhost:3000');
  
  // Corrupt the storage
  await page.evaluate(() => {
    Object.keys(sessionStorage).forEach(key => sessionStorage.setItem(key, 'null'));
    Object.keys(localStorage).forEach(key => localStorage.setItem(key, 'null'));
    // Add some known keys just in case
    sessionStorage.setItem('demo_ledger_history', '{}');
    sessionStorage.setItem('nova_price_alerts', '123');
    sessionStorage.setItem('novacex_demo_security_sessions', 'null');
    sessionStorage.setItem('novacex_demo_security_settings', '"invalid"');
  });

  // Reload
  await page.reload();
  await new Promise(r => setTimeout(r, 2000));
  
  const rootHTML = await page.innerHTML('#root');
  console.log('Root HTML after corruption:', rootHTML.substring(0, 100));
  
  await browser.close();
})();