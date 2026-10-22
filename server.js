// On-demand backend for the review-workload dashboard: serves the static
// page + JSON snapshot, and exposes POST /refresh which re-runs the
// collector (collector.js) right then, in-process. The collector's instance/reviewer caches make a warm
// refresh much faster than the first cold run.
//
// Run with:  node server.js
// Requires PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD set in this
// process's environment so the collector doesn't hang on an interactive
// credential prompt.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { runCollector, readHistoryRange, isValidDateStr, listDates, easternToday, HISTORY_MAX_RANGE_DAYS } = require('./collector');

const ROOT = __dirname;
const PORT = process.env.PORT || 5757;
const MIN_SECONDS_BETWEEN_REFRESHES = 300; // guard against a refresh storm if several people click at once

// Optional periodic auto-refresh, off by default - set AUTO_REFRESH_MINUTES
// to a positive number to enable it (e.g. 120 for every 2 hours). Deliberately
// opt-in rather than defaulting to something like 15 minutes: this refresh
// can be memory-heavy (see collector.js's report-tables child process - this
// app has already hit a host memory limit mid-refresh once on a shared host), so an aggressive
// interval on a constrained host trades a small freshness win for a real risk
// of tripping that limit more often, including while someone's actively
// looking at the page. A couple of times a day is plenty for most uses -
// every 2-4 hours is a reasonable starting point.
const AUTO_REFRESH_MINUTES = parseInt(process.env.AUTO_REFRESH_MINUTES || '0', 10);

// Only these files are ever served. The app root also holds server code, and
// data/ holds caches, history and CSVs with project/reviewer details - none of
// that should be downloadable. The page itself needs just the HTML and the
// snapshot.
const STATIC_ALLOWLIST = new Map([
  ['/', 'workload-dashboard.html'],
  ['/workload-dashboard.html', 'workload-dashboard.html'],
  ['/data/workload-snapshot.json', path.join('data', 'workload-snapshot.json')]
]);

