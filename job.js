import fs from "fs";

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf-8")); }
  catch { return fallback; }
}

const watch = readJson("watchlist.json", { symbols: [] }).symbols || [];
const WATCH = watch.map(sym => ({ name: sym, symbol: sym }));

const NEWS_QUERIES = [
  "미국 증시", "나스닥", "S&P 500", "KOSPI", "KOSDAQ",
  ...watch.slice(0, 8)
];

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "github-actions" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

function parseStooqCSV(csv) {
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

function parseGoogleNewsRSS(xml, limit = 8) {
  const items = [];
  const parts = xml.split("<item>").slice(1);
  for (const p of parts) {
    const title = (p.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || p.match(/<title>(.*?)<\/title>/))?.[1];
    const link = (p.match(/<link>(.*?)<\/link>/) || [])[1];
    const pubDate = (p.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
    if (!title || !link) continue;

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
  const prices = [];
  for (const w of WATCH) {
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
    watchlist: watch,
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