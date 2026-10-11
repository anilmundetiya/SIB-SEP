/* ==========================================================================
   SIB-SEP — Background service worker
   Orchestrates the automation flow, manages state, keeps SW alive.
   ========================================================================== */

const STORAGE_KEY = 'sibsep_state_v1';
const JOB_KEY = 'sibsep_job_v1';
const BRAND_VIEWER_URL = 'http://localhost:8899/';
const BRAND_VIEWER_MATCH = 'http://localhost:8899/*';
const KEEPALIVE_ALARM = 'sibsep-keepalive';
const LOG_MAX = 500;

// Retry settings (per approved spec)
const RETRY_ADD_MS = 5000;
const MAX_RETRIES = 5;

// ---------- Default state ----------

function defaultState() {
  return {
    status: 'idle', // idle | running | paused | stopped | done | error

    queue: [], // [{fileName, csvText, csvFileName, groups:[{id,asins,rows}], groupsTotal, asinsTotal}]
    filesTotal: 0,
    asinsTotal: 0,
    groupsTotal: 0,

    currentFileIdx: 0,   // index into queue
    currentGroupIdx: 0,  // index into current file's groups
    currentFileName: null,
    currentGroupId: null,
    lastAsin: null,

    totalAsinsProcessed: 0,
    totalGroupsProcessed: 0,

    failedGroups: [],    // [{fileName, groupId, asins, reason, timestamp}]

    logs: [],            // ring buffer

    canResume: false,    // true if we were interrupted mid-run
    activeTabId: null,   // Brand Viewer tab we're driving
  };
}

// ---------- State I/O ----------

let stateCache = null;

async function loadState() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  stateCache = r[STORAGE_KEY] || defaultState();
  // Recompute derived counters
  stateCache.filesTotal = stateCache.queue.length;
  stateCache.asinsTotal = stateCache.queue.reduce((s, f) => s + (f.asinsTotal || 0), 0);
  stateCache.groupsTotal = stateCache.queue.reduce((s, f) => s + (f.groupsTotal || 0), 0);
  return stateCache;
}

async function saveState() {
  if (!stateCache) return;
  stateCache.filesTotal = stateCache.queue.length;
  stateCache.asinsTotal = stateCache.queue.reduce((s, f) => s + (f.asinsTotal || 0), 0);
  stateCache.groupsTotal = stateCache.queue.reduce((s, f) => s + (f.groupsTotal || 0), 0);
  stateCache.failedCount = stateCache.failedGroups.length;
  await chrome.storage.local.set({ [STORAGE_KEY]: stateCache });
  broadcastState();
}

// ---------- Popup port ----------

let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sibsep-popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => {
      if (popupPort === port) popupPort = null;
    });
    // Push current state immediately
    if (stateCache) sendPortMessage({ type: 'STATE', state: stateCache });
  } else if (port.name === 'sibsep-processing') {
    // Content script opens this during a group. While it's open, SW is kept alive.
    // No message handling needed — just holding the port open is enough.
    port.onDisconnect.addListener(() => {});
  }
});

function sendPortMessage(msg) {
  if (!popupPort) return;
  try { popupPort.postMessage(msg); } catch (e) { popupPort = null; }
}

function broadcastState() {
  if (stateCache) sendPortMessage({ type: 'STATE', state: stateCache });
}

// ---------- Logging ----------

function log(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  if (!stateCache) return;
  stateCache.logs.push(entry);
  if (stateCache.logs.length > LOG_MAX) stateCache.logs = stateCache.logs.slice(-LOG_MAX);
  sendPortMessage({ type: 'LOG_APPEND', entry });
  // Also write to console for debugging
  const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  fn('[SIB-SEP]', msg);
}

// ---------- Message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const r = await handleMessage(msg, sender);
      sendResponse(r);
    } catch (e) {
      log('error', `Message handler error: ${e.message}`);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async
});