const MIME = { '.png': 'image/png', '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
const COMPRESSIBLE = new Set(['.html', '.json', '.js', '.css']);
const compressedCache = new Map(); // "encoding:path" -> { etag, body }

let refreshInFlight = null; // Promise, so concurrent requests share one run instead of stacking
let lastRefreshFinishedAt = 0;
let refreshStartedAt = null;
let refreshLog = []; // collector.js's own log() lines from the current/last run, for /refresh-status to expose
let refreshLogTotal = 0; // lines pushed this run, including any shifted out of refreshLog
const REFRESH_LOG_MAX_LINES = 200;

function triggerRefresh() {
  if (refreshInFlight) return refreshInFlight; // already running - share it, don't start a second one

  const secondsSinceLast = (Date.now() - lastRefreshFinishedAt) / 1000;
  if (lastRefreshFinishedAt && secondsSinceLast < MIN_SECONDS_BETWEEN_REFRESHES) {
    return Promise.reject(Object.assign(new Error(`A refresh finished ${Math.round(secondsSinceLast)}s ago - please wait a bit before triggering another (min ${MIN_SECONDS_BETWEEN_REFRESHES}s apart).`), { clientSafe: true }));
  }

  refreshStartedAt = Date.now();
  refreshLog = [];
  refreshLogTotal = 0;

  refreshInFlight = runCollector({
    log: (msg) => {
      console.log('[collector]', msg);
      refreshLog.push({ t: Date.now(), msg });
      refreshLogTotal++;
      if (refreshLog.length > REFRESH_LOG_MAX_LINES) refreshLog.shift();
    }
  })
    .then((result) => {
      lastRefreshFinishedAt = Date.now();
      refreshInFlight = null;
      return result;
    })
    .catch((err) => {
      refreshInFlight = null;
      console.error('[collector] refresh failed:', err);
      refreshLog.push({ t: Date.now(), msg: `ERROR: ${clientMessage(err)}` });
      refreshLogTotal++;
      throw err;
    });

  return refreshInFlight;
}

// Raw error text (upstream responses, paths, stack details) stays in the
// server log; browsers get a generic message unless the error is marked safe.
function clientMessage(err) {
  return err && err.clientSafe ? err.message : 'Refresh failed - see the server log for details.';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
  // Small bodies (status polls, errors) aren't worth the CPU; larger ones (history ranges) compress ~10x.
  if (body.length > 1024 && /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '')) {
    zlib.gzip(body, (err, zipped) => {
      if (err) { res.writeHead(status, headers); res.end(body); return; }
      res.writeHead(status, Object.assign({ 'Content-Encoding': 'gzip', 'Content-Length': zipped.length }, headers));
      res.end(zipped);
    });
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}


// GET /history?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?date=YYYY-MM-DD for one day):
// completed-task summary for that inclusive range, read from the collector's
// per-day history files. A single day also returns the actual task list.
async function handleHistory(rawUrl, res) {
  const q = new URL(rawUrl, 'http://localhost').searchParams;
  const from = q.get('from') || q.get('date');
  const to = q.get('to') || q.get('date') || from;
  if (!isValidDateStr(from) || !isValidDateStr(to)) {
    sendJson(res, 400, { ok: false, error: 'from/to (or date) must be real YYYY-MM-DD dates.' });
    return;
  }
  if (from > to) { sendJson(res, 400, { ok: false, error: 'from must not be after to.' }); return; }
  const today = easternToday();
  if (from > today) { sendJson(res, 400, { ok: false, error: 'That date is in the future.' }); return; }
  const clampedTo = to > today ? today : to;
  if (listDates(from, clampedTo).length > HISTORY_MAX_RANGE_DAYS) {
    sendJson(res, 400, { ok: false, error: `Range too long (max ${HISTORY_MAX_RANGE_DAYS} days).` });
    return;
  }
  const result = await readHistoryRange(from, clampedTo, { includeRows: from === clampedTo });
  sendJson(res, 200, Object.assign({ ok: true, Today: today }, result));
}

function serveStatic(req, url, res, rawUrl) {
  const rel = STATIC_ALLOWLIST.get(url.split('?')[0]);
  if (!rel) { sendNotFound(res); return; }
  const filePath = path.join(ROOT, rel);

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) { sendNotFound(res); return; }
    const ext = path.extname(filePath);
    // Weak-ish validator from mtime+size: changes whenever the collector
    // rewrites the file, so clients always see fresh data but an unchanged
    // 5 MB snapshot costs a bodyless 304 on each poll.
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // no-cache = may store, but must revalidate every time. Keeps the old
      // "never show a stale page after an edit" guarantee of no-store.
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept-Encoding'
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const accept = req.headers['accept-encoding'] || '';
    const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (!encoding) {
      fs.readFile(filePath, (err, data) => {
        if (err) { sendNotFound(res); return; }
        res.writeHead(200, headers);
        res.end(data);
      });
      return;
    }
    // Compressed copies are cached per file+encoding until the file changes,
    // so a 5 MB snapshot is compressed once per collector run, not per request.
    const cacheKey = `${encoding}:${filePath}`;
    const cached = compressedCache.get(cacheKey);
    const send = (body) => {
      res.writeHead(200, Object.assign({ 'Content-Encoding': encoding, 'Content-Length': body.length }, headers));
      res.end(body);
    };
    if (cached && cached.etag === etag) { send(cached.body); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { sendNotFound(res); return; }
      const done = (zErr, body) => {
        if (zErr) { res.writeHead(200, headers); res.end(data); return; }
        compressedCache.set(cacheKey, { etag, body });
        send(body);
      };
      if (encoding === 'br') {
        zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
      } else {
        zlib.gzip(data, { level: 6 }, done);
      }
    });
  });
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  // No CORS: the page is same-origin, so cross-origin preflights are refused.
  if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); return; }

  const url = req.url;

  if (url === '/refresh' && req.method === 'POST') {
    // A custom header can't be sent cross-origin without a CORS preflight
    // (which we refuse), so this blocks other sites from triggering a refresh.
    if (req.headers['x-requested-with'] !== 'dashboard') {
      sendJson(res, 403, { ok: false, error: 'Missing X-Requested-With header.' });
      return;
    }
    triggerRefresh()
      .then(({ snapshot, tookSeconds }) => {
        sendJson(res, 200, {
          ok: true,
          tookSeconds,
          generatedAt: snapshot.GeneratedAt,
          totalOpenTasks: snapshot.TotalOpenTasks
        });
      })
      .catch((err) => {
        sendJson(res, err.clientSafe ? 429 : 500, { ok: false, error: clientMessage(err) });
      });
    return;
  }

  if (url.split('?')[0] === '/refresh-status' && req.method === 'GET') {
    // ?since=N: the caller already has the first N log lines of this run, so
    // send only the rest (the page polls every ~1s; resending the whole log
    // each time dominated the traffic of a long refresh). logTotal lets it
    // track what it has; a since beyond logTotal means a new run started.
    const since = parseInt(new URL(url, 'http://localhost').searchParams.get('since') || '0', 10) || 0;
    const firstHeld = refreshLogTotal - refreshLog.length; // ring buffer may have dropped the oldest lines
    const from = since > refreshLogTotal ? firstHeld : Math.max(since, firstHeld);
    sendJson(res, 200, {
      refreshing: !!refreshInFlight,
      lastRefreshFinishedAt: lastRefreshFinishedAt || null,
      startedAt: refreshStartedAt,
      elapsedSeconds: refreshStartedAt ? Math.round((Date.now() - refreshStartedAt) / 1000) : null,
      logTotal: refreshLogTotal,
      logReset: since > refreshLogTotal,
      log: refreshLog.slice(from - firstHeld)
    });
    return;
  }

  if (url.split('?')[0] === '/history' && req.method === 'GET') {
    handleHistory(url, res).catch((err) => { console.error('[history]', err); sendJson(res, 500, { ok: false, error: 'History lookup failed.' }); });
    return;
  }

  serveStatic(req, url, res, req.url);
});

server.listen(PORT, () => {
  console.log(`Review Workload Dashboard server on http://localhost:${PORT}`);
  console.log(`  Static page:  http://localhost:${PORT}/workload-dashboard.html`);
  console.log(`  Refresh API:  POST http://localhost:${PORT}/refresh`);
  if (!process.env.PROJECTDOX_ADMIN_EMAIL || !process.env.PROJECTDOX_ADMIN_PASSWORD) {
    console.warn('WARNING: PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD are not set in this process\'s environment - /refresh will fail until they are.');
  }
  if (AUTO_REFRESH_MINUTES > 0) {
    console.log(`Auto-refresh:  ENABLED, every ${AUTO_REFRESH_MINUTES} minute(s).`);
    setInterval(() => {
      console.log('[auto-refresh] starting...');
      triggerRefresh()
        .then(({ tookSeconds }) => console.log(`[auto-refresh] done in ${tookSeconds}s.`))
        .catch((err) => console.error('[auto-refresh] failed:', err.message));
    }, AUTO_REFRESH_MINUTES * 60 * 1000);
  } else {
    console.log('Auto-refresh:  disabled (set AUTO_REFRESH_MINUTES to enable, e.g. 120 for every 2 hours).');
  }
});
