import fs from "fs";

const WATCH = [
  { name: "S&P 500", symbol: "^SPX" },
  { name: "Dow Jones", symbol: "^DJI" },
  // 필요하면 추가: { name:"Nikkei 225", symbol:"^N225" } 같은 식
];

const NEWS_QUERIES = [
  "S&P 500",
  "Dow Jones",
  "Nasdaq",
  "KOSPI",
  "KOSDAQ",
];

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "github-actions" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

function parseStooqCSV(csv) {
  // 첫 줄 헤더, 둘째 줄 데이터(보통)
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return null;
  const headers = lines[0].split(",").map(s => s.trim());
  const values = lines[1].split(",").map(s => s.trim());
  const obj = {};
  headers.forEach((h, i) => (obj[h] = values[i]));
  return obj;
}

function decodeXmlEntities(s) {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function parseGoogleNewsRSS(xml, limit = 10) {
  const items = [];
  const parts = xml.split("<item>").slice(1);
  for (const p of parts) {
    const title = (p.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || p.match(/<title>(.*?)<\/title>/))?.[1];
    const link = (p.match(/<link>(.*?)<\/link>/) || [])[1];
    const pubDate = (p.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
    if (!title || !link) continue;

    // Google News는 "제목 - 출처" 형태가 많음
    const cleanTitle = decodeXmlEntities(title);
    const [headline, source] = cleanTitle.split(" - ").map(s => s.trim());

    items.push({
      headline: headline || cleanTitle,
      source: source || null,
      link: decodeXmlEntities(link),
      pubDate: pubDate || null,
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function main() {
  // 1) 가격
  const prices = [];
  for (const w of WATCH) {
    // Stooq CSV quote endpoint
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(w.symbol)}&f=sd2t2ohlcvn&h&e=csv`;
    try {
      const csv = await fetchText(url);
      const row = parseStooqCSV(csv);
      prices.push({
        name: w.name,
        symbol: w.symbol,
        date: row?.Date ?? null,
        time: row?.Time ?? null,
        close: row?.Close ?? null,
        open: row?.Open ?? null,
        high: row?.High ?? null,
        low: row?.Low ?? null,
        volume: row?.Volume ?? null,
        ok: !!row?.Close && row?.Close !== "N/A",
      });
    } catch (e) {
      prices.push({ name: w.name, symbol: w.symbol, ok: false, error: String(e) });
    }
  }

  // 2) 뉴스(RSS)
  const news = [];
  for (const q of NEWS_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
    try {
      const xml = await fetchText(url);
      news.push({ query: q, items: parseGoogleNewsRSS(xml, 8) });
    } catch (e) {
      news.push({ query: q, items: [], error: String(e) });
    }
  }

  const data = {
    updatedAt: new Date().toISOString(),
    prices,
    news,
  };

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2), "utf-8");
  console.log("Updated data.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});