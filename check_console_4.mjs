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
  
  // Wait a bit to let it render or crash
  await new Promise(r => setTimeout(r, 1000));
  
  // Corrupt the storage with strings that are completely malformed JSON
  await page.evaluate(() => {
    Object.keys(sessionStorage).forEach(key => sessionStorage.setItem(key, '{ invalid ]'));
    Object.keys(localStorage).forEach(key => localStorage.setItem(key, '{ invalid ]'));
    sessionStorage.setItem('novacex_demo_security_settings', '{"test": 1');
  });

  // Reload
  await page.reload();
  await new Promise(r => setTimeout(r, 2000));
  
  const rootHTML = await page.innerHTML('#root');
  console.log('Root HTML after full JSON corruption:', rootHTML.substring(0, 200));
  
  await browser.close();
})();
