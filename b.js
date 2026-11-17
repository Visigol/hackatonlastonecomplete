import { getConfig, resetConfigCache } from './lib/config.js';
import * as store from './lib/store.js';
import { askNano, nanoProbe } from './lib/nano.js';
import { aiStatus, aiRun, aiSummarize } from './lib/ai-provider.js'; // Nano by default; the SuperAdmin may add a cloud model (Platform settings)
import { timingReport, resetTiming } from './lib/timing.js';
import { getReplica, clearAllReplicas } from './lib/replica.js';
import * as content from './lib/content.js';
import { shapeContent, mergeCatalog } from './lib/content-shape.js';
import { runTool } from './lib/toolrun.js';
import { noteIris, irisStatus } from './lib/iris-watch.js';
import { runSnippet, checkSnippetSafety } from './lib/runner.js';
import { isAdminRole, isFullAdminRole } from './lib/schema.js';
import { getBackend, getPlatformPublic } from './lib/backend.js';

console.log('CogniBuddy service worker started.');

// ============================================================================
// 1) LEGACY IRIS BRIDGE (unchanged behaviour of "CogniBuddy Bridge" 1.0.2)
// ============================================================================
let aiQueuePromise = Promise.resolve();
function enqueueAiTask(taskFn) {
  aiQueuePromise = aiQueuePromise.then(() => taskFn().catch(err => {
    console.error('[Background Queue Error]:', err);
    return 'ERROR: Queue task execution failure: ' + (err.message || JSON.stringify(err));
  }));
  return aiQueuePromise;
}

function legacyBridge(request, sender, sendResponse) {
  if (request.action === 'save_healed_selector') {
    getConfig().then(cfg => {
      if (!cfg.irisBridgeWritebackUrl) return;
      const queryParams = new URLSearchParams({
        action: 'healSelector',
        domain: request.domain || 'General',
        type: request.type || 'General',
        field: request.field || '',
        selector: request.selector || '',
        fingerprint: typeof request.fingerprint === 'object' ? JSON.stringify(request.fingerprint) : (request.fingerprint || '{}')
      });
      fetch(`${cfg.irisBridgeWritebackUrl}?${queryParams.toString()}`, { method: 'GET' })
        .then(res => (res.ok ? res.json() : null))
        .then(data => console.log('[Background] Nano_Brain updated:', data))
        .catch(err => console.warn('[Background] Nano_Brain persist bypassed:', err.message));
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'execute_universal_inference') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) { sendResponse({ success: false, value: 'ERROR: Extension cannot identify active tab ID.' }); return true; }

    if (request.field === 'IRIS_DIAGNOSTIC_PING') {
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'MAIN',
        func: async () => {
          try {
            const lm = (typeof LanguageModel !== 'undefined' ? LanguageModel : null)
              || (window.LanguageModel || null)
              || (typeof ai !== 'undefined' && ai.languageModel ? ai.languageModel : null)
              || (window.ai && window.ai.languageModel ? window.ai.languageModel : null);
            if (!lm) return 'ACTIVE';
            let a = 'readily';
            if (typeof lm.availability === 'function') a = await lm.availability();
            else if (typeof lm.capabilities === 'function') a = (await lm.capabilities()).available;
            if (typeof a === 'object' && a !== null) a = a.available || 'readily';
            return ((a === 'no' || a === 'unavailable') ? 'INACTIVE' : 'ACTIVE') + '|' + a;
          } catch (e) { return 'ACTIVE'; }
        }
      }).then(r => { const raw = String((r && r[0] && r[0].result) || 'ACTIVE|unknown'); const parts = raw.split('|'); sendResponse({ success: true, value: parts[0], availability: parts[1] || 'unknown' }); })
        .catch(() => sendResponse({ success: true, value: 'ACTIVE' }));
      return true;
    }

    enqueueAiTask(() => chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'MAIN',
      func: async (promptText) => {
        try {
          const lm = (typeof LanguageModel !== 'undefined' ? LanguageModel : null)
            || (window.LanguageModel || null)
            || (typeof ai !== 'undefined' && ai.languageModel ? ai.languageModel : null)
            || (window.ai && window.ai.languageModel ? window.ai.languageModel : null);
          if (!lm) return 'ERROR: LanguageModel API missing in top frame.';
          let a = 'readily';
          if (typeof lm.availability === 'function') a = await lm.availability();
          else if (typeof lm.capabilities === 'function') a = (await lm.capabilities()).available;
          if (a === 'no' || a === 'unavailable') return 'ERROR: Gemini Nano model unavailable.';
          const session = await lm.create({ systemPrompt: 'You are an expert Data Engineer. Extract requested menu attributes strictly into minified JSON.' });
          const response = await session.prompt(promptText);
          await session.destroy();
          return response ? response.trim() : '';
        } catch (err) { return 'ERROR: Top-frame execution failure: ' + (err.message || JSON.stringify(err)); }
      },
      args: [request.html]
    }).then(r => (r && r[0] && r[0].result !== undefined ? r[0].result : 'ERROR: No response from Top-Frame AI injection.')))
      .then(val => sendResponse(typeof val === 'string' && val.startsWith('ERROR:') ? { success: false, value: val } : { success: true, value: val }))
      .catch(err => sendResponse({ success: false, value: 'ERROR: Script injection blocked: ' + err.message }));
    return true;
  }
  return false;
}