async function handleMessage(msg, sender) {
  await ensureLoaded();

  switch (msg.type) {
    case 'GET_STATE':
      return { ok: true, state: stateCache };

    case 'ADD_FILES': {
      // msg.files = [{fileName, csvText, csvFileName, groups, asinsTotal, groupsTotal}]
      for (const f of msg.files) {
        stateCache.queue.push(f);
        log('info', `Added ${f.fileName} — ${f.groupsTotal} groups, ${f.asinsTotal} ASINs`);
      }
      await saveState();
      return { ok: true };
    }

    case 'REMOVE_FILE': {
      const idx = msg.index;
      if (stateCache.status === 'running') {
        log('warn', 'Cannot remove files while running. Pause or stop first.');
        return { ok: false, error: 'Running' };
      }
      const removed = stateCache.queue.splice(idx, 1)[0];
      if (removed) log('info', `Removed ${removed.fileName}`);
      // Adjust indices if needed
      if (idx < stateCache.currentFileIdx) stateCache.currentFileIdx--;
      await saveState();
      return { ok: true };
    }

    case 'CLEAR_FILES': {
      if (stateCache.status === 'running') {
        log('warn', 'Cannot clear files while running. Pause or stop first.');
        return { ok: false, error: 'Running' };
      }
      stateCache.queue = [];
      stateCache.currentFileIdx = 0;
      stateCache.currentGroupIdx = 0;
      stateCache.currentFileName = null;
      stateCache.currentGroupId = null;
      stateCache.lastAsin = null;
      stateCache.totalAsinsProcessed = 0;
      stateCache.totalGroupsProcessed = 0;
      stateCache.canResume = false;
      stateCache.status = 'idle';
      try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
      log('info', 'Cleared all files.');
      await saveState();
      return { ok: true };
    }

    case 'START': {
      if (stateCache.queue.length === 0) {
        log('warn', 'No files to process.');
        return { ok: false, error: 'Empty queue' };
      }
      if (stateCache.status === 'running') return { ok: true, note: 'Already running' };

      // If not resuming (or nothing to resume), reset counters
      if (!msg.resume && !stateCache.canResume) {
        stateCache.currentFileIdx = 0;
        stateCache.currentGroupIdx = 0;
        stateCache.totalAsinsProcessed = 0;
        stateCache.totalGroupsProcessed = 0;
        stateCache.lastAsin = null;
      }
      stateCache.canResume = false;
      stateCache.status = 'running';
      startKeepAlive();
      log('info', msg.resume ? 'Resuming from last position…' : 'Starting…');
      await saveState();
      // Kick off the first group (fire-and-forget). Subsequent groups start via GROUP_DONE handler.
      startNextGroup().catch(e => {
        log('error', `startNextGroup crashed: ${e.message}`);
        stateCache.status = 'error';
        stateCache.canResume = true;
        saveState();
      });
      return { ok: true };
    }

    case 'PAUSE': {
      if (stateCache.status !== 'running') return { ok: true };
      stateCache.status = 'paused';
      log('warn', 'Pause requested. Will pause after current group.');
      await saveState();
      return { ok: true };
    }

    case 'STOP': {
      if (stateCache.status !== 'running' && stateCache.status !== 'paused') {
        return { ok: true };
      }
      stateCache.status = 'stopped';
      stateCache.canResume = true;
      log('warn', 'Stop requested. Will stop after current group.');
      await saveState();
      return { ok: true };
    }

    case 'DISCARD_RESUME': {
      stateCache.canResume = false;
      stateCache.currentFileIdx = 0;
      stateCache.currentGroupIdx = 0;
      stateCache.totalAsinsProcessed = 0;
      stateCache.totalGroupsProcessed = 0;
      stateCache.currentFileName = null;
      stateCache.currentGroupId = null;
      stateCache.lastAsin = null;
      stateCache.status = 'idle';
      try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
      log('info', 'Discarded resume point.');
      await saveState();
      return { ok: true };
    }

    case 'CLEAR_LOGS': {
      stateCache.logs = [];
      await saveState();
      return { ok: true };
    }

    case 'CLEAR_FAILED': {
      stateCache.failedGroups = [];
      log('info', 'Cleared failure history.');
      await saveState();
      return { ok: true };
    }

    case 'RETRY_FAILED': {
      const fails = stateCache.failedGroups;
      if (fails.length === 0) return { ok: true };
      // Build a synthetic file from failed groups (group by original fileName may span many files;
      // to keep it simple, we lump into one "retry" file with all failed groups)
      const groupsMap = new Map();
      for (const f of fails) {
        const gid = f.groupId;
        if (!groupsMap.has(gid)) groupsMap.set(gid, { id: gid, asins: [], rows: [] });
        const g = groupsMap.get(gid);
        for (const a of f.asins) {
          if (!g.asins.includes(a)) g.asins.push(a);
          g.rows.push([gid, a, '']); // labels lost — user should re-upload original file if labels critical
        }
      }
      const groups = [...groupsMap.values()];
      const asinsTotal = groups.reduce((s, g) => s + g.asins.length, 0);
      // Build CSV
      const rows = groups.flatMap(g => g.rows);
      const csvText = 'GroupID,ASIN,Label\r\n' + rows.map(r => r.join(',')).join('\r\n');
      const retryFile = {
        fileName: `Retry_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
        csvText,
        csvFileName: `Retry.csv`,
        groups,
        asinsTotal,
        groupsTotal: groups.length,
      };
      stateCache.queue.push(retryFile);
      stateCache.failedGroups = [];
      log('info', `Requeued ${groups.length} failed group(s) as ${retryFile.fileName}`);
      log('warn', 'Note: labels are empty on retry. Re-upload the original file if labels are critical.');
      await saveState();
      return { ok: true };
    }

    case 'LOG': {
      log(msg.entry.level, msg.entry.msg);
      return { ok: true };
    }

    case 'PROGRESS': {
      // Progress update from content script during a group
      if (msg.message) log('info', msg.message);
      return { ok: true };
    }

    case 'GROUP_DONE': {
      // Content script finished a group (success or failure)
      await onGroupDone(msg);
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

async function ensureLoaded() {
  if (!stateCache) await loadState();
}

// ---------- Delay formulas (per approved spec) ----------

function step3DelayMs(asinCount) {
  if (asinCount >= 1 && asinCount <= 5) return 7 * 1000;
  return Math.ceil(asinCount / 10) * 10 * 1000;
}

function step6DelayMs(asinCount) {
  if (asinCount >= 1 && asinCount <= 5) return 15 * 1000;
  return Math.ceil(asinCount / 10) * 22 * 1000;
}

// ---------- Tab management ----------

async function findBrandViewerTab() {
  const tabs = await chrome.tabs.query({ url: BRAND_VIEWER_MATCH });
  return tabs[0] || null;
}

async function ensureBrandViewerTab() {
  let tab = await findBrandViewerTab();
  if (!tab) {
    log('info', 'Opening Brand Viewer tab…');
    tab = await chrome.tabs.create({ url: BRAND_VIEWER_URL, active: true });
  } else if (!tab.active) {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
  }
  // Wait for tab to be ready
  await waitForTabReady(tab.id);
  // Verify content script is present; inject if missing
  await ensureContentScript(tab.id);
  stateCache.activeTabId = tab.id;
  return tab.id;
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return true;
    } catch (e) { return false; }
    await sleep(200);
  }
  return false;
}

async function ensureContentScript(tabId) {
  // Try a ping; if no response, inject.
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r && r.ready) return true;
  } catch (e) {
    // Inject
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await sleep(300);
    } catch (err) {
      log('error', `Failed to inject content script: ${err.message}`);
      throw err;
    }
  }
  return true;
}

// ---------- Automation loop (kick-off + completion handler) ----------

// Starts processing the current group (queue[currentFileIdx].groups[currentGroupIdx]).
// Fires START_GROUP at content script and returns. Completion is handled by onGroupDone
// via a GROUP_DONE message. If all groups/files are done, transitions to 'done'.
async function startNextGroup() {
  await ensureLoaded();
  if (stateCache.status !== 'running') return;

  // Advance past finished files
  while (stateCache.currentFileIdx < stateCache.queue.length) {
    const file = stateCache.queue[stateCache.currentFileIdx];
    if (stateCache.currentGroupIdx < file.groups.length) break;
    log('success', `Finished ${file.fileName}`);
    stateCache.currentFileIdx++;
    stateCache.currentGroupIdx = 0;
    await saveState();
  }

  if (stateCache.currentFileIdx >= stateCache.queue.length) {
    log('success', 'All files processed.');
    stateCache.status = 'done';
    stateCache.canResume = false;
    stateCache.currentFileName = null;
    stateCache.currentGroupId = null;
    stopKeepAlive();
    // Clear any stale job
    try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
    await saveState();
    return;
  }

  const file = stateCache.queue[stateCache.currentFileIdx];
  const group = file.groups[stateCache.currentGroupIdx];

  stateCache.currentFileName = file.fileName;
  stateCache.currentGroupId = group.id;
  stateCache.lastAsin = group.asins[0];
  await saveState();

  // Ensure Brand Viewer tab is open and content script is present
  let tabId;
  try {
    tabId = await ensureBrandViewerTab();
  } catch (e) {
    log('error', `Could not open Brand Viewer: ${e.message}`);
    stateCache.status = 'error';
    stateCache.canResume = true;
    await saveState();
    return;
  }

  const data = {
    groupId: group.id,
    fileName: file.fileName,
    asins: group.asins,
    csvContent: file.csvText,
    csvFileName: file.csvFileName || file.fileName,
    step3DelayMs: step3DelayMs(group.asins.length),
    step6DelayMs: step6DelayMs(group.asins.length),
    retryDelayMs: RETRY_ADD_MS,
    maxRetries: MAX_RETRIES,
  };

  log('info', `▶ ${file.fileName} · Group #${group.id} · ${group.asins.length} ASIN(s)`);

  const sent = await sendStartGroup(tabId, data);
  if (!sent.ok) {
    // Could not start the content script at all — mark this group failed and move on
    await recordGroupFailure(group, file, sent.error || 'Failed to send START_GROUP');
    stateCache.currentGroupIdx++;
    await saveState();
    // Try the next one
    setTimeout(() => startNextGroup().catch(e => log('error', `startNextGroup error: ${e.message}`)), 500);
    return;
  }
  // Now we wait for GROUP_DONE (via onGroupDone) or an alarm safety tick.
}

// Sends START_GROUP to the content script. Retries once with fresh injection on failure.
async function sendStartGroup(tabId, data) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'START_GROUP', data });
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'No ack' };
  } catch (e) {
    // Try to re-inject and retry once
    log('warn', `START_GROUP send failed: ${e.message}. Re-injecting content script…`);
    try {
      await ensureContentScript(tabId);
      const r2 = await chrome.tabs.sendMessage(tabId, { type: 'START_GROUP', data });
      return r2 && r2.ok ? { ok: true } : { ok: false, error: (r2 && r2.error) || 'No ack' };
    } catch (e2) {
      return { ok: false, error: `Content script unreachable: ${e2.message}` };
    }
  }
}

