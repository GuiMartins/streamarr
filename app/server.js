// streamarr — mostra em quais streamings estão os filmes e séries do Radarr/Sonarr
// Zero-dependency Node.js app (runs on node:22-alpine).
//
// Configuração (pela UI ou por variáveis de ambiente; o ambiente tem prioridade):
//   RADARR_URL / RADARR_API_KEY   ex.: http://host.docker.internal:7878
//   SONARR_URL / SONARR_API_KEY   ex.: http://host.docker.internal:8989
//   COUNTRY                       país do catálogo (padrão BR)
//   REFRESH_HOURS                 validade da consulta de cada título (padrão 24)
//   DATA_DIR                      onde ficam config + cache (padrão /appdata)
//   PORT                          porta HTTP (padrão 8080)

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const VERSION = '0.1.0';
const DATA_DIR = process.env.DATA_DIR || '/appdata';
const PORT = parseInt(process.env.PORT || '8080', 10);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const SCAN_MINUTES = 30; // de quanto em quanto tempo procura títulos novos nos *arr
const CONCURRENCY = 4;
const JW_URL = 'https://apis.justwatch.com/graphql';
const LANG = { BR: 'pt', PT: 'pt', US: 'en', GB: 'en', ES: 'es', MX: 'es', AR: 'es' };

const trimUrl = (u) => (u ? String(u).trim().replace(/\/+$/, '') : '');
const ENV = {
  radarrUrl: trimUrl(process.env.RADARR_URL),
  radarrKey: process.env.RADARR_API_KEY || '',
  sonarrUrl: trimUrl(process.env.SONARR_URL),
  sonarrKey: process.env.SONARR_API_KEY || '',
  country: (process.env.COUNTRY || '').toUpperCase(),
  refreshHours: process.env.REFRESH_HOURS ? parseFloat(process.env.REFRESH_HOURS) : 0,
};

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

const config = () => ({
  radarrUrl: ENV.radarrUrl || fileConfig.radarrUrl || '',
  radarrKey: ENV.radarrKey || fileConfig.radarrKey || '',
  sonarrUrl: ENV.sonarrUrl || fileConfig.sonarrUrl || '',
  sonarrKey: ENV.sonarrKey || fileConfig.sonarrKey || '',
  country: ENV.country || fileConfig.country || 'BR',
  refreshHours: ENV.refreshHours || fileConfig.refreshHours || 24,
  myServices: Array.isArray(fileConfig.myServices) ? fileConfig.myServices : [],
});
const configured = () => {
  const c = config();
  return !!((c.radarrUrl && c.radarrKey) || (c.sonarrUrl && c.sonarrKey));
};