// ============================================================================
// 2) COGNIBUDDY ASSISTANT API (content-script UI -> service worker)
// ============================================================================
async function requireUser() {
  const u = await store.whoami();
  if (!u.role) throw new Error('NOT_AUTHORIZED: ' + u.email + ' is not an active user in the CogniBuddy Users sheet.');
  return u;
}
async function requireAdmin() {
  const u = await requireUser();
  if (!isAdminRole(u.role)) throw new Error('ADMIN_ONLY');
  return u;
}
async function requireFullAdmin() {
  const u = await requireUser();
  if (!isFullAdminRole(u.role)) throw new Error('SUPERADMIN_ONLY');
  return u;
}
// Board calls: a gateway that was not redeployed yet answers BAD_OP; tell the person what to do instead of a raw code.
async function boards(fn) {
  try { return await fn(await getBackend()); }
  catch (e) { if (/BAD_OP|Tasks\.gs is missing/.test(String(e.message))) throw new Error('BOARDS_NOT_DEPLOYED: the project boards need the updated gateway (Api.gs + Tasks.gs, new version).'); throw e; }
}
const WS_URL = 'workspace.html';
let workspaceTab = null; // the open Workspace tab, so notifications reuse it instead of opening new tabs
async function openWorkspace(hash) {
  const url = chrome.runtime.getURL(WS_URL) + (hash ? '#' + hash : '');
  if (workspaceTab !== null) {
    try { await chrome.tabs.update(workspaceTab, { url, active: true }); const t = await chrome.tabs.get(workspaceTab); if (t && t.windowId !== undefined) chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); return true; }
    catch (e) { workspaceTab = null; }
  }
  const t = await chrome.tabs.create({ url }); workspaceTab = t.id; return true;
}
chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener((id) => { if (id === workspaceTab) workspaceTab = null; });

const nanoJobs = new Map(); // reqId -> AbortController, so the overlay can cancel a running request