// Called when content script sends GROUP_DONE.
async function onGroupDone(msg) {
  await ensureLoaded();
  if (stateCache.status === 'idle' || stateCache.status === 'done') {
    // Ignore stray completion messages
    return;
  }

  const file = stateCache.queue[stateCache.currentFileIdx];
  const group = file && file.groups[stateCache.currentGroupIdx];
  if (!file || !group) {
    log('warn', 'GROUP_DONE received but no current group in state; ignoring.');
    return;
  }
  // Sanity: groupId should match
  if (msg.groupId != null && String(msg.groupId) !== String(group.id)) {
    log('warn', `GROUP_DONE for #${msg.groupId} but current is #${group.id}; still applying to current.`);
  }

  if (msg.success) {
    stateCache.totalGroupsProcessed++;
    stateCache.totalAsinsProcessed += group.asins.length;
    stateCache.lastAsin = group.asins[group.asins.length - 1];
    log('success', `✓ Group #${group.id} saved (${group.asins.length} ASINs)`);
  } else {
    await recordGroupFailure(group, file, msg.error || 'Unknown error');
  }

  // Advance to next group
  stateCache.currentGroupIdx++;
  // Clear the job blob
  try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
  await saveState();

  // Honor pause/stop set during the group
  if (stateCache.status === 'paused') {
    log('warn', 'Paused. Click Resume when ready.');
    stateCache.canResume = true;
    stopKeepAlive();
    await saveState();
    return;
  }
  if (stateCache.status === 'stopped') {
    log('warn', 'Stopped.');
    stateCache.canResume = true;
    stopKeepAlive();
    await saveState();
    return;
  }

  // Small breather then kick off next
  setTimeout(() => startNextGroup().catch(e => log('error', `startNextGroup error: ${e.message}`)), 600);
}

