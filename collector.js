// Builds the review-workload snapshot from the ProjectDox API and maintains
// the per-day completed-task history. Called in-process by server.js, or run
// standalone:
//   node collector.js
//
// Requires PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD in the
// environment.

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const ROOT = __dirname;
const BASE_URL = 'https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com';
const APP_VERSION = readJsonSafe(path.join(ROOT, 'package.json'), {}).version || 'unknown';

// All generated files (caches, snapshot, history) live under data/.
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const INSTANCE_CACHE_JSON = path.join(DATA_DIR, 'workload-instance-cache.json');
const USER_CACHE_JSON = path.join(DATA_DIR, 'workload-user-cache.json');
const PROJECT_CACHE_JSON = path.join(DATA_DIR, 'workload-project-cache.json');
const REVISION_INSTANCES_CACHE_JSON = path.join(DATA_DIR, 'workload-revision-instances-cache.json');
const REPORT_TABLES_CACHE_JSON = path.join(DATA_DIR, 'workload-report-tables-cache.json');
const COMPLETED_TODAY_CACHE_JSON = path.join(DATA_DIR, 'workload-completed-today-cache.json');
const SNAPSHOT_JSON = path.join(DATA_DIR, 'workload-snapshot.json');

// Stored on every cache entry. Bump it whenever a field is added to what an
// instance/project/revision/report-tables cache entry holds: entries with a
// different version are treated as stale regardless of age, so they are
// refetched with the new field instead of being reused until their TTL expires.
const CACHE_SCHEMA_VERSION = 6;

// Cache lifetimes, in minutes. Each entry's actual lifetime is jittered
// between 75% and 125% of these (see isFresh), so entries cached together on
// a cold start don't all expire in the same refresh.
//
// Workflow instance: project, template and revision never change; the cached
// state (Active or not) is re-checked at this interval.
const MAX_INSTANCE_CACHE_AGE_MIN = 8 * 60;
// Reviewer names.
const MAX_USER_CACHE_AGE_MIN = 3 * 1440;
// Project number, description and location.
const MAX_PROJECT_CACHE_AGE_MIN = 3 * 1440;
// A project's list of revision instances. Also refetched as soon as a
// revision appears that isn't in the cached list.
const MAX_REVISION_CACHE_AGE_MIN = 7 * 1440;
// The Report* tables are an append-only historical mirror of several hundred
// thousand rows. A long TTL keeps most refreshes from re-downloading them; the
// cost is that history for an instance closed within the TTL appears late.
const MAX_REPORT_TABLES_CACHE_AGE_MIN = 360;
const CONCURRENCY = 15; // parallel REST lookups for instance/user/project resolution

// Per-request time limits, so a stalled connection fails the request instead
// of leaving the refresh running forever.
const REQUEST_TIMEOUT_MS = 60 * 1000; // single-record REST calls and login
const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // whole-table QueryDatabase calls
const STREAM_TIMEOUT_MS = 20 * 60 * 1000; // streamed Report* table downloads
const REPORT_CHILD_TIMEOUT_MS = 45 * 60 * 1000; // the whole report-tables child process

// --- small utilities ---------------------------------------------------

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    return fallback;
  }
}

// Written to a temp file and renamed into place, so a reader (the web server,
// or the next run) never sees a partially written file.
function writeFileAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Windows can refuse the rename while another process (e.g. antivirus)
    // holds the target open; fall back to a direct write.
    fs.writeFileSync(filePath, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
  }
}

// compact: no indentation, for files the browser downloads and parses.
function writeJson(filePath, obj, { compact = false } = {}) {
  writeFileAtomic(filePath, compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
}

// Stable value in [0, 1) derived from a cache key.
function keyFraction(key) {
  let h = 2166136261;
  const str = String(key);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// True if a cache entry has the current schema and is younger than its
// lifetime: maxAgeMin scaled by a per-key factor between 0.75 and 1.25.
function isFresh(entry, maxAgeMin, now, key) {
  if (!entry || !entry.CachedAt || entry.SchemaVersion !== CACHE_SCHEMA_VERSION) return false;
  const lifetimeMin = maxAgeMin * (0.75 + 0.5 * keyFraction(key));
  return (now - new Date(entry.CachedAt).getTime()) / 60000 < lifetimeMin;
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- ProjectDox API ------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where retry notices go: the collector's log once a run is underway (so they
// appear in the dashboard's "Show details" panel), plain console otherwise.
// Set per run by runCollector() and by the report-tables child.
let retryLog = (msg) => console.warn(msg);

// fetch() with a time limit covering both the response and reading its body.
function apiFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(timeoutMs) }));
}

// Retries a QueryDatabase request after a transient gateway/overload status
// or a network-level failure. These requests are read-only selects, so
// repeating them is safe. Only the request is retried: once a response body
// has started streaming into a caller's onRow callback, a failure part-way
// through is not retried, since the caller has already received those rows.
const RETRY_DELAYS_MS = [3000, 8000, 20000];
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
async function fetchWithRetry(url, options, label, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    let failure;
    try {
      res = await apiFetch(url, options, timeoutMs);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) return res;
      failure = `HTTP ${res.status}`;
      try { await res.body.cancel(); } catch (e) { /* body already closed */ }
    } catch (e) {
      failure = e.message; // network-level failure (reset connection, DNS, timeout...)
    }
    if (attempt >= RETRY_DELAYS_MS.length) {
      if (res) return res; // out of retries: hand back the last HTTP response, callers turn !res.ok into their own error
      throw new Error(`${label}: ${failure}`);
    }
    retryLog(`WARN: ${label} ${failure} - retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

async function login() {
  const email = process.env.PROJECTDOX_ADMIN_EMAIL;
  const password = process.env.PROJECTDOX_ADMIN_PASSWORD;
  if (!email || !password) {
    throw Object.assign(new Error('PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD are not set on the server.'), { clientSafe: true });
  }
  const res = await apiFetch(`${BASE_URL}/User/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Email: email, Password: password })
  });
  if (!res.ok) throw new Error(`User/Login HTTP ${res.status}`);
  const data = await res.json();
  if (!data.SessionID) throw new Error('Login succeeded but the response had no SessionID.');
  return data.SessionID;
}

function queryDatabaseRequest(sessionId, tableName) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', SessionID: sessionId },
    body: JSON.stringify({ IsProjectDox: true, ConnectionString: null, Operation: 'select', TableName: tableName })
  };
}

