import fs from 'fs';

async function testFetch() {
  const API_KEY = 'PKD4NN6JNJGLBVQPL5YFLJ3RCP';
  const SECRET_KEY = '5HMSSeUm3jLjNoik98vS8JUiWwdBWRxQcGJQkYtzL3Ba';
  const BASE_URL = 'https://data.alpaca.markets/v1beta3/crypto/us/bars';
  
  let pageToken = null;
  let pg = 0;
  
  try {
    const query = new URLSearchParams({ symbols: 'BTC/USD', timeframe: '15Min', start: '2021-01-01T00:00:00Z', end: '2023-12-31T23:59:59Z', limit: '10000' });
    const res = await fetch(`${BASE_URL}?${query.toString()}`, {
      headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': SECRET_KEY, 'accept': 'application/json' }
    });
    
    if(!res.ok) {
        console.log("ERR", await res.text());
        return;
    }
    const data = await res.json();
    const bars = data.bars['BTC/USD'];
    console.log("Got bars: ", bars.length);
    console.log("Next token: ", data.next_page_token);
    
    if (data.next_page_token) {
        const query2 = new URLSearchParams({ symbols: 'BTC/USD', timeframe: '15Min', start: '2021-01-01T00:00:00Z', end: '2023-12-31T23:59:59Z', limit: '10000', page_token: data.next_page_token });
        const res2 = await fetch(`${BASE_URL}?${query2.toString()}`, { headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': SECRET_KEY, 'accept': 'application/json' } });
        const data2 = await res2.json();
        console.log("Got bars 2: ", data2.bars?.['BTC/USD']?.length);
        console.log("Next token 2: ", data2.next_page_token);
    }
    
  } catch(e) {
      console.error(e);
  }
}
testFetch();
