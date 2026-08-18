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
  await new Promise(r => setTimeout(r, 2000));
  
  // Click on transactions
  try {
     const assetsBtn = await page.waitForSelector('text="Assets"', { timeout: 5000 });
     if (assetsBtn) {
         await assetsBtn.click();
         await new Promise(r => setTimeout(r, 1000));
         const historyBtn = await page.waitForSelector('text="History"', { timeout: 5000 });
         if (historyBtn) await historyBtn.click();
     }
     
     await new Promise(r => setTimeout(r, 1000));
     const rootHTML = await page.innerHTML('#root');
     console.log('Root HTML after clicking around:', rootHTML.length > 500 ? rootHTML.substring(0, 500) + '...' : rootHTML);
  } catch(e) {
     console.log("Error interacting: " + e.message);
  }
  
  await browser.close();
})();