// Whole table as an array. The response is shaped {"<TableName>": [ ... ]},
// with the key's casing not guaranteed to match the request.
async function queryTable(sessionId, tableName) {
  const res = await fetchWithRetry(`${BASE_URL}/Query/QueryDatabase`, queryDatabaseRequest(sessionId, tableName),
    `Query/QueryDatabase(${tableName})`, QUERY_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Query/QueryDatabase(${tableName}) HTTP ${res.status}`);
  const data = await res.json();
  const key = Object.keys(data).find((k) => k.toLowerCase() === tableName.toLowerCase());
  return key ? data[key] : [];
}

// Same request as queryTable(), but parses the response body as it streams
// in and calls onRow(row) once per row object, so the full response is never
// held in memory. Used for the very large Report* tables, whose callers slim
// each row and discard the rest immediately.
//
// Scanner: the first top-level `[` (outside any string) starts the row array;
// each balanced `{...}` inside it is one row, passed to JSON.parse(). String
// and escape state are tracked so braces inside string values are ignored.
async function streamQueryTableRows(sessionId, tableName, onRow) {
  const res = await fetchWithRetry(`${BASE_URL}/Query/QueryDatabase`, queryDatabaseRequest(sessionId, tableName),
    `Query/QueryDatabase(${tableName})`, STREAM_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Query/QueryDatabase(${tableName}) HTTP ${res.status}`);
  if (!res.body) throw new Error(`Query/QueryDatabase(${tableName}): response has no readable body to stream`);

  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();

  let state = 'SEEK_ARRAY'; // SEEK_ARRAY -> SEEK_OBJECT -> IN_OBJECT (loops back to SEEK_OBJECT per row) -> DONE
  let inString = false;
  let escapeNext = false;
  let objDepth = 0;
  let objText = '';
  let rowCount = 0;

  function feed(chunkText) {
    for (let i = 0; i < chunkText.length; i++) {
      const ch = chunkText[i];
      if (state === 'IN_OBJECT') objText += ch;

      if (escapeNext) { escapeNext = false; continue; }
      if (inString) {
        if (ch === '\\') { escapeNext = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }

      if (state === 'SEEK_ARRAY') {
        if (ch === '[') state = 'SEEK_OBJECT';
      } else if (state === 'SEEK_OBJECT') {
        if (ch === '{') { state = 'IN_OBJECT'; objDepth = 1; objText = '{'; }
        else if (ch === ']') { state = 'DONE'; }
      } else if (state === 'IN_OBJECT') {
        if (ch === '{') objDepth++;
        else if (ch === '}') {
          objDepth--;
          if (objDepth === 0) {
            onRow(JSON.parse(objText));
            rowCount++;
            objText = '';
            state = 'SEEK_OBJECT';
          }
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
      if (state === 'DONE') break; // the row array is complete; ignore the rest of the body
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* stream already closed */ }
  }

  return rowCount;
}

async function getJson(sessionId, url, label) {
  const res = await apiFetch(url, { headers: { SessionID: sessionId } });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

function getWorkflowInstance(sessionId, wflowInstanceID) {
  return getJson(sessionId, `${BASE_URL}/WorkflowInstance/GetWorkflowInstance?wflowInstanceID=${encodeURIComponent(wflowInstanceID)}`,
    `GetWorkflowInstance(${wflowInstanceID})`);
}

function getUser(sessionId, userID) {
  return getJson(sessionId, `${BASE_URL}/User/GetUser?userID=${encodeURIComponent(userID)}`, `GetUser(${userID})`);
}

function getProject(sessionId, projectID) {
  return getJson(sessionId, `${BASE_URL}/Project/GetProject?projectID=${encodeURIComponent(projectID)}`, `GetProject(${projectID})`);
}

async function getWorkflowInstancesByProjectName(sessionId, projectName) {
  const data = await getJson(sessionId,
    `${BASE_URL}/WorkflowInstance/GetWorkflowInstancesByProjectName?projectName=${encodeURIComponent(projectName)}`,
    `GetWorkflowInstancesByProjectName(${projectName})`);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

// Each revision of a project is its own workflow instance, named like
// "BP00-00000000 R001: DESCRIPTION" (R000 = original submission, R001+ =
// revisions), with its own independent review-cycle counter. Returns the
// revision number, or null if the name doesn't carry one.
function parseRevision(instanceName) {
  if (!instanceName) return null;
  const m = instanceName.match(/\bR0*(\d+)\s*:/);
  return m ? parseInt(m[1], 10) : null;
}

function instanceCacheEntry(inst) {
  return {
    WFlowInstanceID: inst.WFlowInstanceID,
    WFlowID: inst.WFlowID,
    EntityID: inst.EntityID, // the ProjectID
    WFlowInstanceStateID: inst.WFlowInstanceStateID, // 1 = Active
    WFlowInstanceStateName: inst.WFlowInstanceStateName,
    InstanceName: inst.InstanceName,
    Revision: parseRevision(inst.InstanceName),
    DateCompleted: inst.DateCompleted,
    SchemaVersion: CACHE_SCHEMA_VERSION,
    CachedAt: new Date().toISOString()
  };
}

function userDisplayName(u) {
  return u.FullName || `${u.FirstName || ''} ${u.LastName || ''}`.trim() || u.Email || null;
}

// --- report tables: fetched in an isolated child process ------------------
//
// ReportWFlowTasks and ReportWFlowReviewCycles together hold several hundred
// thousand rows, and the raw ReportWFlowTasks rows are wide (27 columns,
// some with long HTML text). They are downloaded by a short-lived child
// process (`node collector.js --fetch-report-tables`) that streams them,
// keeps only the needed columns, and writes them to REPORT_TABLES_CACHE_JSON.
// The download's peak memory therefore never lands in the long-running server
// process, and is returned to the OS when the child exits. The parent only
// reads back the slimmed rows.

function sendProgress(msg) {
  if (process.send) process.send({ type: 'log', text: msg });
  else console.log(msg);
}

// Streams one Report* table into the already-open cache file as it arrives:
// each row is slimmed, serialized and written in batches, so no table is ever
// held in memory in full.
async function streamTableIntoCache(sessionId, fd, cacheKey, tableName, slim, isFirstKey) {
  fs.writeFileSync(fd, (isFirstKey ? '' : ',') + JSON.stringify(cacheKey) + ':[');
  let pending = [];
  let written = 0;
  const flush = () => {
    if (!pending.length) return;
    fs.writeFileSync(fd, (written ? ',' : '') + pending.join(','));
    written += pending.length;
    pending = [];
  };
  const count = await streamQueryTableRows(sessionId, tableName, (row) => {
    pending.push(JSON.stringify(slim(row)));
    if (pending.length >= 2000) flush();
  });
  flush();
  fs.writeFileSync(fd, ']');
  return count;
}

async function fetchAndCacheReportTables() {
  retryLog = sendProgress; // retry notices travel over the same IPC channel as progress lines
  const sessionId = await login();

  // Only the columns used downstream are kept. ReportWFlowTasks keeps enough
  // to render a completed task on its own, because once a workflow instance
  // closes its tasks exist only in this table, not in live WFlowTasks.
  //
  // Written to a temp file and renamed into place once complete, so a failed
  // or killed run leaves the previous cache intact.
  const tmpPath = REPORT_TABLES_CACHE_JSON + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, '{');

    const taskCount = await streamTableIntoCache(sessionId, fd, 'reportTasks', 'ReportWFlowTasks', (t) => ({
      WFlowTaskID: t.WFlowTaskID, WFlowTaskStatusTypeID: t.WFlowTaskStatusTypeID,
      WFlowReviewCycleID: t.WFlowReviewCycleID, UserID: t.UserID, GroupName: t.GroupName, DateCompleted: t.DateCompleted,
      GroupID: t.GroupID, TaskName: t.TaskName, DateCreated: t.DateCreated, DateAccepted: t.DateAccepted,
      DateDue: t.DateDue, WFlowTaskAssignmentTypeID: t.WFlowTaskAssignmentTypeID, WFlowActivityID: t.WFlowActivityID
    }), true);
    sendProgress(`ReportWFlowTasks: ${taskCount} rows (streamed)`);

    const cycleCount = await streamTableIntoCache(sessionId, fd, 'reportReviewCycles', 'ReportWFlowReviewCycles', (c) => ({
      WFlowReviewCycleID: c.WFlowReviewCycleID, WFlowInstanceID: c.WFlowInstanceID, ReviewCycle: c.ReviewCycle
    }));
    sendProgress(`ReportWFlowReviewCycles: ${cycleCount} rows (streamed)`);

    // SchemaVersion/CachedAt go last: peekReportTablesCacheMeta() reads only
    // the tail of this file to check freshness without parsing it.
    fs.writeFileSync(fd, `,"SchemaVersion":${CACHE_SCHEMA_VERSION},"CachedAt":${JSON.stringify(new Date().toISOString())}}`);
    fs.closeSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
    try { fs.unlinkSync(tmpPath); } catch (e) { /* nothing to clean up */ }
    throw err;
  }
  fs.renameSync(tmpPath, REPORT_TABLES_CACHE_JSON);
}

// Runs fetchAndCacheReportTables() in a child process and waits for it.
// Never rejects: a failure, kill or timeout resolves to { ok: false } so the
// refresh can continue with the previous cache (or without report data).
function runReportTablesChildProcess(log) {
  return new Promise((resolve) => {
    const child = fork(__filename, ['--fetch-report-tables'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderrBuf = '';
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, REPORT_CHILD_TIMEOUT_MS);
    child.on('message', (msg) => { if (msg && msg.type === 'log') log(msg.text); });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      if (stderrBuf.length < 4000) stderrBuf += d.toString();
      process.stderr.write(d);
    });
    child.on('error', (err) => { clearTimeout(watchdog); resolve({ ok: false, reason: err.message }); });
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      if (code === 0) { resolve({ ok: true }); return; }
      const reason = timedOut
        ? `child process stopped after exceeding ${REPORT_CHILD_TIMEOUT_MS / 60000} minutes`
        : signal
          ? `child process killed by ${signal} (possibly a memory limit)`
          : `child process exited with code ${code}`;
      resolve({ ok: false, reason, stderr: stderrBuf.trim() });
    });
  });
}

// Reads SchemaVersion/CachedAt from the last bytes of the report-tables cache
// without parsing the (very large) file. Returns null for a missing or
// unrecognized file, which callers treat as "no usable cache".
function peekReportTablesCacheMeta() {
  let fd;
  try {
    const size = fs.statSync(REPORT_TABLES_CACHE_JSON).size;
    const len = Math.min(size, 512);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(REPORT_TABLES_CACHE_JSON, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const m = buf.toString('utf8').match(/"SchemaVersion":(\d+),"CachedAt":"([^"]+)"\}\s*$/);
    return m ? { SchemaVersion: Number(m[1]), CachedAt: m[2] } : null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

// --- completed-task summary (shared by today's snapshot and history) -------

// Within a workflow, "Review Coordinator" and "Submissions" are process/
// routing groups, not technical review disciplines. They are reported
// separately ("Operations", shown as "Routing" on the page) so routing work
// doesn't dilute the review-group breakdown.
const OPERATIONS_GROUP_RE = /^(review coordinator|submissions)$/i;
// Applicant/Fee Group tasks are self-service steps, not staff work, and are
// excluded from every completed-task count.
const SELF_SERVICE_GROUP_RE = /^(applicant|fee group)$/i;

function sortedCountArray(map, nameField) {
  return [...map.entries()]
    .map(([k, count]) => ({ [nameField]: k, Count: count }))
    .sort((a, b) => b.Count - a.Count || String(a[nameField]).localeCompare(String(b[nameField])));
}
// Each user entry carries a per-task breakdown (ByTask), used by the page's
// task-breakdown popover for routing staff.
function sortedUserArray(map) {
  return [...map.values()]
    .sort((a, b) => b.Count - a.Count || (a.UserName || '').localeCompare(b.UserName || ''))
    .map((u) => ({ UserID: u.UserID, UserName: u.UserName, Count: u.Count, ByTask: sortedCountArray(u.ByTask, 'TaskName') }));
}
// Normalizes a task name for the per-person ByTask breakdown so variants of
// the same step count together:
//  - strips the " (Reassigned from <name>)" suffix ProjectDox appends when a
//    task is reassigned (greedy, so names containing parentheses still work);
//  - collapses "Assign Requested Reviews for Department Review for Review
//    Cycle #N" to "Assign Requested Reviews" across cycle numbers.
// Raw task names are kept everywhere else.
function baseTaskName(taskName) {
  return (taskName || '')
    .replace(/\s*\(Reassigned from .*\)\s*$/i, '')
    .trim()
    .replace(/^Assign Requested Reviews\s+for Department Review for Review Cycle #\d+$/i, 'Assign Requested Reviews')
    || 'Unknown task';
}
function bumpUser(map, key, userId, userName, taskName) {
  if (!map.has(key)) map.set(key, { UserID: userId, UserName: userName || 'Unknown', Count: 0, ByTask: new Map() });
  const entry = map.get(key);
  entry.Count++;
  const tName = baseTaskName(taskName);
  entry.ByTask.set(tName, (entry.ByTask.get(tName) || 0) + 1);
}

// Incremental so a multi-month range can be summarized one day-file at a
// time without ever holding every raw row in memory at once. add() takes a
// normalized row: { WorkflowTemplate, GroupName, UserID, UserName, TaskName }
// (already filtered to completed, non-self-service tasks). Unnamed/unresolved
// reviewers (UserID missing or the GetUser lookup failed) are grouped under a
// single "Unknown" bucket rather than dropped, so the totals still reconcile.
function createCompletedSummary() {
  const byTemplate = new Map(); // WorkflowTemplate -> { Count, Operations: {Count, ByGroup, ByUser}, ReviewGroups: {...} }
  const byGroupFlat = new Map(); // template::group -> { WorkflowTemplate, GroupName, IsOperations, Count, ByUser }
  const byReviewerFlat = new Map(); // userKey -> { UserID, UserName, Count, ByWorkflow, ByGroup }

  function add(r) {
    const template = r.WorkflowTemplate || 'Unknown';
    const groupName = (r.GroupName || '').trim() || 'Unknown';
    const isOps = OPERATIONS_GROUP_RE.test(groupName);
    const userKey = r.UserID != null ? String(r.UserID) : 'unknown';
    const userName = r.UserName || 'Unknown';

    if (!byTemplate.has(template)) {
      byTemplate.set(template, {
        WorkflowTemplate: template, Count: 0,
        Operations: { Count: 0, ByGroup: new Map(), ByUser: new Map() },
        ReviewGroups: { Count: 0, ByGroup: new Map(), ByUser: new Map() }
      });
    }
    const t = byTemplate.get(template);
    t.Count++;
    const bucket = isOps ? t.Operations : t.ReviewGroups;
    bucket.Count++;
    bucket.ByGroup.set(groupName, (bucket.ByGroup.get(groupName) || 0) + 1);
    bumpUser(bucket.ByUser, userKey, r.UserID, userName, r.TaskName);

    const gKey = `${template}::${groupName}`;
    if (!byGroupFlat.has(gKey)) {
      byGroupFlat.set(gKey, { WorkflowTemplate: template, GroupName: groupName, IsOperations: isOps, Count: 0, ByUser: new Map() });
    }
    const gf = byGroupFlat.get(gKey);
    gf.Count++;
    bumpUser(gf.ByUser, userKey, r.UserID, userName, r.TaskName);

    if (!byReviewerFlat.has(userKey)) {
      byReviewerFlat.set(userKey, { UserID: r.UserID, UserName: userName, Count: 0, OperationsCount: 0, ReviewGroupsCount: 0, ByWorkflow: new Map(), ByGroup: new Map() });
    }
    const rf = byReviewerFlat.get(userKey);
    rf.Count++;
    if (isOps) rf.OperationsCount++; else rf.ReviewGroupsCount++;
    rf.ByWorkflow.set(template, (rf.ByWorkflow.get(template) || 0) + 1);
    rf.ByGroup.set(groupName, (rf.ByGroup.get(groupName) || 0) + 1);
  }

  function finish() {
    return {
      TotalCount: [...byTemplate.values()].reduce((s, t) => s + t.Count, 0),
      WorkflowCount: byTemplate.size,
      GroupCount: byGroupFlat.size,
      StaffCount: byReviewerFlat.size,
      ByWorkflow: [...byTemplate.values()].map((t) => ({
        WorkflowTemplate: t.WorkflowTemplate,
        Count: t.Count,
        Operations: { Count: t.Operations.Count, ByGroup: sortedCountArray(t.Operations.ByGroup, 'GroupName'), ByUser: sortedUserArray(t.Operations.ByUser) },
        ReviewGroups: { Count: t.ReviewGroups.Count, ByGroup: sortedCountArray(t.ReviewGroups.ByGroup, 'GroupName'), ByUser: sortedUserArray(t.ReviewGroups.ByUser) }
      })).sort((a, b) => b.Count - a.Count || a.WorkflowTemplate.localeCompare(b.WorkflowTemplate)),
      ByGroup: [...byGroupFlat.values()].map((g) => ({
        WorkflowTemplate: g.WorkflowTemplate, GroupName: g.GroupName, IsOperations: g.IsOperations, Count: g.Count,
        ByUser: sortedUserArray(g.ByUser)
      })).sort((a, b) => b.Count - a.Count || a.GroupName.localeCompare(b.GroupName)),
      ByReviewer: [...byReviewerFlat.values()].map((r) => ({
        UserID: r.UserID, UserName: r.UserName, Count: r.Count,
        OperationsCount: r.OperationsCount, ReviewGroupsCount: r.ReviewGroupsCount,
        ByWorkflow: sortedCountArray(r.ByWorkflow, 'WorkflowTemplate'),
        ByGroup: sortedCountArray(r.ByGroup, 'GroupName')
      })).sort((a, b) => b.Count - a.Count || a.UserName.localeCompare(b.UserName))
    };
  }
  return { add, finish };
}

// --- completed-task history (one file per Eastern calendar day) -------------
//
// A completed task is visible in live WFlowTasks only while its workflow
// instance is open, and in the Report* mirror only after the instance closes
// and the mirror catches up; in between it can be in neither. Each refresh
// therefore records the completions it sees into a per-day file, and a day's
// file only ever gains rows, so a task seen once is kept. One file per day
// lets a range request read only the days it needs, one at a time.

const HISTORY_DIR = path.join(DATA_DIR, 'workload-history');
// Permanent project lookups for history rows (project number, location and
// description don't change), plus timestamps of failed lookups so a deleted
// user/project/instance isn't requested again on every refresh.
const HISTORY_LOOKUPS_JSON = path.join(DATA_DIR, 'workload-history-lookups.json');
const HISTORY_LOOKUP_RETRY_MS = 24 * 3600 * 1000; // wait this long before retrying a failed lookup
// How many days back history is kept and backfilled.
const HISTORY_DAYS = Math.max(1, parseInt(process.env.HISTORY_DAYS || '90', 10) || 90);
// A missing day can need hundreds of lookups, so backfill is capped per run;
// history fills in over several refreshes.
const HISTORY_MAX_NEW_DAYS_PER_RUN = Math.max(0, parseInt(process.env.HISTORY_MAX_NEW_DAYS_PER_RUN || '15', 10) || 15);
// Days within this window are re-derived (rows added, never removed) at most
// every HISTORY_RESETTLE_MIN_AGE_HOURS, because a just-closed workflow's tasks
// reach the Report* mirror late. Older days are treated as settled.
const HISTORY_RESETTLE_DAYS = 14;
const HISTORY_RESETTLE_MIN_AGE_HOURS = 12;
// Opt-in: also re-derive settled days whose rows predate a field added to the
// row format (see dayNeedsSchemaBackfill), a few per run within the same
// budget as new-day backfill. A no-op once every day has the field.
const HISTORY_FORCE_RESCHEMA = !!process.env.HISTORY_FORCE_RESCHEMA;
const HISTORY_MAX_RANGE_DAYS = 400; // longest range /history will summarize

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Calendar arithmetic on YYYY-MM-DD strings, anchored at noon UTC so DST
// changes can never shift a date.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);
}
function listDates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
// ProjectDox timestamps are naive local (Eastern) times, so "today" is the
// Eastern calendar date regardless of the server's own time zone.
function easternToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function historyFile(date) { return path.join(HISTORY_DIR, `${date}.json`); }
function listHistoryDates() {
  try {
    return fs.readdirSync(HISTORY_DIR).map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map((m) => m[1]).sort();
  } catch (e) {
    return [];
  }
}
function readHistoryDay(date) {
  return readJsonSafe(historyFile(date), null);
}
function writeHistoryDay(date, obj) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileAtomic(historyFile(date), JSON.stringify(obj));
}

// Compact stored history row:
//   id=WFlowTaskID  wf=workflow template  grp=group  uid/user=who completed it
//   task=raw task name  pid/proj/loc/desc=project id/number/location/description
//   at=DateCompleted
// Text fields are trimmed because the database right-pads CHAR columns with
// spaces.
function toHistoryRow(r) {
  const trimmed = (s) => (s == null ? null : (String(s).trim() || null));
  return {
    id: r.id, wf: r.wf || null, grp: trimmed(r.grp), uid: r.uid != null ? r.uid : null, user: r.user || null,
    task: r.task || null, pid: r.pid != null ? r.pid : null, proj: trimmed(r.proj), loc: trimmed(r.loc),
    desc: trimmed(r.desc), at: r.at || null
  };
}
// True if a recorded day has rows written before the `desc` field existed.
// toHistoryRow always sets every key (possibly to null), so a missing key
// means an older row format.
function dayNeedsSchemaBackfill(date) {
  const day = readHistoryDay(date);
  if (!day || !Array.isArray(day.rows) || !day.rows.length) return false;
  return day.rows.some((r) => !Object.prototype.hasOwnProperty.call(r, 'desc'));
}
function historyRowToSummaryRow(h) {
  return { WorkflowTemplate: h.wf, GroupName: h.grp, UserID: h.uid, UserName: h.user, TaskName: h.task };
}
// Per-workflow counts for one day, split into reviews vs routing, for the
// page's daily chart. Stored rows are already self-service-filtered.
function tallyDayByWorkflow(rows) {
  const byWf = new Map();
  for (const h of rows) {
    const wf = h.wf || 'Unknown';
    if (!byWf.has(wf)) byWf.set(wf, { WorkflowTemplate: wf, Count: 0, ReviewsCount: 0, RoutingCount: 0 });
    const e = byWf.get(wf);
    e.Count++;
    if (OPERATIONS_GROUP_RE.test((h.grp || '').trim())) e.RoutingCount++; else e.ReviewsCount++;
  }
  return [...byWf.values()].sort((a, b) => b.Count - a.Count || a.WorkflowTemplate.localeCompare(b.WorkflowTemplate));
}

// Summary (and, with includeRows, the task list) for an inclusive date range,
// read from the day files one at a time. MissingDays lists days with no
// recorded file so the page can flag them rather than show them as zero.
async function readHistoryRange(from, to, opts = {}) {
  const includeRows = !!opts.includeRows;
  const dates = listDates(from, to);
  const allDates = listHistoryDates();
  const available = new Set(allDates);
  const acc = createCompletedSummary();
  const byDay = [];
  const missingDays = [];
  const rows = [];
  for (const date of dates) {
    if (!available.has(date)) { missingDays.push(date); continue; }
    const day = await fs.promises.readFile(historyFile(date), 'utf8').then((s) => JSON.parse(stripBom(s))).catch(() => null);
    if (!day || !Array.isArray(day.rows)) { missingDays.push(date); continue; }
    for (const h of day.rows) acc.add(historyRowToSummaryRow(h));
    byDay.push({ Date: date, Count: day.rows.length, ByWorkflow: tallyDayByWorkflow(day.rows) });
    if (includeRows) for (const h of day.rows) rows.push(h);
  }
  if (includeRows) rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return {
    from, to,
    Summary: acc.finish(),
    ByDay: byDay,
    MissingDays: missingDays,
    EarliestAvailable: allDates[0] || null,
    LatestAvailable: allDates[allDates.length - 1] || null,
    Rows: includeRows ? rows : undefined
  };
}

// --- main collector --------------------------------------------------------

async function runCollector(opts = {}) {
  const log = opts.log || (() => {});
  const startedAt = Date.now();

  retryLog = log;
  log(`Collector version ${APP_VERSION}`);
  log('Loading reference data...');

  const instanceCache = readJsonSafe(INSTANCE_CACHE_JSON, {});
  log(`${Object.keys(instanceCache).length} workflow instances loaded from cache`);

  const userCache = readJsonSafe(USER_CACHE_JSON, {});
  log(`${Object.keys(userCache).length} reviewer names loaded from cache`);

  const projectCache = readJsonSafe(PROJECT_CACHE_JSON, {});
  log(`${Object.keys(projectCache).length} project entries loaded from cache`);

  log('Logging into ProjectDox...');
  const sessionId = await login();
  log('Logged in.');

  // Workflow template names (a small table, fetched every run).
  const wflows = await queryTable(sessionId, 'WFlows');
  const wflowNameByID = new Map();
  for (const w of wflows) {
    if (w.WFlowID != null) wflowNameByID.set(String(w.WFlowID), w.WFlowName);
  }
  log(`${wflowNameByID.size} workflow template names loaded`);

  const tasks = await queryTable(sessionId, 'WFlowTasks');
  log(`WFlowTasks: ${tasks.length} rows`);
  const reviewCycles = await queryTable(sessionId, 'WFlowReviewCycles');
  log(`WFlowReviewCycles: ${reviewCycles.length} rows`);

  // Live WFlowTasks/WFlowReviewCycles hold only open/active workflow
  // instances; a closed instance's rows exist only in the Report* mirror.
  // Both sources are needed (see completedTasksByInstanceGroup below). The
  // mirror is cached on disk and refetched by a child process when stale.
  //
  // The cache is parsed at most once per run and never while the child is
  // running: its age is read from the file's tail first, then it is either
  // loaded directly (fresh) or refetched and loaded afterwards. If the
  // refetch fails, the previous cache (left intact by the child's
  // temp-file-and-rename write) is used instead.
  const now = Date.now();
  const cacheMeta = peekReportTablesCacheMeta();
  const reportTablesCacheAgeMin = cacheMeta ? (now - new Date(cacheMeta.CachedAt).getTime()) / 60000 : Infinity;
  const reportTablesCacheFresh = !!cacheMeta && cacheMeta.SchemaVersion === CACHE_SCHEMA_VERSION && reportTablesCacheAgeMin < MAX_REPORT_TABLES_CACHE_AGE_MIN;
  let reportTasks, reportReviewCycles;
  const useReportTables = (data) => {
    reportTasks = data.reportTasks;
    reportReviewCycles = data.reportReviewCycles || [];
  };
  const usable = (data) => !!data && data.SchemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(data.reportTasks);
  const reportRowCounts = () => `${reportTasks.length}/${reportReviewCycles.length}`;
  const reportTablesLabel = 'ReportWFlowTasks/ReportWFlowReviewCycles';
  let loadedFromFreshCache = false;
  if (reportTablesCacheFresh) {
    const cached = readJsonSafe(REPORT_TABLES_CACHE_JSON, null);
    if (usable(cached)) {
      useReportTables(cached);
      loadedFromFreshCache = true;
      log(`${reportTablesLabel}: ${reportRowCounts()} rows loaded from cache (${Math.round(reportTablesCacheAgeMin)}m old, TTL ${MAX_REPORT_TABLES_CACHE_AGE_MIN}m)`);
    }
  }
  if (!loadedFromFreshCache) {
    log(`Fetching ${reportTablesLabel} in a separate process...`);
    const result = await runReportTablesChildProcess(log);
    const onDisk = readJsonSafe(REPORT_TABLES_CACHE_JSON, null);
    if (result.ok && usable(onDisk)) {
      useReportTables(onDisk);
    } else {
      const why = result.ok
        ? 'the child process exited cleanly but the cache file it should have written is missing/unreadable'
        : result.reason + (result.stderr ? ` - ${result.stderr}` : '');
      if (usable(onDisk)) {
        useReportTables(onDisk);
        const ageMin = onDisk.CachedAt ? Math.round((Date.now() - new Date(onDisk.CachedAt).getTime()) / 60000) : '?';
        log(`WARN: could not refresh report tables (${why}) - using the previous cached copy (${ageMin}m old: ${reportRowCounts()} rows) for this run instead.`);
      } else {
        log(`WARN: could not fetch report tables (${why}) - continuing without closed-instance data for this run.`);
        reportTasks = [];
        reportReviewCycles = [];
      }
    }
  }

  // Review cycle ID -> { instance, cycle number }. The cycle number tells a
  // re-review (cycle 2+) apart from a first review. Live rows take
  // precedence; Report rows fill in cycles of instances that have closed, so
  // tasks found only in ReportWFlowTasks can still be traced to a project.
  const cycleInfo = new Map();
  for (const c of reviewCycles) {
    if (c.WFlowReviewCycleID != null) {
      cycleInfo.set(String(c.WFlowReviewCycleID), { WFlowInstanceID: c.WFlowInstanceID, ReviewCycle: c.ReviewCycle });
    }
  }
  for (const c of reportReviewCycles) {
    if (c.WFlowReviewCycleID != null && !cycleInfo.has(String(c.WFlowReviewCycleID))) {
      cycleInfo.set(String(c.WFlowReviewCycleID), { WFlowInstanceID: c.WFlowInstanceID, ReviewCycle: c.ReviewCycle });
    }
  }
  const cycleToInstance = new Map(); // cycle ID -> instance ID
  for (const [cycleId, info] of cycleInfo) cycleToInstance.set(cycleId, info.WFlowInstanceID);

  // Coordinator setup tasks that run before any review cycle (e.g. "Board Or
  // Committee Selection") have no WFlowReviewCycleID. They resolve to their
  // instance through WFlowActivityID -> WFlowActivities.WFlowInstanceID.
  const activities = await queryTable(sessionId, 'WFlowActivities');
  log(`WFlowActivities: ${activities.length} rows`);
  const activityToInstance = new Map();
  for (const a of activities) {
    if (a.WFlowActivityID != null) activityToInstance.set(String(a.WFlowActivityID), a.WFlowInstanceID);
  }
  function resolveInstanceID(t) {
    if (t.WFlowReviewCycleID) {
      const viaCycle = cycleToInstance.get(String(t.WFlowReviewCycleID));
      if (viaCycle != null) return viaCycle;
    }
    if (t.WFlowActivityID != null) return activityToInstance.get(String(t.WFlowActivityID));
    return undefined;
  }

  // Task status IDs: 1 = Completed, 2 = Accepted, 3 = Pending.
  //
  // openTasks = open (Pending/Accepted) tasks plus tasks completed today.
  // DateCompleted is a naive Eastern-time timestamp (e.g.
  // "2026-06-10T16:58:28.843"), so its date part is compared with the
  // Eastern calendar date.
  const todayEastern = easternToday();
  const isCompletedTodayCandidate = (t) =>
    t.WFlowTaskStatusTypeID === 1 && t.DateCompleted && t.DateCompleted.slice(0, 10) === todayEastern;
  const openTasks = tasks.filter((t) => {
    if (resolveInstanceID(t) == null) return false;
    if (t.WFlowTaskStatusTypeID === 2 || t.WFlowTaskStatusTypeID === 3) return true;
    if (isCompletedTodayCandidate(t)) return true;
    return false;
  });
  // A task completed today whose workflow also closed today is gone from live
  // WFlowTasks but present in ReportWFlowTasks; add those (deduped by task ID,
  // since an instance closing between the two queries can appear in both).
  const openTaskIDs = new Set(openTasks.map((t) => t.WFlowTaskID));
  let reportOnlyCompletedToday = 0;
  for (const t of reportTasks) {
    if (resolveInstanceID(t) == null || openTaskIDs.has(t.WFlowTaskID)) continue;
    if (isCompletedTodayCandidate(t)) { openTasks.push(t); reportOnlyCompletedToday++; }
  }
  log(`${openTasks.length} open + completed-today department-review tasks (out of ${tasks.length} total, ${reportOnlyCompletedToday} completed-today found only via the closed-instance report data).`);

  // --- resolve distinct workflow instances (cached) ---
  const distinctInstanceIDs = [...new Set(
    openTasks.map(resolveInstanceID).filter((id) => id != null)
  )];
  log(`${distinctInstanceIDs.length} distinct workflow instances referenced.`);

  const toResolve = distinctInstanceIDs.filter((id) => !isFresh(instanceCache[String(id)], MAX_INSTANCE_CACHE_AGE_MIN, now, id));
  log(`${toResolve.length} instance(s) need a fresh lookup (${distinctInstanceIDs.length - toResolve.length} from cache).`);

  let resolvedCount = 0;
  await mapConcurrent(toResolve, CONCURRENCY, async (id) => {
    try {
      instanceCache[String(id)] = instanceCacheEntry(await getWorkflowInstance(sessionId, id));
    } catch (e) {
      log(`WARN GetWorkflowInstance(${id}) failed: ${e.message}`);
    }
    resolvedCount++;
    if (resolvedCount % 100 === 0) writeJson(INSTANCE_CACHE_JSON, instanceCache); // checkpoint long cold runs
  });
  writeJson(INSTANCE_CACHE_JSON, instanceCache);
  log(`Instance cache saved (${Object.keys(instanceCache).length} total entries).`);

  // --- project number/description/location for projects with an Active instance (cached) ---
  const distinctProjectIDs = [...new Set(
    distinctInstanceIDs
      .map((id) => instanceCache[String(id)])
      .filter((inst) => inst && inst.WFlowInstanceStateID === 1)
      .map((inst) => inst.EntityID)
      .filter((id) => id != null)
  )];
  const projectsToResolve = distinctProjectIDs.filter((id) => !isFresh(projectCache[String(id)], MAX_PROJECT_CACHE_AGE_MIN, now, id));
  log(`${distinctProjectIDs.length} distinct project(s) referenced; ${projectsToResolve.length} need a fresh lookup.`);

  let projectResolvedCount = 0;
  await mapConcurrent(projectsToResolve, CONCURRENCY, async (id) => {
    try {
      const p = await getProject(sessionId, id);
      projectCache[String(id)] = { ProjectID: id, Name: p.Name, Description: p.Description, Location: p.Location, SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
    } catch (e) {
      log(`WARN GetProject(${id}) failed: ${e.message}`);
    }
    projectResolvedCount++;
    if (projectResolvedCount % 100 === 0) writeJson(PROJECT_CACHE_JSON, projectCache); // checkpoint long cold runs
  });
  writeJson(PROJECT_CACHE_JSON, projectCache);
  log(`Project cache saved (${Object.keys(projectCache).length} total entries).`);

  // --- earlier-revision instances, for projects that need them ---
  // An open task at Cycle 1 of Revision 1+ has no earlier cycle in its own
  // instance, so its prior reviewers are found in earlier revisions'
  // instances, listed by GetWorkflowInstancesByProjectName.
  const revisionInstancesCache = readJsonSafe(REVISION_INSTANCES_CACHE_JSON, {});
  const revisionInstancesNeededByProject = new Map(); // ProjectID -> Set of instance IDs that need their earlier revisions
  for (const t of openTasks) {
    const wflowInstanceID = resolveInstanceID(t);
    const inst = wflowInstanceID != null ? instanceCache[String(wflowInstanceID)] : null;
    const thisCycleInfo = cycleInfo.get(String(t.WFlowReviewCycleID));
    const reviewCycle = thisCycleInfo ? thisCycleInfo.ReviewCycle : null;
    if (!inst || inst.EntityID == null || inst.WFlowInstanceStateID !== 1 || reviewCycle !== 1 || !((inst.Revision || 0) > 0)) continue;
    if (!revisionInstancesNeededByProject.has(inst.EntityID)) revisionInstancesNeededByProject.set(inst.EntityID, new Set());
    revisionInstancesNeededByProject.get(inst.EntityID).add(String(wflowInstanceID));
  }
  const projectsNeedingRevisionHistory = [...revisionInstancesNeededByProject.keys()];
  // Refetch when the entry has expired or doesn't list the revision being reviewed.
  const revisionProjectsToResolve = projectsNeedingRevisionHistory.filter((id) => {
    const entry = revisionInstancesCache[String(id)];
    if (!isFresh(entry, MAX_REVISION_CACHE_AGE_MIN, now, id)) return true;
    const listed = new Set((entry.instances || []).map((i) => String(i.WFlowInstanceID)));
    return [...revisionInstancesNeededByProject.get(id)].some((instId) => !listed.has(instId));
  });
  log(`${projectsNeedingRevisionHistory.length} project(s) need cross-revision reviewer history; ${revisionProjectsToResolve.length} need a fresh lookup.`);

  let revisionResolvedCount = 0;
  await mapConcurrent(revisionProjectsToResolve, CONCURRENCY, async (projectId) => {
    const proj = projectCache[String(projectId)];
    const projectName = proj ? proj.Name : null;
    if (!projectName) return; // the lookup is by project number
    try {
      const instances = await getWorkflowInstancesByProjectName(sessionId, projectName);
      revisionInstancesCache[String(projectId)] = {
        instances: instances.map((i) => ({
          WFlowInstanceID: i.WFlowInstanceID, Revision: parseRevision(i.InstanceName), InstanceName: i.InstanceName
        })),
        SchemaVersion: CACHE_SCHEMA_VERSION,
        CachedAt: new Date().toISOString()
      };
    } catch (e) {
      log(`WARN GetWorkflowInstancesByProjectName(${projectName}) failed: ${e.message}`);
    }
    revisionResolvedCount++;
    if (revisionResolvedCount % 50 === 0) writeJson(REVISION_INSTANCES_CACHE_JSON, revisionInstancesCache);
  });
  writeJson(REVISION_INSTANCES_CACHE_JSON, revisionInstancesCache);
  log(`Revision instance cache saved (${Object.keys(revisionInstancesCache).length} project entries).`);

  // Instance -> every earlier-revision instance of the same project, nearest
  // first. All of them are kept, not just the previous one, because a
  // revision may not have been routed to a given group at all; the lookup
  // below walks back until it finds one that was.
  const earlierRevisionInstancesByInstance = new Map(); // wflowInstanceID -> [earlier-revision wflowInstanceIDs, nearest first]
  for (const [projectId, entry] of Object.entries(revisionInstancesCache)) {
    const list = (entry.instances || []).filter((i) => i.Revision != null).sort((a, b) => b.Revision - a.Revision);
    for (const inst of list) {
      const earlier = list.filter((i) => i.Revision < inst.Revision).map((i) => i.WFlowInstanceID); // list already sorted desc
      if (earlier.length) earlierRevisionInstancesByInstance.set(String(inst.WFlowInstanceID), earlier);
    }
  }

  // --- re-review history ---
  // For each open task: who completed the same group's review of the same
  // project on an earlier cycle (same revision) or in an earlier revision.
  // Built from completed tasks already in memory, limited to the instances
  // of open tasks plus their earlier-revision instances.
  const relevantInstanceSet = new Set(distinctInstanceIDs.map(String));
  for (const ids of earlierRevisionInstancesByInstance.values()) {
    for (const id of ids) relevantInstanceSet.add(String(id));
  }

  // Revision number per instance. Earlier-revision instances are only in
  // revisionInstancesCache, not instanceCache, so both are read.
  const revisionByInstanceId = new Map();
  for (const [id, cachedInst] of Object.entries(instanceCache)) {
    if (cachedInst.Revision != null) revisionByInstanceId.set(String(id), cachedInst.Revision);
  }
  for (const entry of Object.values(revisionInstancesCache)) {
    for (const i of (entry.instances || [])) {
      if (i.Revision != null) revisionByInstanceId.set(String(i.WFlowInstanceID), i.Revision);
    }
  }

  // Completed tasks come from both live WFlowTasks and ReportWFlowTasks:
  // live covers instances that are still open (their earlier cycles are not
  // yet in the mirror), Report covers instances that have closed.
  //
  // Keyed by group NAME, not GroupID. GroupID is issued per workflow
  // instance, so it differs between revisions of the same project; the name
  // identifies the department. Names are whitespace-normalized and
  // upper-cased because the two tables don't always match byte for byte
  // (e.g. CHAR padding).
  const normGroupName = (name) => (name || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const completedTasksByInstanceGroup = new Map(); // "instanceId::groupName" -> [{Revision, ReviewCycle, UserID, DateCompleted, TaskName}]
  const seenTaskIDs = new Set(); // a task can appear in both sources if its instance closed between the two queries
  const addCompletedTask = (t, info) => {
    if (t.WFlowTaskStatusTypeID !== 1 || !t.WFlowReviewCycleID) return; // 1 = Completed
    if (!info || !relevantInstanceSet.has(String(info.WFlowInstanceID))) return;
    if (t.WFlowTaskID != null) {
      if (seenTaskIDs.has(t.WFlowTaskID)) return;
      seenTaskIDs.add(t.WFlowTaskID);
    }
    const mapKey = `${info.WFlowInstanceID}::${normGroupName(t.GroupName)}`;
    if (!completedTasksByInstanceGroup.has(mapKey)) completedTasksByInstanceGroup.set(mapKey, []);
    completedTasksByInstanceGroup.get(mapKey).push({
      Revision: revisionByInstanceId.has(String(info.WFlowInstanceID)) ? revisionByInstanceId.get(String(info.WFlowInstanceID)) : null,
      ReviewCycle: info.ReviewCycle, UserID: t.UserID, DateCompleted: t.DateCompleted, TaskName: t.TaskName
    });
  };
  for (const t of tasks) addCompletedTask(t, cycleInfo.get(String(t.WFlowReviewCycleID)));
  for (const t of reportTasks) addCompletedTask(t, cycleInfo.get(String(t.WFlowReviewCycleID)));
  // Most recent first: by revision, then cycle, then completion time (a
  // group can complete more than one task in the same cycle, e.g. after a
  // reassignment).
  const byRevisionThenCycleThenDate = (a, b) =>
    (b.Revision || 0) - (a.Revision || 0) ||
    (b.ReviewCycle || 0) - (a.ReviewCycle || 0) ||
    (new Date(b.DateCompleted || 0).getTime() - new Date(a.DateCompleted || 0).getTime());
  for (const list of completedTasksByInstanceGroup.values()) list.sort(byRevisionThenCycleThenDate);

  // --- join ---
  const detailRows = [];
  let skippedUnresolved = 0, skippedNotActive = 0;
  for (const t of openTasks) {
    const wflowInstanceID = resolveInstanceID(t);
    const inst = wflowInstanceID != null ? instanceCache[String(wflowInstanceID)] : null;

    if (!inst) { skippedUnresolved++; continue; }
    // Open tasks are shown only while their workflow is Active; a pending
    // task on a terminated workflow isn't real work. Completed tasks are kept
    // regardless, since a workflow often closes the day its last review is done.
    if (t.WFlowTaskStatusTypeID !== 1 && inst.WFlowInstanceStateID !== 1) { skippedNotActive++; continue; } // 1 = Active

    const status = t.WFlowTaskStatusTypeID === 2 ? 'Accepted' : t.WFlowTaskStatusTypeID === 3 ? 'Pending' : t.WFlowTaskStatusTypeID === 1 ? 'Completed' : `Unknown(${t.WFlowTaskStatusTypeID})`;
    const proj = projectCache[String(inst.EntityID)];
    const templateName = wflowNameByID.get(String(inst.WFlowID)) || `WFlow${inst.WFlowID}`;

    const thisCycleInfo = cycleInfo.get(String(t.WFlowReviewCycleID));
    const reviewCycle = thisCycleInfo ? thisCycleInfo.ReviewCycle : null;
    const thisRevision = inst.Revision || 0;

    // Same-instance (same revision) earlier-cycle history.
    let priorReviews = (completedTasksByInstanceGroup.get(`${wflowInstanceID}::${normGroupName(t.GroupName)}`) || [])
      .filter((e) => reviewCycle == null || (e.ReviewCycle || 0) < reviewCycle);
    // Cycle 1 of a revision: use the nearest earlier revision that has a
    // completed review for this group.
    if (!priorReviews.length && reviewCycle === 1 && thisRevision > 0) {
      const earlierIds = earlierRevisionInstancesByInstance.get(String(wflowInstanceID)) || [];
      for (const earlierId of earlierIds) {
        const found = completedTasksByInstanceGroup.get(`${earlierId}::${normGroupName(t.GroupName)}`) || [];
        if (found.length) { priorReviews = found; break; }
      }
    }

    detailRows.push({
      WFlowTaskID: t.WFlowTaskID,
      TaskName: t.TaskName,
      GroupID: t.GroupID,
      GroupName: t.GroupName,
      TaskStatus: status,
      UserID: t.UserID,
      DateCreated: t.DateCreated,
      DateAccepted: t.DateAccepted,
      DateDue: t.DateDue,
      DateCompleted: t.DateCompleted,
      WFlowInstanceID: wflowInstanceID,
      WorkflowTemplate: templateName,
      ProjectID: inst.EntityID,
      ProjectName: proj ? proj.Name : null,
      ProjectDescription: proj ? proj.Description : null,
      ProjectLocation: proj ? proj.Location : null,
      AssignedUserName: null,
      // WFlowTaskAssignmentTypeID: 1 = Individual (pre-assigned to one person;
      // UserID is set before acceptance), 2 = FirstInGroup (normal Pending),
      // 3 = AllInGroup, 4 = AssignToWorkflowOwner. The page shows a Pending
      // Individual task as "Assigned" rather than open to the group.
      IsDirectAssignment: t.WFlowTaskAssignmentTypeID === 1,
      ReviewCycle: reviewCycle,
      Revision: thisRevision,
      // Earlier completed reviews by the same group on the same project, most
      // recent first. UserName is filled in after reviewer names are resolved.
      PreviousReviewers: priorReviews.map((e) => ({
        Revision: e.Revision, ReviewCycle: e.ReviewCycle, UserID: e.UserID, UserName: null, DateCompleted: e.DateCompleted
      }))
    });
  }
  if (skippedUnresolved) log(`${skippedUnresolved} open task(s) skipped - instance unresolved.`);
  if (skippedNotActive) log(`${skippedNotActive} open task(s) skipped - parent workflow no longer Active.`);

  // --- reviewer names (cached) ---
  // For tasks with a named assignee (Accepted, Completed, or Pending with a
  // direct assignment) and for every prior reviewer.
  const hasNamedAssignee = (r) => r.TaskStatus === 'Accepted' || r.TaskStatus === 'Completed' || (r.TaskStatus === 'Pending' && r.IsDirectAssignment);
  const assignedUserIDs = new Set(detailRows.filter((r) => hasNamedAssignee(r) && r.UserID).map((r) => r.UserID));
  const priorReviewerUserIDs = new Set();
  for (const r of detailRows) {
    for (const p of r.PreviousReviewers) { if (p.UserID) priorReviewerUserIDs.add(p.UserID); }
  }
  const allUserIDsToConsider = [...new Set([...assignedUserIDs, ...priorReviewerUserIDs])];
  const usersToResolve = allUserIDsToConsider.filter((uid) => !isFresh(userCache[String(uid)], MAX_USER_CACHE_AGE_MIN, now, uid));
  log(`${allUserIDsToConsider.length} distinct reviewer(s) (current + prior cycles); ${usersToResolve.length} need a fresh lookup.`);

  let userResolvedCount = 0;
  await mapConcurrent(usersToResolve, CONCURRENCY, async (uid) => {
    try {
      const u = await getUser(sessionId, uid);
      userCache[String(uid)] = { UserID: uid, Name: userDisplayName(u), SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
    } catch (e) {
      log(`WARN GetUser(${uid}) failed: ${e.message}`);
    }
    userResolvedCount++;
    if (userResolvedCount % 100 === 0) writeJson(USER_CACHE_JSON, userCache); // checkpoint long cold runs
  });
  writeJson(USER_CACHE_JSON, userCache);
  log(`Reviewer name cache saved (${Object.keys(userCache).length} total entries).`);

  for (const row of detailRows) {
    if (hasNamedAssignee(row) && row.UserID && userCache[String(row.UserID)]) {
      row.AssignedUserName = userCache[String(row.UserID)].Name;
    }
    for (const p of row.PreviousReviewers) {
      if (p.UserID && userCache[String(p.UserID)]) p.UserName = userCache[String(p.UserID)].Name;
    }
  }

  // Same-day cache of every completed-today row seen by any refresh today
  // (reset at the Eastern date change). A task whose instance just closed can
  // drop out of live WFlowTasks before it reaches the Report* mirror; rows
  // seen earlier today are added back so the count doesn't dip.
  let completedTodayCache = readJsonSafe(COMPLETED_TODAY_CACHE_JSON, {});
  if (completedTodayCache.date !== todayEastern || completedTodayCache.SchemaVersion !== CACHE_SCHEMA_VERSION) {
    completedTodayCache = { date: todayEastern, SchemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
  }
  const seenTodayIDs = new Set();
  for (const row of detailRows) {
    if (row.TaskStatus !== 'Completed') continue;
    seenTodayIDs.add(String(row.WFlowTaskID));
    completedTodayCache.entries[String(row.WFlowTaskID)] = row;
  }
  let rescuedFromCache = 0;
  for (const [taskId, cachedRow] of Object.entries(completedTodayCache.entries)) {
    if (seenTodayIDs.has(taskId)) continue;
    detailRows.push(cachedRow);
    rescuedFromCache++;
  }
  if (rescuedFromCache) log(`${rescuedFromCache} completed-today task(s) not visible this run - restored from earlier today's cache.`);
  writeJson(COMPLETED_TODAY_CACHE_JSON, completedTodayCache);

  // --- aggregate ---
  const groups = new Map(); // key: template::group
  for (const r of detailRows) {
    const key = `${r.WorkflowTemplate}::${r.GroupName}`;
    if (!groups.has(key)) {
      groups.set(key, { WorkflowTemplate: r.WorkflowTemplate, GroupName: r.GroupName, OpenTaskCount: 0, PendingCount: 0, AcceptedCount: 0, CompletedTodayCount: 0, Tasks: [] });
    }
    const g = groups.get(key);
    if (r.TaskStatus === 'Pending') { g.OpenTaskCount++; g.PendingCount++; }
    else if (r.TaskStatus === 'Accepted') { g.OpenTaskCount++; g.AcceptedCount++; }
    else if (r.TaskStatus === 'Completed') { g.CompletedTodayCount++; }
    g.Tasks.push({
      ProjectID: r.ProjectID,
      ProjectName: r.ProjectName,
      ProjectDescription: r.ProjectDescription,
      ProjectLocation: r.ProjectLocation,
      TaskName: r.TaskName,
      TaskStatus: r.TaskStatus,
      AssignedUserName: r.AssignedUserName,
      IsDirectAssignment: r.IsDirectAssignment,
      DateAssigned: r.DateCreated,
      DateAccepted: r.DateAccepted,
      DateDue: r.DateDue,
      DateCompleted: r.DateCompleted,
      ReviewCycle: r.ReviewCycle,
      Revision: r.Revision,
      PreviousReviewers: r.PreviousReviewers
    });
  }
  // Soonest due date first within each group; undated tasks last.
  const byDueDate = (a, b) => {
    const ad = a.DateDue ? new Date(a.DateDue).getTime() : Infinity;
    const bd = b.DateDue ? new Date(b.DateDue).getTime() : Infinity;
    return ad === bd ? 0 : ad < bd ? -1 : 1; // plain subtraction gives NaN for two undated tasks
  };
  for (const g of groups.values()) g.Tasks.sort(byDueDate);

  const summary = [...groups.values()].sort((a, b) =>
    a.WorkflowTemplate.localeCompare(b.WorkflowTemplate) || a.GroupName.localeCompare(b.GroupName)
  );

  // Completed-today summary by workflow, group and reviewer (same
  // aggregation as the history view; see createCompletedSummary).
  const todaySummaryAcc = createCompletedSummary();
  const seenCompletedIds = new Set();
  for (const r of detailRows) {
    if (r.TaskStatus !== 'Completed') continue;
    seenCompletedIds.add(String(r.WFlowTaskID));
    if (SELF_SERVICE_GROUP_RE.test((r.GroupName || '').trim())) continue;
    todaySummaryAcc.add({ WorkflowTemplate: r.WorkflowTemplate, GroupName: r.GroupName, UserID: r.UserID, UserName: r.AssignedUserName, TaskName: r.TaskName });
  }
  // Rows in today's history file that this run didn't see are counted too.
  // That file only gains rows and isn't reset by a CACHE_SCHEMA_VERSION bump,
  // so the count can't drop after a degraded refresh (e.g. a failed
  // report-tables fetch). It is only read here; updateCompletedHistory()
  // writes it.
  let restoredFromHistory = 0;
  const todayHistory = readHistoryDay(todayEastern);
  if (todayHistory && Array.isArray(todayHistory.rows)) {
    for (const h of todayHistory.rows) {
      if (seenCompletedIds.has(String(h.id))) continue;
      todaySummaryAcc.add(historyRowToSummaryRow(h));
      restoredFromHistory++;
    }
  }
  if (restoredFromHistory) log(`${restoredFromHistory} completed-today task(s) recorded earlier today in saved history but not visible this run - still counted in Completed today.`);
  const completedTodaySummary = todaySummaryAcc.finish();

  const snapshot = {
    GeneratedAt: new Date().toISOString(),
    TotalOpenTasks: detailRows.filter((r) => r.TaskStatus !== 'Completed').length,
    CompletedTodaySummary: completedTodaySummary,
    Groups: summary
  };
  writeJson(SNAPSHOT_JSON, snapshot, { compact: true });

  // The snapshot is already written; a history failure is logged, not thrown.
  try {
    await updateCompletedHistory();
  } catch (e) {
    log(`WARN: completed-task history update failed (${e.message}) - the dashboard snapshot itself is unaffected.`);
  }

  // --- completed-task history --------------------------------------------
  //
  // Adds today's completions to today's day file, re-derives recent days from
  // the live + Report tables (see HISTORY_RESETTLE_DAYS), and backfills a few
  // missing older days per run toward HISTORY_DAYS.
  async function updateCompletedHistory() {
    const today = todayEastern;
    const nowMs = Date.now();
    const lookups = readJsonSafe(HISTORY_LOOKUPS_JSON, {});
    lookups.projects = lookups.projects || {};
    lookups.failed = lookups.failed || {};
    for (const kind of ['instances', 'projects', 'users']) {
      // Drop expired failure markers so the file doesn't grow without bound.
      const kept = {};
      for (const [id, at] of Object.entries(lookups.failed[kind] || {})) {
        if (nowMs - new Date(at).getTime() < HISTORY_LOOKUP_RETRY_MS) kept[id] = at;
      }
      lookups.failed[kind] = kept;
    }
    const recentlyFailed = (kind, id) => Object.prototype.hasOwnProperty.call(lookups.failed[kind], String(id));

    // Past days to (re)derive this run. Skipped when the Report tables aren't
    // loaded: a past day derived from the live table alone would be missing
    // every closed workflow's tasks but look complete.
    const haveDates = new Set(listHistoryDates());
    const derive = new Set();
    let reportEarliest = null;
    let missingRemaining = 0;
    if (reportTasks.length > 0) {
      for (const t of reportTasks) {
        if (t.WFlowTaskStatusTypeID !== 1 || !t.DateCompleted) continue;
        const d = t.DateCompleted.slice(0, 10);
        if (reportEarliest === null || d < reportEarliest) reportEarliest = d;
      }
      const oldest = addDays(today, -HISTORY_DAYS);
      const missing = [];
      for (let d = addDays(today, -1); d >= oldest; d = addDays(d, -1)) {
        if (!haveDates.has(d) && (reportEarliest === null || d >= reportEarliest)) missing.push(d);
      }
      missing.slice(0, HISTORY_MAX_NEW_DAYS_PER_RUN).forEach((d) => derive.add(d));
      missingRemaining = Math.max(0, missing.length - HISTORY_MAX_NEW_DAYS_PER_RUN);
      for (let d = addDays(today, -1); d >= addDays(today, -HISTORY_RESETTLE_DAYS); d = addDays(d, -1)) {
        if (!haveDates.has(d)) continue;
        let ageHours = Infinity;
        try { ageHours = (nowMs - fs.statSync(historyFile(d)).mtimeMs) / 3600000; } catch (e) {}
        if (ageHours >= HISTORY_RESETTLE_MIN_AGE_HOURS) derive.add(d);
      }
      if (HISTORY_FORCE_RESCHEMA) {
        // Always logged, so it's visible that the setting took effect.
        const needSchema = [...haveDates].filter((d) => !derive.has(d) && dayNeedsSchemaBackfill(d)).sort();
        const toDo = needSchema.slice(0, HISTORY_MAX_NEW_DAYS_PER_RUN);
        toDo.forEach((d) => derive.add(d));
        log(`History: HISTORY_FORCE_RESCHEMA is set - ${needSchema.length} already-recorded day(s) still need backfilling; re-deriving ${toDo.length} this run.`);
      }
    } else if (HISTORY_FORCE_RESCHEMA) {
      log('History: HISTORY_FORCE_RESCHEMA is set, but the Report tables aren\'t loaded this run, so nothing can be re-derived (see the "Report tables" log line above for why).');
    }

    // Completed tasks on the days being derived, from both sources, deduped by task ID.
    const candidates = [];
    if (derive.size) {
      const seen = new Set();
      const consider = (t) => {
        if (t.WFlowTaskStatusTypeID !== 1 || !t.DateCompleted) return;
        if (!derive.has(t.DateCompleted.slice(0, 10))) return;
        if (t.WFlowTaskID != null) {
          if (seen.has(t.WFlowTaskID)) return;
          seen.add(t.WFlowTaskID);
        }
        if (resolveInstanceID(t) == null) return;
        candidates.push(t);
      };
      for (const t of tasks) consider(t);
      for (const t of reportTasks) consider(t);
    }

    // Any cached instance entry is usable regardless of age: an instance's
    // project and workflow template never change.
    const instanceIds = [...new Set(candidates.map((t) => String(resolveInstanceID(t))))];
    const instancesToFetch = instanceIds.filter((id) => {
      const e = instanceCache[id];
      if (e && e.SchemaVersion === CACHE_SCHEMA_VERSION) return false;
      return !recentlyFailed('instances', id);
    });
    let instanceCacheDirty = false;
    await mapConcurrent(instancesToFetch, CONCURRENCY, async (id) => {
      try {
        instanceCache[id] = instanceCacheEntry(await getWorkflowInstance(sessionId, id));
        instanceCacheDirty = true;
      } catch (e) {
        lookups.failed.instances[id] = new Date().toISOString();
        log(`WARN history: GetWorkflowInstance(${id}) failed: ${e.message}`);
      }
    });
    if (instanceCacheDirty) writeJson(INSTANCE_CACHE_JSON, instanceCache);

    // Rows to persist, grouped by their completion date.
    const rowsByDate = new Map(); // date -> row[]
    const omittedByDate = new Map(); // date -> count of tasks that couldn't be resolved this run
    const pushRow = (row) => {
      const d = (row.at || '').slice(0, 10);
      if (!d) return;
      if (!rowsByDate.has(d)) rowsByDate.set(d, []);
      rowsByDate.get(d).push(row);
    };

    // Today's completions: the same rows the snapshot used, including any
    // restored from the same-day cache.
    for (const r of detailRows) {
      if (r.TaskStatus !== 'Completed') continue;
      const grp = (r.GroupName || '').trim();
      if (SELF_SERVICE_GROUP_RE.test(grp)) continue;
      pushRow({ id: r.WFlowTaskID, wf: r.WorkflowTemplate, grp, uid: r.UserID, user: r.AssignedUserName, task: r.TaskName, pid: r.ProjectID, proj: r.ProjectName, loc: r.ProjectLocation, desc: r.ProjectDescription, at: r.DateCompleted });
    }
    // Past days derived above.
    for (const t of candidates) {
      const d = t.DateCompleted.slice(0, 10);
      const inst = instanceCache[String(resolveInstanceID(t))];
      if (!inst) { omittedByDate.set(d, (omittedByDate.get(d) || 0) + 1); continue; }
      const grp = (t.GroupName || '').trim();
      if (SELF_SERVICE_GROUP_RE.test(grp)) continue;
      const cachedProj = projectCache[String(inst.EntityID)];
      pushRow({
        id: t.WFlowTaskID, wf: wflowNameByID.get(String(inst.WFlowID)) || `WFlow${inst.WFlowID}`, grp, uid: t.UserID, user: null,
        task: t.TaskName, pid: inst.EntityID, proj: cachedProj ? cachedProj.Name : null, loc: cachedProj ? cachedProj.Location : null,
        desc: cachedProj ? cachedProj.Description : null, at: t.DateCompleted
      });
    }

    // Reviewer names and project numbers for whatever's still unresolved.
    const allRows = [...rowsByDate.values()].flat();
    const uidsToFetch = [...new Set(allRows.filter((r) => !r.user && r.uid != null).map((r) => String(r.uid)))]
      .filter((uid) => !userCache[uid] && !recentlyFailed('users', uid));
    await mapConcurrent(uidsToFetch, CONCURRENCY, async (uid) => {
      try {
        const u = await getUser(sessionId, uid);
        userCache[uid] = { UserID: uid, Name: userDisplayName(u), SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
      } catch (e) {
        lookups.failed.users[uid] = new Date().toISOString();
        log(`WARN history: GetUser(${uid}) failed: ${e.message}`);
      }
    });
    if (uidsToFetch.length) writeJson(USER_CACHE_JSON, userCache);
    for (const r of allRows) {
      if (!r.user && r.uid != null && userCache[String(r.uid)]) r.user = userCache[String(r.uid)].Name;
    }

    const pidsToFetch = [...new Set(allRows.filter((r) => !r.proj && r.pid != null).map((r) => String(r.pid)))]
      .filter((pid) => !lookups.projects[pid] && !recentlyFailed('projects', pid));
    await mapConcurrent(pidsToFetch, CONCURRENCY, async (pid) => {
      try {
        const p = await getProject(sessionId, pid);
        lookups.projects[pid] = { Name: p.Name || null, Location: p.Location || null, Description: p.Description || null };
      } catch (e) {
        lookups.failed.projects[pid] = new Date().toISOString();
        log(`WARN history: GetProject(${pid}) failed: ${e.message}`);
      }
    });
    for (const r of allRows) {
      if (r.proj || r.pid == null) continue;
      const p = lookups.projects[String(r.pid)];
      if (p) { r.proj = p.Name || null; r.loc = r.loc || p.Location || null; r.desc = r.desc || p.Description || null; }
    }
    writeJson(HISTORY_LOOKUPS_JSON, lookups);

    // Each day file = existing rows + newly seen rows, keyed by task ID, so it
    // only grows. A new past day with tasks that couldn't be resolved this run
    // is not written, so it stays "missing" and is retried next run instead of
    // being recorded short.
    let wroteDays = 0, wroteRows = 0, retryDays = 0;
    const datesToWrite = new Set([...rowsByDate.keys(), ...[...derive]]);
    for (const d of datesToWrite) {
      const isNewDay = !haveDates.has(d);
      if (isNewDay && d !== today && (omittedByDate.get(d) || 0) > 0) { retryDays++; continue; }
      const existing = haveDates.has(d) ? readHistoryDay(d) : null;
      const byId = new Map();
      if (existing && Array.isArray(existing.rows)) for (const h of existing.rows) byId.set(String(h.id), h);
      for (const r of (rowsByDate.get(d) || [])) {
        const prev = byId.get(String(r.id));
        // Keep a previously-resolved name/project if this run couldn't resolve it.
        const merged = toHistoryRow(r);
        if (prev) { for (const k of ['user', 'proj', 'loc', 'desc']) if (!merged[k] && prev[k]) merged[k] = prev[k]; }
        byId.set(String(r.id), merged);
      }
      const rows = [...byId.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      writeHistoryDay(d, { date: d, derivedAt: new Date().toISOString(), rows });
      wroteDays++; wroteRows += rows.length;
    }
    log(`History: ${wroteDays} day file(s) written (${wroteRows} rows) - today plus ${derive.size} re-derived/backfilled day(s)` +
      (retryDays ? `; ${retryDays} new day(s) deferred (unresolved tasks, will retry)` : '') +
      (missingRemaining ? `; ${missingRemaining} older day(s) still to backfill toward the last ${HISTORY_DAYS} days` : '') + '.');
  }

  const tookSeconds = Math.round((Date.now() - startedAt) / 1000);
  log(`Done in ${tookSeconds}s.`);
  return { snapshot, tookSeconds };
}

module.exports = {
  runCollector, readHistoryRange, isValidDateStr, daysBetween, easternToday, HISTORY_MAX_RANGE_DAYS
};

if (require.main === module) {
  if (process.argv[2] === '--fetch-report-tables') {
    // Internal mode used by runReportTablesChildProcess().
    fetchAndCacheReportTables()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('fetchAndCacheReportTables failed:', err.message);
        process.exit(1);
      });
  } else {
    // Standalone run: `node collector.js`.
    runCollector({ log: console.log })
      .then(({ tookSeconds, snapshot }) => {
        console.log(`\n${snapshot.TotalOpenTasks} open tasks across ${snapshot.Groups.length} (template, group) combinations. Total: ${tookSeconds}s.`);
      })
      .catch((err) => {
        console.error('Collector failed:', err.message);
        process.exit(1);
      });
  }
}
