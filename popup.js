/* ==========================================================================
   SIB-SEP — Popup script
   ========================================================================== */

// ---------- DOM refs ----------

const $ = (id) => document.getElementById(id);

const el = {
  statusPill: $('statusPill'),
  markDot: $('markDot'),

  resumeBanner: $('resumeBanner'),
  resumeInfo: $('resumeInfo'),
  resumeBtn: $('resumeBtn'),
  freshBtn: $('freshBtn'),

  asinsProcessedNum: $('asinsProcessedNum'),
  asinsTotalNum: $('asinsTotalNum'),
  filesStat: $('filesStat'),
  groupsStat: $('groupsStat'),
  failedStat: $('failedStat'),
  progressBar: $('progressBar'),
  currentFile: $('currentFile'),
  currentGroup: $('currentGroup'),
  lastAsin: $('lastAsin'),

  startBtn: $('startBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),

  fileInput: $('fileInput'),
  dropZone: $('dropZone'),
  fileList: $('fileList'),
  clearFilesBtn: $('clearFilesBtn'),

  logWindow: $('logWindow'),
  copyLogsBtn: $('copyLogsBtn'),
  clearLogsBtn: $('clearLogsBtn'),
  autoScrollToggle: $('autoScrollToggle'),

  failedList: $('failedList'),
  failedCount: $('failedCount'),
  retryFailedBtn: $('retryFailedBtn'),
  copyFailedBtn: $('copyFailedBtn'),
  clearFailedBtn: $('clearFailedBtn'),
};

// ---------- State ----------

let currentState = null;
let port = null;

// ---------- Port to background ----------

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'sibsep-popup' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'STATE') {
        renderState(msg.state);
      } else if (msg.type === 'LOG_APPEND') {
        appendLog(msg.entry);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // SW died — auto-reconnect after a short delay (wakes SW back up)
      setTimeout(() => {
        connectPort();
        loadInitialState();
      }, 500);
    });
  } catch (e) {
    port = null;
    setTimeout(() => { connectPort(); loadInitialState(); }, 1000);
  }
}

connectPort();

// Ask for initial state
async function loadInitialState() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (resp && resp.state) renderState(resp.state);
  } catch (e) {
    // SW might still be waking up — retry once
    setTimeout(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        if (resp && resp.state) renderState(resp.state);
      } catch (_) {}
    }, 1000);
  }
}

// ---------- File parsing ----------

function parseCsvText(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Simple CSV parser handling quoted values and CRLF
  const rows = [];
  let i = 0, cur = [], cell = '', inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { cur.push(cell); cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell.length > 0 || cur.length > 0) { cur.push(cell); rows.push(cur); }
  return rows;
}

