async function run() {
  const [apiTickersRes, apiInfoRes] = await Promise.all([
    fetch('https://api.binance.com/api/v3/ticker/24hr'),
    fetch('https://api.binance.com/api/v3/exchangeInfo')
  ]);
  const apiTickers = await apiTickersRes.json();
  const apiInfo = await apiInfoRes.json();

  console.log("API tickers:", apiTickers.length);
  console.log("API info symbols:", apiInfo.symbols.length);
}
run();
