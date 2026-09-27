// Pure-Node port of Get-WorkloadSnapshot.ps1 - same algorithm, same data
// sources, same caching strategy, no PowerShell involved. Can be called
// in-process from server.js's /refresh handler, or run standalone:
//   node collector.js
//
// Requires PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD in the
// environment (same as the PowerShell version did).

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const ROOT = __dirname;
const BASE_URL = 'https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com';

// Fallback only, for the rare case a live Project/GetProject lookup fails -
// not the primary source any more (see PROJECT_CACHE_JSON below). This was a
// one-time Sept 15 snapshot with no automatic refresh, which is exactly what
// made project name/status go stale.
const PROJECT_LIST_CSV = path.join(ROOT, 'projectdox-raw-pull-20260915-230752.csv');
const INSTANCE_CACHE_JSON = path.join(ROOT, 'workload-instance-cache.json');
const USER_CACHE_JSON = path.join(ROOT, 'workload-user-cache.json');
const PROJECT_CACHE_JSON = path.join(ROOT, 'workload-project-cache.json');
const REVISION_INSTANCES_CACHE_JSON = path.join(ROOT, 'workload-revision-instances-cache.json');
const REPORT_TABLES_CACHE_JSON = path.join(ROOT, 'workload-report-tables-cache.json');
const COMPLETED_TODAY_CACHE_JSON = path.join(ROOT, 'workload-completed-today-cache.json');
const SNAPSHOT_JSON = path.join(ROOT, 'workload-snapshot.json');
const DETAIL_CSV = path.join(ROOT, 'workload-detail-latest.csv');

// Bump this whenever a field gets added to what an instance/project/revision/
// report-tables cache entry stores (like Revision was, then the wider
// ReportWFlowTasks projection now). A stale-but-recent entry written by an
// older code version won't have the new field, and the age-based freshness
// check alone has no way to notice that - it'll happily keep reusing an
// entry that's silently missing data forever, until its TTL finally expires
// on its own. Checking SchemaVersion alongside CachedAt makes that kind of
// entry look stale immediately instead, without needing to manually clear a
// cache file every time a field is added (which is exactly what happened
// with Description, Location, Revision, the report-tables cache's
// GroupID/TaskName/dates/AssignmentTypeID fields, and now WFlowActivityID).
const CACHE_SCHEMA_VERSION = 4;

const MAX_INSTANCE_CACHE_AGE_MIN = 120;
const MAX_USER_CACHE_AGE_MIN = 1440;
// Short TTL - project Status changes throughout the day, unlike instance
// state or reviewer names, so this needs to go stale much faster than those.
const MAX_PROJECT_CACHE_AGE_MIN = 15;
// Long TTL - which instances exist for a project's revision history doesn't
// change once a revision is closed out, so this is safe to cache for a while.
const MAX_REVISION_CACHE_AGE_MIN = 1440;
// ReportWFlowTasks/ReportWFlowReviewCycles are ~500k rows combined and add
// 15-25s to every refresh if pulled live every time. They're an append-only
// historical mirror (a completed review's row there never changes), so a
// long TTL is safe - the only cost of staleness is not seeing a review
// group's history for an instance that closed within the last few hours,
// and clicking Refresh Now again after that TTL expires picks it up.
const MAX_REPORT_TABLES_CACHE_AGE_MIN = 360;
const CONCURRENCY = 15; // parallel REST lookups for instance/user/project resolution