function findColumnIndex(headerRow, candidates) {
  const norm = (s) => (s || '').toString().replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, '');
  const normalized = headerRow.map(norm);
  for (const cand of candidates) {
    const idx = normalized.indexOf(norm(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Returns { groups: [{id, asins:[], rows:[[GroupID, ASIN, Label]]}], asinsTotal, groupsTotal, warnings:[] }
function buildGroupsFromRows(rows) {
  const warnings = [];
  if (rows.length < 2) throw new Error('File has no data rows.');

  // Filter empty rows
  const cleanRows = rows.filter(r => r.some(c => (c || '').toString().trim() !== ''));
  if (cleanRows.length < 2) throw new Error('File has no data rows.');

  const header = cleanRows[0];
  const idxGroup = findColumnIndex(header, ['GroupID', 'Group ID', 'Group']);
  const idxAsin = findColumnIndex(header, ['ASIN']);
  const idxLabel = findColumnIndex(header, ['Label', 'Variant', 'Variation']);

  if (idxGroup === -1) throw new Error('Missing "GroupID" column.');
  if (idxAsin === -1) throw new Error('Missing "ASIN" column.');
  if (idxLabel === -1) warnings.push('No "Label" column — labels will be empty.');

  const groupMap = new Map(); // groupId -> {id, asins:[], rows:[]}
  for (let r = 1; r < cleanRows.length; r++) {
    const row = cleanRows[r];
    const gid = (row[idxGroup] || '').toString().trim();
    const asin = (row[idxAsin] || '').toString().trim().toUpperCase();
    const label = idxLabel !== -1 ? ((row[idxLabel] || '').toString().trim()) : '';
    if (!gid || !asin) continue;
    if (!groupMap.has(gid)) {
      groupMap.set(gid, { id: gid, asins: [], rows: [] });
    }
    const g = groupMap.get(gid);
    if (!g.asins.includes(asin)) g.asins.push(asin);
    g.rows.push([gid, asin, label]);
  }

  const groups = [...groupMap.values()].filter(g => g.asins.length > 0);
  const asinsTotal = groups.reduce((s, g) => s + g.asins.length, 0);
  return { groups, asinsTotal, groupsTotal: groups.length, warnings };
}

function rowsToCsvText(header, rows) {
  const escape = (v) => {
    const s = (v ?? '').toString();
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [header.map(escape).join(',')];
  for (const r of rows) lines.push(r.map(escape).join(','));
  return lines.join('\r\n');
}

async function parseFile(file) {
  const name = file.name;
  const lower = name.toLowerCase();

  let rows;
  if (lower.endsWith('.csv')) {
    const text = await file.text();
    rows = parseCsvText(text);
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const buf = await file.arrayBuffer();
    if (typeof XLSX === 'undefined') throw new Error('XLSX parser not loaded.');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('XLSX has no sheets.');
    const ws = wb.Sheets[sheetName];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  } else {
    throw new Error(`Unsupported format: ${name}`);
  }

  const built = buildGroupsFromRows(rows);
  // Reconstruct a normalized CSV of the entire file (for uploading in step 6)
  const csvText = rowsToCsvText(['GroupID', 'ASIN', 'Label'],
    built.groups.flatMap(g => g.rows));

  return {
    fileName: name,
    csvText,
    csvFileName: name.replace(/\.xlsx?$/i, '.csv'),
    groups: built.groups,
    asinsTotal: built.asinsTotal,
    groupsTotal: built.groupsTotal,
    warnings: built.warnings,
  };
}

// ---------- Rendering ----------

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

function truncate(s, n) {
  if (!s) return '—';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderState(state) {
  currentState = state;

  // Status pill
  const st = state.status || 'idle';
  const map = {
    idle: 'Idle',
    running: 'Running',
    paused: 'Paused',
    stopped: 'Stopped',
    done: 'Done',
    error: 'Error',
  };
  el.statusPill.textContent = map[st] || st;
  el.statusPill.dataset.state = st;

  // Buttons
  el.startBtn.disabled = (st === 'running' || (state.queue?.length ?? 0) === 0);
  el.startBtn.innerHTML = (st === 'paused')
    ? '<span class="btn-icon">▶</span> Resume'
    : '<span class="btn-icon">▶</span> Start';
  el.pauseBtn.disabled = (st !== 'running');
  el.stopBtn.disabled = (st !== 'running' && st !== 'paused');

  // Hero counters
  const asinsDone = state.totalAsinsProcessed || 0;
  const asinsTotal = state.asinsTotal || 0;
  el.asinsProcessedNum.textContent = asinsDone;
  el.asinsTotalNum.textContent = asinsTotal;
  el.filesStat.textContent = `${state.currentFileIdx || 0} / ${state.filesTotal || 0}`;
  el.groupsStat.textContent = `${state.totalGroupsProcessed || 0} / ${state.groupsTotal || 0}`;
  el.failedStat.textContent = state.failedCount || 0;
  el.failedStat.dataset.nonzero = String((state.failedCount || 0) > 0);

  const pct = asinsTotal > 0 ? Math.min(100, Math.round((asinsDone / asinsTotal) * 100)) : 0;
  el.progressBar.style.width = pct + '%';
  el.progressBar.dataset.state = st;

  // Current line
  el.currentFile.textContent = state.currentFileName || '—';
  el.currentFile.title = state.currentFileName || '—';
  el.currentGroup.textContent = state.currentGroupId ? `#${state.currentGroupId}` : '—';
  el.lastAsin.textContent = state.lastAsin || '—';

  // File list
  renderFileList(state.queue || [], state.currentFileIdx || 0, st);

  // Resume banner
  if (state.canResume && st !== 'running' && st !== 'paused') {
    el.resumeBanner.hidden = false;
    el.resumeInfo.textContent = `File "${state.currentFileName || '?'}" → Group #${state.currentGroupId || '?'} → ${state.lastAsin || '?'}`;
  } else {
    el.resumeBanner.hidden = true;
  }

  // Failed list
  renderFailedList(state.failedGroups || []);

  // Logs (initial paint)
  if (state.logs && Array.isArray(state.logs)) renderLogs(state.logs);
}

function renderFileList(queue, currentIdx, status) {
  if (!queue.length) {
    el.fileList.innerHTML = '';
    return;
  }
  const frag = document.createDocumentFragment();
  queue.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'file-item';
    let st = 'pending';
    if (i < currentIdx) st = 'done';
    else if (i === currentIdx && (status === 'running' || status === 'paused')) st = 'processing';
    row.dataset.status = st;

    const ext = f.fileName.toLowerCase().endsWith('.xlsx') ? 'XLS' : 'CSV';
    row.innerHTML = `
      <div class="file-icon">${ext}</div>
      <div class="file-info">
        <div class="file-name" title="${f.fileName}">${escapeHtml(f.fileName)}</div>
        <div class="file-meta">${f.groupsTotal} groups · ${f.asinsTotal} ASINs</div>
      </div>
      <button class="file-remove" data-idx="${i}" title="Remove">×</button>
    `;
    frag.appendChild(row);
  });
  el.fileList.innerHTML = '';
  el.fileList.appendChild(frag);

  // Bind remove buttons
  el.fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.idx, 10);
      await chrome.runtime.sendMessage({ type: 'REMOVE_FILE', index: idx });
    });
  });
}