const API = {
  async cb_boot() {
    const cfg = await getConfig();
    if (!cfg.mockMode && !cfg.apiUrl) return { state: 'needs_config', reason: 'apiUrl is empty in config.json' };
    try {
      const user = await store.whoami();
      if (user.status === 'NoIdentity') return { state: 'needs_login' };
      if (!user.role) return { state: 'unauthorized', user };
      return { state: 'ready', user, mock: !!cfg.mockMode, cfg: { maxSnippetOutputChars: cfg.maxSnippetOutputChars } };
    } catch (e) {
      if (String(e.message).startsWith('AUTH_REQUIRED')) return { state: 'needs_login' };
      return { state: 'error', error: e.message };
    }
  },
  // Google sign-in happens in a normal tab on the gateway URL; the session cookie is then shared with the extension.
  async cb_login() { const cfg = await getConfig(); if (cfg.apiUrl) await chrome.tabs.create({ url: cfg.apiUrl }); return { state: 'needs_login' }; },
  async cb_logout() { await chrome.storage.local.remove('cb_catalog_v2'); await chrome.storage.local.remove(['cb_pending', 'cb_draft2', 'cb_user_v1', 'cb_user_v2', 'cb_platform']); await clearAllReplicas(); return true; },
  async cb_catalog(r) {
    const u = await requireUser();
    const cat = await store.getCatalog(!!r.force);
    if (!r.drafts || !isAdminRole(u.role)) return cat;
    // Admin preview: unpublished drafts laid over the published content (only for the admin who asked).
    const raw = await content.syncContent({ force: !!r.force, drafts: true });
    return { ...mergeCatalog(cat, shapeContent(raw.files, { drafts: true })), preview: true };
  },
  async cb_import_seed(r) { await requireAdmin(); return store.importSeed(!!r.overwrite); },
  async cb_list_cases(r) { const u = await requireUser(); return store.listCases({ mine: !isAdminRole(u.role) || !!r.mine, email: u.email }); },
  async cb_get_case(r) {
    const u = await requireUser(); const c = await store.getCase(r.caseId);
    if (!isAdminRole(u.role) && String(c.case.reporter_email).toLowerCase() !== u.email.toLowerCase()) throw new Error('FORBIDDEN');
    return c;
  },
  async cb_create_case(r) { const u = await requireUser(); return store.createCase(u, r.draft); },
  async cb_add_message(r) { const u = await requireUser(); await store.addMessage(r.caseId, r.msg, u.email); return true; },
  // Iris Selectors/Nano_Brain rows for the page's domain; never throws so the interview is not blocked if the sheet is unreadable.
  async cb_sheet_selectors(r) { await requireUser(); try { return { rows: await store.getSheetSelectors(r.domain), error: null }; } catch (e) { return { rows: null, error: String(e.message || e).slice(0, 200) }; } },
  async cb_get_artifact(r) { await requireUser(); return store.getArtifactContent(r.artifactId, r.caseId); },
  async cb_add_artifact(r) { await requireUser(); return store.addArtifact(r.caseId, r.kind, r.label, r.content); },
  // Admins may change anything; for agents the gateway keeps only ack_at/status(Reopened|Triage) on their own cases.
  async cb_update_case(r) { await requireUser(); await store.updateCase(r.caseId, r.patch); return true; },
  async cb_resolve(r) {
    const u = await requireUser();
    if (!isAdminRole(u.role)) {
      const c = await store.getCase(r.caseId);
      if (String(c.case.reporter_email).toLowerCase() !== u.email.toLowerCase()) throw new Error('ADMIN_ONLY');
    }
    await store.resolveCase(r.caseId, u, r.data);
    return true;
  },
  async cb_ack(r) { await requireUser(); await store.acknowledge(r.caseId); poll(); return true; },
  async cb_reopen(r) { const u = await requireUser(); await store.reopen(r.caseId, u, r.reason); poll(); return true; },
  async cb_list_users() { await requireAdmin(); return store.listUsers(); },
  async cb_upsert_user(r) { const u = await requireFullAdmin(); await store.upsertUser(r.user, u.email); return true; },
  async cb_bulk_upsert_users(r) { const u = await requireFullAdmin(); await store.bulkUpsertUsers(r.users || [], u.email); return { count: (r.users || []).length }; },
  async cb_upsert_row(r) {
    const u = await requireAdmin();
    const map = { KnowledgeBase: 'kb_id', Snippets: 'snippet_id', Projects: 'project_id' };
    if (!map[r.tab]) throw new Error('BAD_TAB');
    await store.upsertCatalogRow(r.tab, map[r.tab], r.row); return u.email && true;
  },
  async cb_set_mock_user(r) { const cfg = await getConfig(); if (!cfg.mockMode) throw new Error('NOT_MOCK'); await store.setMockUser(r.user); return true; },
  async cb_pending() { return (await chrome.storage.local.get('cb_pending')).cb_pending || { resolved: [], needsInfo: [], adminOpen: 0 }; },
  async cb_nano(r, sender) { return askNano(sender.tab.id, r.system, r.prompt, { ping: !!r.ping }); },
  // Assistant AI path v2 (lib/nano.js): one mode check, then schema-constrained / streamed requests. Never throws for "AI off".
  async cb_nano_status(r, sender) { return aiStatus(sender.tab ? sender.tab.id : null, { force: !!r.force }); },
  async cb_nano_run(r, sender) {
    const tabId = sender.tab ? sender.tab.id : null;
    const ctl = new AbortController();
    if (r.reqId) nanoJobs.set(r.reqId, ctl);
    const onChunk = r.stream && r.reqId && tabId ? (delta) => { chrome.tabs.sendMessage(tabId, { type: 'cb_nano_chunk', reqId: r.reqId, delta }, { frameId: sender.frameId || 0 }).catch(() => {}); } : null;
    try { return await aiRun(tabId, { system: r.system, prompt: r.prompt, schema: r.schema || null, stream: !!r.stream }, onChunk, ctl.signal); }
    finally { if (r.reqId) nanoJobs.delete(r.reqId); }
  },
  async cb_nano_cancel(r) { const c = nanoJobs.get(r.reqId); if (c) c.abort(); return true; },
  async cb_nano_probe(r, sender) { return nanoProbe(sender.tab ? sender.tab.id : null); },
  async cb_run_snippet(r, sender) {
    await requireUser();
    const cfg = await getConfig();
    const cat = await store.getCatalog();
    // Only admin-authored snippets from the Snippets tab may be executed; the UI cannot pass arbitrary code.
    const sn = cat.snippets.find(s => s.snippet_id === r.snippetId);
    if (!sn) return { ok: false, error: 'Unknown or disabled snippet' };
    return runSnippet(sender.tab.id, sn, r.params || {}, { maxChars: cfg.maxSnippetOutputChars || 200000, allFrames: !!r.allFrames });
  },
  async cb_check_snippet(r) { const cat = await store.getCatalog(); const sn = cat.snippets.find(s => s.snippet_id === r.snippetId); return sn ? checkSnippetSafety(sn.code, sn.risk) : { ok: false, flags: ['unknown'] }; },
  // Sends ONE selector proposal to Iris's live self-healing endpoint (healSelector). Admin only; overwrites the first Nano_Brain row with the same Domain/Type/Field.
  async cb_heal_send(r) {
    await requireAdmin();
    const cfg = await getConfig();
    if (!cfg.irisBridgeWritebackUrl) throw new Error('irisBridgeWritebackUrl is not set in config.json');
    const p = r.proposal || {};
    if (!p.domain || !p.type || !p.field || !p.selector) throw new Error('Incomplete proposal');
    const qs = new URLSearchParams({ action: 'healSelector', domain: p.domain, type: p.type, field: p.field, selector: p.selector, fingerprint: JSON.stringify(p.fingerprint || {}) });
    const res = await fetch(cfg.irisBridgeWritebackUrl + '?' + qs.toString(), { method: 'GET', credentials: 'include' });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!j) throw new Error('Iris did not answer with JSON (not signed in to the Iris web app?): ' + text.slice(0, 120).replace(/\s+/g, ' '));
    return j; // { status, message, readback, ... }
  },
  async cb_reload_config() { resetConfigCache(); return getConfig(true); },
  // Is the Iris Scraper using Gemini Nano right now? (the overlay shows a hint; assistant Nano calls wait for it)
  async cb_iris_status() { return irisStatus(); },

  // ---- content folder tree, Manager Studio, tools, feedback (the gateway re-checks every role) ----
  async cb_content_raw(r) { await requireAdmin(); return content.syncContent({ force: !!r.force, drafts: true }); },
  async cb_fs_write(r) { await requireAdmin(); return content.writeFiles(r.files || []); },
  async cb_fs_delete(r) { await requireAdmin(); return content.deleteFiles(r.paths || []); },
  async cb_fs_publish(r) { await requireAdmin(); return content.publish(r.paths || []); },
  async cb_tool_approve(r) { const u = await requireAdmin(); if (u.role !== 'SuperAdmin') throw new Error('SUPERADMIN_ONLY'); return content.approveTool(r.path, r.approve !== false); },
  async cb_migrate(r) { await requireAdmin(); return content.migrateProject(r.projectId); },
  async cb_import_demo(r) { const u = await requireAdmin(); return content.importDemo(r && r.pack, { approve: u.role === 'SuperAdmin' }); }, // a SuperAdmin installing a bundled pack also approves its commands
  async cb_feedback(r) { await requireUser(); return content.sendFeedback(r.row || {}); },
  async cb_train_now() { await requireAdmin(); return content.trainNow(); },
  async cb_feedback_read(r) { await requireAdmin(); return content.readFeedback(r.limit); },
  async cb_open_studio(r) { await requireAdmin(); const h = r && r.projectId ? '#' + encodeURIComponent(r.projectId) + (r.view ? ':' + encodeURIComponent(r.view) : '') : (r && r.view ? '#:' + encodeURIComponent(r.view) : ''); await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') + h }); return true; },

  // ---- Workspace: role-based Home, project boards, task chat (rules in lib/tasks-core.js, enforced by the gateway) ----
  async cb_open_workspace(r) { await requireUser(); return openWorkspace(r && r.hash); },
  async cb_ws_hello(r, sender) { if (sender.tab) workspaceTab = sender.tab.id; return true; },
  async cb_home() { await requireUser(); const h = await boards(be => be.home()); if (!h) throw new Error('BOARDS_NOT_DEPLOYED: the project boards need the updated gateway (Api.gs + Tasks.gs, new version).'); return h; },
  async cb_board(r) { await requireUser(); return boards(be => be.board(r.projectId)); },
  async cb_task(r) { await requireUser(); return boards(be => be.task(r.taskId)); },
  async cb_task_save(r) { await requireUser(); const t = await boards(be => be.taskSave(r.task || {})); poll(); return t; },
  async cb_task_comment(r) { await requireUser(); return boards(be => be.taskComment(r.taskId, r.comment || {})); },
  async cb_board_save(r) { await requireAdmin(); return boards(be => be.boardSave(r.projectId, r.board || {})); },

  // ---- incidents (everyone), "me too", manager copilot, impact, learning, activity log (rules: lib/ops-core.js + gateway) ----
  async cb_ops(r) {
    await requireUser();
    const allowed = ['incidents', 'incident', 'incidentCreate', 'incidentJoin', 'incidentUpdate', 'similar', 'alsoAffected', 'similarSolved', 'dashboard', 'learnSave', 'learnProgress', 'auditRead', 'settings', 'settingsSave', 'digestPref'];
    if (!allowed.includes(r.op)) throw new Error('Unknown operation');
    const out = await boards(be => be.ops(r.op, r.body || {}));
    if (['incidentCreate', 'incidentJoin', 'incidentUpdate', 'alsoAffected'].includes(r.op)) poll();
    return out;
  },
  // ---- Production: work queue, attendance clock, utilization, dashboard (rules: lib/prod-core.js, enforced by the gateway) ----
  async cb_prod(r) {
    await requireUser();
    if (!/^prod[A-Z][A-Za-z]+$/.test(String(r.op || ''))) throw new Error('Unknown operation');
    return (await getBackend()).prod(r.op, r.body || {});
  },
  // ---- Platform: the SuperAdmin's settings page (AI provider, cache, archive, mirror), measurements, the local copy ----
  async cb_platform(r) {
    await requireUser();
    const op = String(r.op || '');
    if (!/^platform[A-Z][A-Za-z]+$/.test(op)) throw new Error('Unknown operation');
    if (op !== 'platformPublic') await requireFullAdmin(); // everybody may read the public part; everything else is SuperAdmin only (the gateway checks again)
    const out = await (await getBackend()).platform(op, r.body || {});
    if (op === 'platformSettingsSave') { await chrome.storage.local.remove('cb_platform'); await getPlatformPublic(true); }
    return out;
  },
  async cb_timing(r) { await requireAdmin(); return r && r.reset ? resetTiming() : timingReport(); },
  // The local copy of this person: clear it (anyone), or export it as NDJSON (SuperAdmin).
  async cb_replica(r) {
    const u = await requireUser();
    if (r.op === 'clear') { await clearAllReplicas(); return true; }
    if (r.op === 'export') { await requireFullAdmin(); const rep = getReplica(u.email, (await getConfig()).apiUrl); return { ndjson: await rep.exportNdjson(), schema: await rep.schema() }; }
    throw new Error('Unknown operation');
  },
  // Screenshot of the page the person is reporting from (the overlay hides itself first). Uses the activeTab grant of the toolbar click.
  async cb_capture(r, sender) {
    await requireUser();
    if (!sender.tab) throw new Error('No page to capture.');
    try { return { dataUrl: await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 72 }) }; }
    catch (e) { throw new Error('Chrome did not allow a screenshot of this page (' + e.message + '). Click the CogniBuddy icon on the page again and retry.'); }
  },
  // A solved case becomes a draft knowledge article (the manager publishes it in the Studio).
  async cb_draft_article(r) { await requireAdmin(); return content.addDraftArticle(r.projectId, r.row || {}); },
  // Marks board notifications as read (the Workspace calls this when a task is opened or the inbox is viewed).
  async cb_inbox_seen(r) {
    const seen = (await chrome.storage.local.get('cb_inbox_seen')).cb_inbox_seen || {};
    (r.ids || []).forEach(id => { seen[id] = Date.now(); });
    const cut = Date.now() - 30 * 86400000; Object.keys(seen).forEach(k => { if (seen[k] < cut) delete seen[k]; });
    await chrome.storage.local.set({ cb_inbox_seen: seen });
    await updateBadge();
    return true;
  },
  // Runs a published tool by id. With preview:true an admin may run a draft; code tools still need the pinned approval.
  async cb_run_tool(r, sender) {
    const u = await requireUser();
    const cfg = await getConfig();
    let cat = await store.getCatalog();
    if (r.preview && isAdminRole(u.role)) cat = mergeCatalog(cat, shapeContent((await content.syncContent({ drafts: true })).files, { drafts: true }));
    const tool = (cat.tools || []).find(t => t.id === r.toolId && (!r.projectId || t.project_id === r.projectId || t.project_id === 'all'));
    if (!tool) return { ok: false, error: 'Unknown tool' };
    return runTool(sender.tab ? sender.tab.id : null, tool, r.params || {}, { catalog: cat, maxChars: cfg.maxSnippetOutputChars || 200000 });
  },
  // Short summary of a text (SOP section): Summarizer API, else Prompt API; { ok:false } tells the UI to use its own extract.
  async cb_summarize(r, sender) {
    const tabId = sender.tab ? sender.tab.id : null;
    const ctl = new AbortController();
    if (r.reqId) nanoJobs.set(r.reqId, ctl);
    const onChunk = r.stream && r.reqId && tabId ? (delta) => { chrome.tabs.sendMessage(tabId, { type: 'cb_nano_chunk', reqId: r.reqId, delta }, { frameId: sender.frameId || 0 }).catch(() => {}); } : null;
    try { return await aiSummarize(tabId, { text: String(r.text || '').slice(0, 12000), context: r.context || '', sharedContext: r.sharedContext || '', type: r.type, length: r.length }, onChunk, ctl.signal); }
    finally { if (r.reqId) nanoJobs.delete(r.reqId); }
  }
};