// --- small utilities ---------------------------------------------------

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8'); // utf8 with no BOM, unlike PowerShell's Out-File
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(filePath) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function writeCsv(filePath, rows) {
  if (rows.length === 0) { fs.writeFileSync(filePath, '', 'utf8'); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '""';
    const s = String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [cols.map(esc).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
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

async function login() {
  const email = process.env.PROJECTDOX_ADMIN_EMAIL;
  const password = process.env.PROJECTDOX_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD are not set in the environment.');
  }
  const res = await fetch(`${BASE_URL}/User/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Email: email, Password: password })
  });
  if (!res.ok) throw new Error(`User/Login HTTP ${res.status}`);
  const data = await res.json();
  if (!data.SessionID) throw new Error('Login succeeded but no SessionID in response: ' + JSON.stringify(data));
  return data.SessionID;
}

async function queryTable(sessionId, tableName) {
  const res = await fetch(`${BASE_URL}/Query/QueryDatabase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', SessionID: sessionId },
    body: JSON.stringify({ IsProjectDox: true, ConnectionString: null, Operation: 'select', TableName: tableName })
  });
  if (!res.ok) throw new Error(`Query/QueryDatabase(${tableName}) HTTP ${res.status}`);
  const data = await res.json();
  const key = Object.keys(data).find((k) => k.toLowerCase() === tableName.toLowerCase());
  return key ? data[key] : [];
}

// Same endpoint as queryTable(), but never materializes the full response as
// text or as a fully-parsed array of full-width row objects - it scans the
// response body as it streams in and calls onRow(row) once per complete
// object, immediately after that object closes. The caller is expected to
// project/slim each row and discard the rest right away, so at any moment
// at most ONE raw row (plus whatever the caller chose to retain) exists in
// memory - not all ~494k of them at once. This is what makes it possible to
// fetch a huge table like ReportWFlowTasks (27 columns/row, some with long
// HTML text) on a memory-constrained host that can't survive holding the
// full raw shape of the whole table at once (see fetchAndCacheReportTables).
//
// Relies on the response always being shaped {"<TableName>": [ {...}, ... ]}
// - true for every table this app queries - by treating the first top-level
// `[` (outside any string) as the start of the array we want, and each
// balanced `{...}` inside it (again tracking string/escape state so braces
// or brackets embedded in a string value are never mistaken for structure)
// as one row. JSON.parse() is still used per-object - this only avoids ever
// holding the FULL array/response, not per-object parsing itself.
async function streamQueryTableRows(sessionId, tableName, onRow) {
  const res = await fetch(`${BASE_URL}/Query/QueryDatabase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', SessionID: sessionId },
    body: JSON.stringify({ IsProjectDox: true, ConnectionString: null, Operation: 'select', TableName: tableName })
  });
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
      if (state === 'DONE') break; // got the whole array we care about; no need to read further
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* stream already finished/closed - fine */ }
  }

  return rowCount;
}

async function getWorkflowInstance(sessionId, wflowInstanceID) {
  const res = await fetch(`${BASE_URL}/WorkflowInstance/GetWorkflowInstance?wflowInstanceID=${wflowInstanceID}`, {
    headers: { SessionID: sessionId }
  });
  if (!res.ok) throw new Error(`GetWorkflowInstance(${wflowInstanceID}) HTTP ${res.status}`);
  return res.json();
}

async function getUser(sessionId, userID) {
  const res = await fetch(`${BASE_URL}/User/GetUser?userID=${userID}`, {
    headers: { SessionID: sessionId }
  });
  if (!res.ok) throw new Error(`GetUser(${userID}) HTTP ${res.status}`);
  return res.json();
}

async function getProject(sessionId, projectID) {
  const res = await fetch(`${BASE_URL}/Project/GetProject?projectID=${projectID}`, {
    headers: { SessionID: sessionId }
  });
  if (!res.ok) throw new Error(`GetProject(${projectID}) HTTP ${res.status}`);
  return res.json();
}

async function getWorkflowInstancesByProjectName(sessionId, projectName) {
  const res = await fetch(`${BASE_URL}/WorkflowInstance/GetWorkflowInstancesByProjectName?projectName=${encodeURIComponent(projectName)}`, {
    headers: { SessionID: sessionId }
  });
  if (!res.ok) throw new Error(`GetWorkflowInstancesByProjectName(${projectName}) HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data ? [data] : []);
}

// ProjectDox names each revision's own workflow instance like
// "BP22-00009910 R001: OFF SITE SHOPS" - R000 is the original submission,
// R001+ are formal revisions. Each revision is a SEPARATE instance with its
// own independent review-cycle counter (confirmed live: an R001 instance sat
// at Cycle 2 on its own, unrelated to R000's cycle count), so "who reviewed
// this before" for a Cycle-1-of-a-revision task has to look at the PREVIOUS
// revision's instance, not an earlier cycle of this one.
function parseRevision(instanceName) {
  if (!instanceName) return null;
  const m = instanceName.match(/\bR0*(\d+)\s*:/);
  return m ? parseInt(m[1], 10) : null;
}

// --- report tables: fetched in an isolated child process ------------------

// ReportWFlowTasks/ReportWFlowReviewCycles together are ~500k+ rows in their
// full raw shape (27 columns on ReportWFlowTasks, including a long HTML
// task-description field on some rows) - large enough that fetching them in
// the same long-running process as the web server risks tripping a host's
// memory limit and taking the whole app down with it. This is not
// theoretical: on a memory-constrained cPanel/CloudLinux account, the
// account's LVE physical-memory cap killed the server process mid-refresh,
// confirmed by cPanel's own Resource Usage fault log spiking at the exact
// moment the refresh log went silent.
//
// Doing this fetch in a short-lived child process instead means its peak
// memory - dominated by the raw, un-slimmed rows - never has to coexist
// with the rest of the collector's own memory usage in the process that
// must stay alive for the dashboard to keep working, and gets released back
// to the OS the moment the child exits, whether it finishes normally or
// gets killed itself. The parent only ever holds the already-slimmed
// ~6-field version it reads back from the cache file the child writes.
function sendProgress(msg) {
  if (process.send) process.send({ type: 'log', text: msg });
  else console.log(msg);
}

async function fetchAndCacheReportTables() {
  const sessionId = await login();

  // Slim each row down to only the fields actually needed downstream - the
  // full raw 27-column row (some with long HTML text, e.g. Description) is
  // never kept around, which is what lets this fetch survive a tight memory
  // limit that killed it even when it was already isolated in its own child
  // process but still parsing the response the ordinary (whole-array-at-once)
  // way. The extra fields beyond the original 6 (GroupID, TaskName,
  // DateCreated/Accepted/Due, WFlowTaskAssignmentTypeID) are all small
  // scalars/short strings, not the long text that caused the original
  // memory problem - added so a "completed today" task can be fully
  // rendered even when it's ONLY reachable through this table (see the
  // reportOnly merge below: the live WFlowTasks table drops a row entirely,
  // not just marks it inactive, the moment its instance closes - a workflow
  // that terminates the same day its last review completes would otherwise
  // vanish from "completed today" with no trace).
  const reportTasks = [];
  const taskCount = await streamQueryTableRows(sessionId, 'ReportWFlowTasks', (t) => {
    reportTasks.push({
      WFlowTaskID: t.WFlowTaskID, WFlowTaskStatusTypeID: t.WFlowTaskStatusTypeID,
      WFlowReviewCycleID: t.WFlowReviewCycleID, UserID: t.UserID, GroupName: t.GroupName, DateCompleted: t.DateCompleted,
      GroupID: t.GroupID, TaskName: t.TaskName, DateCreated: t.DateCreated, DateAccepted: t.DateAccepted,
      DateDue: t.DateDue, WFlowTaskAssignmentTypeID: t.WFlowTaskAssignmentTypeID, WFlowActivityID: t.WFlowActivityID
    });
  });
  sendProgress(`ReportWFlowTasks: ${taskCount} rows (streamed + slimmed on the fly)`);

  const reportReviewCycles = [];
  const cycleCount = await streamQueryTableRows(sessionId, 'ReportWFlowReviewCycles', (c) => {
    reportReviewCycles.push({
      WFlowReviewCycleID: c.WFlowReviewCycleID, WFlowInstanceID: c.WFlowInstanceID, ReviewCycle: c.ReviewCycle
    });
  });
  sendProgress(`ReportWFlowReviewCycles: ${cycleCount} rows (streamed + slimmed on the fly)`);

  fs.writeFileSync(REPORT_TABLES_CACHE_JSON, JSON.stringify({ reportTasks, reportReviewCycles, SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() }), 'utf8');
}

// Runs fetchAndCacheReportTables() in a separate `node collector.js
// --fetch-report-tables` process and waits for it to finish. Never rejects -
// a failure (including an OOM kill) degrades to { ok: false } so the caller
// can continue the refresh without cross-revision reviewer history rather
// than losing the whole run over this one optional enhancement.
function runReportTablesChildProcess(log) {
  return new Promise((resolve) => {
    const child = fork(__filename, ['--fetch-report-tables'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderrBuf = '';
    child.on('message', (msg) => { if (msg && msg.type === 'log') log(msg.text); });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); process.stderr.write(d); });
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code, signal) => {
      if (code === 0) { resolve({ ok: true }); return; }
      const reason = signal
        ? `child process killed by ${signal} (likely a host memory/resource limit)`
        : `child process exited with code ${code}`;
      resolve({ ok: false, reason, stderr: stderrBuf.trim() });
    });
  });
}

// --- completed-task summary (shared by today's snapshot and history) -------

// Within a workflow, "Review Coordinator" and "Submissions" are process/
// routing groups, not technical review disciplines - the coordinator setup
// tasks resolved via WFlowActivities (see resolveInstanceID below) mostly
// land here. Splitting them out as "Operations" keeps the review-group
// breakdown from being diluted by routing overhead.
const OPERATIONS_GROUP_RE = /^(review coordinator|submissions)$/i;
// Applicant/Fee Group tasks are excluded from every completed-task count
// regardless of the dashboard's "show self-service tasks" toggle (which only
// controls whether those groups appear in the workload breakdown) - a
// self-service task getting marked done isn't staff work, so it has no place
// in a staff performance count.
const SELF_SERVICE_GROUP_RE = /^(applicant|fee group)$/i;