function renderLogs(logs) {
  const auto = el.autoScrollToggle.checked;
  if (!logs || logs.length === 0) {
    el.logWindow.innerHTML = '<div class="log-empty">No activity yet.</div>';
    return;
  }
  el.logWindow.innerHTML = logs.map(logHtml).join('');
  if (auto) el.logWindow.scrollTop = el.logWindow.scrollHeight;
}

function appendLog(entry) {
  const auto = el.autoScrollToggle.checked;
  const empty = el.logWindow.querySelector('.log-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.innerHTML = logHtml(entry);
  el.logWindow.appendChild(div.firstElementChild);

  // Trim to last 500 in DOM
  while (el.logWindow.children.length > 500) el.logWindow.firstElementChild.remove();

  if (auto) el.logWindow.scrollTop = el.logWindow.scrollHeight;
}

function logHtml(e) {
  const lvl = e.level || 'info';
  return `<div class="log-entry" data-level="${lvl}">
    <span class="log-ts">${fmtTs(e.ts)}</span>
    <span class="log-level">${lvl}</span>
    <span class="log-msg">${escapeHtml(e.msg)}</span>
  </div>`;
}

function renderFailedList(fails) {
  el.failedCount.textContent = fails.length;
  el.failedCount.dataset.nonzero = String(fails.length > 0);
  el.retryFailedBtn.disabled = (fails.length === 0);

  if (fails.length === 0) {
    el.failedList.innerHTML = '<div class="log-empty">No failures.</div>';
    return;
  }
  el.failedList.innerHTML = fails.map(f => `
    <div class="failed-item">
      <div class="failed-head">
        <span class="failed-ident">${escapeHtml(f.fileName)} · #${escapeHtml(f.groupId)}</span>
        <span class="failed-ts">${fmtTs(f.timestamp)}</span>
      </div>
      <div class="failed-reason">${escapeHtml(f.reason)}</div>
      <div class="failed-asins" title="${escapeHtml(f.asins.join(', '))}">${escapeHtml(f.asins.join(', '))}</div>
    </div>
  `).join('');
}

function escapeHtml(s) {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- File input handling ----------

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.(csv|xlsx)$/i.test(f.name));
  if (files.length === 0) return;

  const parsed = [];
  for (const f of files) {
    try {
      const p = await parseFile(f);
      parsed.push(p);
      if (p.warnings?.length) {
        for (const w of p.warnings) {
          await chrome.runtime.sendMessage({
            type: 'LOG', entry: { ts: Date.now(), level: 'warn', msg: `${p.fileName}: ${w}` }
          });
        }
      }
    } catch (err) {
      await chrome.runtime.sendMessage({
        type: 'LOG', entry: { ts: Date.now(), level: 'error', msg: `Failed to parse ${f.name}: ${err.message}` }
      });
    }
  }
  if (parsed.length > 0) {
    await chrome.runtime.sendMessage({ type: 'ADD_FILES', files: parsed });
    // Force UI refresh so new file appears immediately (even if port is dead)
    await loadInitialState();
  }
  el.fileInput.value = '';
}

