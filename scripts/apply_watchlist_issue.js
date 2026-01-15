import fs from "fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
const issueNumber = Number(process.env.ISSUE_NUMBER);

if (!token || !repo || !issueNumber) {
  console.error("Missing env: GITHUB_TOKEN / GITHUB_REPOSITORY / ISSUE_NUMBER");
  process.exit(1);
}

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf-8")); }
  catch { return fallback; }
}
function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "watchlist-bot"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${path}: ${text}`);
  return json;
}

function parseBody(body) {
  const lines = (body || "").split("\n").map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const l of lines) {
    const idx = l.indexOf(":");
    if (idx === -1) continue;
    const k = l.slice(0, idx).trim().toLowerCase();
    const v = l.slice(idx + 1).trim();
    map[k] = v;
  }
  return {
    action: (map.action || "").toLowerCase(),
    symbol: (map.symbol || "").toUpperCase()
  };
}

async function comment(msg) {
  const [owner, name] = repo.split("/");
  await gh("POST", `/repos/${owner}/${name}/issues/${issueNumber}/comments`, { body: msg });
}
async function closeIssue() {
  const [owner, name] = repo.split("/");
  await gh("PATCH", `/repos/${owner}/${name}/issues/${issueNumber}`, { state: "closed" });
}

async function main() {
  const [owner, name] = repo.split("/");
  const issue = await gh("GET", `/repos/${owner}/${name}/issues/${issueNumber}`);
  const { action, symbol } = parseBody(issue.body);

  const allowed = new Set((readJson("allowed_symbols.json", { symbols: [] }).symbols || [])
    .map(s => String(s).toUpperCase()));
  const watchObj = readJson("watchlist.json", { symbols: [] });
  const current = new Set((watchObj.symbols || []).map(s => String(s).toUpperCase()));

  if (!["add", "remove"].includes(action) || !symbol) {
    await comment(`⚠️ 형식이 잘못됐어.\n\n예시:\n\naction:add\nsymbol:TSLA\n\n(action는 add/remove, symbol은 대문자 심볼)`);
    await closeIssue();
    return;
  }

  if (!allowed.has(symbol)) {
    await comment(`❌ **${symbol}** 는 현재 허용 목록(allowed_symbols.json)에 없어서 추가/삭제할 수 없어.`);
    await closeIssue();
    return;
  }

  if (action === "add") current.add(symbol);
  if (action === "remove") current.delete(symbol);

  const next = Array.from(current).sort();
  writeJson("watchlist.json", { symbols: next });

  await comment(`✅ watchlist 업데이트 완료: **${action} ${symbol}**\n\n현재 목록: ${next.join(", ")}`);
  await closeIssue();
}

main().catch(async (e) => {
  console.error(e);
  try { await comment(`❌ 처리 중 에러: ${String(e)}`); } catch {}
  try { await closeIssue(); } catch {}
  process.exit(1);
});