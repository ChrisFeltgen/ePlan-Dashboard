// HTTP server for the review-workload dashboard. Serves the page and the
// JSON snapshot, runs the collector (collector.js) on demand or on a timer,
// and exposes refresh progress and completed-task history.
//
// Run with:  node server.js
// The collector needs PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD in
// this process's environment.
//
// Routes:
//   GET  /, /workload-dashboard.html     dashboard page
//   GET  /data/workload-snapshot.json    latest snapshot
//   POST /refresh                        start a refresh (returns immediately)
//   GET  /refresh-status?since=N         progress, log lines and last result
//   GET  /history?from=&to= | ?date=     completed-task history

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { runCollector, readHistoryRange, isValidDateStr, daysBetween, easternToday, HISTORY_MAX_RANGE_DAYS } = require('./collector');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '5757', 10);
// Loopback by default: the app has no login of its own and is meant to sit
// behind a reverse proxy on the same machine. Set HOST=0.0.0.0 to listen on
// every interface.
const HOST = process.env.HOST || '127.0.0.1';
// Minimum gap between refreshes, applied after failures as well as successes
// so a bad credential can't be retried in a tight loop against ProjectDox.
const MIN_SECONDS_BETWEEN_REFRESHES = 300;

// Periodic auto-refresh, off unless AUTO_REFRESH_MINUTES is a positive number.
// The report-table fetch is memory-heavy, so intervals of a few hours are
// recommended.
const AUTO_REFRESH_MINUTES = parseInt(process.env.AUTO_REFRESH_MINUTES || '0', 10);
const MAX_TIMER_MS = 2 ** 31 - 1; // setInterval's upper bound

// The only files ever served. The app root also holds server code, and data/
// holds caches and history with project and reviewer details.
const STATIC_ALLOWLIST = new Map([
  ['/', 'workload-dashboard.html'],
  ['/workload-dashboard.html', 'workload-dashboard.html'],
  ['/data/workload-snapshot.json', path.join('data', 'workload-snapshot.json')]
]);

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const COMPRESSIBLE = new Set(['.html', '.json']);
const compressedCache = new Map(); // "encoding:path" -> { etag, body }

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};
// The page is a single file with inline script and style and no external
// resources; it only talks to this server.
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// --- refresh state -----------------------------------------------------------

let refreshInFlight = null; // Promise while a run is active; concurrent triggers share it
let refreshStartedAt = null;
let lastRefreshFinishedAt = 0;
let lastRefreshResult = null; // { startedAt, ok, tookSeconds?, generatedAt?, error? }
let refreshLog = []; // ring buffer of the current/last run's log lines
let refreshLogTotal = 0; // lines pushed this run, including any dropped from refreshLog
const REFRESH_LOG_MAX_LINES = 200;

function clientSafeError(message) {
  return Object.assign(new Error(message), { clientSafe: true });
}

// Raw error text (upstream responses, paths, stack details) stays in the
// server log; browsers get a generic message unless the error is marked safe.
function clientMessage(err) {
  return err && err.clientSafe ? err.message : 'Refresh failed - see the server log for details.';
}

function pushLog(msg) {
  refreshLog.push({ t: Date.now(), msg });
  refreshLogTotal++;
  if (refreshLog.length > REFRESH_LOG_MAX_LINES) refreshLog.shift();
}

// Starts a collector run, or returns the one already running. Throws a
// client-safe error if the previous run finished too recently.
function startRefresh() {
  if (refreshInFlight) return refreshInFlight;

  const secondsSinceLast = (Date.now() - lastRefreshFinishedAt) / 1000;
  if (lastRefreshFinishedAt && secondsSinceLast < MIN_SECONDS_BETWEEN_REFRESHES) {
    const wait = Math.ceil(MIN_SECONDS_BETWEEN_REFRESHES - secondsSinceLast);
    throw clientSafeError(`The last refresh finished ${Math.round(secondsSinceLast)}s ago. Please wait ${wait}s before starting another.`);
  }

  const startedAt = Date.now();
  refreshStartedAt = startedAt;
  refreshLog = [];
  refreshLogTotal = 0;

  refreshInFlight = runCollector({
    log: (msg) => {
      console.log('[collector]', msg);
      pushLog(msg);
    }
  })
    .then((result) => {
      lastRefreshResult = { startedAt, ok: true, tookSeconds: result.tookSeconds, generatedAt: result.snapshot.GeneratedAt };
      return result;
    })
    .catch((err) => {
      console.error('[collector] refresh failed:', err);
      pushLog(`ERROR: ${clientMessage(err)}`);
      lastRefreshResult = { startedAt, ok: false, error: clientMessage(err) };
      throw err;
    })
    .finally(() => {
      lastRefreshFinishedAt = Date.now();
      refreshInFlight = null;
    });

  return refreshInFlight;
}

// --- responses ---------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' }, BASE_HEADERS);
  // Small bodies aren't worth compressing; history ranges compress ~10x.
  if (body.length > 1024 && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '')) {
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

function sendText(res, status, text, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, BASE_HEADERS, extraHeaders));
  res.end(text);
}

// GET /history?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?date=YYYY-MM-DD for one day):
// completed-task summary for the inclusive range, read from the collector's
// per-day history files. A single day also returns its task list.
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
  if (daysBetween(from, clampedTo) + 1 > HISTORY_MAX_RANGE_DAYS) {
    sendJson(res, 400, { ok: false, error: `Range too long (max ${HISTORY_MAX_RANGE_DAYS} days).` });
    return;
  }
  const result = await readHistoryRange(from, clampedTo, { includeRows: from === clampedTo });
  sendJson(res, 200, Object.assign({ ok: true, Today: today }, result));
}