function sortedCountArray(map, nameField) {
  return [...map.entries()]
    .map(([k, count]) => ({ [nameField]: k, Count: count }))
    .sort((a, b) => b.Count - a.Count || String(a[nameField]).localeCompare(String(b[nameField])));
}
// ByTask is per-person, not per-group - a single "Review Coordinator" total
// hides that the person did several distinct routing steps (Prescreen, Begin
// Review, Batch Stamp, ...), which is exactly what the per-employee task
// breakdown popover on the dashboard needs. Cheap to track for every group,
// not just Operations ones, so it stays available if a review-group
// breakdown is ever wanted too.
function sortedUserArray(map) {
  return [...map.values()]
    .sort((a, b) => b.Count - a.Count || (a.UserName || '').localeCompare(b.UserName || ''))
    .map((u) => ({ UserID: u.UserID, UserName: u.UserName, Count: u.Count, ByTask: sortedCountArray(u.ByTask, 'TaskName') }));
}
// ProjectDox appends " (Reassigned from <PERSON>)" to a task's name when it's
// reassigned after being accepted, which would otherwise split one real task
// type into a separate breakdown row per prior assignee (e.g. "Prescreen
// Review (Main Permit)" vs "Prescreen Review (Main Permit) (Reassigned from
// LEIDY ORTEGA)"). Greedy .* up to the trailing ")" so a name that itself
// contains parentheses still strips cleanly. Only applied to the per-person
// ByTask breakdown - the task's raw TaskName elsewhere (e.g. Task Workload's
// detail table, or the single-day task list) is left untouched.
function baseTaskName(taskName) {
  return (taskName || '').replace(/\s*\(Reassigned from .*\)\s*$/i, '').trim() || 'Unknown task';
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
    const groupName = r.GroupName || 'Unknown';
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

// --- completed-task history (one small file per Eastern calendar day) ---------
//
// Why files on disk instead of just recomputing from ProjectDox on demand: a
// completed task is only visible in ONE of two places at a time - the live
// WFlowTasks table while its workflow instance is still open, then (after a
// lag) the Report* mirror once the instance closes. In between, it can be in
// neither (the same gap the completed-today accumulator cache works around).
// Saving each day's completions as we observe them, and only ever ADDING to
// a day's file, means a task seen once is never lost. One file per day (not
// one big file) so a request only loads the days it asked for, one at a time,
// which keeps memory flat on the memory-limited host regardless of how long
// a range is.

const HISTORY_DIR = path.join(ROOT, 'workload-history');
// Permanent lookups for history (project number/location never change, unlike
// the short-TTL projectCache which also carries mutable Status), plus short
// negative caches so a since-deleted user/project/instance isn't re-requested
// (and re-failing) on every single refresh.
const HISTORY_LOOKUPS_JSON = path.join(ROOT, 'workload-history-lookups.json');
// How far back the collector keeps history for (it backfills toward this a
// few days per refresh; see HISTORY_MAX_NEW_DAYS_PER_RUN), overridable.
const HISTORY_DAYS = Math.max(1, parseInt(process.env.HISTORY_DAYS || '90', 10) || 90);
// A brand-new backfill can mean hundreds of GetWorkflowInstance/GetProject
// calls per missing day - capped per run so one refresh isn't stretched out
// for minutes; history simply fills in over the next few refreshes instead.
const HISTORY_MAX_NEW_DAYS_PER_RUN = Math.max(0, parseInt(process.env.HISTORY_MAX_NEW_DAYS_PER_RUN || '15', 10) || 15);
// Recent days are re-derived (rows only ever added, never removed) because a
// just-closed workflow's tasks can take a while to show up in the Report*
// mirror - see the block comment above. Older days are treated as settled.
const HISTORY_RESETTLE_DAYS = 14;
const HISTORY_RESETTLE_MIN_AGE_HOURS = 12;
// One-time opt-in: when a field is added to the compact row schema (e.g.
// `desc`), only NEW/resettled days pick it up automatically - an
// already-settled day past the resettle window keeps its old-shape rows
// forever otherwise. Setting this backfills old days toward that new shape
// too, a few per run (same budget as new-day backfill). It's self-limiting
// (see dayNeedsSchemaBackfill) - once every recorded day has the field, it's
// a cheap no-op, so it's safe to just leave set rather than remembering to
// unset it.
const HISTORY_FORCE_RESCHEMA = !!process.env.HISTORY_FORCE_RESCHEMA;
const HISTORY_MAX_RANGE_DAYS = 400;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Pure calendar arithmetic on YYYY-MM-DD strings (noon UTC), so DST never
// shifts a date by one.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function listDates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
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
// Written to a temp file then renamed, so a request reading a day while a
// refresh is rewriting it never sees a half-written file.
function writeHistoryDay(date, obj) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const target = historyFile(date);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, target);
}

// A stored history row is deliberately compact (short keys, no per-task
// notes) - ~570 completions/day x a year adds up. desc is the PROJECT's own
// description (one short string per project, not per task), included because
// the dashboard's individual-reviews list shows it next to the project
// number.
//   id=WFlowTaskID wf=workflow template grp=group uid/user=who completed it
//   task=raw task name pid/proj/loc/desc=project id/number/location/description at=DateCompleted
// Project number/location are trimmed: this database right-pads CHAR-typed
// columns with spaces (a location comes back as "421 SE 6 AV" followed by
// ~35 trailing spaces).
function toHistoryRow(r) {
  const trimmed = (s) => (s == null ? null : (String(s).trim() || null));
  return {
    id: r.id, wf: r.wf || null, grp: trimmed(r.grp), uid: r.uid != null ? r.uid : null, user: r.user || null,
    task: r.task || null, pid: r.pid != null ? r.pid : null, proj: trimmed(r.proj), loc: trimmed(r.loc),
    desc: trimmed(r.desc), at: r.at || null
  };
}
// True if some row in this already-recorded day predates a field being added
// to the compact row schema (the row object is missing the KEY entirely, not
// just holding null/undefined for it - toHistoryRow always sets every
// current key, even to null, so a missing key only happens on rows written
// before that key existed). Used by HISTORY_FORCE_RESCHEMA to find days that
// still need a schema backfill, and to stop once none do.
function dayNeedsSchemaBackfill(date) {
  const day = readHistoryDay(date);
  if (!day || !Array.isArray(day.rows) || !day.rows.length) return false;
  return day.rows.some((r) => !Object.prototype.hasOwnProperty.call(r, 'desc'));
}
function historyRowToSummaryRow(h) {
  return { WorkflowTemplate: h.wf, GroupName: h.grp, UserID: h.uid, UserName: h.user, TaskName: h.task };
}