// Iris-first watcher: a SEPARATE listener that only notes when Iris sends a Gemini Nano request. It never answers and never
// returns true, so the bridge below receives and answers every message exactly as before.
chrome.runtime.onMessage.addListener((request) => { try { noteIris(request); } catch (e) {} });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && typeof request.action === 'string' && request.action.startsWith('cb_')) {
    const fn = API[request.action];
    if (!fn) { sendResponse({ ok: false, error: 'Unknown action' }); return false; }
    // Only our own extension contexts (content scripts of this extension) may call; sender.id is enforced by Chrome.
    fn(request, sender).then(data => sendResponse({ ok: true, data })).catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  const handled = legacyBridge(request, sender, sendResponse);
  return handled === true ? true : false;
});

// ============================================================================
// 3) TOOLBAR CLICK -> inject full-screen overlay (fallback to Workspace Assistant)
// ============================================================================
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.id) {
      const pong = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'cb_toggle' }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 400))
      ]);
      if (pong && pong.ok) return;
    }
    const url = (tab && tab.url) || '';
    const isWebPage = /^https?:/i.test(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
    if (!tab || !tab.id || !isWebPage) {
      await openWorkspace('assistant');
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['ui/styles.js', 'ui/modules.js', 'ui/audit.js', 'ui/projects/iris.js', 'ui/learn.js', 'ui/voice.js', 'ui/workflow.js', 'ui/engine.js', 'ui/widgets.js', 'ui/production.js', 'ui/platform.js', 'ui/app.js'] });
  } catch (e) {
    console.warn('Cannot inject on this page, opening Assistant tab:', e.message);
    try { await openWorkspace('assistant'); } catch (e2) {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'CogniBuddy', message: 'Could not open CogniBuddy on this page: ' + e.message });
    }
  }
});