el.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

// Drag & drop
['dragenter', 'dragover'].forEach(evt =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    el.dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach(evt =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    el.dropZone.classList.remove('dragover');
  })
);
el.dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});

// ---------- Button handlers ----------

el.startBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'START' });
});

el.pauseBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'PAUSE' });
});

el.stopBtn.addEventListener('click', async () => {
  const ok = confirm('Stop the current run? Progress will be saved so you can resume later.');
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: 'STOP' });
});

el.clearFilesBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_FILES' });
});

el.clearLogsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
});

el.copyLogsBtn.addEventListener('click', async () => {
  const logs = currentState?.logs || [];
  const text = logs.map(e => `[${fmtTs(e.ts)}] ${(e.level || 'info').toUpperCase()}\t${e.msg}`).join('\n');
  await navigator.clipboard.writeText(text);
  flashButton(el.copyLogsBtn, 'Copied');
});

el.clearFailedBtn.addEventListener('click', async () => {
  if (!(currentState?.failedGroups?.length)) return;
  const ok = confirm('Clear all failure history?');
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_FAILED' });
});

el.copyFailedBtn.addEventListener('click', async () => {
  const fails = currentState?.failedGroups || [];
  if (fails.length === 0) return;
  const lines = ['File,GroupID,ASINs,Reason,Timestamp'];
  for (const f of fails) {
    const asins = f.asins.join('|');
    const reason = f.reason.replace(/"/g, '""');
    lines.push(`"${f.fileName}","${f.groupId}","${asins}","${reason}","${new Date(f.timestamp).toISOString()}"`);
  }
  await navigator.clipboard.writeText(lines.join('\n'));
  flashButton(el.copyFailedBtn, 'Copied');
});

el.retryFailedBtn.addEventListener('click', async () => {
  const fails = currentState?.failedGroups || [];
  if (fails.length === 0) return;
  const ok = confirm(`Retry ${fails.length} failed group(s)?\nThey will be re-queued as a new file.`);
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: 'RETRY_FAILED' });
});

el.resumeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'START', resume: true });
});

el.freshBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCARD_RESUME' });
});

function flashButton(btn, msg) {
  const orig = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 900);
}

// ---------- Kick off ----------

// Pop-out: open popup.html in a standalone window (resizable + draggable)
const popOutBtn = document.getElementById('popOutBtn');
if (popOutBtn) {
  popOutBtn.addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 540,
      height: 780,
    });
    window.close(); // close the tiny popup
  });
}

loadInitialState();

// Backup poll every 15s — keeps UI fresh even if the port silently died
setInterval(() => { loadInitialState(); }, 15000);