function serveStatic(req, pathname, res) {
  const rel = STATIC_ALLOWLIST.get(pathname);
  if (!rel) { sendText(res, 404, 'Not found'); return; }
  const filePath = path.join(ROOT, rel);
  const isHead = req.method === 'HEAD';

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) { sendText(res, 404, 'Not found'); return; }
    const ext = path.extname(filePath);
    // Validator from size + mtime: changes whenever the collector rewrites the
    // file, so an unchanged snapshot costs a bodyless 304 on each poll.
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // may be stored, but must be revalidated on every use
      'ETag': etag,
      'Vary': 'Accept-Encoding'
    }, BASE_HEADERS);
    if (ext === '.html') headers['Content-Security-Policy'] = PAGE_CSP;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const accept = req.headers['accept-encoding'] || '';
    const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (!encoding) {
      fs.readFile(filePath, (err, data) => {
        if (err) { sendText(res, 404, 'Not found'); return; }
        res.writeHead(200, Object.assign({ 'Content-Length': data.length }, headers));
        res.end(isHead ? undefined : data);
      });
      return;
    }
    // Compressed copies are cached per file + encoding until the file changes,
    // so the snapshot is compressed once per collector run, not per request.
    const cacheKey = `${encoding}:${filePath}`;
    const cached = compressedCache.get(cacheKey);
    const send = (body) => {
      res.writeHead(200, Object.assign({ 'Content-Encoding': encoding, 'Content-Length': body.length }, headers));
      res.end(isHead ? undefined : body);
    };
    if (cached && cached.etag === etag) { send(cached.body); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { sendText(res, 404, 'Not found'); return; }
      const done = (zErr, body) => {
        if (zErr) { res.writeHead(200, headers); res.end(isHead ? undefined : data); return; }
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

// --- routing -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (pathname === '/refresh') {
    if (req.method !== 'POST') { sendText(res, 405, 'Method not allowed', { Allow: 'POST' }); return; }
    // A custom header can't be sent cross-origin without a CORS preflight,
    // which this server never approves, so other sites can't trigger a refresh.
    if (req.headers['x-requested-with'] !== 'dashboard') {
      sendJson(res, 403, { ok: false, error: 'Missing X-Requested-With header.' });
      return;
    }
    // Responds as soon as the run starts; the page follows progress through
    // /refresh-status. Holding the request open for the whole run would hit
    // reverse-proxy timeouts on a cold refresh.
    try {
      startRefresh().catch(() => { /* recorded in lastRefreshResult and the log */ });
      sendJson(res, 202, { ok: true, startedAt: refreshStartedAt });
    } catch (err) {
      sendJson(res, err.clientSafe ? 429 : 500, { ok: false, error: clientMessage(err) });
    }
    return;
  }

  if (pathname === '/refresh-status') {
    if (req.method !== 'GET') { sendText(res, 405, 'Method not allowed', { Allow: 'GET' }); return; }
    // ?since=N: the caller already has the first N log lines of this run, so
    // only the rest are sent. A since beyond logTotal means a new run started.
    const since = parseInt(new URL(req.url, 'http://localhost').searchParams.get('since') || '0', 10) || 0;
    const firstHeld = refreshLogTotal - refreshLog.length; // the ring buffer may have dropped the oldest lines
    const from = since > refreshLogTotal ? firstHeld : Math.max(since, firstHeld);
    sendJson(res, 200, {
      refreshing: !!refreshInFlight,
      lastRefreshFinishedAt: lastRefreshFinishedAt || null,
      startedAt: refreshStartedAt,
      elapsedSeconds: refreshStartedAt ? Math.round((Date.now() - refreshStartedAt) / 1000) : null,
      lastResult: lastRefreshResult,
      logTotal: refreshLogTotal,
      logReset: since > refreshLogTotal,
      log: refreshLog.slice(from - firstHeld)
    });
    return;
  }

  if (pathname === '/history') {
    if (req.method !== 'GET') { sendText(res, 405, 'Method not allowed', { Allow: 'GET' }); return; }
    handleHistory(req.url, res).catch((err) => {
      console.error('[history]', err);
      sendJson(res, 500, { ok: false, error: 'History lookup failed.' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' }); return; }
  serveStatic(req, pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Review Workload Dashboard listening on http://${HOST}:${PORT}/`);
  if (!process.env.PROJECTDOX_ADMIN_EMAIL || !process.env.PROJECTDOX_ADMIN_PASSWORD) {
    console.warn('WARNING: PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD are not set - refreshes will fail until they are.');
  }
  if (AUTO_REFRESH_MINUTES > 0) {
    const intervalMs = Math.min(AUTO_REFRESH_MINUTES * 60 * 1000, MAX_TIMER_MS);
    console.log(`Auto-refresh: every ${Math.round(intervalMs / 60000)} minute(s).`);
    setInterval(() => {
      console.log('[auto-refresh] starting...');
      try {
        startRefresh()
          .then(({ tookSeconds }) => console.log(`[auto-refresh] done in ${tookSeconds}s.`))
          .catch((err) => console.error('[auto-refresh] failed:', err.message));
      } catch (err) {
        console.warn('[auto-refresh] skipped:', err.message);
      }
    }, intervalMs);
  } else {
    console.log('Auto-refresh: disabled (set AUTO_REFRESH_MINUTES to enable).');
  }
});