async function recordGroupFailure(group, file, reason) {
  stateCache.failedGroups.push({
    fileName: file.fileName,
    groupId: group.id,
    asins: group.asins,
    reason,
    timestamp: Date.now(),
  });
  log('error', `✗ Group #${group.id} failed: ${reason}`);
}

// ---------- Keep-alive (via alarms) ----------

function startKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // 24 sec
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    await ensureLoaded();
    if (stateCache.status !== 'running') return;

    // Check the current job. If it's stalled (>5 min since start), mark as failed and move on.
    const r = await chrome.storage.local.get(JOB_KEY);
    const job = r[JOB_KEY];
    const now = Date.now();

    if (job && job.active) {
      const age = now - (job.startedAt || now);
      if (age > 5 * 60 * 1000) {
        log('warn', `Job for Group #${job.groupId} stalled ${(age / 1000).toFixed(0)}s. Marking failed.`);
        try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
        await onGroupDone({ groupId: job.groupId, success: false, error: `Stalled after ${(age / 1000).toFixed(0)}s` });
      }
      // Otherwise still working — alarm firing is enough to keep SW alive
      return;
    }

    // No active job but status is running — probably lost a GROUP_DONE message. Kick off next.
    if (job && !job.active && job.phase === 'done') {
      log('info', 'Alarm: recovering missed completion.');
      const success = !!job.success;
      const error = job.error || null;
      try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {}
      await onGroupDone({ groupId: job.groupId, success, error });
      return;
    }

    // No job at all — start next group
    startNextGroup().catch(e => log('error', `startNextGroup error: ${e.message}`));
  }
});

// ---------- Startup & install ----------

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  // If previous state was running/paused, mark for resume
  if (stateCache.status === 'running' || stateCache.status === 'paused') {
    stateCache.status = 'idle';
    stateCache.canResume = true;
    await saveState();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  if (stateCache.status === 'running' || stateCache.status === 'paused') {
    stateCache.status = 'idle';
    stateCache.canResume = true;
    await saveState();
  }
});

// Load on SW wake-up
loadState().then(() => {
  if (stateCache.status === 'running') {
    // SW was killed mid-run; mark as needing resume
    stateCache.status = 'idle';
    stateCache.canResume = true;
    saveState();
  }
});

// ---------- Utils ----------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