// ============================================================================
// 4) POLLING: resolution notices (agents) / new-case badge (admins)
// ============================================================================
async function setupAlarm() {
  const cfg = await getConfig();
  chrome.alarms.create('cb_poll', { periodInMinutes: Math.max(1, Math.round((cfg.pollSeconds || 60) / 60)) });
}
chrome.runtime.onInstalled.addListener(() => { setupAlarm(); poll(); });
chrome.runtime.onStartup.addListener(() => { setupAlarm(); poll(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'cb_poll') poll(); });

async function poll() {
  try {
    const cfg = await getConfig();
    if (!cfg.mockMode && !cfg.apiUrl) return;
    const user = await store.whoami();
    if (!user.role) return;
    const s = await store.pollSummary(user);
    await chrome.storage.local.set({ cb_pending: s });
    await updateBadge(s, user);
    // Pre-warm the catalog in the background if missing or nearing expiry so opening the overlay is instant.
    chrome.storage.local.get('cb_catalog_v2').then(got => {
      const c = got && got.cb_catalog_v2;
      if (!c || !c.data || (Date.now() - c.at > 240000)) store.getCatalog().catch(() => {});
    }).catch(() => {});
    const seen = (await chrome.storage.local.get('cb_notified')).cb_notified || {};
    // General notices (new cases, incidents, reminders, escalations, welcome, SOP reviews): one notification each; click opens the right page.
    for (const n of (s.notices || []).slice(0, 10).reverse()) {
      const key = 'nt|' + n.id;
      if (seen[key]) continue;
      seen[key] = 1;
      chrome.notifications.create('cbn_' + n.link + '|' + n.id, { type: 'basic', iconUrl: 'icons/icon128.png', title: (n.kind === 'incident' ? '🚨 ' : n.kind === 'escalation' ? '⏫ ' : '') + n.title, message: n.text || '', priority: ['incident', 'escalation'].includes(n.kind) ? 2 : 0 });
    }
    refreshTabBadges();
    // Board activity for me: mentions, assignments, messages on my tasks / requests, due dates. One notification each; click opens the task.
    const WHY = { mention: 'mentioned you', assigned: 'assigned you', 'your task': 'wrote on your task', 'your request': 'updated your request' };
    for (const it of (s.inbox || []).slice(0, 10).reverse()) {
      const key = 'ev|' + it.id;
      if (seen[key]) continue;
      seen[key] = 1;
      const what = it.kind === 'status' ? it.text : String(it.text || '').slice(0, 160);
      chrome.notifications.create('cbt_' + it.task_id + '|' + it.id, { type: 'basic', iconUrl: 'icons/icon128.png', title: (it.warning ? '⚠ ' : '') + `${it.by} ${WHY[it.why] || 'updated a task'}`, message: `${it.title}\n${what}`, priority: it.warning || it.why === 'mention' ? 2 : 0 });
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const d of (s.due || [])) {
      const key = 'due|' + d.task_id + '|' + today;
      if (seen[key]) continue;
      seen[key] = 1;
      chrome.notifications.create('cbt_' + d.task_id + '|due', { type: 'basic', iconUrl: 'icons/icon128.png', title: d.days < 0 ? 'CogniBuddy: task overdue' : d.days === 0 ? 'CogniBuddy: task due today' : 'CogniBuddy: task due soon', message: `${d.title}\nDue ${d.due_date}` });
    }
    for (const c of s.resolved || []) {
      const key = c.case_id + '|' + c.resolved_at;
      if (seen[key]) continue;
      seen[key] = 1;
      const text = `${c.case_id}: ${c.title}\n${String(c.resolution_summary).slice(0, 180)}`;
      chrome.notifications.create('cb_' + c.case_id, { type: 'basic', iconUrl: 'icons/icon128.png', title: c.status === 'Solved' ? 'CogniBuddy: your issue was solved ✅' : "CogniBuddy: your issue was closed", message: text, requireInteraction: true });
      const tabs = await chrome.tabs.query({ active: true });
      for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'cb_toast', caseId: c.case_id, title: c.title, status: c.status, summary: c.resolution_summary }).catch(() => {});
    }
    for (const c of s.needsInfo || []) {
      const key = c.case_id + '|info|' + c.updated_at;
      if (seen[key]) continue;
      seen[key] = 1;
      chrome.notifications.create('cbi_' + c.case_id, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'CogniBuddy: more info requested', message: `${c.case_id}: ${c.title}\nOpen CogniBuddy → My cases to answer.` });
    }
    Object.keys(seen).length > 3000 && Object.keys(seen).slice(0, 1000).forEach(k => delete seen[k]);
    await chrome.storage.local.set({ cb_notified: seen });
  } catch (e) { console.warn('poll skipped:', e.message); }
}
// Badge = cases that need me (agents: answers on my cases; managers: new cases in my projects) + unread board notifications.
async function updateBadge(s, user) {
  try {
    s = s || (await chrome.storage.local.get('cb_pending')).cb_pending; if (!s) return;
    user = user || (await store.whoami());
    const seen = (await chrome.storage.local.get('cb_inbox_seen')).cb_inbox_seen || {};
    const unread = (s.inbox || []).filter(i => !seen[i.id]).length + (s.notices || []).filter(i => !seen[i.id]).length;
    const cases = isAdminRole(user.role) ? (s.adminOpen || 0) + (s.resolved || []).length : (s.resolved || []).length + (s.needsInfo ? s.needsInfo.length : 0);
    const count = cases + unread;
    chrome.action.setBadgeBackgroundColor({ color: unread ? '#1565C0' : isAdminRole(user.role) ? '#E67E22' : '#00B14F' });
    chrome.action.setBadgeText({ text: count ? String(count > 99 ? '99+' : count) : '' });
  } catch (e) {}
}
// Clicking a CogniBuddy notification opens the Workspace on the task or the case.
chrome.notifications.onClicked.addListener((id) => {
  let hash = '';
  if (id.startsWith('cbn_')) {
    const link = id.slice(4).split('|')[0];
    if (link.startsWith('studio/')) { chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') + '#' + link.slice(7) }); chrome.notifications.clear(id); return; }
    hash = link;
  }
  else if (id.startsWith('cbt_')) hash = 'task/' + encodeURIComponent(id.slice(4).split('|')[0]);
  else if (id.startsWith('cbi_') || id.startsWith('cb_')) hash = 'case/' + encodeURIComponent(id.replace(/^cbi?_/, ''));
  if (!hash) return;
  openWorkspace(hash).catch(() => {});
  chrome.notifications.clear(id);
});

// ============================================================================
// 5) INCIDENT MARKER PER TAB: on a website that belongs to a project with an active incident, the icon shows a red "!"
//    (only on sites the extension may see, i.e. the supported sites; elsewhere the normal badge stays).
// ============================================================================
async function incidentForUrl(url) {
  if (!/^https?:/i.test(url || '')) return null;
  const st = await chrome.storage.local.get(['cb_pending', 'cb_catalog_v2']);
  const inc = ((st.cb_pending || {}).incidents || []); if (!inc.length) return null;
  const projects = ((st.cb_catalog_v2 || {}).data || {}).projects || [];
  for (const i of inc) {
    const p = projects.find(x => x.project_id === i.project_id); if (!p) continue;
    if ((p.url_patterns || []).some(u => { try { return new RegExp(u, 'i').test(url); } catch (e) { return url.includes(u); } })) return i;
  }
  return null;
}
async function badgeTab(tabId, url) {
  try {
    const i = await incidentForUrl(url);
    if (i) { chrome.action.setBadgeText({ tabId, text: '!' }); chrome.action.setBadgeBackgroundColor({ tabId, color: '#D84315' }); chrome.action.setTitle({ tabId, title: 'CogniBuddy - known issue: ' + i.title }); }
    else { chrome.action.setTitle({ tabId, title: 'CogniBuddy' }); const g = await chrome.action.getBadgeText({}); chrome.action.setBadgeText({ tabId, text: g || '' }); }
  } catch (e) {}
}
async function refreshTabBadges() { try { const tabs = await chrome.tabs.query({ active: true }); for (const t of tabs) if (t.url) badgeTab(t.id, t.url); } catch (e) {} }
chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab && tab.url) badgeTab(tabId, tab.url); });
chrome.tabs.onActivated && chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { const t = await chrome.tabs.get(tabId); if (t.url) badgeTab(tabId, t.url); } catch (e) {} });
