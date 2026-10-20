// Refreshes data.json (scores, schedules, markets, news). Runs on GitHub Actions each morning.
// Node 20+, no dependencies. To change teams or news topics, edit CONFIG below.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = {
  teams: [
    { name: 'Ravens',        league: 'NFL',             espn: 'football/nfl',   id: 'bal', tsdb: 'Baltimore Ravens' },
    { name: 'Orioles',       league: 'MLB',             espn: 'baseball/mlb',   id: 'bal', tsdb: 'Baltimore Orioles' },
    { name: 'Chelsea',       league: 'EPL',             espn: 'soccer/eng.1',   id: '363', tsdb: 'Chelsea' },
    { name: 'Panathinaikos', league: 'Super League GR',                                    tsdb: 'Panathinaikos' },
    { name: 'Capitals',      league: 'NHL',             espn: 'hockey/nhl',     id: 'wsh', tsdb: 'Washington Capitals' },
    { name: 'Wizards',       league: 'NBA',             espn: 'basketball/nba', id: 'wsh', tsdb: 'Washington Wizards' },
  ],
  indices: [
    { symbol: '^GSPC', name: 'S&P 500' },
    { symbol: '^IXIC', name: 'NASDAQ' },
    { symbol: '^DJI',  name: 'DOW' },
  ],
  news: {
    sports:  'Ravens OR Orioles OR "Chelsea FC" OR Panathinaikos OR Capitals OR Wizards OR "Maryland Terps"',
    finance: 'stock market OR economy OR Fed OR earnings',
  },
  newsPerTopic: 6,
};

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; daily-briefing/1.0)' };
const getJSON = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

/* ── Sports ── */
const clean = (s) => String(s ?? '').toLowerCase();

function pickLastNext(games) {
  const now = Date.now();
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  const finished = games.filter((g) => g.state === 'post');
  const upcoming = games.filter((g) => g.state !== 'post' && new Date(g.date).getTime() > now - 4 * 3600e3);
  const live = games.find((g) => g.state === 'in');
  return { last: finished.at(-1) ?? null, next: live ?? upcoming[0] ?? null };
}

async function espnGames(t) {
  const j = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${t.espn}/teams/${t.id}/schedule`);
  return (j.events ?? []).map((ev) => {
    const comp = ev.competitions?.[0];
    if (!comp) return null;
    const us = comp.competitors.find((c) => c.team?.id === t.id || clean(c.team?.abbreviation) === clean(t.id) || clean(c.team?.displayName).includes(clean(t.name)));
    const them = comp.competitors.find((c) => c !== us);
    if (!us || !them) return null;
    const score = (c) => { const s = c.score; return s == null ? null : (typeof s === 'object' ? s.displayValue ?? s.value : s); };
    const st = comp.status?.type ?? ev.status?.type ?? {};
    return {
      date: ev.date, state: st.state ?? 'pre', detail: st.shortDetail ?? '',
      home: us.homeAway === 'home', opp: them.team?.shortDisplayName ?? them.team?.displayName ?? '?',
      us: score(us), them: score(them),
    };
  }).filter(Boolean);
}

async function tsdbGames(t) {
  const base = 'https://www.thesportsdb.com/api/v1/json/3';
  const found = await getJSON(`${base}/searchteams.php?t=${encodeURIComponent(t.tsdb)}`);
  const team = found.teams?.[0];
  if (!team) throw new Error(`TheSportsDB: no team ${t.tsdb}`);
  const [past, future] = await Promise.all([
    getJSON(`${base}/eventslast.php?id=${team.idTeam}`).catch(() => ({})),
    getJSON(`${base}/eventsnext.php?id=${team.idTeam}`).catch(() => ({})),
  ]);
  const mine = clean(team.strTeam);
  return [...(past.results ?? []), ...(future.events ?? [])].map((e) => {
    const home = clean(e.strHomeTeam) === mine;
    const hs = e.intHomeScore, as = e.intAwayScore;
    const played = hs != null && as != null && hs !== '' && as !== '';
    const date = e.strTimestamp ? e.strTimestamp + 'Z' : `${e.dateEvent}T${e.strTime || '00:00:00'}Z`;
    return {
      date, state: played ? 'post' : 'pre', detail: '', home,
      opp: home ? e.strAwayTeam : e.strHomeTeam,
      us: played ? (home ? hs : as) : null, them: played ? (home ? as : hs) : null,
    };
  });
}

async function teamCard(t) {
  let games = [], source = '';
  if (t.espn) { try { games = await espnGames(t); source = 'ESPN'; } catch (e) { console.warn(`ESPN failed for ${t.name}: ${e.message}`); } }
  if (!games.length) { games = await tsdbGames(t); source = 'TheSportsDB'; }
  const { last, next } = pickLastNext(games);
  const fin = (g) => g && { ...g, result: Number(g.us) > Number(g.them) ? 'W' : Number(g.us) < Number(g.them) ? 'L' : 'T' };
  return { name: t.name, league: t.league, source, last: fin(last), next };
}

/* ── Markets (Yahoo Finance) ── */
async function market(i) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(i.symbol)}?interval=1d&range=5d`);
  const m = j.chart.result[0].meta;
  const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
  return { name: i.name, price, change: ((price - prev) / prev) * 100 };
}

/* ── News (Google News RSS, no key needed) ── */
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function news(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} news`);
  const xml = await r.text();
  const seen = new Set();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (n) => (m[1].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) ?? [])[1] ?? '';
    const source = decode(tag('source'));
    let title = decode(tag('title'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (!title || seen.has(title)) continue;
    seen.add(title);
    items.push({ title, source, link: decode(tag('link')), date: new Date(decode(tag('pubDate'))).toISOString() });
    if (items.length >= CONFIG.newsPerTopic) break;
  }
  return items;
}

/* ── Run everything; a failed section keeps yesterday's data so the page never goes blank ── */
const prev = existsSync('data.json') ? JSON.parse(readFileSync('data.json', 'utf8')) : {};
const settle = async (label, fn, fallback) => {
  try { return await fn(); } catch (e) { console.warn(`${label} failed: ${e.message}`); return fallback; }
};

const sports = await Promise.all(CONFIG.teams.map((t) =>
  settle(`team ${t.name}`, () => teamCard(t), prev.sports?.find((p) => p.name === t.name) ?? { name: t.name, league: t.league, last: null, next: null })));
const markets = await settle('markets', () => Promise.all(CONFIG.indices.map(market)), prev.markets ?? []);
const newsOut = {};
for (const [key, q] of Object.entries(CONFIG.news)) newsOut[key] = await settle(`news ${key}`, () => news(q), prev.news?.[key] ?? []);

writeFileSync('data.json', JSON.stringify({ generatedAt: new Date().toISOString(), sports, markets, news: newsOut }, null, 2));
console.log('data.json written');