// Summary (and, for a single day, the task list) for an inclusive date range,
// read from the day files one at a time. Returns which days in the range have
// no file yet, so the dashboard can say so instead of silently under-reporting.
async function readHistoryRange(from, to, opts = {}) {
  const includeRows = !!opts.includeRows;
  const dates = listDates(from, to);
  const available = new Set(listHistoryDates());
  const acc = createCompletedSummary();
  const byDay = [];
  const missingDays = [];
  const rows = [];
  for (const date of dates) {
    if (!available.has(date)) { missingDays.push(date); continue; }
    const day = await fs.promises.readFile(historyFile(date), 'utf8').then((s) => JSON.parse(stripBom(s))).catch(() => null);
    if (!day || !Array.isArray(day.rows)) { missingDays.push(date); continue; }
    for (const h of day.rows) acc.add(historyRowToSummaryRow(h));
    byDay.push({ Date: date, Count: day.rows.length });
    if (includeRows) for (const h of day.rows) rows.push(h);
  }
  if (includeRows) rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const allDates = listHistoryDates();
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

  log('Loading reference data...');
  // Fallback map only, used if a live Project/GetProject lookup fails for a
  // given project - the primary source is the live-resolved projectCache below.
  const projectFallbackByID = new Map();
  if (fs.existsSync(PROJECT_LIST_CSV)) {
    for (const p of readCsv(PROJECT_LIST_CSV)) {
      if (p.ProjectID) projectFallbackByID.set(p.ProjectID, p);
    }
  }

  const instanceCache = readJsonSafe(INSTANCE_CACHE_JSON, {});
  log(`${Object.keys(instanceCache).length} workflow instances loaded from cache`);

  const userCache = readJsonSafe(USER_CACHE_JSON, {});
  log(`${Object.keys(userCache).length} reviewer names loaded from cache`);

  const projectCache = readJsonSafe(PROJECT_CACHE_JSON, {});
  log(`${Object.keys(projectCache).length} project name/status entries loaded from cache (TTL ${MAX_PROJECT_CACHE_AGE_MIN}m)`);

  log('Logging into ProjectDox...');
  const sessionId = await login();
  log('Logged in.');

  // Pulled live rather than from a one-time-probed local JSON file - that
  // file was a fine shortcut for local dev (where it already existed from
  // early API exploration) but doesn't travel with a clean deployment, and
  // would also silently go stale here if a new workflow template were ever
  // added. This table is tiny, so fetching it live every run costs nothing.
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

  // WFlowTasks/WFlowReviewCycles only carry currently-open/active instances -
  // once a workflow instance closes (e.g. a superseded revision), its rows
  // drop out of these tables entirely. Reviewer history for a re-review needs
  // closed instances too, so that join also pulls from ReportWFlowTasks/
  // ReportWFlowReviewCycles - a separate, ~500k-row append-only mirror that
  // retains closed-instance rows the live tables don't (see the big comment
  // further down at completedTasksByInstanceGroup for why BOTH sources are
  // needed, not just this one). Cached to disk with a long TTL since it's
  // pure history that doesn't change once written - see
  // MAX_REPORT_TABLES_CACHE_AGE_MIN above. The fetch itself runs in a child
  // process (see runReportTablesChildProcess) so its large raw-row memory
  // footprint never has to coexist with the rest of this process's own
  // memory - see the comment on that function for why.
  const now = Date.now();
  const reportTablesCache = readJsonSafe(REPORT_TABLES_CACHE_JSON, {});
  const reportTablesCacheAgeMin = reportTablesCache.CachedAt ? (now - new Date(reportTablesCache.CachedAt).getTime()) / 60000 : Infinity;
  const reportTablesCacheFresh = reportTablesCache.SchemaVersion === CACHE_SCHEMA_VERSION && reportTablesCacheAgeMin < MAX_REPORT_TABLES_CACHE_AGE_MIN;
  let reportTasks, reportReviewCycles;
  if (reportTablesCacheFresh) {
    reportTasks = reportTablesCache.reportTasks;
    reportReviewCycles = reportTablesCache.reportReviewCycles;
    log(`ReportWFlowTasks/ReportWFlowReviewCycles: ${reportTasks.length}/${reportReviewCycles.length} rows loaded from cache (${Math.round(reportTablesCacheAgeMin)}m old, TTL ${MAX_REPORT_TABLES_CACHE_AGE_MIN}m)`);
  } else {
    log('Fetching ReportWFlowTasks/ReportWFlowReviewCycles in a separate process (keeps their large peak memory off the main server process)...');
    const result = await runReportTablesChildProcess(log);
    const fresh = result.ok ? readJsonSafe(REPORT_TABLES_CACHE_JSON, null) : null;
    if (fresh && fresh.reportTasks) {
      reportTasks = fresh.reportTasks;
      reportReviewCycles = fresh.reportReviewCycles;
    } else {
      const why = result.ok
        ? 'the child process exited cleanly but the cache file it should have written is missing/unreadable'
        : result.reason + (result.stderr ? ` - ${result.stderr}` : '');
      log(`WARN: could not fetch ReportWFlowTasks/ReportWFlowReviewCycles (${why}) - continuing without cross-revision reviewer history for this run.`);
      reportTasks = [];
      reportReviewCycles = [];
    }
  }

  // Each review cycle carries both which instance (project) it belongs to
  // and its cycle number (1, 2, 3...) - the cycle number is what lets us tell
  // "this group already reviewed this project once before" apart from a
  // first-time review.
  //
  // Also merges in ReportWFlowReviewCycles (live takes precedence; report
  // only fills in cycle IDs the live table doesn't have) - live
  // WFlowReviewCycles drops a row entirely the moment its instance closes,
  // so a cycle whose workflow terminated has no other way to resolve to an
  // instance at all. Needed so a "completed today" task from
  // ReportWFlowTasks (below) can still be traced back to its project.
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
  const cycleToInstance = new Map(); // kept as a simple id->instance map for the rest of the pipeline
  for (const [cycleId, info] of cycleInfo) cycleToInstance.set(cycleId, info.WFlowInstanceID);

  // Not every task belongs to a review cycle - a workflow's coordinator-only
  // setup tasks (e.g. "Board Or Committee Selection"), which happen before
  // any department review cycle starts, have WFlowReviewCycleID = null and
  // were previously invisible to this dashboard entirely (confirmed live:
  // 314 such open Review Coordinator tasks exist system-wide). WFlowActivities
  // carries WFlowInstanceID directly, so WFlowTaskID -> WFlowActivityID ->
  // WFlowActivities.WFlowInstanceID resolves these the same way cycle-based
  // tasks resolve via WFlowReviewCycleID - used as a fallback wherever a
  // task has no cycle to resolve through.
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

  // Also pulls in tasks Completed today, alongside the normal Pending/
  // Accepted "open" set - lets the dashboard optionally show today's
  // completed work per group. Variable name kept as openTasks since it
  // still drives the exact same downstream join; only the eligibility
  // filter changed.
  //
  // "Today" is compared using Eastern time (America/New_York), not UTC:
  // DateCompleted comes back from the API as a naive timestamp with no
  // timezone marker (e.g. "2026-06-10T16:58:28.843") which is already
  // Pompano Beach's own local time, not UTC. Comparing that string's date
  // directly against a UTC "today" would put the day boundary several hours
  // off from what "today" actually means to City staff using this.
  const todayEastern = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const isCompletedTodayCandidate = (t) =>
    t.WFlowTaskStatusTypeID === 1 && t.DateCompleted && t.DateCompleted.slice(0, 10) === todayEastern;
  const openTasks = tasks.filter((t) => {
    if (resolveInstanceID(t) == null) return false;
    if (t.WFlowTaskStatusTypeID === 2 || t.WFlowTaskStatusTypeID === 3) return true;
    if (isCompletedTodayCandidate(t)) return true;
    return false;
  });
  // Live WFlowTasks drops a row entirely (not just marks it inactive) the
  // moment its instance closes, so a task completed today whose workflow
  // ALSO terminated today - a common sequence, since there's often nothing
  // left to do once the last review is in - would otherwise silently vanish
  // from "completed today" with no trace, even though it's a real event
  // that happened today. ReportWFlowTasks retains it; merge in whatever the
  // live pull didn't already have (dedupe by WFlowTaskID - an instance that
  // closed between the two queries could plausibly appear in both).
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

  const toResolve = distinctInstanceIDs.filter((id) => {
    const entry = instanceCache[String(id)];
    if (!entry || !entry.CachedAt || entry.SchemaVersion !== CACHE_SCHEMA_VERSION) return true;
    return (now - new Date(entry.CachedAt).getTime()) / 60000 >= MAX_INSTANCE_CACHE_AGE_MIN;
  });
  log(`${toResolve.length} instance(s) need a fresh lookup (${distinctInstanceIDs.length - toResolve.length} from cache).`);

  let resolvedCount = 0;
  await mapConcurrent(toResolve, CONCURRENCY, async (id) => {
    try {
      const inst = await getWorkflowInstance(sessionId, id);
      instanceCache[String(id)] = {
        WFlowInstanceID: inst.WFlowInstanceID,
        WFlowID: inst.WFlowID,
        EntityID: inst.EntityID,
        WFlowInstanceStateID: inst.WFlowInstanceStateID,
        WFlowInstanceStateName: inst.WFlowInstanceStateName,
        InstanceName: inst.InstanceName,
        Revision: parseRevision(inst.InstanceName),
        DateCompleted: inst.DateCompleted,
        SchemaVersion: CACHE_SCHEMA_VERSION,
        CachedAt: new Date().toISOString()
      };
    } catch (e) {
      log(`WARN GetWorkflowInstance(${id}) failed: ${e.message}`);
    }
    resolvedCount++;
    if (resolvedCount % 100 === 0) writeJson(INSTANCE_CACHE_JSON, instanceCache);
  });
  writeJson(INSTANCE_CACHE_JSON, instanceCache);
  log(`Instance cache saved (${Object.keys(instanceCache).length} total entries).`);

  // --- resolve project name/status for distinct referenced ACTIVE projects (short-TTL cache) ---
  const distinctProjectIDs = [...new Set(
    distinctInstanceIDs
      .map((id) => instanceCache[String(id)])
      .filter((inst) => inst && inst.WFlowInstanceStateID === 1)
      .map((inst) => inst.EntityID)
      .filter((id) => id != null)
  )];
  const projectsToResolve = distinctProjectIDs.filter((id) => {
    const entry = projectCache[String(id)];
    if (!entry || !entry.CachedAt || entry.SchemaVersion !== CACHE_SCHEMA_VERSION) return true;
    return (now - new Date(entry.CachedAt).getTime()) / 60000 >= MAX_PROJECT_CACHE_AGE_MIN;
  });
  log(`${distinctProjectIDs.length} distinct project(s) referenced; ${projectsToResolve.length} need a fresh lookup (TTL ${MAX_PROJECT_CACHE_AGE_MIN}m).`);

  let projectResolvedCount = 0;
  await mapConcurrent(projectsToResolve, CONCURRENCY, async (id) => {
    try {
      const p = await getProject(sessionId, id);
      projectCache[String(id)] = { ProjectID: id, Name: p.Name, Status: p.Status, Description: p.Description, Location: p.Location, SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
    } catch (e) {
      log(`WARN GetProject(${id}) failed: ${e.message}`);
    }
    projectResolvedCount++;
    if (projectResolvedCount % 100 === 0) writeJson(PROJECT_CACHE_JSON, projectCache);
  });
  writeJson(PROJECT_CACHE_JSON, projectCache);
  log(`Project cache saved (${Object.keys(projectCache).length} total entries).`);

  // --- discover sibling revision instances, only for projects that actually
  // need one: an open task sitting at Cycle 1 of a Revision >= 1 instance has
  // no earlier cycle of its OWN to look back at (each revision is its own
  // instance with its own cycle counter), so the relevant history lives in
  // the previous revision's instance instead. ---
  const revisionInstancesCache = readJsonSafe(REVISION_INSTANCES_CACHE_JSON, {});
  const projectsNeedingRevisionHistory = [...new Set(
    openTasks
      .map((t) => {
        const wflowInstanceID = resolveInstanceID(t);
        const inst = wflowInstanceID != null ? instanceCache[String(wflowInstanceID)] : null;
        const thisCycleInfo = cycleInfo.get(String(t.WFlowReviewCycleID));
        const reviewCycle = thisCycleInfo ? thisCycleInfo.ReviewCycle : null;
        const needsIt = inst && inst.WFlowInstanceStateID === 1 && reviewCycle === 1 && (inst.Revision || 0) > 0;
        return needsIt ? inst.EntityID : null;
      })
      .filter((id) => id != null)
  )];
  const revisionProjectsToResolve = projectsNeedingRevisionHistory.filter((id) => {
    const entry = revisionInstancesCache[String(id)];
    if (!entry || !entry.CachedAt || entry.SchemaVersion !== CACHE_SCHEMA_VERSION) return true;
    return (now - new Date(entry.CachedAt).getTime()) / 60000 >= MAX_REVISION_CACHE_AGE_MIN;
  });
  log(`${projectsNeedingRevisionHistory.length} project(s) need cross-revision reviewer history; ${revisionProjectsToResolve.length} need a fresh lookup.`);

  let revisionResolvedCount = 0;
  await mapConcurrent(revisionProjectsToResolve, CONCURRENCY, async (projectId) => {
    const proj = projectCache[String(projectId)] || projectFallbackByID.get(String(projectId));
    const projectName = proj ? proj.Name : null;
    if (!projectName) return; // can't look this up without the project number
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

  // For each open task needing it, find EVERY earlier-revision instance, not
  // just the immediately preceding one - a given revision can leave a group
  // untouched entirely (e.g. a minor revision that never reached Zoning
  // again), so the reviewer who actually last worked this group might be two
  // or more revisions further back than the one right before this task's.
  // Sorted nearest-revision-first so the lookup below stops at the closest
  // one that actually has data.
  const earlierRevisionInstancesByInstance = new Map(); // wflowInstanceID -> [earlier-revision wflowInstanceIDs, nearest first]
  for (const [projectId, entry] of Object.entries(revisionInstancesCache)) {
    const list = (entry.instances || []).filter((i) => i.Revision != null).sort((a, b) => b.Revision - a.Revision);
    for (const inst of list) {
      const earlier = list.filter((i) => i.Revision < inst.Revision).map((i) => i.WFlowInstanceID); // list already sorted desc
      if (earlier.length) earlierRevisionInstancesByInstance.set(String(inst.WFlowInstanceID), earlier);
    }
  }

  // --- build re-review history: for each open task, who (if anyone) reviewed
  // the same project, for the same review group, on an earlier cycle (same
  // revision) or an earlier revision's last cycle. Built entirely from the
  // WFlowTasks pull already in memory (Completed status = 1), scoped to the
  // instances that actually matter: currently-open-task instances plus
  // whatever earlier-revision instances were just discovered above. ---
  const relevantInstanceSet = new Set(distinctInstanceIDs.map(String));
  for (const ids of earlierRevisionInstancesByInstance.values()) {
    for (const id of ids) relevantInstanceSet.add(String(id));
  }

  // Revision numbers for every instance we know about - the main instance
  // cache only covers CURRENTLY active instances (resolved via the full
  // per-instance GetWorkflowInstance call); previous-revision sibling
  // instances were only fetched cheaply via GetWorkflowInstancesByProjectName
  // above and never got added to instanceCache, so their Revision has to
  // come from revisionInstancesCache instead or this silently comes back null.
  const revisionByInstanceId = new Map();
  for (const [id, cachedInst] of Object.entries(instanceCache)) {
    if (cachedInst.Revision != null) revisionByInstanceId.set(String(id), cachedInst.Revision);
  }
  for (const entry of Object.values(revisionInstancesCache)) {
    for (const i of (entry.instances || [])) {
      if (i.Revision != null) revisionByInstanceId.set(String(i.WFlowInstanceID), i.Revision);
    }
  }

  // Built from BOTH WFlowTasks/WFlowReviewCycles (live) AND ReportWFlowTasks/
  // ReportWFlowReviewCycles (historical mirror) - neither is complete alone.
  // The live tables only carry currently-open/active instances, so a closed
  // instance's history (e.g. a superseded revision) is entirely absent from
  // them. The Report* tables looked like the fix, but turned out to be the
  // mirror image of the same problem: probing them confirmed they DO retain
  // closed-instance rows, yet after switching to them exclusively, EVERY
  // same-instance earlier-cycle lookup (cycle 2+ of a still-open instance)
  // came back empty - strong evidence the Report* mirror is populated by a
  // batch sync keyed off instance closure, so a still-active instance's
  // already-completed earlier cycles simply aren't copied over yet. Live
  // tables cover "still open," Report tables cover "already closed" - only
  // the union covers both.
  //
  // Keyed by GroupName, not GroupID: GroupID is a per-workflow-instance
  // routing-slip row ID, freshly issued whenever a revision's workflow is
  // (re-)initiated - it is NOT a stable department identifier across
  // instances/revisions, even though it happens to stay constant across
  // cycles within the same instance. GroupName is the stable identity (it's
  // what the rest of this file already groups departments by - see the
  // `${r.WorkflowTemplate}::${r.GroupName}` key below), so cross-revision
  // lookups must match on it instead or they silently miss real history.
  //
  // GroupName is trimmed/case-folded on every use below: this database
  // right-pads some CHAR-typed columns with spaces (seen already on
  // ProjectDescription / ProjectLocation), and ReportWFlowTasks.GroupName
  // doesn't necessarily match WFlowTasks.GroupName byte-for-byte even for
  // the identical department - an unnormalized compare silently matches
  // nothing at all.
  const normGroupName = (name) => (name || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const reportCycleInfo = new Map();
  for (const c of reportReviewCycles) {
    if (c.WFlowReviewCycleID != null) {
      reportCycleInfo.set(String(c.WFlowReviewCycleID), { WFlowInstanceID: c.WFlowInstanceID, ReviewCycle: c.ReviewCycle });
    }
  }
  const completedTasksByInstanceGroup = new Map(); // "instanceId::groupName" -> [{WFlowTaskID, Revision, ReviewCycle, UserID, DateCompleted, TaskName}]
  const seenTaskIDs = new Set(); // dedupe: a task that's already in both sources (e.g. an instance that closed between the two queries) shouldn't be counted twice
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
  for (const t of reportTasks) addCompletedTask(t, reportCycleInfo.get(String(t.WFlowReviewCycleID)));
  // DateCompleted as a third tiebreaker: the same group can complete more
  // than one task within what's nominally the same (Revision, Cycle) - e.g.
  // reassigned mid-review - so ties need the actual most-recent completion,
  // not whatever order they happened to come out of the WFlowTasks pull in.
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
    // Only Pending/Accepted tasks need their parent workflow to still be
    // Active - a stale open task on an abandoned/terminated workflow
    // shouldn't show as work someone could pick up. A Completed task is a
    // historical fact regardless of what happened to the instance
    // afterward, so it must NOT be filtered out here - a workflow commonly
    // terminates the same day its last reviews complete (nothing left to
    // do), which was silently dropping that day's completions from the
    // "completed today" feature before this exclusion was added.
    if (t.WFlowTaskStatusTypeID !== 1 && inst.WFlowInstanceStateID !== 1) { skippedNotActive++; continue; } // 1 = Active

    const status = t.WFlowTaskStatusTypeID === 2 ? 'Accepted' : t.WFlowTaskStatusTypeID === 3 ? 'Pending' : t.WFlowTaskStatusTypeID === 1 ? 'Completed' : `Unknown(${t.WFlowTaskStatusTypeID})`;
    const cachedProj = projectCache[String(inst.EntityID)];
    const proj = cachedProj || projectFallbackByID.get(String(inst.EntityID));
    const templateName = wflowNameByID.get(String(inst.WFlowID)) || `WFlow${inst.WFlowID}`;

    const thisCycleInfo = cycleInfo.get(String(t.WFlowReviewCycleID));
    const reviewCycle = thisCycleInfo ? thisCycleInfo.ReviewCycle : null;
    const thisRevision = inst.Revision || 0;

    // Same-instance (same revision) earlier-cycle history.
    let priorReviews = (completedTasksByInstanceGroup.get(`${wflowInstanceID}::${normGroupName(t.GroupName)}`) || [])
      .filter((e) => reviewCycle == null || (e.ReviewCycle || 0) < reviewCycle);
    // Cycle 1 of a revision has no same-instance history by definition - walk
    // backwards through earlier revisions (nearest first) and stop at the
    // first one that actually has a completed review for this group. Don't
    // stop at the immediately-preceding revision unconditionally - it may
    // never have touched this group at all (e.g. a minor revision that
    // didn't get re-routed to Zoning), which would wrongly report "no prior
    // reviewer" when an earlier revision's approval is the real answer.
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
      ProjectStatus: proj ? proj.Status : null,
      ProjectDescription: proj ? proj.Description : null,
      ProjectLocation: proj ? proj.Location : null,
      AssignedUserName: null,
      // WFlowTaskAssignmentTypeID: 1=Individual (pre-assigned to one named
      // person - UserID is already set even before they've formally
      // accepted it), 2=FirstInGroup (open to whoever in the group grabs it
      // first - the normal "Pending" case), 3=AllInGroup, 4=AssignToWorkflowOwner.
      // A Pending task that's actually Individual isn't available to "first
      // available" the way a plain Pending task is, so the frontend needs
      // to tell the two apart instead of showing both identically.
      IsDirectAssignment: t.WFlowTaskAssignmentTypeID === 1,
      ReviewCycle: reviewCycle,
      Revision: thisRevision,
      // Same review group, earlier review(s) for the same project - same
      // revision's earlier cycles if any exist, else the previous revision's
      // history - most recent (by revision, then cycle) first. UserName
      // filled in once reviewer names are resolved, further down.
      PreviousReviewers: priorReviews.map((e) => ({
        Revision: e.Revision, ReviewCycle: e.ReviewCycle, UserID: e.UserID, UserName: null, DateCompleted: e.DateCompleted
      }))
    });
  }
  if (skippedUnresolved) log(`${skippedUnresolved} open task(s) skipped - instance unresolved.`);
  if (skippedNotActive) log(`${skippedNotActive} open task(s) skipped - parent workflow no longer Active.`);

  // --- resolve reviewer names for Accepted/Completed tasks, directly-assigned
  // Pending tasks, AND prior-cycle reviewers (cached) ---
  const assignedUserIDs = new Set(
    detailRows
      .filter((r) => (r.TaskStatus === 'Accepted' || r.TaskStatus === 'Completed' || (r.TaskStatus === 'Pending' && r.IsDirectAssignment)) && r.UserID)
      .map((r) => r.UserID)
  );
  const priorReviewerUserIDs = new Set();
  for (const r of detailRows) {
    for (const p of r.PreviousReviewers) { if (p.UserID) priorReviewerUserIDs.add(p.UserID); }
  }
  const allUserIDsToConsider = [...new Set([...assignedUserIDs, ...priorReviewerUserIDs])];
  const usersToResolve = allUserIDsToConsider.filter((uid) => {
    const entry = userCache[String(uid)];
    if (!entry || !entry.CachedAt || entry.SchemaVersion !== CACHE_SCHEMA_VERSION) return true;
    return (now - new Date(entry.CachedAt).getTime()) / 60000 >= MAX_USER_CACHE_AGE_MIN;
  });
  log(`${allUserIDsToConsider.length} distinct reviewer(s) (current + prior cycles); ${usersToResolve.length} need a fresh lookup.`);

  let userResolvedCount = 0;
  await mapConcurrent(usersToResolve, CONCURRENCY, async (uid) => {
    try {
      const u = await getUser(sessionId, uid);
      const name = u.FullName || `${u.FirstName || ''} ${u.LastName || ''}`.trim() || u.Email || null;
      userCache[String(uid)] = { UserID: uid, Name: name, SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
    } catch (e) {
      log(`WARN GetUser(${uid}) failed: ${e.message}`);
    }
    userResolvedCount++;
    if (userResolvedCount % 100 === 0) writeJson(USER_CACHE_JSON, userCache);
  });
  writeJson(USER_CACHE_JSON, userCache);
  log(`Reviewer name cache saved (${Object.keys(userCache).length} total entries).`);

  for (const row of detailRows) {
    const isResolvableAssignment = row.TaskStatus === 'Accepted' || row.TaskStatus === 'Completed' || (row.TaskStatus === 'Pending' && row.IsDirectAssignment);
    if (isResolvableAssignment && row.UserID && userCache[String(row.UserID)]) {
      row.AssignedUserName = userCache[String(row.UserID)].Name;
    }
    for (const p of row.PreviousReviewers) {
      if (p.UserID && userCache[String(p.UserID)]) p.UserName = userCache[String(p.UserID)].Name;
    }
  }

  // Accumulates every Completed-today row this process has ever actually
  // observed, across every refresh so far today, and resets at the Eastern
  // day boundary. This exists because visibility of a just-closed
  // instance's completed tasks isn't stable within a single day: a task can
  // be found via the live tables right after it completes, then briefly
  // disappear from BOTH the live tables (dropped the moment its instance
  // closes) AND the Report* mirror (populated by what looks like a batch
  // sync keyed off closure, which doesn't always keep up same-day) before
  // showing up again later - or, in the worst case observed live
  // (BP26-00006787), never reappear again before midnight at all. Once we've
  // actually seen a completion, we don't need to see it again to keep
  // reporting it for the rest of today.
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
  if (rescuedFromCache) log(`${rescuedFromCache} completed-today task(s) no longer independently resolvable this run - restored from earlier today's cache.`);
  writeJson(COMPLETED_TODAY_CACHE_JSON, completedTodayCache);

  writeCsv(DETAIL_CSV, detailRows);
  log(`Detail CSV written (${detailRows.length} rows).`);

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
  // Soonest due date first within each group (undated tasks sort last) - the
  // most time-pressured items surface at the top of the detail list.
  const byDueDate = (a, b) => {
    const ad = a.DateDue ? new Date(a.DateDue).getTime() : Infinity;
    const bd = b.DateDue ? new Date(b.DateDue).getTime() : Infinity;
    return ad - bd;
  };
  for (const g of groups.values()) g.Tasks.sort(byDueDate);

  const summary = [...groups.values()].sort((a, b) =>
    a.WorkflowTemplate.localeCompare(b.WorkflowTemplate) || a.GroupName.localeCompare(b.GroupName)
  );

  // Completed-today breakdown, across every group, sliced three ways (by
  // workflow, by group, by reviewer) so the dashboard can answer "who
  // completed what today" without requiring someone to open each group one
  // at a time. See createCompletedSummary() for the aggregation rules
  // (Operations vs Reviews split, self-service exclusion, task-name
  // normalization) - shared with the history view.
  const todaySummaryAcc = createCompletedSummary();
  for (const r of detailRows) {
    if (r.TaskStatus !== 'Completed') continue;
    if (SELF_SERVICE_GROUP_RE.test(r.GroupName || '')) continue;
    todaySummaryAcc.add({ WorkflowTemplate: r.WorkflowTemplate, GroupName: r.GroupName, UserID: r.UserID, UserName: r.AssignedUserName, TaskName: r.TaskName });
  }
  const completedTodaySummary = todaySummaryAcc.finish();

  const snapshot = {
    GeneratedAt: new Date().toISOString(),
    TotalOpenTasks: detailRows.filter((r) => r.TaskStatus !== 'Completed').length,
    CompletedTodaySummary: completedTodaySummary,
    Groups: summary
  };
  writeJson(SNAPSHOT_JSON, snapshot);

  // History is a bonus on top of the snapshot that's already been written -
  // a failure here must never fail (or hide) a refresh whose main job
  // succeeded.
  try {
    await updateCompletedHistory();
  } catch (e) {
    log(`WARN: completed-task history update failed (${e.message}) - the dashboard snapshot itself is unaffected.`);
  }

  // --- completed-task history --------------------------------------------
  //
  // Writes today's completions to today's day file (adding to whatever is
  // already there - a file only ever grows), re-derives the last couple of
  // weeks from the live + Report tables (a just-closed workflow's tasks can
  // lag into the Report mirror), and backfills a few older missing days per
  // run toward HISTORY_DAYS. See the block comment above HISTORY_DIR for why
  // this exists as files at all.
  async function updateCompletedHistory() {
    const today = todayEastern;
    const nowMs = Date.now();
    const lookups = readJsonSafe(HISTORY_LOOKUPS_JSON, {});
    lookups.projects = lookups.projects || {};
    lookups.failed = lookups.failed || { instances: {}, projects: {}, users: {} };
    const NEG_TTL_MS = 24 * 3600 * 1000;
    const recentlyFailed = (kind, id) => {
      const at = lookups.failed[kind][String(id)];
      return at && (nowMs - new Date(at).getTime()) < NEG_TTL_MS;
    };

    // Which past days to (re)derive from the live + Report tables this run.
    // Skipped entirely when the Report tables couldn't be loaded - deriving a
    // past day from the live table alone would write a file that's missing
    // every closed workflow's tasks and then look "complete".
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
        // Always logged (even when 0 need it, or 0 fit this run's budget) -
        // silence here would be indistinguishable from the env var not
        // actually reaching this process (e.g. a restart that didn't take).
        const needSchema = [...haveDates].filter((d) => !derive.has(d) && dayNeedsSchemaBackfill(d)).sort();
        const toDo = needSchema.slice(0, HISTORY_MAX_NEW_DAYS_PER_RUN);
        toDo.forEach((d) => derive.add(d));
        log(`History: HISTORY_FORCE_RESCHEMA is set - ${needSchema.length} already-recorded day(s) still need backfilling; re-deriving ${toDo.length} this run.`);
      }
    } else if (HISTORY_FORCE_RESCHEMA) {
      log('History: HISTORY_FORCE_RESCHEMA is set, but the Report tables aren\'t loaded this run, so nothing can be re-derived (see the "Report tables" log line above for why).');
    }

    // Candidate completed tasks (live table + Report mirror, deduped by task
    // id) for every date being derived.
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

    // Instances: any cached entry works regardless of age - which project and
    // workflow template an instance belongs to never changes.
    const instanceIds = [...new Set(candidates.map((t) => String(resolveInstanceID(t))))];
    const instancesToFetch = instanceIds.filter((id) => {
      const e = instanceCache[id];
      if (e && e.SchemaVersion === CACHE_SCHEMA_VERSION) return false;
      return !recentlyFailed('instances', id);
    });
    let instanceCacheDirty = false;
    await mapConcurrent(instancesToFetch, CONCURRENCY, async (id) => {
      try {
        const inst = await getWorkflowInstance(sessionId, id);
        instanceCache[id] = {
          WFlowInstanceID: inst.WFlowInstanceID, WFlowID: inst.WFlowID, EntityID: inst.EntityID,
          WFlowInstanceStateID: inst.WFlowInstanceStateID, WFlowInstanceStateName: inst.WFlowInstanceStateName,
          InstanceName: inst.InstanceName, Revision: parseRevision(inst.InstanceName), DateCompleted: inst.DateCompleted,
          SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString()
        };
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

    // Today's completions come from the same detailRows the dashboard itself
    // just used (including any rescued from the same-day accumulator cache).
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
        const name = u.FullName || `${u.FirstName || ''} ${u.LastName || ''}`.trim() || u.Email || null;
        userCache[uid] = { UserID: uid, Name: name, SchemaVersion: CACHE_SCHEMA_VERSION, CachedAt: new Date().toISOString() };
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
      const p = lookups.projects[String(r.pid)] || projectFallbackByID.get(String(r.pid));
      if (p) { r.proj = p.Name || null; r.loc = r.loc || p.Location || null; r.desc = r.desc || p.Description || null; }
    }
    writeJson(HISTORY_LOOKUPS_JSON, lookups);

    // Write each day: existing file rows + newly seen rows, keyed by task id
    // so it only ever grows. A NEW past day that had tasks it couldn't
    // resolve this run (an API hiccup) isn't written at all, so it stays
    // "missing" and gets another try next run instead of being recorded as a
    // finished-but-short day; re-derived days just add whatever they found.
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
        if (prev) { for (const k of ['user', 'proj', 'loc']) if (!merged[k] && prev[k]) merged[k] = prev[k]; }
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
  runCollector, readHistoryRange, isValidDateStr, listDates, addDays, easternToday, listHistoryDates,
  createCompletedSummary, HISTORY_MAX_RANGE_DAYS
};

if (require.main === module) {
  if (process.argv[2] === '--fetch-report-tables') {
    // Internal mode: spawned by runReportTablesChildProcess() as its own
    // process, specifically so its memory footprint is isolated from the
    // main server. Not meant to be run manually, though it's harmless to.
    fetchAndCacheReportTables()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('fetchAndCacheReportTables failed:', err.message);
        process.exit(1);
      });
  } else {
    // Allow `node collector.js` standalone.
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
