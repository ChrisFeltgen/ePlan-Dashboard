// On-demand backend for the review-workload dashboard: serves the static
// page + JSON snapshot, and exposes POST /refresh which re-runs the
// collector (collector.js) right then, in-process - no PowerShell, no
// scheduled task. The collector's instance/reviewer caches make a warm
// refresh much faster than the first cold run.
//
// Run with:  node server.js
// Requires PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD set in this
// process's environment so the collector doesn't hang on an interactive
// credential prompt.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runCollector, readHistoryRange, isValidDateStr, listDates, easternToday, HISTORY_MAX_RANGE_DAYS } = require('./collector');

const ROOT = __dirname;
const PORT = process.env.PORT || 5757;
const MIN_SECONDS_BETWEEN_REFRESHES = 300; // guard against a refresh storm if several people click at once

// Optional periodic auto-refresh, off by default - set AUTO_REFRESH_MINUTES
// to a positive number to enable it (e.g. 120 for every 2 hours). Deliberately
// opt-in rather than defaulting to something like 15 minutes: this refresh
// can be memory-heavy (see collector.js's report-tables child process - this
// app has already hit a host memory limit mid-refresh once), so an aggressive
// interval on a constrained host trades a small freshness win for a real risk
// of tripping that limit more often, including while someone's actively
// looking at the page. A couple of times a day is plenty for most uses -
// every 2-4 hours is a reasonable starting point.
const AUTO_REFRESH_MINUTES = parseInt(process.env.AUTO_REFRESH_MINUTES || '0', 10);

// Set this if the app is reachable under a path prefix rather than at its
// own domain/subdomain root - e.g. BASE_PATH=/ePlan-Dashboard for
// https://scrapcraft.dev/ePlan-Dashboard/. Some Passenger/cPanel Node
// Selector setups proxy the request through with that prefix still on
// req.url instead of stripping it, which otherwise makes every route (and
// the "/" static-file lookup) miss and 404. Leave unset for a root-mounted
// deployment (including plain localhost dev) - nothing changes there.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

function stripBasePath(url) {
  if (BASE_PATH && url.startsWith(BASE_PATH)) {
    const rest = url.slice(BASE_PATH.length);
    return rest === '' ? '/' : rest;
  }
  return url;
}

// Optional HTTP Basic Auth gate. This dashboard shows internal review-
// workload data (project names, reviewer names, task assignments) - fine to
// leave open on a machine only reachable on a trusted local/office network,
// but not once it's reachable from the public internet. Set both env vars to
// require a login; leave either unset and the app runs exactly as before
// (unauthenticated), which is what local development still wants.
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_ENABLED = !!(DASHBOARD_USER && DASHBOARD_PASSWORD);

function isAuthorized(req) {
  const header = req.headers['authorization'] || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  return decoded.slice(0, sep) === DASHBOARD_USER && decoded.slice(sep + 1) === DASHBOARD_PASSWORD;
}

const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

let refreshInFlight = null; // Promise, so concurrent requests share one run instead of stacking
let lastRefreshFinishedAt = 0;
let refreshStartedAt = null;
let refreshLog = []; // collector.js's own log() lines from the current/last run, for /refresh-status to expose
const REFRESH_LOG_MAX_LINES = 200;

