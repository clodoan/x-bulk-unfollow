// manager.js — X Bulk Unfollow (full manager tab)
// This file is intentionally split across logical sections for readability during development.
// In a real session we will progressively replace the stubs with working code.

(() => {
  'use strict';

  // ==================== CONSTANTS & STATE ====================
  const API_BASE = 'https://api.x.com/2';
  const REQUIRED_SCOPES = 'users.read follows.read follows.write';

  // ==================== SAFETY & ABUSE PREVENTION CONSTANTS ====================
  // These exist specifically to reduce the risk of account restrictions and misuse.
  const MIN_UNFOLLOW_DELAY_MS = 18000;        // 18 seconds minimum between unfollow API calls (safer than X's 50/15min)
  const MAX_UNFOLLOWS_PER_SESSION = 180;      // Hard cap per browser session to prevent runaway actions
  const LARGE_ACTION_THRESHOLD = 30;          // Extra confirmation friction above this number
  const AI_SUGGESTION_WARNING = 'AI/local scores are suggestions only. You are fully responsible for every unfollow.';

  let state = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    clientId: null,
    me: null,                 // {id, username, name, profile_image_url, ...}
    following: [],            // array of user objects from API
    filtered: [],
    selectedIds: new Set(),
    queue: [],
    isProcessing: false,
    isPaused: false,
    rateInfo: { remaining: null, reset: null },
    dryRun: false,

    // === Smart Analysis (local + optional Grok) ===
    scores: {},               // { userId: { score: 0-100, reasons: string[], source: 'local' | 'grok' } }
    xaiApiKey: null,
    analysisRunAt: null,
  };

  // ==================== DOM HELPERS ====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function show(el) { el && el.classList.remove('hidden'); }
  function hide(el) { el && el.classList.add('hidden'); }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function logToProcessor(message, type = 'info') {
    const logEl = $('#proc-log');
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ==================== STORAGE ====================
  async function saveState(partial) {
    Object.assign(state, partial);
    const toStore = {
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: state.expiresAt,
      clientId: state.clientId,
      me: state.me,
      xaiApiKey: state.xaiApiKey,
      // scores and following are intentionally NOT persisted across full reloads (fresh load is safer)
    };
    await chrome.storage.local.set(toStore);
  }

  async function restoreState() {
    const data = await chrome.storage.local.get([
      'accessToken', 'refreshToken', 'expiresAt', 'clientId', 'me', 'xaiApiKey'
    ]);
    if (data.accessToken) state.accessToken = data.accessToken;
    if (data.refreshToken) state.refreshToken = data.refreshToken;
    if (data.expiresAt) state.expiresAt = data.expiresAt;
    if (data.clientId) state.clientId = data.clientId;
    if (data.me) state.me = data.me;
    if (data.xaiApiKey) state.xaiApiKey = data.xaiApiKey;
  }

  // ==================== OAUTH PKCE (STUBS — implemented in next pass) ====================
  function generateCodeVerifier() {
    const array = new Uint8Array(48);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function getRedirectUri() {
    return chrome.identity.getRedirectURL('x-unfollow-oauth');
  }

  async function connectWithX() {
    if (!state.clientId) {
      alert('Please open Settings and paste your X App Client ID first.');
      openSettingsModal();
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const redirectUri = getRedirectUri();
    const stateParam = crypto.randomUUID();

    // Persist verifier + state temporarily so we can exchange after redirect
    await chrome.storage.session.set({ pkceVerifier: verifier, pkceState: stateParam });

    const authUrl = new URL('https://api.x.com/2/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', state.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', REQUIRED_SCOPES);
    authUrl.searchParams.set('state', stateParam);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    try {
      const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true
      });

      const url = new URL(redirectUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) throw new Error('No authorization code returned');
      if (returnedState !== stateParam) throw new Error('State mismatch — possible CSRF');

      await exchangeCodeForToken(code, verifier);
    } catch (err) {
      console.error('OAuth flow failed:', err);
      alert('Connection failed: ' + (err.message || err));
    }
  }

  async function exchangeCodeForToken(code, verifier) {
    const redirectUri = getRedirectUri();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: state.clientId,
      code_verifier: verifier
    });

    const resp = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${txt}`);
    }

    const json = await resp.json();
    const expiresAt = Date.now() + (json.expires_in * 1000) - 30_000; // 30s safety

    await saveState({
      accessToken: json.access_token,
      refreshToken: json.refresh_token || null,
      expiresAt,
    });

    await fetchMe(); // populate user pill
    updateUIForConnection();
  }

  // ==================== API CLIENT (core) ====================
  async function refreshIfNeeded() {
    if (!state.refreshToken || !state.expiresAt || Date.now() < state.expiresAt) return;
    if (!state.clientId) throw new Error('Missing Client ID for refresh');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
      client_id: state.clientId
    });

    const resp = await fetch(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!resp.ok) {
      // Refresh failed — force re-auth
      await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt']);
      throw new Error('Refresh token expired. Please reconnect.');
    }

    const json = await resp.json();
    const newExpires = Date.now() + (json.expires_in * 1000) - 30_000;
    await saveState({
      accessToken: json.access_token,
      refreshToken: json.refresh_token || state.refreshToken,
      expiresAt: newExpires
    });
  }

  async function apiRequest(path, opts = {}) {
    await refreshIfNeeded();
    if (!state.accessToken) throw new Error('Not authenticated');

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const headers = {
      'Authorization': `Bearer ${state.accessToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    };

    const resp = await fetch(url, { ...opts, headers });

    // Capture rate limit info for UI
    const remaining = resp.headers.get('x-rate-limit-remaining');
    const reset = resp.headers.get('x-rate-limit-reset');
    if (remaining !== null) {
      state.rateInfo = { remaining: parseInt(remaining, 10), reset: reset ? parseInt(reset, 10) : null };
      updateRatePill();
    }

    if (resp.status === 429) {
      const waitMs = state.rateInfo.reset ? (state.rateInfo.reset * 1000 - Date.now() + 1500) : 60_000;
      logToProcessor(`Rate limited. Waiting ${Math.round(waitMs/1000)}s...`, 'warning');
      await new Promise(r => setTimeout(r, waitMs));
      return apiRequest(path, opts); // retry once
    }

    if (resp.status === 401) {
      // token might be bad — clear and ask user to reconnect
      await chrome.storage.local.remove(['accessToken', 'refreshToken']);
      throw new Error('Authentication expired. Please reconnect in Settings.');
    }

    if (!resp.ok) {
      const problem = await resp.json().catch(() => ({}));
      const msg = problem.detail || problem.title || `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    return resp;
  }

  async function fetchMe() {
    const resp = await apiRequest('/users/me?user.fields=id,username,name,profile_image_url,verified');
    const json = await resp.json();
    if (json.data) {
      state.me = json.data;
      await saveState({ me: state.me });
      updateUIForConnection();
    }
    return state.me;
  }

  async function fetchFollowing(userId, paginationToken = null) {
    let path = `/users/${userId}/following?max_results=1000&user.fields=id,username,name,profile_image_url,verified,description,public_metrics`;
    if (paginationToken) path += `&pagination_token=${encodeURIComponent(paginationToken)}`;

    const resp = await apiRequest(path);
    return resp.json();
  }

  async function unfollowUser(sourceUserId, targetUserId) {
    if (state.dryRun) {
      logToProcessor(`[DRY] Would unfollow ${targetUserId}`, 'info');
      return { data: { following: false } };
    }
    const resp = await apiRequest(`/users/${sourceUserId}/following/${targetUserId}`, { method: 'DELETE' });
    return resp.json();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ==================== SMART ANALYSIS — LOCAL HEURISTICS (Tier 1) ====================
  // computeLocalScore is now provided by lib/scoring.js (pure + testable).
  // We keep a tiny wrapper here so the rest of the code stays unchanged.

  /** Run local analysis over the entire following list and store results */
  function runLocalAnalysis() {
    if (!state.following.length) {
      alert('Load your following list first.');
      return;
    }

    state.scores = {};
    let lowValueCount = 0;

    state.following.forEach(user => {
      const result = computeLocalScore(user);
      state.scores[user.id] = result;
      if (result.score < 42) lowValueCount++;
    });

    state.analysisRunAt = Date.now();
    logToProcessor(`Local analysis complete: ${lowValueCount} accounts scored < 42 (good candidates to unfollow)`);

    // Re-render so scores appear
    if (state.filtered.length) {
      renderTable();
    }

    // Show the smart suggestions bar if there are good candidates
    showSmartSuggestions(lowValueCount);

    // Persistent abuse-prevention reminder
    logToProcessor(AI_SUGGESTION_WARNING, 'warning');
  }

  function showSmartSuggestions(lowValueCount) {
    // For now we just log + enable a quick action in the bulk area.
    // A dedicated suggestions card can be added in the next iteration.
    const bar = $('#bulk-bar');
    if (bar && lowValueCount > 8) {
      // We could inject a small hint, but for v1 the "Smart Sort" button + score column is enough.
      logToProcessor(`${lowValueCount} low-value accounts detected. Use "Smart Sort (lowest first)" to surface them.`, 'warning');
    }
  }

  // ==================== GROK-POWERED ANALYSIS (Tier 2) ====================
  async function analyzeWithGrok(accounts) {
    if (!state.xaiApiKey) throw new Error('Missing xAI API key');

    const simplified = accounts.map(u => ({
      id: u.id,
      name: u.name,
      username: u.username,
      bio: (u.description || '').slice(0, 180),
      followers: u.public_metrics?.followers_count || 0,
      tweets: u.public_metrics?.tweet_count || 0,
      verified: !!u.verified
    }));

    const system = `You are an exceptionally good personal curator for Claudio, a designer/engineer who works at xAI. He values craft, thoughtful writing, people who actually ship, design systems, typography, and high-signal technical discussion.

For each account, return a JSON object with:
- id (string)
- score: integer 0-100 (higher = more worth keeping in his feed)
- reason: one short sentence explaining the score

Be honest and a little ruthless. Low follower count + zero original posts = low score. Verified designer who ships interesting work = high score.`;

    const userMsg = `Here are ${simplified.length} accounts Claudio currently follows. Score them:\n\n` +
      simplified.map(a => `ID:${a.id} | @${a.username} (${a.name}) | ${a.followers} followers, ${a.tweets} posts | verified:${a.verified}\nBio: ${a.bio}`).join('\n\n');

    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.xaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'grok-3-mini', // fast and cheap for this task; change to grok-3 if you want deeper reasoning
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`xAI error: ${resp.status} ${err}`);
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Try to extract JSON array or objects from the response
    let parsed;
    try {
      // Grok sometimes returns a JSON array, sometimes one object per line
      const jsonMatch = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        // fallback: parse line by line
        parsed = text.split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .map(l => JSON.parse(l));
      }
    } catch (e) {
      console.warn('Failed to parse Grok response as JSON, raw text:', text);
      throw new Error('Grok returned unparseable output. Try again or use a different model.');
    }

    const results = Array.isArray(parsed) ? parsed : [parsed];

    results.forEach(item => {
      if (item && item.id) {
        state.scores[item.id] = {
          score: Math.max(0, Math.min(100, parseInt(item.score, 10) || 50)),
          reasons: [item.reason || 'Grok analysis'],
          source: 'grok'
        };
      }
    });

    return results.length;
  }

  /** Returns the current list sorted by score ascending (worst first) */
  function getSmartSortedList() {
    const list = [...state.filtered];
    list.sort((a, b) => {
      const sa = state.scores[a.id]?.score ?? 50;
      const sb = state.scores[b.id]?.score ?? 50;
      return sa - sb; // lowest score (most worth unfollowing) first
    });
    return list;
  }

  // ==================== UI UPDATES (STUB) ====================
  function updateUIForConnection() {
    const connectBtn = $('#btn-connect');
    const refreshBtn = $('#btn-refresh');
    const pill = $('#user-pill');

    if (state.me) {
      connectBtn.classList.add('hidden');
      refreshBtn.disabled = false;
      show(pill);
      $('#user-avatar').src = state.me.profile_image_url || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI5IiBmaWxsPSIjMzMzIi8+PC9zdmc+';
      $('#user-name').textContent = state.me.name || '';
      $('#user-handle').textContent = `@${state.me.username}`;
    } else {
      hide(pill);
      connectBtn.classList.remove('hidden');
      refreshBtn.disabled = true;
    }
  }

  function updateFollowCount(n) {
    setText('follow-count', n ? n.toLocaleString() : '—');
    setText('follow-sub', n ? `${n} accounts loaded` : 'Load your following list to begin');
  }

  // ==================== SETTINGS MODAL ====================
  function openSettingsModal() {
    const modal = $('#modal-settings');
    const input = $('#input-client-id');
    const xaiInput = $('#input-xai-key');
    const redirectEl = $('#redirect-uri');

    input.value = state.clientId || '';
    xaiInput.value = state.xaiApiKey || '';
    redirectEl.textContent = getRedirectUri();

    show(modal);
    modal.onclick = (e) => { if (e.target === modal) hide(modal); };

    $('#btn-save-settings').onclick = async () => {
      const newId = input.value.trim();
      const newXaiKey = xaiInput.value.trim();

      const updates = {};
      if (newId) updates.clientId = newId;
      if (newXaiKey) updates.xaiApiKey = newXaiKey;
      else if (state.xaiApiKey) updates.xaiApiKey = null; // allow clearing

      if (Object.keys(updates).length) await saveState(updates);
      hide(modal);
    };

    $('#btn-disconnect').onclick = async () => {
      await chrome.storage.local.clear();
      state = { ...state, accessToken: null, refreshToken: null, me: null, following: [], selectedIds: new Set(), scores: {}, xaiApiKey: null };
      location.reload(); // simplest reset
    };
  }

  // ==================== INIT & EVENT WIRING ====================
  async function init() {
    await restoreState();

    // Wire header buttons
    $('#btn-connect').addEventListener('click', connectWithX);
    $('#btn-refresh').addEventListener('click', () => {
      alert('Full list loading + API client will be wired in the next implementation pass. (Plan step 7)');
    });
    $('#btn-settings').addEventListener('click', openSettingsModal);

    // Real "Load Following" handler (fetches all pages)
    const loadBtn = $('#btn-load');
    loadBtn.addEventListener('click', async () => {
      if (!state.accessToken) {
        alert('Please connect with X first (top right).');
        return;
      }
      if (!state.me) {
        await fetchMe();
      }

      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading…';
      $('#empty-state').innerHTML = '<p><span class="loading"></span> Fetching your following list (paginated)...</p>';

      try {
        let all = [];
        let nextToken = null;
        let page = 0;

        do {
          page++;
          const pageData = await fetchFollowing(state.me.id, nextToken);
          if (pageData.data) all.push(...pageData.data);
          nextToken = pageData.meta?.next_token || null;
          logToProcessor(`Page ${page}: +${pageData.data?.length || 0} (total ${all.length})`);
        } while (nextToken);

        state.following = all;
        state.filtered = [...all];
        state.selectedIds = new Set();

        updateFollowCount(all.length);
        renderTable();
        show($('#toolbar'));
        show($('#table-section'));
        hide($('#empty-state'));

        // Wire search & filters now that we have data
        wireListControls();

      } catch (err) {
        console.error(err);
        alert('Failed to load following: ' + err.message);
        $('#empty-state').innerHTML = `<p style="color:var(--danger)">Error: ${err.message}</p>`;
      } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Refresh Following List';
      }
    });

    // Filter buttons (visual only for now)
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Dry-run toggle
    const dryToggle = $('#dry-run-toggle');
    if (dryToggle) dryToggle.addEventListener('change', (e) => { state.dryRun = e.target.checked; });

    // Initial UI
    updateUIForConnection();
    if (state.me) {
      updateFollowCount(state.following.length || 0);
    }

    // Show redirect helper hint on first open if no clientId
    if (!state.clientId) {
      setTimeout(() => {
        const s = $('#follow-sub');
        if (s) s.textContent = 'Open Settings (gear) → paste your Client ID → Connect with X';
      }, 1200);
    }

    console.log('%c[X Bulk Unfollow] manager initialized (stub mode — full logic in next commits)', 'color:#666');
  }

  // ==================== TABLE RENDER + FILTERS (step 8) ====================
  function renderTable() {
    const tbody = $('#table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const frag = document.createDocumentFragment();

    state.filtered.forEach(user => {
      const isSelected = state.selectedIds.has(user.id);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${user.id}" ${isSelected ? 'checked' : ''}></td>
        <td><img class="avatar" src="${user.profile_image_url || ''}" alt=""></td>
        <td>
          <span class="username">${user.name || ''}</span>
          ${user.verified ? '<span class="verified">✓</span>' : ''}
          <div style="font-size:12px;color:#666">@${user.username}</div>
        </td>
        <td style="text-align:center; font-variant-numeric:tabular-nums;">
          ${renderScoreBadge(user.id)}
        </td>
        <td class="count">${(user.public_metrics?.followers_count || 0).toLocaleString()}</td>
        <td class="bio" title="${(user.description || '').replace(/"/g, '&quot;')}">${user.description || ''}</td>
        <td class="action-cell">
          <button class="btn btn-sm btn-secondary single-unfollow" data-id="${user.id}">Unfollow</button>
        </td>
      `;

      // checkbox
      const cb = tr.querySelector('input[type="checkbox"]');
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedIds.add(user.id);
        else state.selectedIds.delete(user.id);
        updateBulkBar();
      });

      // single unfollow — still respects global safety delay
      tr.querySelector('.single-unfollow').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await unfollowUser(state.me.id, user.id);
          logToProcessor(`Unfollowed @${user.username}`, 'success');
          // remove from arrays
          state.following = state.following.filter(u => u.id !== user.id);
          state.filtered = state.filtered.filter(u => u.id !== user.id);
          state.selectedIds.delete(user.id);
          renderTable();
          updateFollowCount(state.following.length);

          // Respect the same safety delay even for single actions
          await sleep(MIN_UNFOLLOW_DELAY_MS);
        } catch (err) {
          logToProcessor(`Failed @${user.username}: ${err.message}`, 'error');
        } finally {
          e.target.disabled = false;
        }
      });

      frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    updateBulkBar();
    updateVisibleCount();
  }

  function updateVisibleCount() {
    const el = $('#visible-count');
    if (el) el.textContent = `${state.filtered.length} / ${state.following.length} shown`;
  }

  /** Small colored badge for the local score */
  function renderScoreBadge(userId) {
    const s = state.scores[userId];
    if (!s) return `<span style="color:#555;font-size:11px">—</span>`;

    const { score, source } = s;
    let color = '#22c55e';
    if (score < 35) color = '#ef4444';
    else if (score < 48) color = '#f59e0b';
    else if (score < 62) color = '#eab308';

    const label = source === 'grok' ? 'G' : 'L';
    return `<span style="display:inline-block; min-width:38px; text-align:center; font-size:11px; font-weight:600; padding:1px 5px; border-radius:4px; background:${color}22; color:${color}; border:1px solid ${color}44" title="${s.reasons.join(' • ')}">${score} <span style="opacity:0.6;font-size:9px">${label}</span></span>`;
  }

  function updateRatePill() {
    const pill = $('#rate-pill');
    if (!pill) return;
    if (state.rateInfo.remaining == null) {
      hide(pill);
      return;
    }
    show(pill);
    setText('rate-remaining', state.rateInfo.remaining);
    if (state.rateInfo.reset) {
      const mins = Math.max(0, Math.ceil((state.rateInfo.reset * 1000 - Date.now()) / 60000));
      setText('rate-reset', `resets in ~${mins}m`);
    }
  }

  function updateBulkBar() {
    const bar = $('#bulk-bar');
    const countEl = $('#selected-count');
    if (!bar || !countEl) return;

    const n = state.selectedIds.size;
    countEl.textContent = `${n} selected`;

    if (n > 0) {
      show(bar);
      $('#btn-unfollow-selected').disabled = false;
    } else {
      hide(bar);
    }
  }

  function applyFilterAndSearch() {
    const q = ($('#search').value || '').toLowerCase().trim();
    const activeFilterBtn = $('.filter-btn.active');
    const mode = activeFilterBtn ? activeFilterBtn.dataset.filter : 'all';

    state.filtered = state.following.filter(u => {
      const matchesSearch = !q ||
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.description && u.description.toLowerCase().includes(q));

      let matchesFilter = true;
      if (mode === 'verified') matchesFilter = !!u.verified;
      if (mode === 'non-verified') matchesFilter = !u.verified;

      return matchesSearch && matchesFilter;
    });

    renderTable();
  }

  function wireListControls() {
    const search = $('#search');
    if (search) {
      search.addEventListener('input', () => applyFilterAndSearch());
    }

    $$('.filter-btn').forEach(btn => {
      btn.onclick = () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyFilterAndSearch();
      };
    });

    $('#btn-select-all').onclick = () => {
      state.filtered.forEach(u => state.selectedIds.add(u.id));
      renderTable();
    };
    $('#btn-select-none').onclick = () => {
      state.selectedIds.clear();
      renderTable();
    };

    // === New Smart Analysis buttons ===
    const analysisBtn = $('#btn-run-analysis');
    if (analysisBtn) {
      analysisBtn.onclick = () => runLocalAnalysis();
    }

    const smartSortBtn = $('#btn-smart-sort');
    if (smartSortBtn) {
      smartSortBtn.onclick = () => {
        if (!Object.keys(state.scores).length) {
          runLocalAnalysis(); // auto-run if not done yet
        }
        state.filtered = getSmartSortedList();
        renderTable();
        logToProcessor('Table sorted by local score (lowest first = strongest unfollow candidates)');
      };
    }

    const grokBtn = $('#btn-grok-analyze');
    if (grokBtn) {
      grokBtn.onclick = async () => {
        if (!state.xaiApiKey) {
          alert('Add your xAI API key first in Settings (gear icon).');
          openSettingsModal();
          return;
        }
        if (!state.following.length) {
          alert('Load your following list first.');
          return;
        }

        grokBtn.disabled = true;
        grokBtn.textContent = 'Analyzing…';

        try {
          // Analyze in batches of 28 for context safety
          const batchSize = 28;
          let totalAnalyzed = 0;

          for (let i = 0; i < state.following.length; i += batchSize) {
            const batch = state.following.slice(i, i + batchSize);
            const count = await analyzeWithGrok(batch);
            totalAnalyzed += count;
            logToProcessor(`Grok analyzed batch ${Math.floor(i / batchSize) + 1} (${count} accounts)`);
            // small pause to be nice to the API
            await new Promise(r => setTimeout(r, 650));
          }

          renderTable();
          logToProcessor(`Grok analysis complete on ${totalAnalyzed} accounts. Use Smart Sort to see the new scores.`, 'success');

        } catch (err) {
          console.error(err);
          alert('Grok analysis failed: ' + err.message);
        } finally {
          grokBtn.disabled = false;
          grokBtn.textContent = 'Analyze with Grok';
        }
      };
    }

    // Bulk unfollow stub (opens confirmation)
    const bulkBtn = $('#btn-unfollow-selected');
    if (bulkBtn) {
      bulkBtn.onclick = () => {
        const ids = Array.from(state.selectedIds);
        if (!ids.length) return;
        const confirm = $('#modal-confirm');
        $('#confirm-text').innerHTML = `You are about to unfollow <strong>${ids.length}</strong> accounts.`;
        show(confirm);

        $('#btn-cancel-confirm').onclick = () => hide(confirm);
        $('#btn-do-unfollow').onclick = async () => {
          hide(confirm);

          // === Abuse prevention: hard session cap ===
          const toDo = ids.slice(0, MAX_UNFOLLOWS_PER_SESSION);
          if (ids.length > MAX_UNFOLLOWS_PER_SESSION) {
            logToProcessor(`Capped at ${MAX_UNFOLLOWS_PER_SESSION} unfollows for this session (safety limit).`, 'warning');
          }

          // Stronger warning for larger actions (especially when driven by scores)
          if (toDo.length >= LARGE_ACTION_THRESHOLD) {
            logToProcessor(`Large action (${toDo.length} accounts). ${AI_SUGGESTION_WARNING}`, 'warning');
          }

          for (let i = 0; i < toDo.length; i++) {
            const id = toDo[i];
            const u = state.following.find(x => x.id === id);
            if (!u) continue;

            try {
              await unfollowUser(state.me.id, id);
              logToProcessor(`✓ Unfollowed @${u.username} (${i + 1}/${toDo.length})`, 'success');
            } catch (e) {
              logToProcessor(`✗ ${u.username}: ${e.message}`, 'error');
            }

            // Enforced minimum delay between calls — critical for X ToS / rate safety
            if (i < toDo.length - 1) {
              await sleep(MIN_UNFOLLOW_DELAY_MS);
            }
          }

          // Refresh UI
          state.following = state.following.filter(u => !toDo.includes(u.id));
          state.filtered = [...state.following];
          state.selectedIds.clear();
          renderTable();
          updateFollowCount(state.following.length);
        };
      };
    }

    $('#btn-export').onclick = () => {
      const csv = ['name,username,verified,followers'].concat(
        state.filtered.map(u => `"${(u.name||'').replace(/"/g,'""')}",${u.username},${u.verified?1:0},${u.public_metrics?.followers_count||0}`)
      ).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `x-following-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    };
  }

  // Expose a few things for console debugging during development
  window.XUF_DEBUG = { state, getRedirectUri, saveState, renderTable };

  document.addEventListener('DOMContentLoaded', init);
})();
