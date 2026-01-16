import fs from "fs";

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf-8")); }
  catch { return fallback; }
}
function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

function cleanVal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === "N/A" || u === "N/D" || u === "NA" || u === "ND") return null;
  return s;
}

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

function isProbablyUSSymbol(sym) {
  // "AAPL", "TSLA" 같은 심볼은 보통 미국. 접미사 없는 경우에만 .US 후보로 취급
  const s = sym.toUpperCase();
  if (s.startsWith("^")) return false;        // 지수
  if (s.includes(".")) return false;          // 이미 접미사 있음 (AAPL.US, 005930.KS 등)
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  return true;
}

async function fetchStooqRow(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcvn&h&e=csv`;
  const csv = await fetchText(url);
  const row = parseStooqCSV(csv);
  return row;
}

async function fetchPriceSmart(originalSymbol) {
  // 1) 원래 심볼로 조회
  // 2) Close가 없으면(=N/D 포함) 미국 심볼로 추정되는 경우 .US 붙여서 재조회
  const sym = originalSymbol;
  let usedSymbol = sym;
  let row = null;

  try {
    row = await fetchStooqRow(sym);
  } catch (e) {
    // 네트워크/HTTP 에러는 바로 리턴 (아래에서 ok false 처리)
    return { ok: false, symbol: sym, usedSymbol, error: String(e), row: null };
  }

  const close1 = cleanVal(row?.Close);
  if (close1) {
    return { ok: true, symbol: sym, usedSymbol, error: null, row };
  }

  // 2차 시도 (.US)
  if (isProbablyUSSymbol(sym)) {
    const alt = `${sym}.US`;
    try {
      const row2 = await fetchStooqRow(alt);
      const close2 = cleanVal(row2?.Close);
      if (close2) {
        usedSymbol = alt;
        row = row2;
        return { ok: true, symbol: sym, usedSymbol, error: null, row };
      }
    } catch (e2) {
      // 무시하고 아래에서 실패 처리
    }
  }

  return { ok: false, symbol: sym, usedSymbol, error: null, row };
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
  const watch = readJson("watchlist.json", { symbols: [] }).symbols || [];
  const WATCH = watch.map(sym => ({ name: sym, symbol: sym }));

  const NEWS_QUERIES = [
    "미국 증시", "나스닥", "S&P 500", "KOSPI", "KOSDAQ",
    ...watch.slice(0, 8)
  ];

  // 가격
  const prices = [];
  for (const w of WATCH) {
    try {
      const res = await fetchPriceSmart(w.symbol);
      const row = res.row || {};

      const close = cleanVal(row.Close);
      const date = cleanVal(row.Date);
      const time = cleanVal(row.Time);

      prices.push({
        name: w.name,
        symbol: w.symbol,                 // 사용자가 넣은 심볼(원본)
        resolvedSymbol: res.usedSymbol,   // 실제 조회에 성공한 심볼(AAPL.US 같은)
        date,
        time,
        close,
        open: cleanVal(row.Open),
        high: cleanVal(row.High),
        low: cleanVal(row.Low),
        volume: cleanVal(row.Volume),
        ok: !!close,
        error: res.ok ? null : (res.error || "No data (N/D)"),
      });
    } catch (e) {
      prices.push({
        name: w.name,
        symbol: w.symbol,
        resolvedSymbol: w.symbol,
        ok: false,
        error: String(e),
      });
    }
  }

  // 뉴스
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

  // 이전 data.json 있으면 (선택) 보관할 수도 있지만, 일단은 새로 저장
  const data = {
    updatedAt: new Date().toISOString(),
    watchlist: watch,
    prices,
    news,
  };

  writeJson("data.json", data);
  console.log("Updated data.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});