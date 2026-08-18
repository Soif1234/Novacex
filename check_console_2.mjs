import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log(`[Browser Console] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });
  
  page.on('pageerror', error => {
    console.log(`[Browser PageError] ${error.message}\n${error.stack}`);
  });

  await page.goto('http://localhost:3000');
  
  // Wait a bit to let it render or crash
  await new Promise(r => setTimeout(r, 2000));
  
  const rootHTML = await page.innerHTML('#root');
  console.log('Root HTML:', rootHTML.substring(0, 500));
  
  await browser.close();
})();