function triggerRefresh() {
  if (refreshInFlight) return refreshInFlight; // already running - share it, don't start a second one

  const secondsSinceLast = (Date.now() - lastRefreshFinishedAt) / 1000;
  if (lastRefreshFinishedAt && secondsSinceLast < MIN_SECONDS_BETWEEN_REFRESHES) {
    return Promise.reject(new Error(`A refresh finished ${Math.round(secondsSinceLast)}s ago - please wait a bit before triggering another (min ${MIN_SECONDS_BETWEEN_REFRESHES}s apart).`));
  }

  refreshStartedAt = Date.now();
  refreshLog = [];

  refreshInFlight = runCollector({
    log: (msg) => {
      console.log('[collector]', msg);
      refreshLog.push({ t: Date.now(), msg });
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
      refreshLog.push({ t: Date.now(), msg: `ERROR: ${err.message}` });
      throw err;
    });

  return refreshInFlight;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

function serveStatic(url, res, rawUrl) {
  let filePath = path.join(ROOT, decodeURIComponent(url.split('?')[0]));
  if (url === '/') filePath = path.join(ROOT, 'workload-dashboard.html');
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      // TEMP DIAG - root-causing the cPanel subpath 404; safe to leave (no
      // secrets), but trim back to plain "Not found" once this is resolved.
      res.end(`Not found. [diag] rawUrl=${JSON.stringify(rawUrl)} BASE_PATH=${JSON.stringify(BASE_PATH)} strippedUrl=${JSON.stringify(url)} filePath=${JSON.stringify(filePath)}`);
      return;
    }
    const ext = path.extname(filePath);
    // No caching: this file gets edited frequently, and a stale cached copy
    // in the browser (showing old columns/layout after an update) is a much
    // more confusing failure mode than re-fetching a few KB on every load.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // If the app is mounted under a path prefix (BASE_PATH) and someone hits
  // that exact path with no trailing slash (e.g. /ePlan-Dashboard instead
  // of /ePlan-Dashboard/), serving the page in place - rather than
  // redirecting - leaves the browser's own address bar without the trailing
  // slash. Every relative URL the page then requests (workload-snapshot.json,
  // /refresh, ...) resolves against the PARENT directory instead of this
  // one, since a trailing path segment with no slash is treated as a
  // filename per URL resolution rules - breaking the very first fetch
  // (reported as "Could not load workload-snapshot.json"). A conventional
  // static file server (e.g. Apache's mod_dir) already redirects a
  // directory request like this automatically; this app has to do it itself
  // since Passenger hands the raw request straight through.
  if (BASE_PATH) {
    const rawPath = req.url.split('?')[0];
    if (rawPath === BASE_PATH) {
      const qsIndex = req.url.indexOf('?');
      const qs = qsIndex === -1 ? '' : req.url.slice(qsIndex);
      res.writeHead(302, { Location: BASE_PATH + '/' + qs });
      res.end();
      return;
    }
  }

  if (AUTH_ENABLED && !isAuthorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Review Workload Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Authentication required.');
    return;
  }

  const url = stripBasePath(req.url);

  if (url === '/refresh' && req.method === 'POST') {
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
        sendJson(res, 500, { ok: false, error: err.message });
      });
    return;
  }

  if (url === '/refresh-status' && req.method === 'GET') {
    sendJson(res, 200, {
      refreshing: !!refreshInFlight,
      lastRefreshFinishedAt: lastRefreshFinishedAt || null,
      startedAt: refreshStartedAt,
      elapsedSeconds: refreshStartedAt ? Math.round((Date.now() - refreshStartedAt) / 1000) : null,
      log: refreshLog
    });
    return;
  }

  if (url.split('?')[0] === '/history' && req.method === 'GET') {
    handleHistory(url, res).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  serveStatic(url, res, req.url);
});

server.listen(PORT, () => {
  console.log(`Review Workload Dashboard server on http://localhost:${PORT}`);
  console.log(`  Static page:  http://localhost:${PORT}/workload-dashboard.html`);
  console.log(`  Refresh API:  POST http://localhost:${PORT}/refresh`);
  if (BASE_PATH) console.log(`  Base path:    ${BASE_PATH} (stripped from incoming request URLs before routing)`);
  if (!process.env.PROJECTDOX_ADMIN_EMAIL || !process.env.PROJECTDOX_ADMIN_PASSWORD) {
    console.warn('WARNING: PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD are not set in this process\'s environment - /refresh will fail until they are.');
  }
  if (AUTH_ENABLED) {
    console.log('HTTP Basic Auth: ENABLED (DASHBOARD_USER/DASHBOARD_PASSWORD are set).');
  } else {
    console.warn('WARNING: DASHBOARD_USER / DASHBOARD_PASSWORD are not set - this app is running WITHOUT a login. Fine on a trusted local/office network; set both before exposing it publicly.');
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
