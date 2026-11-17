// CogniBuddy overlay shell: full-screen UI inside a Shadow DOM. Injected on toolbar click.
(function () {
  if (window.__CB_APP) { window.__CB_APP.toggle(); return; }
  const CB = window.CB, h = CB.h, esc = CB.esc;

  const COLS = {
    KnowledgeBase: ['kb_id', 'project_id', 'type', 'title', 'question_variants', 'answer', 'symptoms', 'tags', 'status'],
    Snippets: ['snippet_id', 'project_id', 'title', 'layer', 'description', 'params', 'code', 'expected_output', 'auto_offer', 'order', 'risk', 'enabled'],
    Projects: ['project_id', 'name', 'description', 'owner_email', 'status', 'url_patterns', 'keywords', 'required_facts', 'system_hint']
  };
  const KEY = { KnowledgeBase: 'kb_id', Snippets: 'snippet_id', Projects: 'project_id' };
  // What each step of the thought process used (shown as a small chip in the live steps and in "How I got this").
  const STEP_TOOL = { project: ['🧭', 'Project rules'], classifier: ['🧠', 'Trained classifier'], search: ['🔎', 'Knowledge search'], mode: ['⚙️', 'Mode check'], ai_read: ['✨', 'Gemini Nano'], facts: ['🧾', 'Fact check'], skill: ['📘', 'Playbook'], ai_answer: ['✨', 'Gemini Nano'], workflow: ['🪜', 'Workflow'], next: ['➡️', 'Planner'] };
  const toolChip = (step) => { const t = STEP_TOOL[step]; return t ? h('span', { class: 'tchip' }, t[0] + ' ' + t[1]) : null; };

  const app = {
    host: null, root: null, ui: {}, boot: null, user: null, realUser: null, agentPreview: null, cat: null, engine: null, view: 'chat', pageUrl: location.href, busy: false, preview: false, lastFb: null,

    toggle() { if (this.host.style.display === 'none') this.open(); else this.close(); },
    open() {
      this.host.style.display = 'block'; this.lockPage(); this.pageUrl = location.href;
      if (this.boot && this.boot.state === 'ready' && this.cat && this.engine && this.ui && this.ui.body && this.ui.body.isConnected) {
        this.engine.pageUrl = this.pageUrl;
        if (!this.engine.s.projectId && this.engine.autoSelectInitialProject) {
          const picked = this.engine.autoSelectInitialProject();
          if (picked && this.view === 'chat' && !this.engine.s.history.length) this.paintCanvas(this.engine.homeCanvas());
        }
        if (this.view === 'chat' && this.renderProjBar) this.renderProjBar();
        this.refreshSilently();
        return;
      }
      this.start();
    },
    async refreshSilently() {
      if (this._refreshing) return;
      this._refreshing = true;
      try {
        const [boot, cat] = await Promise.all([CB.api('cb_boot').catch(() => null), CB.api('cb_catalog', { drafts: this.preview }).catch(() => null)]);
        if (boot && boot.state === 'ready' && boot.user) {
          this.boot = boot;
          this.realUser = boot.user;
          this.user = (this.agentPreview && this.agentPreview.active)
            ? { ...this.realUser, role: 'Agent', projects: this.agentPreview.projects.slice() }
            : this.realUser;
          if (this.engine) this.engine.user = this.user;
        }
        if (cat && cat.projects) {
          this.cat = cat;
          if (this.engine && this.engine.setCatalog) this.engine.setCatalog(cat);
          else if (this.engine) this.engine.cat = cat;
          if (this.view === 'chat' && this.renderProjBar) this.renderProjBar();
        }
        this.refreshBadge();
        this.checkPending();
      } finally { this._refreshing = false; }
    },
    close() { this.host.style.display = 'none'; this.unlockPage(); },
    // While the full-screen overlay is open the page underneath is made inert: modal focus traps (e.g. an open item popup) can no
    // longer steal the keyboard focus from CogniBuddy's text boxes, and clicks/keys cannot reach the site. Removed on close and during "peek".
    lockPage() {
      this._inerted = this._inerted || [];
      Array.from(document.documentElement.children).forEach(el => {
        if (el === this.host || el.tagName === 'HEAD' || /^cogni-/.test(el.id) || el.inert) return;
        el.inert = true; this._inerted.push(el);
      });
    },
    unlockPage() { (this._inerted || []).forEach(el => { try { el.inert = false; } catch (e) {} }); this._inerted = []; },

    init() {
      const old = document.getElementById('cogni-overlay-host');
      if (old) old.remove();
      Array.from(document.documentElement.children).forEach(el => {
        if (el.inert) try { el.inert = false; } catch (e) {}
      });
      this.host = h('div', { id: 'cogni-overlay-host' });
      this.host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.append(h('style', {}, window.CB_CSS));
      this.shell = h('div', { class: 'root' });
      this.root.append(this.shell);
      CB.ripple(this.shell);
      document.documentElement.append(this.host);
      // Interacting with CogniBuddy must not leak to the page: sites close popups on any click outside them.
      // A click on any text box focuses it explicitly (belt and braces against focus-stealing page scripts).
      this.shell.addEventListener('mousedown', (ev) => { const t = ev.target && ev.target.closest ? ev.target.closest('input,textarea,select') : null; if (t) setTimeout(() => { try { t.focus(); } catch (e) {} }, 0); });
      ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu'].forEach(ev => this.host.addEventListener(ev, (e) => e.stopPropagation()));
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.host.style.display !== 'none' && !this.root.querySelector('.modal-bg')) this.close(); }, true);
      chrome.runtime.onMessage.addListener((m, _, sendResponse) => { if (m && m.type === 'cb_toggle') { this.toggle(); try { sendResponse({ ok: true }); } catch (e) {} } });
      window.__CB_APP = this;
      this.open();
    },

    // ---------- peek: hide the overlay during a countdown so the user can prepare the page (e.g. open an item popup) ----------
    peek(seconds, label) {
      return new Promise((resolve) => {
        this.host.style.display = 'none'; this.unlockPage(); // the user must be able to use the page during the countdown
        const pill = document.createElement('div'); pill.id = 'cogni-peek-host'; pill.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
        const r = pill.attachShadow({ mode: 'open' });
        r.innerHTML = '<style>.p{font:600 13px system-ui,Segoe UI,sans-serif;background:#0F172A;color:#fff;border-radius:16px;padding:12px 16px;box-shadow:0 12px 40px rgba(0,0,0,.35);border-left:6px solid #00B14F;max-width:320px}button{margin-top:8px;margin-right:6px;border:0;border-radius:14px;padding:5px 12px;font-weight:700;cursor:pointer}.g{background:#00B14F;color:#fff}.c{background:#334155;color:#fff}small{display:block;color:#CBD5E1;font-weight:400;margin-top:2px}</style><div class="p"><span id="t"></span><small>Open the item popup on the page now. CogniBuddy comes back with the result.</small><button class="g" id="go">Run now</button><button class="c" id="x">Cancel</button></div>';
        ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'keydown'].forEach(ev => pill.addEventListener(ev, (e) => e.stopPropagation()));
        let left = seconds; const t = r.getElementById('t');
        const done = (go) => { clearInterval(iv); pill.remove(); resolve(go); };
        const tick = () => { t.textContent = `Running “${label}” in ${left}s…`; if (left-- <= 0) done(true); };
        const iv = setInterval(tick, 1000); tick();
        r.getElementById('go').onclick = () => done(true); r.getElementById('x').onclick = () => done(false);
        document.documentElement.append(pill);
      });
    },
    unpeek() { this.host.style.display = 'block'; this.lockPage(); },

    // ---------- helpers ----------
    err(e) { const t = h('div', { class: 'm sys', style: 'color:#C62828' }, '⚠ ' + (e.message || e)); (this.ui.msgs || this.ui.body || this.shell).append(t); setTimeout(() => t.remove(), 9000); console.warn('[CogniBuddy]', e); },
    modal(content) { const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal' }, content)); this.shell.append(bg); return { close: () => bg.remove() }; },
    isAdmin() { return this.user && ['Manager', 'Admin', 'SuperAdmin'].includes(this.user.role); },          // any manager (effective)
    isFull() { return this.user && (this.user.role === 'Admin' || this.user.role === 'SuperAdmin'); },          // every project + people (effective)
    isRealAdmin() { return this.realUser && ['Manager', 'Admin', 'SuperAdmin'].includes(this.realUser.role); }, // underlying signed-in admin
    // Projects this manager manages (null = all). Agents and other projects are filtered out of the admin lists.
    scope() { if (this.isFull()) return null; const p = this.user.projects || []; return p.includes('*') ? null : p; },
    inScope(pid) { const sc = this.scope(); return !sc || sc.includes(pid); },
    fmt(d) { try { return new Date(d).toLocaleString(); } catch (e) { return d || ''; } },
    pill(st) { const c = { Solved: 'ok', "Won't fix": 'na', New: 'warn', Reopened: 'bad', 'Needs info': 'warn' }[st] || 'na'; return h('span', { class: 'pill ' + c }, st); },
    openAgentPreviewModal() {
      const real = this.realUser || this.user;
      const realFull = real && ['Admin', 'SuperAdmin'].includes(real.role);
      const realProjs = Array.isArray(real && real.projects) ? real.projects : [];
      const avail = (this.cat && this.cat.projects || []).filter(p => p.project_id && p.project_id !== 'generic' && (realFull || realProjs.includes('*') || realProjs.includes(p.project_id)));
      const sel = new Set((this.agentPreview && this.agentPreview.projects) || (avail[0] ? [avail[0].project_id] : []));
      const box = h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin:10px 0' });
      const chipStyle = (on) => `padding:4px 10px;border-radius:99px;border:1px solid ${on ? '#008F3F' : '#CBD5E1'};background:${on ? '#E6F4EA' : '#FFF'};color:${on ? '#006B2F' : '#334155'};font-size:12px;cursor:pointer;font-weight:${on ? '600' : '400'}`;
      const draw = () => {
        box.innerHTML = '';
        avail.forEach(p => {
          box.append(h('button', {
            type: 'button',
            style: chipStyle(sel.has(p.project_id)),
            onclick: () => { if (sel.has(p.project_id)) sel.delete(p.project_id); else sel.add(p.project_id); draw(); }
          }, (sel.has(p.project_id) ? '✓ ' : '') + p.name));
        });
      };
      draw();
      const m = this.modal([
        h('h2', { style: 'margin-top:0' }, '👁 Preview as Agent'),
        h('div', { class: 'sub' }, 'Test exactly what a Basic Agent sees and can access without changing Google Sheet permissions. Pick 1 project to auto-open straight into it, or multiple projects to see their project cards & switcher.'),
        h('div', { class: 'small muted' }, 'Assign projects to this previewed Agent:'),
        avail.length ? box : h('div', { class: 'small muted', style: 'margin:8px 0' }, 'No projects available in your scope.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => { m.close(); this.agentPreview = { active: true, projects: [...sel] }; this.engine = null; try { chrome.storage.local.remove('cb_draft2'); } catch (e) {} this.view = 'chat'; this.start(); } }, 'Start Agent Preview'),
          this.agentPreview && this.agentPreview.active ? h('button', { class: 'btn', onclick: () => { m.close(); this.agentPreview = null; this.engine = null; try { chrome.storage.local.remove('cb_draft2'); } catch (e) {} this.view = 'chat'; this.start(); } }, 'Exit Preview') : null,
          h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'))
      ]);
    },

    // ---------- boot ----------
    async start() {
      this.shell.innerHTML = '';
      const msg = h('div', { class: 'muted' }, 'Starting CogniBuddy…');
      const close = h('button', { class: 'close', style: 'position:absolute;top:14px;right:16px', onclick: () => this.close() }, '✕');
      this.shell.append(close, h('div', { class: 'center', style: 'margin:auto' }, h('div', { class: 'logo', style: 'margin:0 auto 14px' }, 'C'), msg));
      const t0 = Date.now(); const lap = (what) => { const s = ((Date.now() - t0) / 1000).toFixed(1); console.log(`[CogniBuddy] start: ${what} at ${s}s`); msg.textContent = `Starting CogniBuddy… ${what} (${s}s)`; };
      const stall = setTimeout(() => { msg.append(h('div', { class: 'small', style: 'margin-top:10px' }, 'Taking longer than usual. ', h('a', { href: '#', style: 'color:#008F3F', onclick: (ev) => { ev.preventDefault(); this.start(); } }, 'Retry'))); }, 12000);
      try {
        lap('checking your account');
        try { this.boot = await CB.api('cb_boot'); } catch (e) { this.boot = { state: 'error', error: e.message }; }
        const b = this.boot;
        if (b.state !== 'ready') { clearTimeout(stall); return this.renderGate(b); }
        this.realUser = b.user;
        this.user = (this.agentPreview && this.agentPreview.active)
          ? { ...this.realUser, role: 'Agent', projects: this.agentPreview.projects.slice() }
          : this.realUser;
        lap('loading projects and knowledge');
        try { this.cat = await CB.api('cb_catalog', { drafts: this.preview }); if (CB.audit && CB.audit.setOverrides) CB.audit.setOverrides(this.cat.auditRules); } catch (e) { clearTimeout(stall); return this.renderGate(String(e.message).startsWith('AUTH_REQUIRED') ? { state: 'needs_login' } : { state: 'error', error: e.message }); }
        lap('opening');
        if (!this.engine) this.engine = new CB.Engine(this.cat, this.user, this.pageUrl); else { this.engine.cat = this.cat; this.engine.user = this.user; }
        if (!this.isAdmin() && !['chat', 'cases'].includes(this.view)) this.view = 'chat';
        this.renderShell();
        const restored = await this.engine.restore().catch(() => false);
        this.show(this.view);
        if (restored && this.view === 'chat') this.replayChat();
        clearTimeout(stall);
        lap('ready');
        this.checkPending();
        this.engine.nanoMode(true).then(m => this.setNano(m)).catch(() => this.setNano('guided'));
      } catch (e) { // any unexpected error must show on screen, never leave the start screen frozen
        clearTimeout(stall); console.error('[CogniBuddy] start failed', e);
        this.renderGate({ state: 'error', error: 'Unexpected error while opening: ' + (e && e.message ? e.message : e) });
      }
    },

    renderGate(b) {
      this.shell.innerHTML = '';
      const close = h('button', { class: 'close', style: 'position:absolute;top:14px;right:16px', onclick: () => this.close() }, '✕');
      let body;
      if (b.state === 'needs_login') body = [h('h2', {}, 'Sign in to Google first'), h('p', { class: 'muted' }, 'CogniBuddy uses your Cognizant Google session. A tab will open: sign in there (and approve the one-time access prompt if Google shows it), close that tab, then press Retry.'), h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: () => CB.api('cb_login') }, 'Open sign-in tab'), h('button', { class: 'btn', onclick: () => this.start() }, 'Retry'))];
      else if (b.state === 'needs_config') body = [h('h2', {}, 'Setup needed'), h('p', { class: 'muted' }, b.reason + '. Paste the Apps Script web-app URL into extension/config.json ("apiUrl") or the Options page, then reload the extension. See docs/SETUP.md.'), h('button', { class: 'btn', onclick: () => chrome.runtime.sendMessage({ action: 'cb_reload_config' }, () => this.start()) }, 'Retry')];
      else if (b.state === 'unauthorized') body = [h('h2', {}, 'No access yet'), h('p', { class: 'muted' }, `${b.user.email} is not an active user in the CogniBuddy Users sheet. Ask an admin to add you.`), h('button', { class: 'btn', onclick: async () => { await CB.api('cb_logout'); this.start(); } }, 'Use another account')];
      else body = [h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, b.error || 'Unknown error'), h('button', { class: 'btn', onclick: () => this.start() }, 'Retry')];
      this.shell.append(close, h('div', { class: 'center' }, h('div', { class: 'logo', style: 'margin:0 auto 16px' }, 'C'), body));
    },

    renderShell() {
      this.shell.innerHTML = '';
      const nav = h('div', { class: 'nav' });
      this.ui.navBtns = {};
      const items = [['chat', '💬 Assistant'], ['cases', this.isAdmin() ? '📥 Case inbox' : '📂 My cases']];
      if (this.isAdmin()) {
        items.push(['admin', '⚙️ Admin']);
        items.push(['workspace', '🗂 Workspace ↗']);
      }
      items.forEach(([k, label]) => { const b = h('button', { onclick: () => (k === 'workspace' ? CB.api('cb_open_workspace', {}).catch(e => this.err(e)) : this.show(k)), title: k === 'workspace' ? 'Home, project boards and task chat (opens a tab)' : null }, label, k === 'cases' ? (this.ui.badge = h('span', { class: 'badge', style: 'display:none' })) : k === 'workspace' ? (this.ui.wsBadge = h('span', { class: 'badge', style: 'display:none;background:#1565C0' })) : null); this.ui.navBtns[k] = b; nav.append(b); });
      this.ui.nanoDot = h('span', { class: 'dot' + (this.isAdmin() ? '' : ' on') });
      this.ui.nanoTxt = h('span', {}, this.isAdmin() ? 'Checking Gemini Nano…' : 'Assistant ready');
      const spacer = h('div', { class: 'sp' });
      const side = h('div', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'C'), h('b', {}, 'CogniBuddy')),
        h('button', { class: 'btn primary', onclick: () => { this.engine.reset(); chrome.storage.local.remove('cb_draft2'); this.show('chat', true); } }, '＋ New chat'),
        nav, spacer,
        this.cat && this.cat.preview ? h('div', { class: 'preview-flag', title: 'You see unpublished drafts. Colleagues do not.' }, '👁 Draft preview is on') : null,
        h('div', { class: 'who' }, this.ui.nanoDot, this.ui.nanoTxt, h('br'), h('b', {}, this.user.name || this.user.email), h('br'), this.user.role + (this.boot.mock ? ' · MOCK DATA' : ''),
          this.isAdmin() ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', style: 'width:100%', onclick: () => this.openAgentPreviewModal() }, '👁 Preview as Agent')) : null));
      this.ui.title = h('h2', {});
      this.ui.body = h('div', { class: 'view' });
      this.ui.iris = h('div', { class: 'iris-flag', style: 'display:none' });
      let previewBar = null;
      if (this.agentPreview && this.agentPreview.active && this.isRealAdmin()) {
        const real = this.realUser || {};
        const realFull = ['Admin', 'SuperAdmin'].includes(real.role);
        const realProjs = Array.isArray(real.projects) ? real.projects : [];
        const avail = (this.cat && this.cat.projects || []).filter(p => p.project_id && p.project_id !== 'generic' && (realFull || realProjs.includes('*') || realProjs.includes(p.project_id)));
        const sel = new Set(this.agentPreview.projects || []);
        const chipStyle = (on) => `padding:2px 8px;border-radius:99px;border:1px solid ${on ? '#1D4ED8' : '#93C5FD'};background:${on ? '#1D4ED8' : '#FFF'};color:${on ? '#FFF' : '#1E3A8A'};font-size:11px;cursor:pointer;font-weight:${on ? '600' : '400'}`;
        previewBar = h('div', { style: 'background:#EFF6FF;border-bottom:1px solid #93C5FD;color:#1E3A8A;padding:7px 14px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px' },
          h('b', {}, '👁 Previewing as Agent · Projects:'),
          avail.map(p => h('button', {
            type: 'button',
            style: chipStyle(sel.has(p.project_id)),
            onclick: () => {
              if (sel.has(p.project_id)) sel.delete(p.project_id); else sel.add(p.project_id);
              this.agentPreview.projects = [...sel];
              this.user = { ...this.realUser, role: 'Agent', projects: this.agentPreview.projects.slice() };
              try { chrome.storage.local.remove('cb_draft2'); } catch (e) {}
              this.engine = new CB.Engine(this.cat, this.user, this.pageUrl);
              this.renderShell(); this.show('chat', true); this.engine.nanoMode(true).then(m => this.setNano(m)).catch(() => {});
            }
          }, (sel.has(p.project_id) ? '✓ ' : '') + p.name)),
          h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: () => { this.agentPreview = null; this.engine = null; try { chrome.storage.local.remove('cb_draft2'); } catch (e) {} this.view = 'chat'; this.start(); } }, '✕ Exit Preview'));
      }
      const main = h('div', { class: 'main' }, previewBar, this.ui.iris, h('div', { class: 'top' }, this.ui.title, h('button', { class: 'close', title: 'Close (Esc)', onclick: () => this.close() }, '✕')), this.ui.body);
      this.shell.append(side, main);
      this.refreshBadge();
      this.watchIris();
      // Production (work queue, clock, utilization): shown for admins / managers (hidden from basic Agent demo sidebar).
      if (CB.prod && this.isAdmin()) CB.prod.info(this, true).then(i => {
        if (!i || !nav.isConnected || !((i.configured && i.role) || this.isFull())) return;
        const b = h('button', { onclick: () => this.show('production'), title: 'Your work queue, clock, utilization and the production dashboard' }, '📈 Production');
        this.ui.navBtns.production = b; nav.insertBefore(b, this.ui.navBtns.workspace);
        if (i.configured && i.role) side.insertBefore(CB.prod.clock(this), spacer);
        if (this.view === 'production') b.classList.add('on');
      }).catch(() => {}); // a gateway without the production files: no Production item
    },
    // Iris has priority on Gemini Nano. While it scrapes, a banner says so (checked every 4 s while the overlay is open).
    watchIris() {
      clearInterval(this._irisT);
      const tick = async () => {
        if (!this.ui.iris || !this.ui.iris.isConnected) { clearInterval(this._irisT); return; }
        if (this.host.style.display === 'none') return;
        let st = null; try { st = await CB.api('cb_iris_status', {}, 5000); } catch (e) {}
        const on = !!(st && st.active);
        this.ui.iris.style.display = on ? '' : 'none';
        if (on) this.ui.iris.textContent = st.busy ? '🔍 Iris is scraping and using Gemini Nano right now. It has priority, so my answers may wait or come without AI until it finishes - for the best answers, ask again when Iris is done.' : '🔍 Iris was scraping a moment ago. If it starts again, it gets Gemini Nano first.';
      };
      tick(); this._irisT = setInterval(tick, 4000);
    },
    // mode: 'ai' | 'downloading' | 'guided' (true / false are accepted too)
    setNano(m) {
      if (!this.ui.nanoDot) return;
      const mode = m === true ? 'ai' : (m === false || !m) ? 'guided' : m;
      if (!this.isAdmin()) {
        this.ui.nanoDot.className = 'dot on';
        this.ui.nanoTxt.textContent = mode === 'ai' ? 'Smart Assistant active' : 'Assistant ready';
        this.ui.nanoTxt.title = 'Ready to answer questions, guide workflows and create cases.';
        return;
      }
      this.ui.nanoDot.className = 'dot ' + (mode === 'ai' ? 'on' : mode === 'downloading' ? 'load' : 'warn');
      this.ui.nanoTxt.textContent = mode === 'ai' ? 'Gemini Nano active' : mode === 'downloading' ? 'Gemini Nano downloading - guided mode' : 'Guided mode (Gemini Nano not active)';
      this.ui.nanoTxt.title = mode === 'ai' ? 'Answers and fact reading use on-device Gemini Nano.' : 'The assistant works fully without Gemini Nano: it asks step by step and shows knowledge articles.';
    },
    async refreshBadge() {
      const p = await CB.api('cb_pending').catch(() => null); if (!p || !this.ui.badge) return;
      const n = this.isAdmin() ? p.adminOpen : ((p.resolved || []).length + (p.needsInfo || []).length);
      this.ui.badge.textContent = n; this.ui.badge.style.display = n ? '' : 'none';
      // unread board notifications (mentions, assignments, messages on my tasks) -> the Workspace item
      if (this.ui.wsBadge) { let seen = {}; try { seen = (await chrome.storage.local.get('cb_inbox_seen')).cb_inbox_seen || {}; } catch (e) {} const u = (p.inbox || []).filter(i => !seen[i.id]).length + (p.due || []).length; this.ui.wsBadge.textContent = u; this.ui.wsBadge.style.display = u ? '' : 'none'; }
    },
    async checkPending() {
      const p = await CB.api('cb_pending').catch(() => null);
      if (!p || this.isAdmin()) return;
      const c = (p.resolved || [])[0]; if (c) this.resolutionModal(c);
    },
    resolutionModal(c) {
      const m = this.modal([
        h('h2', { style: 'margin-top:0' }, c.status === 'Solved' ? '✅ Your issue was solved' : 'ℹ️ Your issue was closed'),
        h('div', { class: 'small muted' }, `${c.case_id} · ${c.title}`),
        h('h3', {}, 'Resolution summary'), h('div', { html: CB.md(c.resolution_summary).replace(/\n/g, '<br>') }),
        c.root_cause ? h('div', { class: 'small', style: 'margin-top:10px' }, h('b', {}, 'Root cause: '), c.root_cause) : null,
        h('div', { class: 'small muted', style: 'margin-top:8px' }, `Resolved by ${c.resolved_by} on ${this.fmt(c.resolved_at)}`),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await CB.api('cb_ack', { caseId: c.case_id }); m.close(); this.refreshBadge(); this.checkPending(); } catch (e) { this.err(e); } } }, 'Got it, thanks'),
          h('button', { class: 'btn', onclick: async () => { const r = prompt('What is still failing?'); if (r === null) return; try { await CB.api('cb_reopen', { caseId: c.case_id, reason: r }); m.close(); this.show('cases'); } catch (e) { this.err(e); } } }, 'Still failing - reopen'))]);
    },

    show(view, fresh) {
      this.view = view;
      Object.entries(this.ui.navBtns).forEach(([k, b]) => b.classList.toggle('on', k === view));
      this.ui.body.innerHTML = '';
      this.ui.body.classList.remove('swap'); void this.ui.body.offsetWidth; this.ui.body.classList.add('swap');
      if (view === 'chat') { this.ui.title.textContent = 'Assistant'; this.renderChat(fresh); }
      else if (view === 'cases') { this.ui.title.textContent = this.isAdmin() ? 'Case inbox' : 'My cases'; this.renderCases(); }
      else if (view === 'admin') { this.ui.title.textContent = 'Admin'; this.renderAdmin(this.isFull() ? 'users' : 'projects'); }
      else if (view === 'production' && CB.prod) { this.ui.title.textContent = 'Production'; CB.prod.render(this, CB.prod.state.tab); }
      else if (view === 'platform' && CB.platform && this.isFull()) { this.ui.title.textContent = 'Platform settings'; CB.platform.render(this); }
      this.refreshBadge();
    },

    // =============== CHAT ===============
    renderProjBar() {
      const bar = this.ui.projBar; if (!bar || !this.engine) return;
      bar.innerHTML = '';
      const assigned = this.engine.assignedProjects ? this.engine.assignedProjects() : [];
      const curId = this.engine.s.projectId;
      const show = assigned.length > 0 || !!curId;
      bar.style.display = show ? 'flex' : 'none';
      if (!show) return;
      bar.append(h('span', { class: 'small muted', style: 'margin-right:4px' }, assigned.length > 1 ? 'Your projects:' : 'Project:'));
      const switchTo = (id) => {
        if (this.busy) return;
        const e = this.engine;
        if (e.s.projectId === id) { e.s.mode = 'open'; e.s.skipIntake = false; e.s.canvas = e.homeCanvas(); e.save(); this.paintCanvas(e.s.canvas); this.renderProjBar(); return; }
        if (e.s.wf) e.wfClose('abandoned');
        const p = this.cat.projects.find(x => x.project_id === id);
        this.bubble('user', p ? p.name : id);
        this.apply(e.pickProject(id));
      };
      assigned.forEach(p => {
        bar.append(h('button', {
          class: 'btn sm' + (p.project_id === curId ? ' primary' : ''),
          onclick: () => switchTo(p.project_id)
        }, (p.icon ? p.icon + ' ' : '') + p.name));
      });
      if (curId && !assigned.some(p => p.project_id === curId)) {
        const cur = this.cat.projects.find(x => x.project_id === curId);
        if (cur) bar.append(h('button', { class: 'btn sm primary', onclick: () => switchTo(cur.project_id) }, (cur.icon ? cur.icon + ' ' : '') + cur.name));
      }
      const restricted = !!(this.engine.isProjectRestricted && this.engine.isProjectRestricted());
      if (curId && (!restricted || assigned.length > 1)) {
        bar.append(h('button', {
          class: 'btn sm',
          style: 'margin-left:auto',
          onclick: () => { if (!this.busy) this.ctx().onChangeProject(); }
        }, restricted ? 'All my projects ▾' : 'All projects ▾'));
      }
    },
    renderChat(fresh) {
      this.ui.msgs = h('div', { class: 'msgs' });
      this.ui.canvas = h('div', { class: 'canvas' });
      const ta = h('textarea', { rows: 1, placeholder: 'Ask how a tool works, or describe what went wrong…' });
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      const send = () => { const t = ta.value.trim(); if (!t || this.busy) return; ta.value = ''; ta.style.height = 'auto'; this.userSays(t); };
      this.ui.ta = ta;
      this.ui.projBar = h('div', { style: 'display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 14px;border-bottom:1px solid #E2E8F0;background:#F8FAFC' });
      this.ui.incBar = h('div', {});
      this.ui.body.append(h('div', { class: 'chat' }, this.ui.projBar, this.ui.incBar, this.ui.msgs, h('div', { class: 'composer' }, ta, h('button', { class: 'btn', title: 'Attach a screenshot of this page to your report (CogniBuddy hides for a moment)', onclick: () => this.captureShot() }, '📸'), h('button', { class: 'btn primary', onclick: send }, 'Send'))), this.ui.canvas);
      this.renderProjBar();
      this.incidentBanner();
      if (!fresh && this.engine.s.history.length) { this.replayChat(); return; }
      const first = (this.user.name || '').split(' ')[0] || 'there';
      const activeProj = this.engine.s.projectId && this.engine.project;
      const greet = activeProj
        ? `Hi ${first}! 👋 I'm ready on **${activeProj.name}**. Ask anything below, or pick a guide on the right.`
        : (CB.voice ? CB.voice.say('greet', { name: first }) : `Hi ${first}! 👋 Pick the project you need help with on the right, or just type your question or problem here.`);
      this.bubble('bot', greet);
      this.paintCanvas(activeProj ? this.engine.homeCanvas() : null);
    },
    replayChat() {
      if (!this.ui.msgs) return;
      this.renderProjBar();
      this.ui.msgs.innerHTML = '';
      this.engine.s.history.forEach(m => this.bubble(m.role === 'bot' ? 'bot' : 'user', m.text));
      this.paintCanvas(this.engine.s.canvas);
    },
    bubble(role, text) { const b = h('div', { class: 'm ' + role, html: CB.md(text) }); this.ui.msgs.append(b); this.ui.msgs.scrollTop = 1e9; return b; },
    // Sends one feedback row about the last answer / article / SOP section that was shown.
    sendFb(extra) { const fb = this.lastFb; if (!fb || !fb.ref_id) return; CB.feedback({ kind: fb.kind, ref_id: fb.ref_id, project_id: fb.project_id || '', query: fb.query || '', mode: fb.mode || '', ...extra }); },
    fbBar(fb) { return CB.feedbackBar(({ rating, reason }) => CB.feedback({ kind: fb.kind, ref_id: fb.ref_id, project_id: fb.project_id || '', query: fb.query || '', mode: fb.mode || '', rating, reason })); },
    toolParams() {
      const e = this.engine, o = {};
      Object.keys(e.s.facts).forEach(k => { const v = e.s.facts[k]; o[k] = typeof v === 'string' && v.length > 20000 ? v.slice(0, 20000) : v; });
      if (!o.url) o.url = this.pageUrl;
      o.__pageUrl = this.pageUrl;
      return o;
    },
    ctx() {
      const e = this.engine;
      return {
        engine: e, pageUrl: this.pageUrl, peek: (s, l) => this.peek(s, l), unpeek: () => this.unpeek(),
        onWorkflow: (id) => { const w = e.wfLookup(id); this.bubble('user', w ? w.title : id); this.apply(e.wfStart(id, w ? w.title : id)); },
        onWfChoice: (choice, echo) => { this.bubble('user', echo); this.apply(e.wfChoice(choice, echo)); },
        canApprove: this.user.role === 'SuperAdmin',
        approveTool: async (toolId) => { // a SuperAdmin approves the published tool exactly as it is, then the step is shown again
          const t = (e.cat.tools || []).find(x => x.id === toolId); if (!t) throw new Error('This tool was not found.');
          await CB.api('cb_tool_approve', { path: 'projects/' + t.project_id + '/tools/' + t.id + '.json', approve: true });
          this.cat = await CB.api('cb_catalog', { force: true, drafts: this.preview }); e.cat = this.cat; this.apply(e.wfShow());
        },
        openStudio: () => CB.api('cb_open_studio', { projectId: e.s.projectId }),
        runTool: (toolId, extra) => CB.api('cb_run_tool', { toolId, projectId: e.s.projectId, preview: this.preview, params: { ...this.toolParams(), ...(extra || {}) } }),
        onWfTool: (result) => { const echo = result && result.ok ? 'Check done: ' + String(result.summary || '').slice(0, 120) : 'Continue without the check'; this.bubble('user', echo); this.apply(e.wfToolDone(result, echo)); },
        onWfAbort: () => { this.bubble('user', 'Stop the guide'); this.apply(e.wfAbort('Stop the guide')); },
        onSmartPaste: () => this.smartPaste(),
        capture: () => this.captureShot(),
        repaint: () => this.paintCanvas(e.s.canvas),
        slaText: this.slaText(e.s.projectId),
        findSimilar: (pid, text) => (pid && pid !== 'generic' ? CB.api('cb_ops', { op: 'similar', body: { project_id: pid, text } }).catch(() => null) : Promise.resolve(null)),
        onJoinIncident: (i, d) => this.joinInstead('incident', i, d),
        onJoinCase: (c, d) => this.joinInstead('case', c, d),
        onClarify: (kbId, title) => { this.bubble('user', title); const res = e.showArticle(kbId, title); this.apply(res); this.lastFb = res.fb; if (res.fb) this.ui.msgs.append(this.fbBar(res.fb)); },
        onHome: () => { e.s.mode = 'open'; e.s.skipIntake = false; e.s.canvas = e.s.projectId ? e.homeCanvas() : null; e.save(); this.paintCanvas(e.s.canvas); },
        onProject: (id) => { const p = this.cat.projects.find(x => x.project_id === id); this.bubble('user', p ? p.name : id); this.apply(e.pickProject(id)); },
        onReport: () => { this.bubble('user', 'Report an issue'); this.apply(e.startIssue('Report an issue')); },
        onAsk: (q) => this.userSays(q),
        onChangeProject: () => { if (e.s.wf) e.wfClose('abandoned'); e.s.projectId = ''; e.s.mode = 'open'; e.s.canvas = null; e.save(); this.renderProjBar(); this.paintCanvas(null); this.incidentBanner(); },
        onFact: (k, v, d) => { this.bubble('user', d); this.apply(e.provideFact(k, v, d)); },
        onSkip: (k) => { this.bubble('user', '(skipped)'); this.apply(e.skipFact(k)); },
        onSnippetResult: (sn, text, via) => { this.bubble('user', `Result for "${sn.title}" sent (${text.length} chars)`); this.apply(e.snippetDone(sn, text, via)); },
        onSkipSnippet: (sn) => { this.bubble('user', `(skipped "${sn.title}")`); this.apply(e.skipSnippet(sn)); },
        onSolved: () => { this.sendFb({ solved: 'true', rating: 1 }); this.bubble('user', 'That fixed it ✅'); this.bubble('bot', 'Great, glad it helped! Come back any time. 🙌'); e.reset(); chrome.storage.local.remove('cb_draft2'); this.renderProjBar(); this.paintCanvas(e.s.projectId && e.project ? e.homeCanvas() : null); },
        onStillFailing: () => { this.sendFb({ solved: 'false' }); if (e.s.wf) { this.bubble('user', 'That does not answer it'); this.apply(e.wfStep('That does not answer it - back to the guide')); return; } this.bubble('user', 'Still failing'); e.s.mode = 'case'; this.apply(e.advance('Opening a case for this problem.')); },
        runAll: (ids, ui, ctrl) => this.runAllChecks(ids, ui, ctrl),
        onManual: () => { this.bubble('user', 'Run the checks one by one'); this.apply(e.startManual()); },
        onBatchDone: () => {
          // checks that were not run (unticked, cancelled, failed to run) are skipped so the interview moves on
          e.nextSnippets().forEach(sn => { if (!e.s.skipped.includes('sn:' + sn.snippet_id)) e.s.skipped.push('sn:' + sn.snippet_id); });
          const rs = Object.values(e.s.results); const n = (f) => rs.filter(r => f(r)).length;
          const msg = `Ran ${rs.length} diagnostic(s) automatically: ${n(r => r.pass === true)} passed, ${n(r => r.pass === false)} failed, ${n(r => r.pass !== true && r.pass !== false)} inconclusive/captured`;
          this.bubble('user', msg); this.apply(e.finishBatch(msg));
        },
        onMoreTest: (id) => { this.bubble('user', 'Add extra check'); this.apply(e.addExtra(id)); },
        onMoreDone: () => { this.bubble('user', 'Continue to review'); this.apply(e.moreDone()); },
        onSubmit: async (prio, unlock) => {
          if (this.submitting) return; this.submitting = true; // never allow a second submit of the same draft
          try {
            const d = e.draftCase(); d.priority = prio;
            const pc = CB.prod ? await CB.prod.activeCase() : null; // the production case this person is working on
            if (pc) d.facts = { ...d.facts, production_case: `${pc.id} (${pc.account || pc.title || ''})` };
            this.bubble('user', 'Submit case');
            this.paintCanvas({ widget: 'none' }, h('div', { class: 'card center' }, h('div', { style: 'font-size:34px' }, '⏳'), h('h3', {}, 'Submitting your case…'), h('div', { class: 'sub' }, 'Saving the conversation and attachments. Please wait, do not close this window.')));
            const id = await CB.api('cb_create_case', { draft: d });
            const sla = this.slaText(d.projectId);
            const ack = `✅ Case **${id}** was submitted. I'll notify you when an admin replies or resolves it - you can follow it under “My cases”.${sla ? ' ' + sla : ''}\nDo you have another issue to report?`;
            CB.api('cb_add_message', { caseId: id, msg: { role: 'bot', text: `Case ${id} submitted by the reporter.` } }).catch(() => {});
            this.bubble('bot', ack);
            e.reset(); chrome.storage.local.remove('cb_draft2');
            this.awaitingAnother = true;
            this.paintCanvas(null, h('div', { class: 'card center' }, h('div', { style: 'font-size:40px' }, '📨'), h('h3', {}, 'Case ' + id + ' submitted'), h('div', { class: 'sub' }, 'Do you have another issue to report?'),
              h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: () => this.anotherIssue() }, 'Yes, report another issue'), h('button', { class: 'btn', onclick: () => this.finishChat() }, 'No, that is all'), h('button', { class: 'btn sm', onclick: () => this.show('cases') }, 'Open my cases')),
              pc ? h('div', { class: 'row', style: 'justify-content:center' }, h('span', { class: 'small muted' }, `Linked to your production case ${pc.id}.`), h('button', { class: 'btn sm warn', title: 'Paused time does not count as handling time', onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; const r = await CB.prod.pauseFor(pc.id); if (r) { b.textContent = '⏸ Paused'; CB.api('cb_add_message', { caseId: id, msg: { role: 'bot', text: `Production case ${pc.id} was paused while this problem blocks the reporter.` } }).catch(() => {}); } else b.disabled = false; } }, `⏸ Pause ${pc.id} while this blocks you`)) : null));
            this.refreshBadge();
          } catch (er) { this.err(er); if (unlock) unlock(); this.paintCanvas(e.s.canvas); }
          this.submitting = false;
        }
      };
    },
    // Runs the selected diagnostics one after another in the page and records every result automatically.
    // Checks that need a person (an open item popup) run last, behind a countdown during which CogniBuddy hides.
    async runAllChecks(ids, ui, ctrl) {
      const e = this.engine;
      try { await e.loadContext(); } catch (er) {}
      const list = ids.map(id => e.cat.snippets.find(s => s.snippet_id === id)).filter(Boolean).sort((a, b) => a.order - b.order);
      list.forEach(sn => { if (!e.offered(sn)) (e.s.extra = e.s.extra || []).push(sn.snippet_id); }); // picked extras become part of the case
      const auto = list.filter(s => !e.needsPage(s)), page = list.filter(s => e.needsPage(s));
      const counts = { pass: 0, fail: 0, inconclusive: 0, captured: 0 }; const failed = []; let skipped = 0, ran = 0;
      const runOne = async (sn) => {
        ui.setStatus(sn.snippet_id, 'running');
        try {
          const params = CB.snippetParams(e, sn);
          const r = await Promise.race([CB.api('cb_run_snippet', { snippetId: sn.snippet_id, params, allFrames: false }), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 120 s')), 120000))]);
          const good = (r.frames || []).filter(f => f.ok && f.result && f.result !== 'null');
          if (!r.ok || !good.length) throw new Error(r.error || (r.frames && r.frames[0] && r.frames[0].error) || 'no result');
          const obj = e.recordSnippet(sn, good[0].result, 'auto'); ran++;
          const st = obj && obj.pass === true ? 'pass' : obj && obj.pass === false ? 'fail' : obj ? 'inconclusive' : 'captured';
          counts[st]++; ui.setStatus(sn.snippet_id, st, obj && obj.summary ? String(obj.summary).slice(0, 160) : '');
        } catch (er) { failed.push(sn.snippet_id); ui.setStatus(sn.snippet_id, 'error', String(er.message || er).slice(0, 160)); }
      };
      for (const sn of auto) { if (ctrl.cancel) { skipped++; ui.setStatus(sn.snippet_id, 'skipped'); continue; } await runOne(sn); }
      for (const sn of page) {
        if (ctrl.cancel) { skipped++; ui.setStatus(sn.snippet_id, 'skipped'); continue; }
        ui.setStatus(sn.snippet_id, 'waiting', 'Open the item popup on the page now - CogniBuddy is hidden during the countdown.');
        const go = await this.peek(15, sn.title);
        if (!go) { skipped++; ui.setStatus(sn.snippet_id, 'skipped', 'cancelled'); this.unpeek(); continue; }
        await runOne(sn); this.unpeek();
      }
      e.save();
      return { counts, failed, skipped, ran };
    },
    anotherIssue(echo = true) {
      this.awaitingAnother = false; this.engine.reset(); chrome.storage.local.remove('cb_draft2');
      const activeProj = this.engine.s.projectId && this.engine.project;
      if (echo) this.bubble('user', 'Yes, another issue');
      this.bubble('bot', activeProj ? `Sure — what else can I help with in **${activeProj.name}**?` : 'Sure - which project is it about? Pick a card.');
      this.renderProjBar();
      this.paintCanvas(activeProj ? this.engine.homeCanvas() : null);
    },
    finishChat(echo = true) {
      this.awaitingAnother = false; this.engine.reset(); chrome.storage.local.remove('cb_draft2');
      if (echo) this.bubble('user', 'No, that is all'); this.bubble('bot', 'Thanks! Your case is with the team and I will let you know when it moves. 👋');
      if (this.ui.ta) { this.ui.ta.disabled = true; this.ui.ta.placeholder = 'Conversation finished'; }
      this.renderProjBar();
      this.paintCanvas(null, h('div', { class: 'card center' }, h('div', { style: 'font-size:40px' }, '👋'), h('h3', {}, 'Conversation finished'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: () => this.show('chat', true) }, 'Start a new conversation'), h('button', { class: 'btn', onclick: () => this.close() }, 'Close CogniBuddy'))));
    },
    apply(res) { this.bubble('bot', res.say); this.afterSay(res); },
    afterSay(res) { this.renderProjBar(); this.paintCanvas(res.canvas); if (this.engine.s.facts.url) this.engine.loadContext().catch(() => {}); this.incidentBanner(); },
    // The real steps of a turn (engine events), collapsed under "How I got this".
    traceEl(res) {
      const line = (ev) => h('li', {}, toolChip(ev.step), h('b', {}, ev.label), ev.detail ? ' - ' + ev.detail : '', ev.ms !== null && ev.ms !== undefined ? h('span', { class: 'muted' }, ` (${(ev.ms / 1000).toFixed(1)} s)`) : null);
      return h('details', { class: 'trace' }, h('summary', {}, `How I got this · ${res.trace.length} step${res.trace.length === 1 ? '' : 's'} · ${(res.ms / 1000).toFixed(1)} s`), h('ol', {}, res.trace.map(line)));
    },
    paintCanvas(spec, custom) { this.ui.canvas.innerHTML = ''; const el = custom || CB.renderCanvas(spec, this.ctx()); el.classList.add('enter'); this.ui.canvas.append(el); this.ui.canvas.scrollTop = 0; },
    async userSays(text, opts = {}) {
      if (this.busy) return;
      if (this.awaitingAnother) { // answer to "Do you have another issue to report?"
        if (/^\s*(no|nope|nothing|that'?s all|that is all|done|no thanks|nah)\b/i.test(text)) { this.bubble('user', text); this.finishChat(false); return; }
        this.awaitingAnother = false;
        if (/^\s*(yes|yeah|yep|sure|another|ok|okay)\b/i.test(text) && text.trim().split(/\s+/).length <= 3) { this.bubble('user', text); this.anotherIssue(false); return; }
      }
      // Production commands ("start my break", "pause my case", "how am I doing") - never in the middle of a guide or a case interview
      if (!opts.skipProd && CB.prod && this.engine && !this.engine.s.wf && this.engine.s.mode !== 'case') {
        this.busy = true; let done = false;
        try { done = await CB.prod.chat(this, text); } catch (e) { done = false; }
        this.busy = false;
        if (done) return;
      }
      this.busy = true;
      this.ui.msgs.querySelectorAll('.row').forEach(r => { if (r.parentElement === this.ui.msgs) r.remove(); });
      if (!opts.noEcho) this.bubble('user', text);
      const now = h('span', {}, 'Thinking…'), steps = h('ol', {});
      const t = h('div', { class: 'm bot thinking' }, h('div', { class: 'think-head' }, h('span', { class: 'spin' }), now), steps);
      this.ui.msgs.append(t);
      const down = () => { this.ui.msgs.scrollTop = 1e9; };
      down();
      let live = null, raw = ''; // the answer bubble while Gemini Nano is streaming
      const hooks = {
        onEvent: (ev) => { now.textContent = ev.label + '…'; steps.append(h('li', {}, toolChip(ev.step), ev.label + (ev.detail ? ' - ' + ev.detail : ''))); down(); },
        onStream: (d) => { if (!live) { live = this.bubble('bot', ''); live.classList.add('streaming'); } raw += d; live.textContent = raw; down(); }
      };
      try {
        const res = await this.engine.turn(text, hooks);
        t.remove();
        const e = this.engine; this.setNano(e.s.nano ? 'ai' : (e.nanoInfo && e.nanoInfo.mode !== 'ai' ? e.nanoInfo.mode : 'guided'));
        const tr = this.isAdmin() && res.trace && res.trace.length ? this.traceEl(res) : null;
        if (live) { live.classList.remove('streaming'); live.innerHTML = CB.md(res.say); if (tr) live.before(tr); this.afterSay(res); }
        else { if (tr) this.ui.msgs.append(tr); this.apply(res); }
        this.lastFb = res.fb || null;
        if (res.fb && res.fb.ref_id) this.ui.msgs.append(this.fbBar(res.fb));
        down();
      } catch (e) { t.remove(); if (live) live.remove(); this.err(e); }
      this.busy = false;
    },

    // =============== incidents, screenshots, smart paste, "me too" ===============
    slaText(pid) { const a = this.cat && this.cat.automation && this.cat.automation[pid]; return a && Number(a.sla_hours) ? `The team aims to answer within ${a.sla_hours} hour${Number(a.sla_hours) === 1 ? '' : 's'}.` : ''; },
    async saveProjectNotice(pid, noticeObj) {
      if (!pid) throw new Error('Pick a project first.');
      const path = `projects/${pid}/automation.json`;
      let base = {};
      try {
        const raw = await CB.api('cb_content_raw', { force: false });
        const f = raw && raw.files && (raw.files['drafts/' + path] || raw.files[path]);
        if (f && f.content) base = JSON.parse(f.content);
      } catch (e) {}
      if (!base || typeof base !== 'object') base = { ...((this.cat && this.cat.automation && this.cat.automation[pid]) || {}) };
      const next = { schema: 'cb.automation/1', ...base };
      if (noticeObj && noticeObj.text) next.notice = noticeObj;
      else delete next.notice;
      await CB.api('cb_fs_write', { files: [{ path: 'drafts/' + path, content: JSON.stringify(next, null, 1) }] });
      await CB.api('cb_fs_publish', { paths: ['drafts/' + path] });
      this.cat = await CB.api('cb_catalog', { force: true, drafts: this.preview });
      if (this.engine && this.engine.setCatalog) this.engine.setCatalog(this.cat);
      else if (this.engine) this.engine.cat = this.cat;
    },
    // Project notices & known issues for this project or this page: banners above the chat.
    async incidentBanner() {
      const bar = this.ui.incBar; if (!bar || !this.cat) return;
      const p = await CB.api('cb_pending').catch(() => null);
      const inc = (p && p.incidents) || [], pid = this.engine && this.engine.s.projectId;
      const onPage = (i) => { const pr = this.cat.projects.find(x => x.project_id === i.project_id); return pr && (pr.url_patterns || []).some(u => { try { return new RegExp(u, 'i').test(this.pageUrl); } catch (e) { return false; } }); };
      const rel = inc.filter(i => i.project_id === pid || onPage(i)).sort((a, b) => ['critical', 'major', 'minor'].indexOf(a.severity) - ['critical', 'major', 'minor'].indexOf(b.severity));
      const noticeFor = (id) => {
        const a = id && this.cat.automation && this.cat.automation[id];
        const n = a && a.notice;
        if (!n || !n.text) return null;
        if (n.expires_at && Date.parse(n.expires_at) <= Date.now()) return null;
        const pr = (this.cat.projects || []).find(x => x.project_id === id);
        return { pid: id, pname: pr ? pr.name : id, ...n };
      };
      let notice = noticeFor(pid);
      if (!notice) {
        const matchP = (this.cat.projects || []).find(pr => pr.project_id !== 'generic' && (pr.url_patterns || []).some(u => { try { return new RegExp(u, 'i').test(this.pageUrl); } catch (e) { return false; } }));
        if (matchP && (!this.engine || !this.engine.isProjectRestricted || !this.engine.isProjectRestricted() || (this.engine.userProjectIds && this.engine.userProjectIds().includes(matchP.project_id)))) {
          notice = noticeFor(matchP.project_id);
        }
      }
      bar.innerHTML = '';
      if (notice) {
        bar.append(h('div', { class: 'inc-banner', style: 'background:#EFF6FF;border-color:#93C5FD;color:#1E3A8A' },
          h('span', { style: 'font-size:18px' }, '📌'),
          h('div', { style: 'flex:1;min-width:200px' },
            h('b', {}, notice.pname + ' Notice: '), notice.text,
            notice.expires_at ? h('span', { class: 'small muted', style: 'margin-left:8px' }, `(until ${String(notice.expires_at).slice(0, 10)})`) : null),
          this.isAdmin() && this.inScope(notice.pid) ? h('button', { class: 'btn sm', onclick: () => this.saveProjectNotice(notice.pid, null).then(() => this.incidentBanner()).catch(e => this.err(e)) }, 'Clear') : null));
      }
      if (!rel.length) return;
      const i = rel[0];
      bar.append(h('div', { class: 'inc-banner' }, h('span', { style: 'font-size:18px' }, '🚨'), h('div', { style: 'flex:1;min-width:200px' }, h('b', {}, 'Known issue: ' + i.title), ' ', h('span', { class: 'sev ' + i.severity }, i.severity), h('div', { class: 'small muted' }, `${i.status} · ${i.affected} affected · the team is on it${rel.length > 1 ? ' · +' + (rel.length - 1) + ' more' : ''}`)),
        h('button', { class: 'btn sm primary', onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { const r2 = await CB.api('cb_ops', { op: 'incidentJoin', body: { incident_id: i.incident_id, join: {} } }); b.textContent = `✓ Added (${r2.affectedCount} affected)`; } catch (e) { b.disabled = false; this.err(e); } } }, "I'm affected too"),
        h('button', { class: 'btn sm', onclick: () => CB.api('cb_open_workspace', { hash: 'incident/' + i.incident_id }).catch(e => this.err(e)) }, 'Details')));
    },
    async captureShot() {
      const e = this.engine;
      this.host.style.display = 'none';
      await new Promise(r => setTimeout(r, 260)); // let the page repaint without CogniBuddy
      let shot = null, er = null;
      try { shot = await CB.api('cb_capture', {}, 20000); } catch (x) { er = x; }
      this.host.style.display = 'block';
      if (er) return this.err(er);
      CB.shotEditor(shot.dataUrl, (img) => {
        const n = (e.s.artifacts || []).filter(a => a.kind === 'screenshot').length + 1;
        (e.s.artifacts = e.s.artifacts || []).push({ kind: 'screenshot', label: 'screenshot ' + n + ' - ' + new Date().toLocaleTimeString(), content: img });
        e.save();
        this.bubble('user', '📸 Screenshot attached');
        this.paintCanvas(e.s.canvas);
      }, this.shell);
    },
    smartPaste() {
      const ta = h('textarea', { class: 'in', style: 'font-family:inherit;min-height:160px', placeholder: 'Paste the error message, the console output or the email here…' });
      const out = h('div', { class: 'small muted' });
      const m = this.modal([h('h2', { style: 'margin-top:0' }, 'Fill in from pasted text'), h('div', { class: 'sub' }, 'I only take over what is literally in the text: links, matching options, the error itself' + (this.engine.s.nano ? ', and with Gemini Nano the other answers it can find.' : '.')), ta, out,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async (ev) => {
          if (!ta.value.trim()) return; ev.currentTarget.disabled = true; out.textContent = 'Reading…';
          const r2 = await this.engine.fillFromText(ta.value);
          if (!r2.filled.length) { out.textContent = 'I could not find any of the answers in this text. Please answer the questions one by one.'; ev.currentTarget.disabled = false; return; }
          m.close();
          const labels = r2.filled.map(k => this.engine.factLabel(k)).join(', ');
          this.bubble('user', '📋 Pasted text (' + ta.value.length + ' characters)');
          this.apply(this.engine.advance('Filled in from the pasted text: ' + labels));
        } }, 'Fill in'), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'))]);
      setTimeout(() => ta.focus(), 50);
    },
    // Join an incident / say "same for me" on an open case instead of opening a new one.
    async joinInstead(kind, item, d) {
      if (!confirm(kind === 'incident' ? 'Add yourself to this incident instead of opening a new case? You will be told when it is resolved.' : 'Tell the team you have the same problem instead of opening a new case? You will be told when it is solved.')) return;
      try {
        const note = [d.summary, (d.artifacts || []).some(a => a.kind === 'screenshot') ? '(screenshot available in my draft)' : ''].filter(Boolean).join(' ').slice(0, 800);
        if (kind === 'incident') await CB.api('cb_ops', { op: 'incidentJoin', body: { incident_id: item.incident_id, join: { note } } });
        else await CB.api('cb_ops', { op: 'alsoAffected', body: { case_id: item.case_id, note } });
        this.bubble('user', kind === 'incident' ? 'This is my problem too: ' + item.title : 'Same for me: ' + item.title);
        this.bubble('bot', "Done - you're on the list. I'll let you know as soon as it is solved, so there is no need to open a separate case. 👍");
        this.engine.reset(); chrome.storage.local.remove('cb_draft2');
        this.paintCanvas(null, h('div', { class: 'card center' }, h('div', { style: 'font-size:40px' }, '👥'), h('h3', {}, 'Added to the existing report'), h('div', { class: 'sub' }, item.title), h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: () => this.show('chat', true) }, 'Start a new conversation'))));
      } catch (e) { this.err(e); }
    },
    // Printable view of a case (Print -> Save as PDF).
    printCase(c, data) {
      const esc = CB.esc, w = window.open('', '_blank'); if (!w) return this.err(new Error('The browser blocked the print window - allow pop-ups for this page.'));
      const facts = Object.entries(c.facts || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : String(v).slice(0, 2000))}</td></tr>`).join('');
      const msgs = data.messages.map(m => `<div class="m"><b>${esc(m.author || m.role)}</b> <span>${esc(this.fmt(m.ts))}</span><div>${esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('');
      const shots = data.artifacts.filter(a => a.kind === 'screenshot' && !a.remote).map(a => `<img src="${a.content}">`).join('');
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Case ${esc(c.case_id)}</title><style>body{font:13px/1.45 Segoe UI,Arial,sans-serif;color:#0F172A;margin:28px}h1{font-size:20px;margin:0}table{border-collapse:collapse;width:100%;margin:10px 0}td{border-bottom:1px solid #ddd;padding:5px 8px;vertical-align:top}td:first-child{color:#64748B;width:28%}.m{border-left:3px solid #00B14F;padding:4px 10px;margin:8px 0}.m span{color:#64748B;font-size:11px}img{max-width:100%;margin:8px 0;border:1px solid #ddd}.meta{color:#64748B;margin:4px 0 14px}</style></head><body>
        <h1>${esc(c.title)}</h1><div class="meta">${esc(c.case_id)} · ${esc(c.project_name)} · ${esc(c.status)} · priority ${esc(c.priority)} · reported by ${esc(c.reporter_name)} on ${esc(this.fmt(c.created_at))}</div>
        ${c.resolution_summary ? '<p><b>Resolution:</b> ' + esc(c.resolution_summary) + (c.root_cause ? '<br><b>Root cause:</b> ' + esc(c.root_cause) : '') + '</p>' : ''}
        <h3>Details</h3><table>${facts}</table><p>${esc(c.summary || '')}</p>${shots ? '<h3>Screenshots</h3>' + shots : ''}<h3>Conversation</h3>${msgs}
        <p style="color:#64748B;font-size:11px">Printed from CogniBuddy on ${esc(new Date().toLocaleString())}</p></body></html>`);
      w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 300);
    },
    // Manager copilot: summary, similar solved cases, matching knowledge, ready replies and a suggested reply.
    copilot(c, data, reply) {
      const nano = !!(this.engine && this.engine.nanoInfo && this.engine.nanoInfo.mode === 'ai');
      const eng = new CB.Engine(this.cat, this.user, c.page_url || ''); eng.s.projectId = c.project_id;
      const text = [c.title, c.summary, Object.values(c.facts || {}).map(v => Array.isArray(v) ? v.join(' ') : String(v).slice(0, 300)).join(' ')].join(' ');
      const kb = eng.retrieve(text, 3);
      const insert = (t) => { reply.value = (reply.value ? reply.value.trim() + '\n\n' : '') + t; reply.focus(); };
      const first = String(c.reporter_name || '').split(' ')[0] || 'there';
      const sumEl = h('div', { class: 'small' }), simEl = h('div', { class: 'small muted' }, 'Looking for similar solved cases…');
      // 1) summary
      const keyFacts = () => { const diag = data.artifacts.filter(a => a.kind === 'snippet_result').length; return `${c.title}. ${c.summary || ''} ${diag ? '(' + diag + ' diagnostic result(s) attached.)' : ''} ${data.messages.length} message(s) in the thread.`; };
      sumEl.textContent = keyFacts();
      if (data.messages.length > 2) {
        const thread = data.messages.map(m => (m.role === 'admin' ? 'Admin' : m.role === 'bot' ? 'Assistant' : 'Reporter') + ': ' + m.text).join('\n').slice(-6000);
        sumEl.textContent = 'Summarising…';
        CB.summarize({ text: thread, context: 'What is the problem, what was already tried, and what is still open?', length: 'medium' }).then(r2 => { sumEl.textContent = r2 && r2.ok ? '✨ ' + r2.value : keyFacts(); }).catch(() => { sumEl.textContent = keyFacts(); });
      }
      // 2) similar solved cases
      let similar = [];
      CB.api('cb_ops', { op: 'similarSolved', body: { project_id: c.project_id, text } }).then(list => {
        similar = (list || []).filter(x => x.case_id !== c.case_id);
        simEl.innerHTML = ''; simEl.className = 'small';
        if (!similar.length) { simEl.textContent = 'No similar solved case yet.'; simEl.className = 'small muted'; return; }
        similar.forEach(x => simEl.append(h('div', { class: 'item', style: 'cursor:default;margin:4px 0;display:block' }, h('b', {}, x.title), h('div', { class: 'muted' }, x.case_id + ' · ' + String(x.resolution_summary).slice(0, 220)), h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: () => insert(x.resolution_summary) }, 'Use this resolution'))));
      }).catch(() => { simEl.textContent = 'Similar cases are not available (gateway not updated yet).'; });
      // 3) knowledge
      const kbEl = kb.length ? kb.map(x => h('div', { class: 'item', style: 'cursor:default;margin:4px 0' }, h('div', {}, h('b', {}, x.k._sop ? '📄 ' + x.k._sop.title + ' › ' + x.k.title : x.k.title), h('div', { class: 'small muted' }, CB.voice ? CB.voice.lead(x.k.answer, text, 160) : '')),
        h('button', { class: 'btn sm', onclick: () => insert((CB.voice ? CB.voice.lead(x.k.answer, text) : x.k.answer.slice(0, 300)) + (x.k._sop ? `\n(${x.k._sop.title}, ${eng.sopWhere(x.k)}${x.k._sop.url ? ': ' + x.k._sop.url : ''})` : `\n(See the article "${x.k.title}" in CogniBuddy.)`)) }, 'Insert'))) : h('div', { class: 'small muted' }, 'No matching article.');
      // 4) ready replies of the project
      const replies = ((this.cat.automation || {})[c.project_id] || {}).replies || [];
      const ready = replies.length ? h('select', { class: 'in', onchange: (ev) => { const rr = replies[Number(ev.target.value)]; if (rr) insert(String(rr.text).replace(/\{name\}/g, first).replace(/\{case\}/g, c.case_id)); ev.target.value = ''; } }, h('option', { value: '' }, '＋ Insert a ready reply…'), replies.map((x, i) => h('option', { value: i }, x.title))) : null;
      // 5) suggested reply
      const sugg = h('button', { class: 'btn sm primary', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; b.textContent = nano ? '✨ Writing…' : 'Preparing…';
        const top = kb[0] && kb[0].k, sim = similar[0];
        let txt = '';
        if (nano) {
          const src = [top ? 'Knowledge: ' + top.title + ': ' + String(top.answer).slice(0, 1400) : '', sim ? 'A similar solved case was fixed like this: ' + sim.resolution_summary : ''].filter(Boolean).join('\n');
          try {
            const r2 = await CB.nano({ system: 'You draft replies for a support manager. Friendly, short, concrete. Use only the given knowledge; never invent steps, numbers or promises.', prompt: `Case: ${c.title}\nReporter: ${first}\nWhat they reported: ${String(c.summary || '').slice(0, 600)}\n${src || 'No documented answer is available.'}\nWrite the reply to the reporter in at most 90 words. If no documented answer is given, ask for the one detail that is missing.` });
            if (r2 && r2.ok) { const nums = (r2.value.match(/\d+(?:[.,]\d+)?/g) || []); txt = nums.every(n => src.includes(n) || String(c.summary).includes(n) || c.case_id.includes(n)) ? r2.value.trim() : ''; }
          } catch (e) {}
        }
        if (!txt) txt = `Hi ${first},\n\nthanks for reporting this.${top ? ' ' + (CB.voice ? CB.voice.lead(top.answer, text) : '') + (top._sop ? ` (${top._sop.title}, ${eng.sopWhere(top)})` : '') : ''}${sim ? '\n\nA similar case was solved like this: ' + sim.resolution_summary : ''}\n\nCould you check this and tell me if it solves it?`;
        insert(txt); b.disabled = false; b.textContent = '✍ Suggest a reply';
      } }, '✍ Suggest a reply');
      return h('div', { class: 'card copilot' }, h('h3', { style: 'margin:0' }, '🤖 Copilot'), h('div', { class: 'sub' }, nano ? 'Gemini Nano summarises and drafts; everything comes from the case, solved cases and your documents. You decide what is sent.' : 'Works without AI. With Gemini Nano active it also writes the summary and the reply.'),
        h('h4', {}, 'In short'), sumEl, h('h4', {}, 'Similar solved cases'), simEl, h('h4', {}, 'Matching knowledge'), kbEl,
        h('div', { class: 'row' }, sugg, ready));
    },
    // A solved case becomes a draft article (Gemini Nano tidies it up when active; the facts come only from the case).
    async articleFromCase(c, resolution, root) {
      let row = { kb_id: 'case-' + c.case_id.toLowerCase(), type: 'troubleshoot', title: c.title, question_variants: [c.title], symptoms: [String(c.summary || c.title).slice(0, 300)], answer: resolution + (root ? '\nRoot cause: ' + root : ''), tags: ['from-case', c.case_id] };
      if (this.engine && this.engine.nanoInfo && this.engine.nanoInfo.mode === 'ai') {
        const src = `Problem: ${c.title}. ${c.summary || ''}\nResolution: ${resolution}${root ? '\nRoot cause: ' + root : ''}`;
        try {
          const r2 = await CB.nano({ system: 'You turn solved support cases into short knowledge articles. Use only the given text.', prompt: src + '\nWrite a knowledge article: a question-style title, 3 ways a colleague would ask it, the symptoms, and the answer (what to do), max 120 words.', schema: { type: 'object', additionalProperties: false, required: ['title', 'question_variants', 'symptoms', 'answer'], properties: { title: { type: 'string' }, question_variants: { type: 'array', items: { type: 'string' } }, symptoms: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' } } } });
          const o = r2 && r2.ok ? JSON.parse(String(r2.value).match(/\{[\s\S]*\}/)[0]) : null;
          if (o && o.answer && (o.answer.match(/\d+(?:[.,]\d+)?/g) || []).every(n => src.includes(n))) row = { ...row, title: String(o.title || row.title).slice(0, 160), question_variants: [c.title].concat(o.question_variants || []).slice(0, 5), symptoms: (o.symptoms || row.symptoms).slice(0, 5), answer: o.answer };
        } catch (e) {}
      }
      const res = await CB.api('cb_draft_article', { projectId: c.project_id, row });
      return res;
    },

    // =============== CASES ===============
    caseSlaInfo(c) {
      let facts = c.facts;
      if (!facts && c.facts_json) { try { facts = JSON.parse(c.facts_json); } catch (e) {} }
      facts = facts && typeof facts === 'object' ? facts : {};
      const closed = c.status === 'Solved' || c.status === "Won't fix";
      const claimedAt = facts._claimed_at || '';
      const claimedBy = facts._claimed_by || c.assigned_to || '';
      const logs = Array.isArray(facts._inv_logs) ? facts._inv_logs : [];
      const refTs = claimedAt || c.created_at;
      const elapsedMs = Math.max(0, Date.now() - (Date.parse(refTs) || Date.now()));
      const hrs = elapsedMs / 3600000;
      if (closed) return { facts, closed: true, state: 'closed', cls: 'ok', hrs, claimedAt, claimedBy, logs, needsAction: false, label: '✅ Closed' };
      if (hrs < 24) {
        const rem = Math.max(0, 24 - hrs), hh = Math.floor(rem), mm = Math.floor((rem - hh) * 60);
        return {
          facts, closed: false, state: claimedAt ? 'active' : 'unclaimed', cls: claimedAt ? 'ok' : 'na', hrs, claimedAt, claimedBy, logs, needsAction: false,
          label: (claimedAt ? '⏱ Investigating · ' : '⏳ ') + `${hh}h ${mm}m left (24h SLA)`
        };
      }
      if (hrs < 72) {
        const hh = Math.floor(hrs), rh = Math.max(0, Math.ceil(72 - hrs));
        return {
          facts, closed: false, state: 'critical', cls: 'warn', hrs, claimedAt, claimedBy, logs, needsAction: true,
          label: `🔥 CRITICAL · ${hh}h elapsed (${rh}h to overdue)`
        };
      }
      const hh = Math.floor(hrs);
      return {
        facts, closed: false, state: 'overdue', cls: 'bad', hrs, claimedAt, claimedBy, logs, needsAction: true,
        label: `🚨 OVERDUE · ${hh}h elapsed (>72h)`
      };
    },
    async renderCases() {
      const wrap = h('div', { class: 'list' }, CB.skeleton(5));
      this.ui.body.append(wrap);
      const admin = this.isAdmin();
      let rows, home = null;
      try {
        [rows, home] = await Promise.all([
          CB.api('cb_list_cases', { mine: !admin }),
          admin ? CB.api('cb_home', {}).catch(() => null) : Promise.resolve(null)
        ]);
      } catch (e) { wrap.innerHTML = ''; wrap.append(h('div', { class: 'm sys' }, '⚠ ' + e.message)); return; }
      const pName = (pid) => { const p = (this.cat.projects || []).find(x => x.project_id === pid); return p ? p.name : pid; };
      const restricted = !!(this.engine && this.engine.isProjectRestricted && this.engine.isProjectRestricted());
      if (restricted) {
        const allowed = new Set(this.engine.userProjectIds());
        rows = rows.filter(c => !c.project_id || allowed.has(c.project_id));
      }
      const assigned = this.engine && this.engine.assignedProjects ? this.engine.assignedProjects() : [];
      const projOpts = restricted ? assigned : this.cat.projects;
      const myTasks = (home && home.myTasks) || [];
      const tasksCard = () => {
        if (!myTasks.length) return null;
        return h('div', { class: 'card', style: 'margin:0 0 12px' },
          h('div', { class: 'row', style: 'margin:0 0 8px;justify-content:space-between' },
            h('h3', { style: 'margin:0' }, `📋 My Assigned Tasks (${myTasks.length})`),
            h('button', { class: 'btn sm', onclick: () => CB.api('cb_open_workspace', {}).catch(e => this.err(e)) }, 'Open Workspace ↗')),
          myTasks.slice(0, 5).map(t => h('div', { class: 'item', style: 'padding:8px 10px', onclick: () => CB.api('cb_open_workspace', { hash: 'task/' + t.task_id }).catch(e => this.err(e)) },
            h('div', {}, h('b', {}, t.title), h('div', { class: 'small muted' }, `${pName(t.project_id)} · ${t.status}${t.due_date ? ' · due ' + t.due_date : ''}`)),
            t.priority && t.priority !== 'Normal' ? h('span', { class: 'pill warn' }, t.priority) : h('span', { class: 'pill na' }, t.status))));
      };
      const f = {
        q: h('input', { class: 'in', style: 'width:220px', placeholder: 'Search…' }),
        status: h('select', { class: 'in' }, h('option', { value: '' }, 'All statuses'), h('option', { value: '__open', selected: admin ? 'selected' : null }, 'Open only'), ['New', 'Needs info', 'Triage', 'In progress', 'Solved', "Won't fix", 'Reopened'].map(s => h('option', { value: s }, s))),
        project: h('select', { class: 'in' }, h('option', { value: '' }, 'All projects'), projOpts.map(p => h('option', { value: p.project_id }, p.name)))
      };
      const draw = () => {
        wrap.innerHTML = '';
        const tc = admin ? tasksCard() : null; if (tc) wrap.append(tc);
        if (assigned.length > 0 && (!restricted || assigned.length > 1)) {
          const pills = h('div', { class: 'row', style: 'margin:0 0 8px;flex-wrap:wrap;gap:6px' },
            h('button', { class: 'btn sm' + (!f.project.value ? ' primary' : ''), onclick: () => { f.project.value = ''; draw(); } }, `All projects (${rows.length})`),
            assigned.map(p => {
              const cnt = rows.filter(c => c.project_id === p.project_id).length;
              return h('button', { class: 'btn sm' + (f.project.value === p.project_id ? ' primary' : ''), onclick: () => { f.project.value = p.project_id; draw(); } }, `${p.icon ? p.icon + ' ' : ''}${p.name} (${cnt})`);
            }));
          wrap.append(pills);
        }
        const st = f.status.value, pr = f.project.value, q = f.q.value.toLowerCase();
        const list = rows.filter(c => (!st || (st === '__open' ? !['Solved', "Won't fix"].includes(c.status) : c.status === st)) && (!pr || c.project_id === pr) && (!q || JSON.stringify(c).toLowerCase().includes(q)));
        wrap.append(h('div', { class: 'filters' }, f.q, f.status, f.project, h('span', { class: 'muted small' }, list.length + ' case(s)')));
        if (!list.length) wrap.append(h('div', { class: 'center muted' }, 'No cases here yet.'));
        list.forEach(c => {
          const sla = this.caseSlaInfo(c);
          wrap.append(h('div', { class: 'item', onclick: () => this.renderCase(c.case_id) },
            h('div', {}, h('b', {}, c.title), h('div', { class: 'small muted' }, `${c.case_id} · ${c.project_name || c.project_id} · ${c.reporter_name || c.reporter_email} · ${this.fmt(c.updated_at)}`), h('div', { class: 'small' }, String(c.summary).slice(0, 160))),
            h('div', { style: 'text-align:right' }, this.pill(c.status), !sla.closed ? h('div', { style: 'margin-top:4px' }, h('span', { class: 'pill ' + sla.cls }, sla.label)) : null, c.priority && c.priority !== 'Normal' ? h('div', { class: 'small muted', style: 'margin-top:2px' }, c.priority) : null)));
        });
      };
      f.q.oninput = draw; f.status.onchange = draw; f.project.onchange = draw;
      draw();
    },

    async renderCase(caseId) {
      this.ui.body.innerHTML = ''; this.ui.title.textContent = 'Case ' + caseId;
      const wrap = h('div', { class: 'full' }, CB.skeleton(4)); this.ui.body.append(wrap);
      let data; try { data = await CB.api('cb_get_case', { caseId }); } catch (e) { wrap.innerHTML = ''; wrap.append('⚠ ' + e.message); return; }
      const c = data.case; const admin = this.isAdmin();
      const visibleFacts = Object.entries(c.facts || {}).filter(([k]) => !k.startsWith('_'));
      const sla = this.caseSlaInfo(c);
      wrap.innerHTML = '';
      wrap.append(h('div', { class: 'row', style: 'margin:0' }, h('button', { class: 'btn sm', onclick: () => this.show('cases') }, '← Back'), h('button', { class: 'btn sm', title: 'Print or save as PDF', onclick: () => this.printCase(c, data) }, '🖨 Print')));
      wrap.append(h('div', { class: 'card', style: 'margin-top:12px' }, h('div', { class: 'row', style: 'margin:0;justify-content:space-between' }, h('h3', { style: 'margin:0' }, c.title), this.pill(c.status)),
        h('div', { class: 'small muted' }, `${c.case_id} · ${c.project_name} · reported by ${c.reporter_name} (${c.reporter_email}) · ${this.fmt(c.created_at)} · priority ${c.priority}${c.assigned_to ? ' · assigned to ' + c.assigned_to : ''}`),
        c.page_url ? h('div', { class: 'small' }, 'Page: ', /^https?:\/\//i.test(c.page_url) ? h('a', { href: c.page_url, target: '_blank', rel: 'noopener noreferrer', style: 'color:#008F3F' }, c.page_url.slice(0, 120)) : c.page_url.slice(0, 120)) : null,
        visibleFacts.length ? h('table', { class: 't', style: 'margin-top:8px' }, visibleFacts.map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, Array.isArray(v) ? v.join(', ') : String(v).slice(0, 400))))) : null,
        c.status === 'Solved' || c.status === "Won't fix" ? h('div', { class: 'm', style: 'background:#E0F2EB;margin-top:10px;max-width:100%' }, h('b', {}, 'Resolution: '), c.resolution_summary, c.root_cause ? h('div', {}, h('b', {}, 'Root cause: '), c.root_cause) : null) : null));

      // Investigation log & 24h Critical / 72h Overdue SLA tracker
      const statusChoices = ['Investigating root cause', 'Reproduced the issue', 'Waiting on reporter / customer info', 'Waiting on engineering fix', 'Testing a workaround / fix', 'Blocked / Escalated'];
      const stDrop = h('select', { class: 'in' }, statusChoices.map(s => h('option', { value: s }, s)));
      const noteIn = h('input', { class: 'in', style: 'flex:1;min-width:200px', placeholder: 'What status / findings did you encounter?' });
      const saveLog = async (action, noteText, explicitStatus) => {
        const ts = new Date().toISOString();
        const nextFacts = { ...(c.facts || {}) };
        if (!nextFacts._claimed_at) { nextFacts._claimed_at = ts; nextFacts._claimed_by = this.user.email; }
        nextFacts._last_log_at = ts;
        nextFacts._inv_logs = (Array.isArray(nextFacts._inv_logs) ? nextFacts._inv_logs : []).concat([{ ts, by: this.user.email, action, note: noteText || '' }]).slice(-50);
        const mappedStatus = explicitStatus || (action === 'Waiting on reporter / customer info' ? 'Needs info' : (c.status === 'New' || c.status === 'Triage' || c.status === 'Needs info' ? 'In progress' : c.status));
        await CB.api('cb_update_case', { caseId, patch: { status: mappedStatus, assigned_to: c.assigned_to || this.user.email, facts_json: JSON.stringify(nextFacts) } });
        await CB.api('cb_add_message', { caseId, msg: { role: admin ? 'admin' : 'user', text: `⏱ [${action}]${noteText ? ' ' + noteText : ''}` } }).catch(() => {});
        this.renderCase(caseId);
      };
      wrap.append(h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin:0;justify-content:space-between;align-items:center' },
          h('h3', { style: 'margin:0' }, '⏱ Investigation Log & 24h / 72h SLA'),
          h('span', { class: 'pill ' + sla.cls }, sla.label)),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, sla.claimedAt
          ? `Investigation claimed ${this.fmt(sla.claimedAt)} by ${sla.claimedBy}`
          : `Not claimed yet · counting from created time (${this.fmt(c.created_at)}). Press "Claim & Start Investigating" when you begin working it.`),
        sla.needsAction ? h('div', { style: sla.state === 'overdue'
          ? 'background:#FEE2E2;border:1px solid #EF4444;color:#991B1B;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px'
          : 'background:#FEF3C7;border:1px solid #F59E0B;color:#92400E;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px' },
          sla.state === 'overdue'
            ? '🚨 Overdue (>72h): Please log the current status encountered below or submit a final resolution for this case.'
            : '🔥 Critical (>24h): Past the 24-hour target. Log what status you encountered or give a resolution before 72h overdue.') : null,
        !sla.closed ? h('div', { style: 'margin-top:10px' },
          !sla.claimedAt ? h('div', { class: 'row', style: 'margin:0 0 8px' },
            h('button', { class: 'btn primary', onclick: (ev) => { ev.currentTarget.disabled = true; saveLog('Started investigating', 'Claimed investigation — 24h SLA countdown started.', 'In progress').catch(e => { ev.currentTarget.disabled = false; this.err(e); }); } }, '🔍 Claim & Start Investigating')) : null,
          h('div', { class: 'row', style: 'margin:0;flex-wrap:wrap;gap:6px' },
            stDrop, noteIn,
            h('button', { class: 'btn', onclick: (ev) => { ev.currentTarget.disabled = true; saveLog(stDrop.value, noteIn.value.trim()).catch(e => { ev.currentTarget.disabled = false; this.err(e); }); } }, '📝 Log status'),
            h('button', { class: 'btn primary', onclick: () => this.resolveModal(c) }, '✅ Give Resolution…'))) : null,
        sla.logs.length ? h('div', { style: 'margin-top:12px;border-top:1px solid #E2E8F0;padding-top:8px' },
          h('div', { class: 'small muted', style: 'margin-bottom:4px;font-weight:600' }, `Activity timeline (${sla.logs.length})`),
          sla.logs.slice().reverse().map(l => h('div', { class: 'small', style: 'padding:4px 0;border-bottom:1px dashed #E2E8F0' },
            h('b', {}, l.action), l.note ? ' — ' + l.note : '',
            h('span', { class: 'muted' }, ` · ${l.by} · ${this.fmt(l.ts)}`)))) : h('div', { class: 'small muted', style: 'margin-top:8px' }, 'No investigation logs recorded yet.')));

      // audit conclusion (project module): verdict + ranked findings + proposals, from the evidence artifact and the check results
      const amod = CB.moduleFor(c.project_id), au = amod && amod.audit;
      if (au) {
        const holder = h('div', {});
        const jsonArt = data.artifacts.find(a => au.isEvidence(a));
        const draw = (text) => {
          holder.innerHTML = '';
          const a = au.fromCase(c.facts || {}, data.artifacts, text);
          if (jsonArt && jsonArt.remote && !text) holder.append(h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin:0' }, h('span', { class: 'small' }, au.remoteNote),
            h('button', { class: 'btn sm primary', onclick: async () => { try { const r = await CB.api('cb_get_artifact', { artifactId: jsonArt.artifact_id, caseId }); draw(r.content); } catch (e) { this.err(e); } } }, au.loadLabel))));
          holder.append(CB.renderAudit(a, { admin: this.isAdmin(), onSend: this.isAdmin() ? (p) => this.sendProposal(c, p) : null }));
        };
        draw();
        wrap.append(holder);
      }

      // diagnostics board: pass/fail per console check, built from the attached snippet results
      const diag = data.artifacts.filter(a => a.kind === 'snippet_result').map(a => {
        const id = String(a.label || '').split(':')[0].trim();
        const sn = this.cat.snippets.find(s => s.snippet_id === id) || {};
        let o = null; if (!a.remote) { try { o = JSON.parse(a.content); } catch (e) {} }
        if (o && (typeof o !== 'object' || Array.isArray(o))) o = null;
        return { a, id, sn, o, order: sn.order || 999, title: sn.title || String(a.label || '').replace(/^[^:]*:\s*/, ''), layer: (o && o.layer) || sn.layer || '' };
      }).sort((x, y) => x.order - y.order);
      if (diag.length) {
        const st = (d) => !d.o ? { c: 'na', t: d.a.remote ? 'in Drive' : 'raw output' } : d.o.pass === true ? { c: 'ok', t: 'PASS' } : d.o.pass === false ? { c: 'bad', t: 'FAIL' } : { c: 'warn', t: 'inconclusive' };
        const cnt = { ok: 0, bad: 0, warn: 0, na: 0 }; diag.forEach(d => cnt[st(d).c]++);
        const rank = { bad: 0, warn: 1, na: 2, ok: 3 };
        wrap.append(h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin:0;justify-content:space-between' }, h('h3', { style: 'margin:0' }, 'Diagnostics'),
            h('div', {}, h('span', { class: 'pill bad' }, cnt.bad + ' failed'), ' ', h('span', { class: 'pill warn' }, cnt.warn + ' inconclusive'), ' ', h('span', { class: 'pill ok' }, cnt.ok + ' passed'))),
          h('div', { class: 'sub' }, 'Results of the console checks the reporter ran. Failed and inconclusive checks are listed first.'),
          h('table', { class: 't' }, h('tr', {}, ['Layer', 'Check', 'Status', 'What it found'].map(x => h('th', {}, x))),
            diag.slice().sort((x, y) => rank[st(x).c] - rank[st(y).c] || x.order - y.order).map(d => {
              const s = st(d);
              const extra = d.o ? Object.fromEntries(Object.entries(d.o).filter(([k]) => !['layer', 'pass', 'summary'].includes(k))) : null;
              return h('tr', {}, h('td', {}, h('b', {}, d.layer || '-')), h('td', {}, d.title), h('td', {}, h('span', { class: 'pill ' + s.c }, s.t)),
                h('td', {}, h('div', {}, d.o && d.o.summary ? d.o.summary : (d.a.remote ? 'Large output stored in Drive - see Attachments below.' : String(d.a.content).slice(0, 200))),
                  extra && Object.keys(extra).length ? h('details', {}, h('summary', { class: 'small muted' }, 'details'), h('pre', { class: 'code' }, JSON.stringify(extra, null, 1).slice(0, 6000))) : null));
            }))));
      }

      // screenshots
      const shots = data.artifacts.filter(a => a.kind === 'screenshot');
      if (shots.length) wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Screenshots (' + shots.length + ')'), h('div', { class: 'shots' }, shots.map(a => {
        const box = h('div', { class: 'shot', style: 'width:220px;height:140px;cursor:zoom-in' });
        // Only real image data is shown, and the full-size view is built with DOM calls (never written as HTML into the page's origin).
        const show = (src) => { box.innerHTML = ''; if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(src))) { box.append(h('div', { class: 'small muted' }, 'Not an image.')); return; } box.append(h('img', { src, alt: a.label, onclick: () => { const w = window.open(); if (w) { const im = w.document.createElement('img'); im.src = src; im.style.maxWidth = '100%'; w.document.body.append(im); } } })); };
        if (!a.remote) show(a.content); else box.append(h('button', { class: 'btn sm', style: 'margin:50px auto;display:block', onclick: async () => { try { const r2 = await CB.api('cb_get_artifact', { artifactId: a.artifact_id, caseId }); show(r2.content); } catch (e) { this.err(e); } } }, 'Load'));
        return box;
      }))));

      // artifacts
      if (data.artifacts.length) wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Attachments (' + data.artifacts.length + ')'),
        data.artifacts.map(a => {
          let full = a.content; // remote (Drive-stored) artifacts are fetched on demand
          const pre = h('pre', { class: 'code' }, a.remote ? '(stored as a file in Drive - press "Load")' : full.slice(0, 20000) + (full.length > 20000 ? '\n…(use Copy/Download for the full content)' : ''));
          const ensure = async () => {
            if (full || !a.remote) return full;
            pre.textContent = 'Loading from Drive…';
            const r = await CB.api('cb_get_artifact', { artifactId: a.artifact_id, caseId });
            full = r.content; pre.textContent = full.slice(0, 20000) + (full.length > 20000 ? '\n…(showing first 20,000 characters; use Copy/Download for everything)' : '');
            return full;
          };
          return h('details', { style: 'margin:6px 0' }, h('summary', {}, `${a.label} · ${a.kind} · ${(a.remote ? a.size : a.content.length)} chars${a.remote ? ' · Drive file' : ''}`),
            h('div', { class: 'row' },
              a.remote ? h('button', { class: 'btn sm', onclick: () => ensure().catch(e => this.err(e)) }, 'Load') : null,
              h('button', { class: 'btn sm', onclick: async () => { try { navigator.clipboard.writeText(await ensure()); } catch (e) { this.err(e); } } }, 'Copy'),
              h('button', { class: 'btn sm', onclick: async () => { try { const t = await ensure(); let ext = '.txt'; try { JSON.parse(t); ext = '.json'; } catch (e) {} const u = URL.createObjectURL(new Blob([t], { type: 'text/plain' })); const l = document.createElement('a'); l.href = u; l.download = (a.label || 'artifact').replace(/[^\w.-]+/g, '_') + ext; l.click(); URL.revokeObjectURL(u); } catch (e) { this.err(e); } } }, 'Download')),
            pre);
        })));

      // thread
      const thread = h('div', { class: 'card' }, h('h3', {}, 'Conversation'));
      const pmod = CB.moduleFor(c.project_id); // read-only stand-in for the engine when a reporter re-runs a check from the thread
      const pseudo = { cat: this.cat, s: { facts: c.facts || {} }, ctx: {}, pageUrl: this.pageUrl, module: pmod, suppliedKeys: () => (pmod && pmod.supplied) || [] };
      data.messages.forEach(m => {
        const role = m.role === 'bot' ? 'bot' : m.role === 'admin' ? 'admin' : 'user';
        thread.append(h('div', { class: 'm ' + role, style: 'max-width:100%;margin-bottom:8px' }, h('div', { class: 'small muted' }, `${m.author || m.role} · ${this.fmt(m.ts)}`), h('div', { html: CB.md(m.text).replace(/\n/g, '<br>') })));
        if (m.widget && m.widget.widget === 'snippet' && !admin) {
          thread.append(CB.renderCanvas(m.widget, { engine: pseudo, pageUrl: this.pageUrl, peek: (s, l) => this.peek(s, l), unpeek: () => this.unpeek(), onSkipSnippet: () => {}, onSnippetResult: async (sn, text) => { try { await CB.api('cb_add_artifact', { caseId, kind: 'snippet_result', label: `${sn.snippet_id}: ${sn.title}`, content: text }); await CB.api('cb_add_message', { caseId, msg: { role: 'user', text: `Result for "${sn.title}" attached (${text.length} chars).` } }); this.renderCase(caseId); } catch (e) { this.err(e); } } }));
        } else if (m.widget && m.widget.widget === 'snippet') thread.append(h('div', { class: 'small muted' }, '↳ asked the reporter to run snippet ' + m.widget.snippetId));
      });
      wrap.append(thread);

      // reply box
      const reply = h('textarea', { class: 'in', style: 'font-family:inherit;min-height:70px', placeholder: admin ? 'Message to the reporter…' : 'Add information or answer the admin…' });
      const snSel = admin ? h('select', { class: 'in' }, h('option', { value: '' }, '＋ attach a diagnostic to run…'), this.cat.snippets.filter(s => !c.project_id || s.project_id === c.project_id || s.project_id === 'all').map(s => h('option', { value: s.snippet_id }, `${s.layer || ''} ${s.title}`))) : null;
      const post = async (needsInfo) => {
        const text = reply.value.trim(); if (!text && !(snSel && snSel.value)) return;
        try {
          const msg = { role: admin ? 'admin' : 'user', text: text || 'Please run the attached diagnostic.' };
          if (snSel && snSel.value) msg.widget = { widget: 'snippet', snippetId: snSel.value };
          await CB.api('cb_add_message', { caseId, msg });
          if (admin && needsInfo) await CB.api('cb_update_case', { caseId, patch: { status: 'Needs info' } });
          if (!admin && c.status === 'Needs info') await CB.api('cb_update_case', { caseId, patch: { status: 'Triage' } }).catch(() => {});
          this.renderCase(caseId);
        } catch (e) { this.err(e); }
      };
      if (admin && this.inScope(c.project_id)) wrap.append(this.copilot(c, data, reply));
      wrap.append(h('div', { class: 'card' }, reply, snSel ? h('div', { class: 'row' }, snSel) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => post(true) }, admin ? 'Send & request info' : 'Send'), admin ? h('button', { class: 'btn', onclick: () => post(false) }, 'Send (keep status)') : null)));

      // admin controls
      if (admin) {
        const st = h('select', { class: 'in' }, ['New', 'Needs info', 'Triage', 'In progress', 'Reopened'].map(s => h('option', { selected: s === c.status ? 'selected' : null }, s)));
        wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Admin actions'), h('div', { class: 'row' }, st,
          h('button', { class: 'btn', onclick: async () => { try { await CB.api('cb_update_case', { caseId, patch: { status: st.value } }); this.renderCase(caseId); } catch (e) { this.err(e); } } }, 'Set status'),
          h('button', { class: 'btn', onclick: async () => { try { await CB.api('cb_update_case', { caseId, patch: { assigned_to: this.user.email, status: c.status === 'New' ? 'In progress' : c.status } }); this.renderCase(caseId); } catch (e) { this.err(e); } } }, 'Assign to me'),
          h('button', { class: 'btn primary', onclick: () => this.resolveModal(c) }, '✅ Resolve…'),
          c.project_id && this.inScope(c.project_id) ? h('button', { class: 'btn', title: 'Put this case on the project board so the team can work on it', onclick: async () => {
            try { const t = await CB.api('cb_task_save', { task: { project_id: c.project_id, title: c.title, description: `From case ${c.case_id} (reported by ${c.reporter_name}).\n${c.summary || ''}`, status: 'todo', priority: c.priority === 'Blocker' ? 'Urgent' : c.priority === 'High' ? 'High' : 'Normal', case_id: c.case_id } });
              await CB.api('cb_add_message', { caseId: c.case_id, msg: { role: 'admin', text: `Added to the project board as task ${t.task_id}.` } }).catch(() => {});
              CB.api('cb_open_workspace', { hash: 'task/' + t.task_id }); } catch (e) { this.err(e); }
          } }, '🗂 Create a board task') : null)));
      } else if ((c.status === 'Solved' || c.status === "Won't fix") && !c.ack_at) this.resolutionModal(c);
    },
    async sendProposal(c, p) {
      const msg = `Send this selector to Iris's live Nano_Brain?\n\n${p.domain} / ${p.type} / ${p.field}\n${p.selector}\n\nThis OVERWRITES the first Nano_Brain row with the same Domain/Type/Field for every user (confidence +5). Prefer "Copy Trainer JSON" if unsure. Continue?`;
      if (!confirm(msg)) return;
      try {
        const r = await CB.api('cb_heal_send', { proposal: p });
        const ok = r && String(r.status).toUpperCase() === 'OK';
        await CB.api('cb_add_message', { caseId: c.case_id, msg: { role: 'admin', text: `Selector proposal sent to Nano_Brain (${p.domain}/${p.type}/${p.field}): ${ok ? 'OK' : 'FAILED'} - ${r && r.message ? r.message : ''}` } });
        const m = this.modal([h('h2', { style: 'margin-top:0' }, ok ? '✅ Sent to Nano_Brain' : '⚠ Iris answered with a problem'), h('div', { class: 'small muted' }, r && r.message), h('pre', { class: 'code' }, JSON.stringify(r, null, 1).slice(0, 3000)), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { m.close(); this.renderCase(c.case_id); } }, 'Close'))]);
      } catch (e) { this.err(e); }
    },
    resolveModal(c) {
      const sum = h('textarea', { class: 'in', style: 'font-family:inherit;min-height:110px', placeholder: 'Resolution summary - what was wrong and what was done (the reporter will see this).' });
      const root = h('input', { class: 'in', placeholder: 'Root cause (short)' });
      const st = h('select', { class: 'in' }, h('option', {}, 'Solved'), h('option', {}, "Won't fix"));
      const canDoc = c.project_id && c.project_id !== 'generic' && this.inScope(c.project_id);
      const art = h('input', { type: 'checkbox' }); art.checked = !!canDoc;
      const m = this.modal([h('h2', { style: 'margin-top:0' }, 'Resolve ' + c.case_id), sum, h('div', { style: 'height:8px' }), root, h('div', { style: 'height:8px' }), st,
        canDoc ? h('label', { class: 'small', style: 'display:flex;gap:8px;align-items:center;margin-top:10px' }, art, 'Also draft a knowledge article from this case (you publish it in the Studio)') : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
          if (!sum.value.trim()) return;
          try {
            await CB.api('cb_resolve', { caseId: c.case_id, data: { status: st.value, resolution_summary: sum.value.trim(), root_cause: root.value.trim() } });
            if (!this.isAdmin()) await CB.api('cb_ack', { caseId: c.case_id }).catch(() => {});
            if (canDoc && art.checked && st.value === 'Solved') { try { await this.articleFromCase(c, sum.value.trim(), root.value.trim()); CB.api('cb_add_message', { caseId: c.case_id, msg: { role: 'admin', text: 'A draft knowledge article was created from this case.' } }).catch(() => {}); } catch (e) { this.err(new Error('Resolved, but the draft article could not be saved: ' + e.message)); } }
            m.close(); this.renderCase(c.case_id);
          } catch (e) { this.err(e); }
        } }, 'Resolve & notify reporter'), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'))]);
    },

    // =============== ADMIN ===============
    async renderAdmin(tab) {
      this.ui.body.innerHTML = '';
      const wrap = h('div', { class: 'full' });
      const tabs = h('div', { class: 'tabs' }, [['users', 'Users'], ['projects', 'Projects'], ['kb', 'Knowledge base'], ['snippets', 'Snippets'], ['setup', 'Setup']].filter(([k]) => k !== 'users' || this.isFull()).map(([k, l]) => h('button', { class: 'tab' + (k === tab ? ' on' : ''), onclick: () => this.renderAdmin(k) }, l)));
      const myProjs = (this.cat.projects || []).filter(p => p.project_id && p.project_id !== 'generic' && this.inScope(p.project_id));
      const firstPid = myProjs[0] ? myProjs[0].project_id : '';
      if (!this.isFull()) wrap.append(h('div', { class: 'small muted', style: 'margin-bottom:10px' }, myProjs.length ? 'You manage: ' + myProjs.map(p => p.name).join(', ') + '. You see and edit only these projects.' : 'You are a manager without a project yet. A SuperAdmin assigns your projects.'));
      wrap.append(h('div', { class: 'card studio-cta' },
        h('div', {}, h('h3', {}, '🎛 Manager Hub & Studio'), h('div', { class: 'sub', style: 'margin:0' }, 'Jump straight to your project knowledge, feedback training review, workflows, task boards, or preview as an Agent.')),
        h('div', { class: 'row', style: 'margin:0;flex-wrap:wrap;gap:6px' },
          h('button', { class: 'btn primary', onclick: () => CB.api('cb_open_studio', { projectId: firstPid }).catch(e => this.err(e)) }, '🎛 Open Studio ↗'),
          h('button', { class: 'btn', onclick: () => CB.api('cb_open_studio', { projectId: firstPid, view: 'knowledge' }).catch(e => this.err(e)) }, '💡 Knowledge'),
          h('button', { class: 'btn', onclick: () => CB.api('cb_open_studio', { projectId: firstPid, view: 'review' }).catch(e => this.err(e)) }, '📊 Training review'),
          h('button', { class: 'btn', onclick: () => CB.api('cb_open_workspace', {}).catch(e => this.err(e)) }, '🗂 Project boards ↗'),
          h('button', { class: 'btn', onclick: () => this.openAgentPreviewModal() }, '👁 Preview as Agent'))));
      if (myProjs.length) {
        const pSel = h('select', { class: 'in' }, myProjs.map(p => h('option', { value: p.project_id }, p.name)));
        const nTxt = h('input', { class: 'in', style: 'flex:1;min-width:220px', placeholder: 'e.g. New Wolt menu layout today — use the updated Price check' });
        const expSel = h('select', { class: 'in' }, [['', 'No expiry'], ['24h', 'Expires in 24h'], ['72h', 'Expires in 3 days'], ['7d', 'Expires in 7 days']].map(([v, l]) => h('option', { value: v }, l)));
        const nStatus = h('span', { class: 'small muted' });
        const loadCurNotice = () => {
          const cur = (this.cat.automation && this.cat.automation[pSel.value] && this.cat.automation[pSel.value].notice) || null;
          nTxt.value = (cur && cur.text) || '';
          nStatus.textContent = cur && cur.text ? (cur.expires_at ? 'Active until ' + String(cur.expires_at).slice(0, 10) : 'Active') : '';
        };
        pSel.addEventListener('change', loadCurNotice);
        loadCurNotice();
        wrap.append(h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin:0 0 6px;justify-content:space-between' }, h('h3', { style: 'margin:0' }, '📢 Project Notice Banner'), nStatus),
          h('div', { class: 'sub' }, 'Post a lightweight tip at the top of that project\'s Assistant chat without filing an outage incident.'),
          h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
            pSel, nTxt, expSel,
            h('button', { class: 'btn sm primary', onclick: async (ev) => {
              const t = nTxt.value.trim(); if (!t) return;
              const hrs = { '24h': 24, '72h': 72, '7d': 168 }[expSel.value] || 0;
              const b = ev.currentTarget; b.disabled = true; nStatus.textContent = 'Publishing…';
              try {
                await this.saveProjectNotice(pSel.value, { text: t, expires_at: hrs ? new Date(Date.now() + hrs * 3600000).toISOString() : '', updated_by: this.user.email, updated_at: new Date().toISOString() });
                loadCurNotice(); nStatus.textContent = 'Published ✓';
              } catch (e) { this.err(e); nStatus.textContent = ''; }
              b.disabled = false;
            } }, '📌 Post Notice'),
            h('button', { class: 'btn sm', onclick: async (ev) => {
              const b = ev.currentTarget; b.disabled = true; nStatus.textContent = 'Clearing…';
              try { await this.saveProjectNotice(pSel.value, null); nTxt.value = ''; nStatus.textContent = 'Cleared'; } catch (e) { this.err(e); nStatus.textContent = ''; }
              b.disabled = false;
            } }, 'Clear'))));
      }
      wrap.append(tabs); this.ui.body.append(wrap);
      try {
        if (tab === 'users') await this.adminUsers(wrap);
        else if (tab === 'setup') this.adminSetup(wrap);
        else await this.adminCatalog(wrap, { projects: 'Projects', kb: 'KnowledgeBase', snippets: 'Snippets' }[tab], tab);
      } catch (e) { wrap.append(h('div', { class: 'm sys' }, '⚠ ' + e.message)); }
    },
    async adminUsers(wrap) {
      const users = await CB.api('cb_list_users');
      const allProjs = (this.cat.projects || []).filter(p => p.project_id && p.project_id !== 'generic');
      const parseList = (v) => String(v || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      const chipStyle = (on) => `padding:3px 9px;border-radius:99px;border:1px solid ${on ? '#008F3F' : '#CBD5E1'};background:${on ? '#E6F4EA' : '#FFF'};color:${on ? '#006B2F' : '#334155'};font-size:12px;cursor:pointer;font-weight:${on ? '600' : '400'}`;
      const makePicker = (initial, onChange) => {
        const sel = new Set(parseList(initial));
        const box = h('div', { class: 'row', style: 'margin:4px 0;flex-wrap:wrap;gap:5px' });
        const redraw = () => {
          box.innerHTML = '';
          box.append(h('button', { type: 'button', style: chipStyle(sel.has('*')), title: 'All current and future projects', onclick: () => { if (sel.has('*')) sel.delete('*'); else { sel.clear(); sel.add('*'); } redraw(); onChange([...sel]); } }, 'All projects (*)'));
          allProjs.forEach(p => {
            box.append(h('button', { type: 'button', style: chipStyle(sel.has(p.project_id)), onclick: () => { sel.delete('*'); if (sel.has(p.project_id)) sel.delete(p.project_id); else sel.add(p.project_id); redraw(); onChange([...sel]); } }, p.name));
          });
        };
        redraw();
        return box;
      };
      const emailsIn = h('textarea', { class: 'in', placeholder: 'One email or paste multiple emails (comma, space, or newline separated)\ne.g.\nalice@cognizant.com\nbob@cognizant.com', style: 'min-height:60px;width:100%' });
      const name = h('input', { class: 'in', placeholder: 'Name (for single user)', style: 'width:180px' });
      const role = h('select', { class: 'in' }, ['Agent', 'Manager', 'SuperAdmin'].map(r => h('option', {}, r)));
      let picked = [];
      wrap.append(h('div', { class: 'card' },
        h('h3', {}, 'Add or bulk-assign users'),
        h('div', { class: 'sub' }, 'Paste 1 or up to 50+ emails, choose a role, and select one or multiple projects below. Agents only see their assigned projects.'),
        emailsIn,
        h('div', { class: 'row', style: 'margin-top:8px' }, name, role),
        h('div', { class: 'small muted', style: 'margin-top:6px' }, 'Assigned projects:'),
        makePicker('', v => { picked = v; }),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async (ev) => {
          const parsed = [...new Set(emailsIn.value.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
          if (!parsed.length) return this.err(new Error('Enter at least one valid email address.'));
          const b = ev.currentTarget; b.disabled = true;
          try {
            const list = parsed.map(em => ({ email: em, name: parsed.length === 1 && name.value.trim() ? name.value.trim() : em.split('@')[0], role: role.value, status: 'Active', projects: picked.join(',') }));
            if (list.length === 1) await CB.api('cb_upsert_user', { user: list[0] });
            else await CB.api('cb_bulk_upsert_users', { users: list });
            this.renderAdmin('users');
          } catch (e) { b.disabled = false; this.err(e); }
        } }, 'Save / Assign'))));
      const tbl = h('table', { class: 't' }, h('tr', {}, ['User', 'Role', 'Projects', 'Status', ''].map(x => h('th', {}, x))));
      users.forEach(u => {
        const projCell = h('td', { class: 'small' });
        const roleCell = h('td', {});
        const actCell = h('td', {});
        const showView = () => {
          const plist = parseList(u.projects);
          const pLabel = plist.includes('*') ? 'all' : plist.length ? plist.map(id => { const p = allProjs.find(x => x.project_id === id); return p ? p.name : id; }).join(', ') : ((u.role === 'Admin' || u.role === 'SuperAdmin') ? 'all' : '-');
          roleCell.textContent = u.role === 'Admin' ? 'Manager (all projects)' : u.role;
          projCell.textContent = pLabel;
          actCell.innerHTML = '';
          actCell.append(h('div', { class: 'row', style: 'margin:0;gap:4px' },
            h('button', { class: 'btn sm', onclick: () => showEdit() }, 'Edit'),
            h('button', { class: 'btn sm', onclick: async () => { try { await CB.api('cb_upsert_user', { user: { ...u, status: u.status === 'Active' ? 'Inactive' : 'Active' } }); this.renderAdmin('users'); } catch (e) { this.err(e); } } }, u.status === 'Active' ? 'Deactivate' : 'Activate')));
        };
        const showEdit = () => {
          let eProjs = String(u.projects || '');
          const rSel = h('select', { class: 'in' }, ['Agent', 'Manager', 'Admin', 'SuperAdmin'].map(r => h('option', { value: r, selected: r === u.role ? 'selected' : null }, r === 'Admin' ? 'Manager (all)' : r)));
          roleCell.innerHTML = ''; roleCell.append(rSel);
          projCell.innerHTML = ''; projCell.append(makePicker(eProjs, v => { eProjs = v.join(','); }));
          actCell.innerHTML = '';
          actCell.append(h('div', { class: 'row', style: 'margin:0;gap:4px' },
            h('button', { class: 'btn sm primary', onclick: async () => { try { await CB.api('cb_upsert_user', { user: { ...u, role: rSel.value, projects: eProjs } }); this.renderAdmin('users'); } catch (e) { this.err(e); } } }, 'Save'),
            h('button', { class: 'btn sm', onclick: () => showView() }, 'Cancel')));
        };
        showView();
        tbl.append(h('tr', {}, h('td', {}, h('b', {}, u.name || u.email), h('div', { class: 'small muted' }, u.email)), roleCell, projCell, h('td', {}, u.status), actCell));
      });
      wrap.append(h('div', { class: 'card' }, tbl));
    },
    async adminCatalog(wrap, tabName, key) {
      const cat = await CB.api('cb_catalog', { force: true });
      const raw = { projects: cat.projects.map(p => ({ ...p, required_facts: JSON.stringify(p.required_facts), url_patterns: p.url_patterns.join(', '), keywords: p.keywords.join(', ') })), kb: cat.kb, snippets: cat.snippets.map(s => ({ ...s, params: JSON.stringify(s.params), auto_offer: s.offer })) }[key];
      const titleOf = (r) => r.title || r.name;
      const mine = raw.filter(r => this.inScope(r.project_id)); raw.length = 0; mine.forEach(r => raw.push(r)); // managers: only their projects
      wrap.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, key === 'projects' && !this.isFull() ? null : h('button', { class: 'btn primary', onclick: () => this.rowEditor(tabName, {}, key) }, '＋ New'), h('span', { class: 'muted small' }, raw.length + ' row(s). Changes apply to everyone within ~5 minutes (catalog cache).')));
      raw.forEach(r => wrap.append(h('div', { class: 'item', onclick: () => this.rowEditor(tabName, r, key) }, h('div', {}, h('b', {}, titleOf(r)), h('div', { class: 'small muted' }, [r[KEY[tabName]], r.project_id, r.type, r.layer].filter(Boolean).join(' · ')))), h('span', { class: 'small muted' }, 'edit')));
    },
    rowEditor(tabName, row, key) {
      const cols = COLS[tabName]; const inputs = {};
      const form = cols.map(c => { const long = ['answer', 'code', 'question_variants', 'symptoms', 'description', 'required_facts', 'system_hint', 'expected_output'].includes(c); const el = long ? h('textarea', { class: 'in', style: 'min-height:' + (c === 'code' || c === 'answer' ? '180px' : '70px') }) : h('input', { class: 'in' }); el.value = row[c] === undefined ? '' : row[c]; inputs[c] = el; return h('label', { class: 'small muted', style: 'display:block;margin-top:8px' }, c, el); });
      const m = this.modal([h('h2', { style: 'margin-top:0' }, (row[KEY[tabName]] ? 'Edit ' : 'New ') + tabName), form, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        const o = {}; cols.forEach(c => (o[c] = inputs[c].value)); if (!o[KEY[tabName]]) { this.err(new Error('ID required')); return; }
        if (tabName === 'Projects') { try { JSON.parse(o.required_facts || '[]'); } catch (e) { this.err(new Error('required_facts must be valid JSON')); return; } }
        try { await CB.api('cb_upsert_row', { tab: tabName, row: o }); m.close(); this.cat = await CB.api('cb_catalog', { force: true }); this.engine.cat = this.cat; this.renderAdmin(key); } catch (e) { this.err(e); }
      } }, 'Save'), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'))]);
    },
    adminSetup(wrap) {
      const out = h('div', { class: 'small muted' });
      if (this.isFull()) wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Knowledge seed'), h('div', { class: 'sub' }, 'Adds the bundled Projects / Knowledge base / Snippets (Iris + generic intake) to the sheet. Existing rows are never overwritten.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: async () => { out.textContent = 'Importing…'; try { const r = await CB.api('cb_import_seed', {}); out.textContent = 'Added: ' + JSON.stringify(r); } catch (e) { out.textContent = '⚠ ' + e.message; } } }, 'Import seed data'),
          h('button', { class: 'btn warn', title: 'Overwrites Projects and Snippets with the versions bundled in this extension (use after updating the extension). Knowledge base rows are never overwritten.', onclick: async () => { if (!confirm('Overwrite the Projects and Snippets rows with the bundled versions? Your edits to those rows will be lost.')) return; out.textContent = 'Syncing…'; try { const r = await CB.api('cb_import_seed', { overwrite: true }); out.textContent = 'Synced: ' + JSON.stringify(r); } catch (e) { out.textContent = '⚠ ' + e.message; } } }, 'Re-sync Projects & Snippets (overwrite)')), out));
      const pv = h('input', { type: 'checkbox' }); pv.checked = this.preview;
      pv.addEventListener('change', () => { this.preview = pv.checked; this.engine = null; chrome.storage.local.remove('cb_draft2'); this.view = 'chat'; this.start(); });
      const demoOut = h('div', { class: 'small muted' });
      wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Content from the Studio'),
        h('label', { class: 'small', style: 'display:flex;gap:8px;align-items:center' }, pv, 'Preview my unpublished drafts in this assistant (only I see them; reopens the chat)'),
        !this.isFull() ? null : h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { if (!confirm('Add the demo project "Demo Helpdesk" (a workflow, tools, a playbook and an SOP) so you can try every feature? It is published for everyone until you archive it.')) return; demoOut.textContent = 'Installing…'; try { const r = await CB.api('cb_import_demo'); this.cat = await CB.api('cb_catalog', { force: true, drafts: this.preview }); this.engine.cat = this.cat; demoOut.textContent = 'Installed ' + r.files + ' file(s). Start a new chat and pick "Demo Helpdesk".'; } catch (e) { demoOut.textContent = '⚠ ' + e.message + (/BAD_OP/.test(e.message) ? ' - redeploy setup/Api.gs first.' : ''); } } }, 'Install the demo project'),
          h('button', { class: 'btn', onclick: async () => { if (!confirm('Add the project "Company laptop issues"? It brings knowledge and guided checks for slow laptops, frozen apps, bad internet and Teams problems, published for everyone.\n\nAs SuperAdmin, installing it also approves its PowerShell / cmd commands exactly as they are shipped (you can read them in Studio → Tools & playbooks). If anyone edits a command later, it is hidden again until you approve it again.')) return; demoOut.textContent = 'Installing…'; try { const r = await CB.api('cb_import_demo', { pack: 'laptop' }); this.cat = await CB.api('cb_catalog', { force: true, drafts: this.preview }); this.engine.cat = this.cat; demoOut.textContent = 'Installed ' + r.files + ' file(s). ' + (r.approved ? r.approved + ' command(s) approved as shipped. Read them in Studio → Tools & playbooks.' : 'Next: a SuperAdmin approves each command in Studio → Tools & playbooks (the Admin role cannot).') + ''; } catch (e) { demoOut.textContent = '⚠ ' + e.message; } } }, 'Install "Company laptop issues"')), demoOut,
        (this.cat.contentErrors || []).length ? h('div', { class: 'small', style: 'color:#B25E00;margin-top:8px' }, 'Content files with problems: ' + this.cat.contentErrors.map(x => x.path + ' (' + x.error + ')').join('; ')) : null));
      if (this.isFull() && CB.platform) wrap.append(h('div', { class: 'card' }, h('h3', {}, '⚙️ Platform settings'), h('div', { class: 'sub' }, 'For all agents: the AI model (Gemini Nano or a cloud model), the local copy and sync, the nightly archive and the NDJSON mirror, and where the time goes.'),
        h('button', { class: 'btn primary', onclick: () => this.show('platform') }, 'Open Platform settings')));
      if (this.isFull() && CB.prod) wrap.append(h('div', { class: 'card' }, h('h3', {}, '📈 Production'), h('div', { class: 'sub' }, 'Connect the Production and Attendance sheets (work queue, clock, utilization, dashboard), set the targets and match people.'),
        h('button', { class: 'btn primary', onclick: () => CB.prod.openView(this, 'settings') }, 'Open Production settings')));
      wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Session'), h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { await CB.api('cb_logout'); this.start(); } }, 'Sign out'),
        h('button', { class: 'btn', onclick: async () => { this.cat = await CB.api('cb_catalog', { force: true, drafts: this.preview }); this.engine.cat = this.cat; out.textContent = 'Catalog reloaded.'; } }, 'Reload catalog'))));
      if (this.boot.mock) {
        const role = h('select', { class: 'in' }, ['Agent', 'Manager', 'Admin', 'SuperAdmin'].map(r => h('option', { selected: r === this.user.role ? 'selected' : null }, r)));
        const mail = h('input', { class: 'in', value: this.user.email });
        const allProjs = (this.cat.projects || []).filter(p => p.project_id && p.project_id !== 'generic');
        const sel = new Set(Array.isArray(this.user.projects) ? this.user.projects : String(this.user.projects || '').split(/[\s,;]+/).filter(Boolean));
        const chipStyle = (on) => `padding:3px 9px;border-radius:99px;border:1px solid ${on ? '#008F3F' : '#CBD5E1'};background:${on ? '#E6F4EA' : '#FFF'};color:${on ? '#006B2F' : '#334155'};font-size:12px;cursor:pointer;font-weight:${on ? '600' : '400'}`;
        const mbox = h('div', { class: 'row', style: 'margin:6px 0;flex-wrap:wrap;gap:5px' });
        const drawChips = () => {
          mbox.innerHTML = '';
          mbox.append(h('button', { type: 'button', style: chipStyle(sel.has('*')), onclick: () => { if (sel.has('*')) sel.delete('*'); else { sel.clear(); sel.add('*'); } drawChips(); } }, 'All projects (*)'));
          allProjs.forEach(p => {
            mbox.append(h('button', { type: 'button', style: chipStyle(sel.has(p.project_id)), onclick: () => { sel.delete('*'); if (sel.has(p.project_id)) sel.delete(p.project_id); else sel.add(p.project_id); drawChips(); } }, p.name));
          });
        };
        drawChips();
        wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Mock mode: act as…'), h('div', { class: 'sub' }, 'Mock data lives in this browser only. Switch role and select one or multiple projects to test the agent ↔ admin flow.'),
          h('div', { class: 'row' }, mail, role),
          mbox,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { await CB.api('cb_set_mock_user', { user: { email: mail.value, name: mail.value.split('@')[0], role: role.value, projects: [...sel].join(',') } }); this.agentPreview = null; this.engine = null; chrome.storage.local.remove('cb_draft2'); this.view = 'chat'; this.start(); } }, 'Switch'))));
      }
    }
  };

  app.init();
})();
