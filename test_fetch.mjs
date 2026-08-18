async function run() {
  const [fapiTickersRes, fapiInfoRes] = await Promise.all([
    fetch('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')
  ]);
  const fapiTickers = await fapiTickersRes.json();
  const fapiInfo = await fapiInfoRes.json();

  console.log("FAPI tickers:", fapiTickers.length);
  console.log("FAPI info symbols:", fapiInfo.symbols.length);
}
run();