// cache = { lookups: { "<kind>:<tmdb|imdb>": { at, country, match } }, report }
let cache = { lookups: {}, report: null };
try { cache = { lookups: {}, report: null, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch {}
const status = { running: false, phase: '', done: 0, total: 0, startedAt: null, lastError: null };

async function saveJson(file, obj) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}

// ---------------- Radarr / Sonarr ----------------
async function arr(url, key, p) {
  const res = await fetch(`${url}/api/v3${p}`, {
    headers: { 'X-Api-Key': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${url}${p} -> HTTP ${res.status}`);
  return res.json();
}

const poster = (images) => {
  const img = (images || []).find((i) => i.coverType === 'poster');
  const u = img && (img.remoteUrl || '');
  // TMDB entrega o original (pesado); w342 basta para o card
  return u.replace('/t/p/original/', '/t/p/w342/');
};

async function loadLibrary() {
  const c = config();
  const items = [];
  if (c.radarrUrl && c.radarrKey) {
    for (const m of await arr(c.radarrUrl, c.radarrKey, '/movie')) {
      items.push({
        kind: 'movie', id: m.id, title: m.title, originalTitle: m.originalTitle, year: m.year,
        tmdbId: m.tmdbId ? String(m.tmdbId) : '', imdbId: m.imdbId || '',
        poster: poster(m.images), downloaded: !!m.hasFile, monitored: !!m.monitored,
        size: m.sizeOnDisk || 0, added: m.added, slug: m.titleSlug || String(m.tmdbId),
      });
    }
  }
  if (c.sonarrUrl && c.sonarrKey) {
    for (const s of await arr(c.sonarrUrl, c.sonarrKey, '/series')) {
      const st = s.statistics || {};
      items.push({
        kind: 'show', id: s.id, title: s.title, originalTitle: s.originalTitle, year: s.year,
        tmdbId: s.tmdbId ? String(s.tmdbId) : '', imdbId: s.imdbId || '',
        poster: poster(s.images), downloaded: (st.episodeFileCount || 0) > 0, monitored: !!s.monitored,
        episodes: { have: st.episodeFileCount || 0, total: st.episodeCount || 0 },
        size: st.sizeOnDisk || 0, added: s.added, slug: s.titleSlug || String(s.tvdbId),
      });
    }
  }
  return items;
}

// ---------------- JustWatch ----------------
const JW_QUERY = `query($q:String!,$c:Country!,$l:Language!){
  popularTitles(country:$c, first:8, filter:{searchQuery:$q}){ edges{ node{
    objectType
    content(country:$c, language:$l){ title fullPath externalIds{ imdbId tmdbId } }
    offers(country:$c, platform:WEB){
      monetizationType presentationType standardWebURL
      package{ packageId clearName technicalName icon(profile:S100, format:PNG) }
    }
  }}}}`;

async function jwSearch(q, country) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(JW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': `streamarr/${VERSION}` },
        body: JSON.stringify({ query: JW_QUERY, variables: { q, c: country, l: LANG[country] || 'en' } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`JustWatch HTTP ${res.status}`);
      const j = await res.json();
      if (j.errors) throw new Error(`JustWatch: ${j.errors[0].message}`);
      return j.data.popularTitles.edges.map((e) => e.node);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Junta as variações do mesmo serviço: "Netflix Standard with Ads" -> Netflix,
// "HBO Max Amazon Channel" -> HBO Max (via Amazon), "Disney Plus" -> Disney+
function serviceOf(clearName) {
  let name = clearName.trim();
  let via = null;
  const ch = name.match(/^(.*?)\s+(Amazon|Apple TV|Roku Premium|Prime Video)\s+Channels?$/i);
  if (ch) { name = ch[1]; via = /apple/i.test(ch[2]) ? 'Apple TV' : 'Amazon'; }
  name = name
    .replace(/\s+(Standard|Basic|Premium)?\s*with Ads$/i, '')
    .replace(/\s+(Premium|Standard|Basic)$/i, '')
    .replace(/\s+Plus$/i, '+')
    .replace(/^Amazon Prime Video$/i, 'Prime Video');
  return { name, via };
}

const TYPE = { FLATRATE: 'sub', FREE: 'free', ADS: 'free', RENT: 'rent', BUY: 'buy' };

function summarizeOffers(offers) {
  const byKey = new Map();
  for (const o of offers || []) {
    const type = TYPE[o.monetizationType];
    if (!type || !o.package) continue;
    const { name, via } = serviceOf(o.package.clearName);
    const key = `${type}|${name}`;
    let e = byKey.get(key);
    if (!e) { e = { service: name, type, url: null, icon: null, via: [], direct: false, uhd: false }; byKey.set(key, e); }
    if (o.presentationType === '_4K') e.uhd = true;
    if (via) {
      if (!e.via.includes(via)) e.via.push(via);
      if (!e.url) e.url = o.standardWebURL;
      if (!e.icon) e.icon = o.package.icon;
    } else {
      // o pacote "direto" ganha do canal na hora de escolher link e ícone
      if (!e.direct) { e.url = o.standardWebURL; e.icon = o.package.icon; }
      e.direct = true;
    }
  }
  return [...byKey.values()].map((e) => ({ ...e, icon: e.icon ? `https://images.justwatch.com${e.icon}` : null }));
}

async function lookup(item, country) {
  const want = item.kind === 'movie' ? 'MOVIE' : 'SHOW';
  const queries = [item.title];
  if (item.originalTitle && item.originalTitle !== item.title) queries.push(item.originalTitle);
  for (const q of queries) {
    const nodes = await jwSearch(q, country);
    const hit = nodes.find((n) => {
      const ex = (n.content && n.content.externalIds) || {};
      if (n.objectType !== want) return false;
      return (item.tmdbId && ex.tmdbId === item.tmdbId) || (item.imdbId && ex.imdbId === item.imdbId);
    });
    if (hit) {
      return {
        url: hit.content.fullPath ? `https://www.justwatch.com${hit.content.fullPath}` : null,
        offers: summarizeOffers(hit.offers),
      };
    }
  }
  return null;
}

// ---------------- Refresh ----------------
const lookupKey = (it) => `${it.kind}:${it.tmdbId || it.imdbId || it.title}`;

async function refresh({ force = false } = {}) {
  if (status.running || !configured()) return;
  Object.assign(status, { running: true, phase: 'Lendo Radarr/Sonarr', done: 0, total: 0, startedAt: Date.now(), lastError: null });
  try {
    const c = config();
    const items = await loadLibrary();
    const ttl = c.refreshHours * 3600e3;
    const now = Date.now();
    const stale = items.filter((it) => {
      const l = cache.lookups[lookupKey(it)];
      return force || !l || l.country !== c.country || now - l.at > ttl;
    });
    Object.assign(status, { phase: 'Consultando o JustWatch', total: stale.length });

    let next = 0, failures = 0, lastFail = null;
    const worker = async () => {
      while (next < stale.length) {
        const it = stale[next++];
        try {
          cache.lookups[lookupKey(it)] = { at: Date.now(), country: c.country, match: await lookup(it, c.country) };
        } catch (e) {
          failures++; lastFail = e;
        }
        status.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failures && failures === stale.length) throw lastFail;

    // tira do cache o que saiu da biblioteca
    const keep = new Set(items.map(lookupKey));
    for (const k of Object.keys(cache.lookups)) if (!keep.has(k)) delete cache.lookups[k];

    cache.report = {
      generatedAt: Date.now(),
      country: c.country,
      failures,
      items: items.map((it) => {
        const l = cache.lookups[lookupKey(it)];
        const { originalTitle, ...rest } = it;
        return { ...rest, checkedAt: l ? l.at : null, justwatch: l && l.match ? l.match.url : null, matched: !!(l && l.match), offers: l && l.match ? l.match.offers : [] };
      }),
    };
    await saveJson(CACHE_FILE, cache);
    if (failures) status.lastError = `${failures} título(s) não puderam ser consultados: ${lastFail.message}`;
  } catch (e) {
    status.lastError = e.message;
    console.error('refresh failed:', e);
  } finally {
    status.running = false;
    status.phase = '';
  }
}

// ---------------- HTTP ----------------
const INDEX = path.join(__dirname, 'index.html');

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

const portOf = (u) => { try { const x = new URL(u); return x.port || (x.protocol === 'https:' ? '443' : '80'); } catch { return null; } };

function publicConfig() {
  const c = config();
  return {
    radarrUrl: c.radarrUrl, sonarrUrl: c.sonarrUrl,
    hasRadarrKey: !!c.radarrKey, hasSonarrKey: !!c.sonarrKey,
    country: c.country, refreshHours: c.refreshHours, myServices: c.myServices,
    radarrPort: portOf(c.radarrUrl), sonarrPort: portOf(c.sonarrUrl),
    fromEnv: Object.keys(ENV).filter((k) => ENV[k]),
    configured: configured(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await fsp.readFile(INDEX), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/status') return send(res, 200, { version: VERSION, ...status, config: publicConfig(), generatedAt: cache.report && cache.report.generatedAt });
    if (url.pathname === '/api/data') return send(res, 200, { config: publicConfig(), report: cache.report });
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      refresh({ force: url.searchParams.get('force') === '1' });
      return send(res, 202, { ok: true });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      const next = { ...fileConfig };
      for (const k of ['radarrUrl', 'sonarrUrl']) if (k in b) next[k] = trimUrl(b[k]);
      // chave em branco = manter a atual; nunca devolvemos as chaves para o navegador
      for (const k of ['radarrKey', 'sonarrKey']) if (b[k]) next[k] = String(b[k]).trim();
      for (const k of ['radarrKey', 'sonarrKey']) if (b[`clear_${k}`]) next[k] = '';
      if (b.country) next.country = String(b.country).toUpperCase().slice(0, 2);
      if (b.refreshHours) next.refreshHours = Math.max(1, Math.min(24 * 30, parseFloat(b.refreshHours) || 24));
      if (Array.isArray(b.myServices)) next.myServices = b.myServices.map(String).slice(0, 100);
      const changedSource = ['radarrUrl', 'sonarrUrl', 'radarrKey', 'sonarrKey', 'country'].some((k) => next[k] !== fileConfig[k]);
      fileConfig = next;
      await saveJson(CONFIG_FILE, fileConfig);
      if (changedSource) refresh();
      return send(res, 200, publicConfig());
    }
    if (url.pathname === '/api/test' && req.method === 'POST') {
      const b = await readBody(req);
      const c = config();
      const which = b.which === 'sonarr' ? 'sonarr' : 'radarr';
      const u = trimUrl(b.url) || c[`${which}Url`];
      const k = (b.key && String(b.key).trim()) || c[`${which}Key`];
      try {
        const s = await arr(u, k, '/system/status');
        return send(res, 200, { ok: true, version: s.version, appName: s.appName });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`streamarr ${VERSION} ouvindo na porta ${PORT}`);
  refresh();
  setInterval(refresh, SCAN_MINUTES * 60e3).unref();
});
