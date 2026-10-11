/* ==========================================================================
   SIB-SEP — Content script (state-machine, survives page navigation)
   Runs on http://localhost:8899/* at document_idle.

   Each group is broken into phases. The phase is committed to storage
   BEFORE any click that might navigate. On page reload, the content script
   re-boots, reads the phase, and resumes.
   ========================================================================== */

(() => {
  if (window.__SIBSEP_CS_LOADED__) return;
  window.__SIBSEP_CS_LOADED__ = true;

  const JOB_KEY = 'sibsep_job_v1';

  // ---------- Utils ----------

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function csLog(...args) { console.log('[SIB-SEP][cs]', ...args); }

  async function waitFor(fn, timeoutMs = 10000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const r = fn(); if (r) return r; } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  function textNormalize(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function textCompact(s) { return (s || '').replace(/\s+/g, '').toUpperCase(); }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickEl(el) {
    if (!el) throw new Error('clickEl: null element');
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    try { el.click(); } catch (_) {}
  }

  async function uploadFileToInput(input, content, filename) {
    const blob = new Blob([content], { type: 'text/csv' });
    const file = new File([blob], filename, { type: 'text/csv', lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- Element finders (Brand Viewer-specific) ----------

  function findNewSearchButton() {
    for (const b of document.querySelectorAll('button, a')) {
      if (/^\s*New\s+Search\s*$/i.test(textNormalize(b.textContent)) && isVisible(b)) return b;
    }
    return null;
  }

  function findAsinModeButton() {
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (textCompact(b.textContent) === 'ASIN' && isVisible(b)) return b;
    }
    return null;
  }

  function findAsinTextarea() {
    const tas = document.querySelectorAll('textarea');
    for (const ta of tas) {
      if (/paste\s+asin/i.test(ta.placeholder || '') && isVisible(ta)) return ta;
    }
    for (const ta of tas) if (isVisible(ta)) return ta;
    return null;
  }

  function findSearchButton() {
    for (const b of document.querySelectorAll('button')) {
      if (/^Search$/i.test(textNormalize(b.textContent)) && isVisible(b)) return b;
    }
    return null;
  }

  function findResultsTable() {
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const heads = [...t.querySelectorAll('thead th')].map(th => textNormalize(th.textContent).toUpperCase());
      if (heads.includes('ASIN')) return t;
    }
    return tables[0] || null;
  }

  function isOnResultsPage() {
    const tbl = findResultsTable();
    if (!tbl) return false;
    return tbl.querySelectorAll('tbody tr').length > 0;
  }

  function isOnSearchForm() {
    if (findAsinTextarea()) return true;
    for (const n of document.querySelectorAll('div, span, label, p, h1, h2, h3')) {
      if (/search\s+mode/i.test(textNormalize(n.textContent))) return true;
    }
    return false;
  }

  function findHeaderCheckbox() {
    const tbl = findResultsTable();
    if (!tbl) return null;
    const th = tbl.querySelector('thead input[type="checkbox"]');
    if (th && isVisible(th)) return th;
    return tbl.querySelector('input[type="checkbox"]');
  }

  function findCreateSiblingsButton() {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (/create\s+siblings/i.test(textNormalize(b.textContent)) && isVisible(b)) return b;
    }
    return null;
  }

  function findSiblingModal() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="header"]');
    for (const h of heads) {
      if (/create\s+sibling\s+group/i.test(textNormalize(h.textContent))) {
        let el = h;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement;
          const cls = el.className || '';
          const role = el.getAttribute && el.getAttribute('role');
          if (role === 'dialog' || /modal|dialog|overlay|popup/i.test(String(cls))) return el;
        }
        return h.closest('div');
      }
    }
    return document.querySelector('[role="dialog"]');
  }

  function isModalOpen() {
    const m = findSiblingModal();
    return !!(m && isVisible(m));
  }

  function findFileInputInModal() {
    const modal = findSiblingModal();
    if (!modal) return null;
    const inputs = modal.querySelectorAll('input[type="file"]');
    for (const inp of inputs) {
      const acc = (inp.accept || '').toLowerCase();
      if (!acc || /csv|\*/.test(acc)) return inp;
    }
    return inputs[0] || null;
  }

  function findUploadLabelsButton() {
    const modal = findSiblingModal();
    const scope = modal || document;
    for (const b of scope.querySelectorAll('button, label, a, [role="button"]')) {
      if (/upload\s+labels/i.test(textNormalize(b.textContent)) && isVisible(b)) return b;
    }
    return null;
  }

  function findSaveGroupButton() {
    const modal = findSiblingModal();
    const scope = modal || document;
    for (const b of scope.querySelectorAll('button, [role="button"]')) {
      if (/save\s+group/i.test(textNormalize(b.textContent)) && isVisible(b)) return b;
    }
    return null;
  }

  // ---------- Storage helpers ----------

  async function getJob() {
    const r = await chrome.storage.local.get(JOB_KEY);
    return r[JOB_KEY] || null;
  }

  async function setJob(patch) {
    const cur = (await getJob()) || {};
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [JOB_KEY]: next });
    return next;
  }

  // ---------- Reporting to background ----------

  function progress(msg) {
    try { chrome.runtime.sendMessage({ type: 'PROGRESS', message: msg }); } catch (_) {}
  }

  function reportDone(groupId, success, error) {
    try {
      chrome.runtime.sendMessage({ type: 'GROUP_DONE', groupId, success, error: error || null });
    } catch (_) {}
  }

  async function finishJob(job, success, errorMsg) {
    await setJob({ active: false, phase: 'done', success, error: errorMsg || null });
    if (success) progress(`Group #${job.groupId}: ✓ complete`);
    else progress(`Group #${job.groupId}: ✗ ${errorMsg}`);
    reportDone(job.groupId, success, errorMsg);
  }

  // ---------- State machine ----------

  let executing = false; // guard against re-entrant runs

  async function executePhase(job) {
    if (!job || !job.active) return;
    const step3 = job.step3DelayMs;
    const step6 = job.step6DelayMs;

    csLog(`Phase=${job.phase} | search=${isOnSearchForm()} results=${isOnResultsPage()} modal=${isModalOpen()}`);

    // Phase 1 — get to search form (may click New Search which reloads)
    if (job.phase === 'need_search_form') {
      if (isOnResultsPage() && !isOnSearchForm()) {
        progress(`Group #${job.groupId}: clicking New Search…`);
        const btn = findNewSearchButton();
        if (!btn) throw new Error('New Search button not found on results page');
        clickEl(btn);
        // Page will reload; script will re-boot with phase still = need_search_form
        await sleep(600);
        return;
      }
      if (isOnSearchForm()) {
        await setJob({ phase: 'need_paste_and_search' });
        return executePhase(await getJob());
      }
      // Unknown state — wait briefly for one of the two, then retry
      const got = await waitFor(() => isOnSearchForm() || isOnResultsPage(), 5000);
      if (got) return executePhase(job);
      throw new Error('Brand Viewer page not recognized (expected search form or results)');
    }

    // Phase 2 — paste ASINs, click Search (WILL reload)
    if (job.phase === 'need_paste_and_search') {
      if (!isOnSearchForm()) {
        await setJob({ phase: 'need_search_form' });
        return executePhase(await getJob());
      }
      progress(`Group #${job.groupId}: selecting ASIN mode…`);
      const asinBtn = await waitFor(() => findAsinModeButton(), 8000);
      if (!asinBtn) throw new Error('ASIN mode button not found');
      clickEl(asinBtn);

      const textarea = await waitFor(() => findAsinTextarea(), 5000);
      if (!textarea) throw new Error('ASIN textarea did not appear');
      await sleep(150);

      progress(`Group #${job.groupId}: pasting ${job.asins.length} ASIN(s)…`);
      setNativeValue(textarea, job.asins.join('\n'));
      await sleep(300);

      const searchBtn = await waitFor(() => findSearchButton(), 3000);
      if (!searchBtn) throw new Error('Search button not found');

      // CRITICAL: commit next phase BEFORE clicking, in case click navigates
      await setJob({ phase: 'need_select_and_save' });
      progress(`Group #${job.groupId}: clicking Search (wait ${(step3/1000).toFixed(0)}s)…`);
      clickEl(searchBtn);

      // Either the page reloads (script dies, re-boots on results) or results appear inline.
      await sleep(step3);
      if (isOnResultsPage()) return executePhase(await getJob());

      let tries = 0;
      while (!isOnResultsPage() && tries < job.maxRetries) {
        tries++;
        progress(`Group #${job.groupId}: results not ready, +${(job.retryDelayMs/1000).toFixed(0)}s (${tries}/${job.maxRetries})…`);
        await sleep(job.retryDelayMs);
      }
      if (!isOnResultsPage()) {
        throw new Error(`Results did not load within ${(step3/1000).toFixed(0)}s + ${job.maxRetries}×${(job.retryDelayMs/1000).toFixed(0)}s`);
      }
      return executePhase(await getJob());
    }

    // Phase 3 — on results: select all, open modal, upload CSV, save
    if (job.phase === 'need_select_and_save') {
      if (!isOnResultsPage()) {
        const got = await waitFor(() => isOnResultsPage(), Math.min(step3, 15000));
        if (!got) throw new Error('Results page did not load');
      }
      await sleep(1000); // extra stabilization after page load

      progress(`Group #${job.groupId}: selecting all rows…`);
      const cb = await waitFor(() => findHeaderCheckbox(), 5000);
      if (!cb) throw new Error('Header (select-all) checkbox not found');

      // React checkboxes need special handling:
      // - clickEl() fires synthetic MouseEvent('click') AND .click(), causing TWO toggles (on→off)
      // - Use ONLY .click() for checkboxes — it toggles native checked AND fires one click event
      // Strategy: try .click(), verify via Create Siblings button, retry with alternatives if needed
      csLog('Checkbox found, attempting .click()');
      cb.click();
      await sleep(1000);

      let createBtn = findCreateSiblingsButton();
      if (!createBtn) {
        // .click() may have toggled wrong way (was already checked), or didn't register. Try again.
        csLog('Create Siblings not visible after .click() — trying .click() again');
        cb.click();
        await sleep(1000);
        createBtn = findCreateSiblingsButton();
      }
      if (!createBtn) {
        // Force checked via React internal props (find onChange handler on fiber)
        csLog('Trying React fiber onChange approach');
        const reactPropsKey = Object.keys(cb).find(k => k.startsWith('__reactProps$'));
        if (reactPropsKey && cb[reactPropsKey]?.onChange) {
          cb[reactPropsKey].onChange({ target: { checked: true }, preventDefault() {}, stopPropagation() {} });
          await sleep(1000);
          createBtn = findCreateSiblingsButton();
        }
      }
      if (!createBtn) {
        // Force checked property + dispatch change (last resort for React controlled inputs)
        csLog('Trying forced .checked=true + change/input events');
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        if (nativeSetter) nativeSetter.call(cb, true);
        else cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(1000);
        createBtn = findCreateSiblingsButton();
      }
      if (!createBtn) {
        // Nuclear fallback: click each individual row checkbox
        csLog('Header checkbox failed — clicking individual row checkboxes');
        const tbl = findResultsTable();
        if (tbl) {
          const rowCbs = tbl.querySelectorAll('tbody input[type="checkbox"]');
          for (const rcb of rowCbs) {
            if (!rcb.checked) rcb.click();
          }
          await sleep(1000);
          createBtn = findCreateSiblingsButton();
        }
      }
      if (!createBtn) throw new Error('Create Siblings button not found (checkbox click did not select rows)');
      clickEl(createBtn);

      const modal = await waitFor(() => isModalOpen() ? findSiblingModal() : null, 6000);
      if (!modal) throw new Error('Create Sibling Group modal did not open');
      await sleep(400);

      progress(`Group #${job.groupId}: uploading labels CSV…`);
      let fileInput = findFileInputInModal();
      if (!fileInput) {
        const upBtn = findUploadLabelsButton();
        if (upBtn) { clickEl(upBtn); await sleep(400); fileInput = findFileInputInModal(); }
      }
      if (!fileInput) {
        const anys = document.querySelectorAll('input[type="file"]');
        if (anys.length > 0) fileInput = anys[anys.length - 1];
      }
      if (!fileInput) throw new Error('File input for Upload Labels CSV not found');
      await uploadFileToInput(fileInput, job.csvContent, job.csvFileName);
      await sleep(1500);

      const saveBtn = await waitFor(() => findSaveGroupButton(), 4000);
      if (!saveBtn) throw new Error('Save Group button not found');

      // CRITICAL: commit next phase BEFORE clicking Save
      await setJob({ phase: 'need_reset' });
      progress(`Group #${job.groupId}: clicking Save Group (wait ${(step6/1000).toFixed(0)}s)…`);
      clickEl(saveBtn);

      await sleep(step6);
      return executePhase(await getJob());
    }

    // Phase 4 — verify save closed the modal, then get back to search form
    if (job.phase === 'need_reset') {
      if (isModalOpen()) {
        let tries = 0;
        while (isModalOpen() && tries < job.maxRetries) {
          tries++;
          progress(`Group #${job.groupId}: save not complete, +${(job.retryDelayMs/1000).toFixed(0)}s (${tries}/${job.maxRetries})…`);
          await sleep(job.retryDelayMs);
        }
        if (isModalOpen()) {
          throw new Error(`Save Group did not complete within ${(step6/1000).toFixed(0)}s + ${job.maxRetries}×${(job.retryDelayMs/1000).toFixed(0)}s`);
        }
      }
      // Modal closed. Either page reloaded to search form, or we're still on results and must click New Search.
      if (isOnSearchForm()) {
        await finishJob(job, true);
        return;
      }
      if (isOnResultsPage()) {
        progress(`Group #${job.groupId}: clicking New Search…`);
        const nsBtn = findNewSearchButton();
        if (!nsBtn) throw new Error('New Search button not found after save');
        await setJob({ phase: 'need_group_done' });
        clickEl(nsBtn);
        await sleep(600);
        return;
      }
      const got = await waitFor(() => isOnSearchForm() || isOnResultsPage(), 5000);
      if (got) return executePhase(await getJob());
      throw new Error('Page not recognized after save');
    }

    // Phase 5 — confirm we're back on search form after New Search
    if (job.phase === 'need_group_done') {
      if (isOnSearchForm()) { await finishJob(job, true); return; }
      const got = await waitFor(() => isOnSearchForm(), 8000);
      if (got) { await finishJob(job, true); return; }
      throw new Error('Search form did not load after New Search');
    }

    throw new Error(`Unknown phase: ${job.phase}`);
  }

  async function runOnce() {
    if (executing) return;
    executing = true;
    try {
      const job = await getJob();
      if (!job || !job.active) return;
      try {
        await executePhase(job);
      } catch (e) {
        csLog('Phase error:', e);
        const cur = await getJob();
        if (cur && cur.active) await finishJob(cur, false, e.message || String(e));
      }
    } finally {
      executing = false;
    }
  }

  // ---------- Message handling ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PING') {
      sendResponse({ ready: true });
      return; // sync
    }
    if (msg?.type === 'START_GROUP') {
      (async () => {
        try {
          await setJob({
            ...msg.data,
            active: true,
            phase: 'need_search_form',
            startedAt: Date.now(),
            success: null,
            error: null,
          });
          sendResponse({ ok: true });
          // Fire and forget — the async runOnce may trigger navigation
          runOnce();
        } catch (e) {
          try { sendResponse({ ok: false, error: e.message }); } catch (_) {}
        }
      })();
      return true; // async response
    }
    if (msg?.type === 'CANCEL_JOB') {
      (async () => {
        const job = await getJob();
        if (job && job.active) await finishJob(job, false, 'Cancelled');
        sendResponse({ ok: true });
      })();
      return true;
    }
  });

  // ---------- Auto-resume on page load ----------

  // If there's an active job in storage (e.g. we just reloaded mid-flow), pick up where we left off.
  runOnce().catch(e => csLog('runOnce error:', e));

  csLog('SIB-SEP content script ready on', location.href);
})();
