// ─────────────────────────────────────────────────────────────
//  ADMIN.JS v34 — rich toast system, clean UI
//  Polling every 2s as ground truth; realtime = speed boost
// ─────────────────────────────────────────────────────────────

let allPlayers     = [];
let allTeams       = [];
let soldMap        = {};     // player_id → { team_name, team_id, sold_price, is_retained }
let unsoldIds      = new Set();
let unsoldLogMap   = {};
let currentState   = null;
let timerInterval  = null;
let autoSellTimer      = null;
let _autoSellCdTimer   = null;   // countdown interval for warning
let _qlFocusIdx        = -1;     // quick-launch keyboard index
let sortKey        = 'name';
let sortDir        = 'asc';
let hSortKey       = 'sold_at';
let hSortDir       = 'desc';
let sqSortKey      = 'sold_price';
let sqSortDir      = 'desc';
let activeFilters  = { overseas: false, uncapped: false, rtm: false };
let auctionHistory = [];
let squadRows      = [];
let realtimeChannel  = null;
let autopilotEnabled = false;
let activeSetSlots   = [];
let setSlotChannel   = null;
let adminPollInterval = null;
let adminSetTimerInterval = null;
let _lastAdminStateHash = '';
const MAX_RETRY = 5;

const SILHOUETTE_ADMIN = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%23111520' rx='40'/%3E%3Ccircle cx='40' cy='28' r='14' fill='%2364748b'/%3E%3Cellipse cx='40' cy='70' rx='22' ry='18' fill='%2364748b'/%3E%3C/svg%3E";
window._SIL_ADMIN = SILHOUETTE_ADMIN;

function getIPLColors(code) {
  const map = {
    CSK:{ primary:'#f7c948', secondary:'#00184e', glow:'rgba(247,201,72,0.3)' },
    MI: { primary:'#005da0', secondary:'#d1ab3e', glow:'rgba(0,93,160,0.35)' },
    RCB:{ primary:'#d41620', secondary:'#1a1a1a', glow:'rgba(212,22,32,0.35)' },
    KKR:{ primary:'#6a1bac', secondary:'#b08c3c', glow:'rgba(106,27,172,0.35)' },
    SRH:{ primary:'#f26522', secondary:'#1a1a1a', glow:'rgba(242,101,34,0.35)' },
    DC: { primary:'#004c93', secondary:'#ef2826', glow:'rgba(0,76,147,0.35)' },
    PBKS:{ primary:'#aa192f', secondary:'#dbbe6c', glow:'rgba(170,25,47,0.35)' },
    RR: { primary:'#2d62a4', secondary:'#e83f5b', glow:'rgba(45,98,164,0.35)' },
    GT: { primary:'#1c3e6e', secondary:'#c8a84b', glow:'rgba(28,62,110,0.35)' },
    LSG:{ primary:'#00b4d8', secondary:'#c6a200', glow:'rgba(0,180,216,0.35)' },
  };
  return map[(code||'').toUpperCase()] || null;
}
function getIPLLogoUrl(code) {
  if (!code) return null;
  const c = (code||'').trim().toUpperCase();
  return `https://documents.iplt20.com/ipl/${c}/logos/Logooutline/${c}outline.png`;
}
// IPL 25 Fantasy Avg tier helper
function avgTier(v) {
  if (!v) return { cls:'', label:'—', color:'var(--muted)', badge:'' };
  const n = Number(v);
  if (n >= 120) return { cls:'avg-elite', label:n.toFixed(1), color:'#fbbf24', badge:'Elite' };
  if (n >=  90) return { cls:'avg-good',  label:n.toFixed(1), color:'var(--green)', badge:'Good' };
  if (n >=  60) return { cls:'avg-fair',  label:n.toFixed(1), color:'#60a5fa', badge:'Fair' };
  return         { cls:'avg-weak',  label:n.toFixed(1), color:'#94a3b8', badge:'Weak' };
}


const el  = id => document.getElementById(id);
const fmt = v  => '₹' + Number(v).toFixed(2) + ' Cr';

// Per-key debounce map
const _dbt = {};
function dbt(key, fn, ms = 350) {
  clearTimeout(_dbt[key]);
  _dbt[key] = setTimeout(fn, ms);
}

// ─── INIT ─────────────────────────────────────────────────────
async function doLogout() { await sb.auth.signOut(); location.href = 'index.html'; }

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  if (session.user.app_metadata?.role !== 'admin') { location.href = 'auction.html'; return; }
  setConn('reconnecting');
  await loadTeams();
  await loadPlayers();
  await loadAuctionState();
  await loadHistory();
  await updateStats();
  revealAdminUI();
  subscribeRealtime();

  // Primary sync: poll every 2s (realtime is just a speed-boost on top)
  startAdminPolling();

  // Re-sync on tab focus
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollAdminState();
  });
}

function startAdminPolling() {
  stopAdminPolling();
  adminPollInterval = setInterval(pollAdminState, 2000);
}
function stopAdminPolling() {
  clearInterval(adminPollInterval); adminPollInterval = null;
}

async function pollAdminState() {
  // Lightweight state check — only do heavy reload if something changed
  try {
    const { data: state } = await sb.from('auction_state')
      .select('status,current_player_id,current_highest_bid,current_highest_team_id,bid_timer_end,rtm_pending,rtm_team_id,last_player_id,current_set_name,unsold_player_ids,autopilot_enabled,last_action_at')
      .eq('id', 1).maybeSingle();
    if (!state) return;

    // Always refresh set slots when set is live (bids come in without changing auction_state hash)
    if (state.status === 'set_live' && state.current_set_name) {
      await loadSetSlots(state.current_set_name);
      const tab = el('tab-sets');
      if (tab?.classList.contains('active')) renderSetLauncher();
    }

    const hash = [
      state.status, state.current_player_id, state.current_highest_bid,
      state.current_highest_team_id, state.bid_timer_end, state.rtm_pending,
      state.rtm_team_id, state.last_player_id, state.current_set_name,
      (state.unsold_player_ids||[]).length, state.autopilot_enabled,
      state.last_action_at
    ].join('|');
    if (hash === _lastAdminStateHash) return; // nothing changed
    _lastAdminStateHash = hash;
    // State changed — do full reload including history for accurate stats
    await Promise.all([loadAuctionState(), loadTeams(), loadHistory()]);
    await updateStats();
  } catch(e) { /* silent — realtime is fallback */ }
}

function revealAdminUI() {
  ['auction-skeleton','teams-skeleton','tabs-skeleton','stats-skeleton'].forEach(id => {
    const e = el(id); if (e) e.style.display = 'none';
  });
  ['admin-controls','no-player','teams-table-wrap','tabs-real','stats-real'].forEach(id => {
    const e = el(id); if (e) e.style.display = '';
  });
  const lb = el('live-block'); if (lb) lb.style.display = 'none';
}

// ─── RETRY HELPER ─────────────────────────────────────────────
async function safeLoad(fn, label) {
  for (let i = 0; i < MAX_RETRY; i++) {
    try { await fn(); return true; }
    catch (e) {
      const wait = Math.min(1000 * Math.pow(2, i), 12000);
      console.warn(`[${label}] attempt ${i+1} failed:`, e.message);
      setConn('reconnecting');
      await new Promise(r => setTimeout(r, wait));
    }
  }
  showError(`${label}: failed after ${MAX_RETRY} attempts.`);
  setConn('error');
  return false;
}

// ─── PLAYERS ──────────────────────────────────────────────────
async function loadPlayers() {
  await safeLoad(async () => {
    const { data: players, error: pe } = await sb
      .from('players_master')
      .select('*')
      .order('name');
    if (pe) throw new Error(pe.message);
    allPlayers = players || [];

    const { data: sold, error: se } = await sb.from('team_players')
      .select('player_id,sold_price,sold_at,is_retained,team_id,team:teams(team_name)');
    if (se) throw new Error(se.message);
    soldMap = {};
    (sold || []).forEach(r => {
      soldMap[r.player_id] = {
        team_name: r.team?.team_name || '?',
        team_id: r.team_id,
        sold_price: r.sold_price,
        sold_at: r.sold_at,
        is_retained: r.is_retained || false,
      };
    });

    const sets = [...new Set(allPlayers.map(p => p.set_name).filter(Boolean))].sort();
    const sel = el('filter-set');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All Sets</option>' +
        sets.map(s => `<option value="${s}">${s}</option>`).join('');
      if (cur) sel.value = cur;
    }
    renderPlayerList(); await updateStats();
  }, 'loadPlayers');
}

function renderPlayerList() {
  const q       = (el('player-search')?.value || '').toLowerCase();
  const fSet    = el('filter-set')?.value    || '';
  const fRole   = el('filter-role')?.value   || '';
  const fStatus = el('filter-status')?.value || '';
  const tbody   = el('players-tbody');

  let list = allPlayers.filter(p => {
    if (q && !p.name.toLowerCase().includes(q) &&
             !(p.role||'').toLowerCase().includes(q) &&
             !(p.ipl_team||'').toLowerCase().includes(q)) return false;
    if (fSet  && p.set_name !== fSet)  return false;
    if (fRole && p.role     !== fRole) return false;
    const isSold   = !!soldMap[p.id];
    const isUnsold = unsoldIds.has(p.id);
    if (activeFilters.overseas && !p.is_overseas)        return false;
    if (activeFilters.uncapped && !p.is_uncapped)        return false;
    if (activeFilters.rtm      && !p.is_rtm_eligible)   return false;
    if (fStatus === 'sold'      && !isSold)              return false;
    if (fStatus === 'unsold'    && !isUnsold)            return false;
    if (fStatus === 'available' && (isSold || isUnsold)) return false;
    return true;
  });

  list.sort((a, b) => {
    let va = a[sortKey] ?? '', vb = b[sortKey] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  document.querySelectorAll('#tab-players .data-table th[onclick]').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    const m = th.getAttribute('onclick')?.match(/sortBy\('([^']+)'\)/);
    if (m && m[1] === sortKey) th.classList.add('sort-' + sortDir);
  });

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">No players found</td></tr>'; return;
  }

  tbody.innerHTML = list.map(p => {
    const sold     = soldMap[p.id];
    const isUnsold = unsoldIds.has(p.id);
    const isCurrent = currentState?.current_player_id === p.id &&
                      ['live','paused'].includes(currentState?.status);
    let badge, action;
    if (sold) {
      const retTag = sold.is_retained ? ' <span class="tag tag-retained" style="font-size:10px;">RTN</span>' : '';
      badge  = `<span class="tag tag-sold" style="font-size:11px;">₹${Number(sold.sold_price).toFixed(2)} → ${sold.team_name}</span>${retTag}`;
      action = `<button class="btn btn-sm btn-ghost" onclick="undoSale()" title="Undo">↩</button>`;
    } else if (isUnsold) {
      badge  = '<span class="tag tag-unsold">Unsold</span>';
      action = `<button class="btn btn-sm btn-start" onclick="startAuction('${p.id}')">↻ Re</button>
                <button class="btn btn-sm btn-ghost" onclick="undoUnsold('${p.id}')">↩</button>`;
    } else if (isCurrent) {
      badge  = '<span class="tag tag-live">Live</span>';
      action = '';
    } else {
      badge  = '<span class="avail-label">Available</span>';
      action = `<button class="btn btn-sm btn-start" onclick="startAuction('${p.id}')">▶ Start</button>`;
    }
    const row = sold ? 'row-sold' : isUnsold ? 'row-unsold' : isCurrent ? 'row-current' : '';
    const img = p.image_url
      ? `<img src="${p.image_url}" class="player-avatar" alt="" onerror="this.onerror=null;this.src=window._SIL_ADMIN||''">`
      : `<img src="${SILHOUETTE_ADMIN}" class="player-avatar" alt="">`;
    // Tags — clear semantics:
    // RTN = pre-retained by admin (most important, shown first)
    // RTM = eligible for RTM at auction (only if not retained)
    // OS/UC = nationality/status
    let tags = '';
    if (sold?.is_retained) tags += '<span class="tag tag-retained">RTN</span> ';
    else if (p.is_rtm_eligible) tags += '<span class="tag tag-rtm">RTM</span> ';
    if (p.is_overseas)    tags += '<span class="tag tag-overseas">OS</span> ';
    if (p.is_uncapped)    tags += '<span class="tag tag-uncapped">UC</span> ';
    return `<tr class="${row}">
      <td style="padding:6px 8px;">${img}</td>
      <td style="max-width:150px;overflow:hidden;"><strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${p.name}</strong></td>
      <td style="white-space:nowrap;font-size:13px;">${p.role}</td>
      <td style="white-space:nowrap;font-size:12px;color:var(--muted);">${p.ipl_team||'—'}</td>
      <td style="white-space:nowrap;font-size:12px;color:var(--muted);text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;">${p.set_no||'—'}</td>
      <td style="white-space:nowrap;font-size:11px;color:var(--muted);">${p.set_name||'—'}</td>
      <td style="white-space:nowrap;">₹${p.base_price}</td>
      <td style="white-space:nowrap;">${tags || '<span style="color:var(--muted);font-size:11px;">—</span>'}</td>
      <td style="max-width:180px;">${badge}</td>
      <td style="white-space:nowrap;">${action}</td>
    </tr>`;
  }).join('');
}

function sortBy(key) {
  sortDir = (sortKey === key && sortDir === 'asc') ? 'desc' : 'asc';
  sortKey = key; renderPlayerList();
}
function toggleFilter(name) {
  activeFilters[name] = !activeFilters[name];
  el('ft-'+name)?.classList.toggle('active', activeFilters[name]);
  renderPlayerList();
}
function clearFilters() {
  ['player-search','filter-set','filter-role','filter-status'].forEach(id => {
    const e = el(id); if (e) e.value = '';
  });
  activeFilters = { overseas:false, uncapped:false, rtm:false };
  ['overseas','uncapped','rtm'].forEach(f => el('ft-'+f)?.classList.remove('active'));
  renderPlayerList();
}

// ─── AUCTION CONTROLS ─────────────────────────────────────────
// ─── SERVER-SIDE BID VALIDATION NOTE ─────────────────────────
// The place_bid RPC enforces: bid > current_highest, bid is multiple of 0.25,
// bid <= purse_remaining, auction is live, player matches current_player_id.
// Any tampered client call will be rejected server-side.
// ──────────────────────────────────────────────────────────────

async function startAuction(playerId) {
  clearError();
  let forceOverride = false;
  const liveStatus = currentState?.status;
  if (liveStatus === 'live' || liveStatus === 'set_live') {
    const ok = await confirm2(
      liveStatus === 'set_live'
        ? 'A set auction is live. Force-start this player anyway?'
        : 'Another player is live. Force-start this one instead?',
      { title:'Force Start', icon:'▶', danger:true }
    );
    if (!ok) return;
    forceOverride = true;
  }
  const { data, error } = await sb.rpc('start_auction', { p_player_id: playerId, p_force: forceOverride });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  toast('Auction Started', (data.player||'Player') + ' is now live', 'success');
  await loadAuctionState(); renderPlayerList();
}

async function pauseAuction() {
  if (!await confirm2('Pause the current auction?', { title:'Pause', icon:'⏸' })) return;
  clearError(); clearAutoSell();
  const { data, error } = await sb.rpc('pause_auction');
  if (error) return showError(error.message);
  if (!data.success) return showError(data.error);
  toast('Auction Paused', 'Bidding has been paused', 'info'); await loadAuctionState();
}

// #13 — Panic cancel: stop live player, return to Available (no sale, no unsold mark)
async function cancelLiveAuction() {
  const playerName = currentState?.current_player?.name || 'current player';
  if (!await confirm2(
    `Cancel the live auction for **${playerName}**?\nPlayer returns to Available. All bids are cleared. No purse changes.`,
    { title:'Cancel Live Auction', icon:'✕', danger:true }
  )) return;
  clearError(); clearAutoSell(); stopTimer();
  // Reset state back to waiting — purses are NOT affected (no bid was accepted)
  const { error } = await sb.from('auction_state').update({
    status: 'waiting',
    current_player_id: null,
    current_highest_bid: 0,
    current_highest_team_id: null,
    second_highest_bid: 0,
    second_highest_team_id: null,
    bid_timer_end: null,
    rtm_pending: false,
    rtm_team_id: null,
  }).eq('id', 1);
  if (error) return showError('Cancel failed: ' + error.message);
  toast('Auction Cancelled', playerName + ' returned to Available pool', 'warn');
  await Promise.all([loadAuctionState(), loadPlayers()]);
  renderPlayerList();
}

async function resumeAuction() {
  clearError();
  const { data, error } = await sb.rpc('resume_auction');
  if (error) return showError(error.message);
  if (!data.success) return showError(data.error);
  toast('Auction Resumed', 'Bidding is now live again', 'success'); await loadAuctionState();
}

async function forceSell() {
  clearError(); clearAutoSell();
  const btn = el('force-sell-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const { data, error } = await sb.rpc('force_sell');
  if (btn) { btn.disabled = false; btn.textContent = '🔨 Force Sell'; }
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  const result = data.result || data.message;
  toast(
    result === 'unsold'     ? 'Marked Unsold'       :
    result === 'rtm_pending'? 'RTM Available'       : 'Sold',
    result === 'unsold'     ? 'No bids received — player marked unsold' :
    result === 'rtm_pending'? data.rtm_team + ' can exercise RTM' :
                              'Player successfully sold',
    result === 'unsold'     ? 'warn' : result === 'rtm_pending' ? 'rtm' : 'success'
  );
  await Promise.all([loadPlayers(), loadAuctionState(), loadTeams(), loadHistory()]);
  await updateStats();
}

async function resetState() {
  if (!await confirm2('Reset to **Waiting**? Does NOT undo sold/unsold.', { title:'Reset State', icon:'↺' })) return;
  clearError(); clearAutoSell(); stopTimer();
  const { data, error } = await sb.rpc('reset_auction_state');
  if (error) return showError(error.message);
  if (!data.success) return showError(data.error);
  toast('State Reset', 'Auction state returned to Waiting', 'info'); await loadAuctionState(); renderPlayerList();
}

async function restartAuction() {
  if (!await confirmDanger(
    'This will:\n• **Clear ALL sold players**\n• Refund all purses (100 Cr minus retention costs)\n• Clear unsold list\n• Reset to Waiting\n\nThis CANNOT be undone.',
    'Last chance — delete **ALL auction progress**?',
    'Full Restart'
  )) return;
  clearError(); clearAutoSell(); stopTimer();

  try {
    // Step 1: load retention costs per team before deleting
    const { data: retRows } = await sb.from('team_players')
      .select('team_id, sold_price')
      .eq('is_retained', true);
    const retentionByTeam = {};
    (retRows || []).forEach(r => {
      retentionByTeam[r.team_id] = (retentionByTeam[r.team_id] || 0) + Number(r.sold_price || 0);
    });

    // Step 2: delete all non-retained team_players
    const { error: e1 } = await sb.from('team_players')
      .delete().eq('is_retained', false);
    if (e1) throw new Error('Clear players: ' + e1.message);

    // Step 3: delete unsold_log — delete by known player ids to give PostgREST a WHERE
    const { data: ulRows } = await sb.from('unsold_log').select('player_id');
    if (ulRows?.length) {
      const ids = ulRows.map(r => r.player_id);
      const { error: e2 } = await sb.from('unsold_log')
        .delete().in('player_id', ids);
      if (e2) throw new Error('Clear unsold: ' + e2.message);
    }

    // Step 4: delete auction_slots by known ids
    const { data: slotRows } = await sb.from('auction_slots').select('id');
    if (slotRows?.length) {
      const ids = slotRows.map(r => r.id);
      const { error: e3 } = await sb.from('auction_slots')
        .delete().in('id', ids);
      if (e3) throw new Error('Clear slots: ' + e3.message);
    }

    // Step 5: reset each team's purse individually (explicit WHERE per team)
    const { data: teams } = await sb.from('teams').select('id');
    for (const t of (teams || [])) {
      const retCost = retentionByTeam[t.id] || 0;
      const { error: e4 } = await sb.from('teams')
        .update({ purse_remaining: 100 - retCost, rtm_cards_used: 0 })
        .eq('id', t.id);
      if (e4) throw new Error('Reset purse: ' + e4.message);
    }

    // Step 6: reset auction_state (single row, WHERE id=1)
    // NOTE: use null for uuid[] column (not []) — Supabase client throws on []
    const { error: e5 } = await sb.from('auction_state').update({
      status: 'waiting',
      current_player_id: null,
      current_highest_bid: 0,
      current_highest_team_id: null,
      second_highest_bid: 0,
      second_highest_team_id: null,
      bid_timer_end: null,
      rtm_pending: false,
      rtm_team_id: null,
      unsold_player_ids: '{}',
      last_player_id: null,
      last_player_result: null,
      last_sold_to_team: null,
      last_sold_price: null,
      current_set_name: null
    }).eq('id', 1);
    if (e5) throw new Error('Reset state: ' + e5.message);

    // Step 7: recompute RTM cards via RPC (this one always works)
    await sb.rpc('compute_rtm_cards');

    toast('Auction Restarted', 'All sold players cleared, purses reset to 100 Cr', 'warn');
    await Promise.all([loadPlayers(), loadTeams(), loadAuctionState(), loadHistory()]);
    await updateStats();
  } catch (err) {
    showError('Restart failed: ' + err.message);
  }
}

// #14 — Queue all unsold players for re-auction (mark them as available again)
async function queueAllUnsold() {
  const count = unsoldIds.size;
  if (!count) { toast('Nothing to Re-queue', 'No unsold players found', 'info'); return; }
  if (!await confirm2(
    `Remove **Unsold** mark from all **${count}** unsold players?\nThey return to Available and can be re-auctioned.`,
    { title:'Re-queue All Unsold', icon:'↻' }
  )) return;
  clearError();
  // Delete all unsold_log entries
  const ids = [...unsoldIds];
  const { error } = await sb.from('unsold_log').delete().in('player_id', ids);
  if (error) return showError('Re-queue failed: ' + error.message);
  toast('Re-queued', count + ' unsold player(s) returned to Available', 'success');
  await Promise.all([loadPlayers(), loadAuctionState()]);
  renderPlayerList();
}

async function resetSet() {
  if (!await confirm2('Abort the live set auction?\nAll held bids will be refunded. Players return to available.', { title:'Reset Set', icon:'⚡', danger:true })) return;
  clearError(); clearInterval(adminSetTimerInterval);
  const { data, error } = await sb.rpc('reset_set_auction');
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  toast('Set Reset', 'All slot bids cleared, purses refunded', 'warn');
  activeSetSlots = [];
  if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
  await Promise.all([loadAuctionState(), loadTeams()]);
  await updateStats(); renderPlayerList();
}

async function resetDay() {
  // Pick date to reset — default today
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata',
    day:'2-digit', month:'short', year:'numeric' });
  const isoToday = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

  if (!await confirmDanger(
    `This will for **${today}**:\n• Clear all auction wins (non-retained)\n• Refund their costs to each team\n• Clear unsold players for that day\n• Keep retentions and other days intact\n• Reset to Waiting`,
    `Reset auction day (${today})?`,
    'Reset Day'
  )) return;
  clearError(); clearAutoSell(); stopTimer();
  const { data, error } = await sb.rpc('reset_day', { p_date: isoToday });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  toast('Day Reset', data.players_cleared + ' players cleared, ' + Number(data.purse_refunded||0).toFixed(2) + ' Cr refunded', 'warn');
  // Clear the last result banner
  await sb.from('auction_state').update({
    last_player_id: null, last_player_result: null,
    last_sold_price: null, last_sold_to_team: null
  }).eq('id', 1);
  await Promise.all([loadPlayers(), loadTeams(), loadAuctionState(), loadHistory()]);
  await updateStats();
}

// RTM admin controls
async function adminExerciseRTM(accept) {
  if (!await confirm2(
    accept ? 'RTM accepted — franchise keeps player at match price.' : 'RTM declined — winning bidder gets the player.',
    { title: accept ? 'Accept RTM' : 'Decline RTM', icon: '🔄', danger: !accept }
  )) return;
  const { data, error } = await sb.rpc('exercise_rtm', { p_accept: accept });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  toast(accept ? 'RTM Exercised' : 'RTM Declined', accept ? 'Player retained at winning bid price' : 'Player awarded to winning bidder', accept ? 'success' : 'info');
  await Promise.all([loadAuctionState(), loadTeams(), loadHistory()]);
  await updateStats(); renderPlayerList();
}

// ─── UNDO ─────────────────────────────────────────────────────
async function undoSale() {
  if (!await confirm2('Player returns to **Available** and purse refunded.', { title:'Undo Last Sale', icon:'↩' })) return;
  clearError();
  const { data, error } = await sb.rpc('undo_last_sale');
  if (error) return showError(error.message);
  if (!data.success) return showError(data.error);
  // Clear the last result banner in auction_state so teams see a blank state
  await sb.from('auction_state').update({
    last_player_id: null, last_player_result: null,
    last_sold_price: null, last_sold_to_team: null
  }).eq('id', 1);
  toast('Sale Undone', 'Player returned to Available, purse refunded', 'warn');
  await Promise.all([loadPlayers(), loadTeams(), loadHistory(), loadAuctionState()]); await updateStats();
}

async function undoSaleByPlayer(playerName, teamName, price) {
  if (!await confirm2(
    `Undo sale of **${playerName}** to **${teamName}** (₹${Number(price).toFixed(2)} Cr)?\nPlayer returns to Available and purse is refunded.`,
    { title:'Undo Sale', icon:'↩' }
  )) return;
  clearError();
  // Find the player id from in-memory list
  const player = allPlayers.find(p => p.name === playerName);
  if (!player) return showError('Player not found in list');
  const { data, error } = await sb.rpc('undo_sale_by_player', { p_player_id: player.id });
  if (error || !data?.success) {
    // Graceful fallback: if RPC doesn't exist yet, fall back to undo_last_sale with a warning
    if (error?.message?.includes('does not exist') || error?.code === 'PGRST202') {
      const { data: d2, error: e2 } = await sb.rpc('undo_last_sale');
      if (e2 || !d2?.success) return showError((e2||d2)?.message || 'Undo failed');
      toast('Sale Undone', 'Player returned to Available (global undo used)', 'warn');
    } else {
      return showError(error?.message || data?.error || 'Undo failed');
    }
  } else {
    toast('Sale Undone', playerName + ' returned to Available, purse refunded', 'warn');
  }
  // Clear the last result banner
  await sb.from('auction_state').update({
    last_player_id: null, last_player_result: null,
    last_sold_price: null, last_sold_to_team: null
  }).eq('id', 1);
  await Promise.all([loadPlayers(), loadTeams(), loadHistory(), loadAuctionState()]); await updateStats();
}

async function undoUnsold(playerId) {
  if (!await confirm2('Remove Unsold mark? Returns to **Available**.', { title:'Undo Unsold', icon:'↩' })) return;
  clearError();
  const { data, error } = await sb.rpc('undo_mark_unsold', { p_player_id: playerId });
  if (error) return showError(error.message);
  if (!data.success) return showError(data.error);
  // If the unsold banner is showing this player, clear it
  if (currentState?.last_player_id === playerId && currentState?.last_player_result === 'unsold') {
    await sb.from('auction_state').update({
      last_player_id: null, last_player_result: null,
      last_sold_price: null, last_sold_to_team: null
    }).eq('id', 1);
  }
  toast('Cleared', 'Unsold mark removed — player back to Available', 'info');
  unsoldIds.delete(playerId); delete unsoldLogMap[playerId];
  renderPlayerList(); await updateStats(); await loadHistory();
}

async function undoUnsoldByName(playerName) {
  const p = allPlayers.find(x => x.name === playerName);
  if (p) await undoUnsold(p.id);
}

// ─── AUTOPILOT ────────────────────────────────────────────────
async function toggleAutopilot() {
  const newVal = !autopilotEnabled;
  const msg = newVal
    ? 'Enable Autopilot?\n\nServer auto-sells when timer expires, even if you are logged out.'
    : 'Disable Autopilot?\n\nYou must manually click Force Sell after timer expires.';
  if (!await confirm2(msg, { title:'Autopilot', icon:'🤖' })) return;
  const { data, error } = await sb.rpc('set_autopilot', { enabled: newVal });
  if (error) return showError(error.message);
  autopilotEnabled = newVal;
  renderAutopilotBtn();
  toast(newVal ? 'Autopilot Enabled' : 'Autopilot Disabled', newVal ? 'Players will auto-sell after timer' : 'Manual force-sell required', newVal ? 'success' : 'warn');
}
async function setAutopilotDelay(seconds) {
  const s = parseInt(seconds);
  if (isNaN(s)) return;
  const { data, error } = await sb.rpc('set_autopilot_delay', { p_seconds: s });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error || 'Error');
  toast('Auto-sell Delay Updated', s + ' seconds after timer ends', 'info');
}

function renderAutopilotBtn() {
  const btn = el('autopilot-btn');
  const dot = el('autopilot-dot');
  const lbl = el('autopilot-label');
  if (autopilotEnabled) {
    if (btn) { btn.textContent = '🤖 Autopilot ON';  btn.className = 'btn btn-green btn-sm'; }
    if (dot) dot.style.background = 'var(--green)';
    if (lbl) lbl.textContent = 'Autopilot ON';
  } else {
    if (btn) { btn.textContent = '🤖 Autopilot OFF'; btn.className = 'btn btn-ghost btn-sm'; }
    if (dot) dot.style.background = 'var(--muted)';
    if (lbl) lbl.textContent = 'Autopilot OFF';
  }
}

// ─── AUCTION STATE ────────────────────────────────────────────
async function loadAuctionState() {
  await safeLoad(async () => {
    // Two-step load: main state first, then join separately to avoid ambiguous FK
    const { data: state, error } = await sb.from('auction_state')
      .select(`*,
        current_player:players_master!auction_state_current_player_id_fkey(*),
        highest_team:teams!auction_state_current_highest_team_id_fkey(team_name),
        second_team:teams!auction_state_second_highest_team_id_fkey(team_name)`)
      .eq('id', 1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!state) { showError('Auction state row missing — run schema SQL'); return; }

    // last_player: separate fetch to avoid ambiguous FK
    if (state.last_player_id) {
      const { data: lp } = await sb.from('players_master')
        .select('id,name,role,image_url').eq('id', state.last_player_id).maybeSingle();
      state.last_player = lp || null;
    } else {
      state.last_player = null;
    }

    // rtm_team: separate fetch
    if (state.rtm_team_id) {
      const { data: rt } = await sb.from('teams')
        .select('team_name').eq('id', state.rtm_team_id).maybeSingle();
      state.rtm_team = rt || null;
    } else {
      state.rtm_team = null;
    }

    unsoldIds        = new Set(state.unsold_player_ids || []);
    autopilotEnabled = !!state.autopilot_enabled;
    currentState     = state;
    setConn('connected'); clearError();
    renderAuctionState(state); renderAutopilotBtn(); renderUnsoldQueue();
  }, 'loadAuctionState');
}

function renderAuctionState(state) {
  const statusEl = el('auction-status');
  const labels   = { waiting:'Waiting', live:'LIVE', sold:'Sold', paused:'Paused', set_live:'SET LIVE' };
  statusEl.textContent = state.rtm_pending ? 'RTM' : (labels[state.status] || state.status);
  statusEl.className   = 'status-badge status-' + (state.rtm_pending ? 'rtm' : state.status);

  const isLive   = state.status === 'live';
  const isPaused = state.status === 'paused';

  el('pause-btn').style.display      = isLive   ? 'inline-flex' : 'none';
  el('resume-btn').style.display     = isPaused ? 'inline-flex' : 'none';
  // Force sell: always visible when live or paused (not hidden until timer hits 0)
  el('force-sell-btn').style.display = (isLive || isPaused) ? 'inline-flex' : 'none';
  const cancelLiveBtn = el('cancel-live-btn');
  if (cancelLiveBtn) cancelLiveBtn.style.display = (isLive || isPaused) ? 'inline-flex' : 'none';
  const resetSetBtn = el('reset-set-btn');
  if (resetSetBtn) resetSetBtn.style.display = (state.status === 'set_live') ? 'inline-flex' : 'none';

  // RTM admin block
  renderRTMAdminBlock(state);

  if ((isLive || isPaused) && state.current_player) {
    const p = state.current_player;

    // IPL colours
    const colors  = typeof getIPLColors === 'function' ? getIPLColors(p.ipl_team) : null;
    const logoUrl = typeof getIPLLogoUrl === 'function' ? getIPLLogoUrl(p.ipl_team) : null;

    // IPL band
    const band = el('admin-ipl-band');
    if (band) band.style.background = colors ? colors.primary : 'var(--gold-dim)';

    // Avatar
    const img = el('cp-img');
    if (img) {
      img.src = p.image_url || SILHOUETTE_ADMIN;
      img.onerror = () => { img.src = SILHOUETTE_ADMIN; };
      img.style.display = 'block';
      img.style.borderColor = colors ? colors.primary : 'var(--gold-dim)';
      if (colors) img.style.boxShadow = `0 0 16px ${colors.glow}`;
    }

    // IPL logo overlay
    const logoEl = el('cp-ipl-logo');
    if (logoEl && logoUrl) { logoEl.src = logoUrl; logoEl.style.display = 'block'; }
    else if (logoEl) logoEl.style.display = 'none';

    // Name
    el('cp-name').textContent = p.name;

    // Meta badges
    const metaBadges = el('cp-meta-badges');
    if (metaBadges) {
      metaBadges.innerHTML = [
        { icon:'🎭', val: p.role || '—' },
        { icon:'🏏', val: p.ipl_team || '—', color: colors?.primary },
        { icon:'📁', val: p.set_name || '—' },
        { icon:'💰', val: `₹${p.base_price} Cr` },
      ].map(m => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:13px;
        color:var(--muted);background:rgba(255,255,255,0.04);border:1px solid var(--border);
        border-radius:4px;padding:3px 8px;">
        ${m.icon} <strong style="color:${m.color||'var(--text2)'};font-weight:600;">${m.val}</strong>
      </span>`).join('');
    }

    // Flags
    let flags = p.is_overseas
      ? '<span class="tag tag-overseas">🌍 Overseas</span>'
      : '<span class="tag tag-indian">🇮🇳 Indian</span>';
    flags += p.is_uncapped
      ? ' <span class="tag tag-uncapped">Uncapped</span>'
      : ' <span class="tag tag-capped">Capped</span>';
    if (p.is_rtm_eligible && !p.is_retained) flags += ' <span class="tag tag-rtm">🔄 RTM</span>';
    if (p.is_retained) flags += ' <span class="tag tag-retained">📌 Retained</span>';
    el('cp-flags').innerHTML = flags;

    // Mini stats grid — 4 chips, using shared .adv-stat CSS (matches auction page)
    const statsGrid = el('cp-stats-grid');
    if (statsGrid) {
      const _at = avgTier(p.bfl_avg);
      const avg = _at.label; const avgCls = _at.cls;
      const roleShort = { 'Batter':'BAT', 'Bowler':'BOWL', 'All-Rounder':'AR', 'Wicket-Keeper':'WK' }[p.role] || (p.role||'—').substring(0,4);
      statsGrid.innerHTML = [
        { val: avg,                                  cls: avgCls,                                        lbl: '📊 IPL 25 Avg' },
        { val: roleShort,                            cls: '',                                            lbl: '🎭 Role' },
        { val: p.is_overseas ? '🌍 OS' : '🇮🇳 IND',  cls: p.is_overseas ? 'warn' : 'good',               lbl: 'Origin' },
        { val: p.is_uncapped ? 'UNCAP' : 'CAP',     cls: p.is_uncapped ? 'good' : '',                   lbl: '🎖 Status' },
      ].map((s,i) => `<div class="adv-stat" style="animation-delay:${i*0.05}s">
        <div class="adv-stat-val ${s.cls}"${(s.lbl==='🏏 IPL'&&colors)?` style="color:${colors.primary}"`:''}>${s.val}</div>
        <div class="adv-stat-lbl">${s.lbl}</div>
      </div>`).join('');
    }

    // Bid data
    const hasBid = state.current_highest_bid > 0;
    el('current-bid').textContent  = hasBid ? fmt(state.current_highest_bid) : 'No bids';
    el('leading-team').textContent = state.highest_team?.team_name || '—';
    el('second-bid').textContent   = state.second_highest_bid > 0 ? fmt(state.second_highest_bid) : '—';
    el('second-team').textContent  = state.second_team?.team_name || '—';

    el('live-block').style.display = '';
    el('no-player').style.display  = 'none';

    if (isLive && !state.rtm_pending) startTimer(state.bid_timer_end);
    else { stopTimer(); const t = el('timer'); if (t) { t.textContent = isPaused ? 'Paused' : (state.rtm_pending ? 'RTM' : '—'); t.className = 'timer'; } }
  } else {
    clearAutoSell(); stopTimer();
    el('live-block').style.display = 'none';
    el('no-player').style.display  = '';
    el('no-player').textContent =
      state.status === 'sold'    ? '✓ Sold — select next player.' :
      state.status === 'set_live'? `Set Live: ${state.current_set_name}` :
      unsoldIds.size > 0         ? `Waiting — ${unsoldIds.size} unsold player(s).` :
                                   'Select a player to start.';
  }
}

function renderRTMAdminBlock(state) {
  let block = el('rtm-admin-block');
  if (!block) {
    block = document.createElement('div');
    block.id = 'rtm-admin-block';
    block.style.cssText = 'width:100%;';
    const controls = el('admin-controls');
    if (controls) controls.insertBefore(block, controls.firstChild);
  }
  if (state.rtm_pending) {
    const deadlineMs = state.rtm_deadline ? new Date(state.rtm_deadline).getTime() : null;
    const remInit = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : null;
    block.innerHTML = `
      <div class="rtm-admin-banner" style="position:relative;">
        ${remInit !== null ? `<div id="rtm-admin-countdown" style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;color:var(--gold);position:absolute;top:10px;right:12px;">${remInit}s</div>` : ''}
        <span class="rtm-admin-title">🔄 RTM PENDING</span>
        <span class="rtm-admin-sub">${state.rtm_team?.team_name || '?'} · Match: <strong>${fmt(state.rtm_match_price||0)}</strong>${remInit !== null ? ' · <span style="color:var(--muted);font-size:11px;">auto-declines when timer hits 0</span>' : ''}</span>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-gold btn-sm" onclick="adminExerciseRTM(true)">✓ Accept RTM</button>
          <button class="btn btn-ghost btn-sm" onclick="adminExerciseRTM(false)">✗ Decline</button>
        </div>
      </div>`;
    if (deadlineMs) startAdminRTMCountdown(deadlineMs);
  } else {
    stopAdminRTMCountdown();
    block.innerHTML = '';
  }
}

let adminRTMInterval = null;
function startAdminRTMCountdown(endMs) {
  clearInterval(adminRTMInterval); adminRTMInterval = null;
  adminRTMInterval = setInterval(() => {
    const t = el('rtm-admin-countdown');
    if (!t) { clearInterval(adminRTMInterval); adminRTMInterval = null; return; }
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    t.textContent = rem + 's';
    t.style.color = rem <= 10 ? 'var(--red)' : 'var(--gold)';
    if (rem <= 0) { clearInterval(adminRTMInterval); adminRTMInterval = null; }
  }, 300);
}
function stopAdminRTMCountdown() { clearInterval(adminRTMInterval); adminRTMInterval = null; }

// ─── TIMER ────────────────────────────────────────────────────
function startTimer(endTime) {
  stopTimer(); clearAutoSell();
  const endMs = new Date(endTime).getTime();
  function tick() {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t   = el('timer');
    if (!t) { stopTimer(); return; }
    t.textContent = rem + 's';
    t.className   = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
    if (rem === 0) {
      stopTimer();
      if (!autopilotEnabled) {
        // Show warning countdown, then fire at 12s
        showAutoSellWarning(12);
        autoSellTimer = setTimeout(async () => {
          hideAutoSellWarning();
          if (currentState?.status === 'live') await forceSell();
        }, 12000);
      }
    }
  }
  tick();
  timerInterval = setInterval(tick, 300);
}
function stopTimer()     { clearInterval(timerInterval); timerInterval = null; }
function clearAutoSell() {
  clearTimeout(autoSellTimer); autoSellTimer = null;
  hideAutoSellWarning();
}

function showAutoSellWarning(totalSecs) {
  const w = el('autosell-warning'); if (!w) return;
  w.classList.add('visible');
  let rem = totalSecs;
  const cd = el('autosell-cd'); if (cd) cd.textContent = rem;
  clearInterval(_autoSellCdTimer);
  _autoSellCdTimer = setInterval(() => {
    rem = Math.max(0, rem - 1);
    if (cd) cd.textContent = rem;
    if (rem <= 0) clearInterval(_autoSellCdTimer);
  }, 1000);
}

function hideAutoSellWarning() {
  const w = el('autosell-warning'); if (w) w.classList.remove('visible');
  clearInterval(_autoSellCdTimer); _autoSellCdTimer = null;
}

function cancelAutoSell() {
  clearAutoSell();
  toast('Auto-sell Cancelled', 'Use Force Sell when ready to close bidding', 'info');
}

// ─── UNSOLD QUEUE ─────────────────────────────────────────────
function renderUnsoldQueue() {
  const cont = el('unsold-queue-container'); if (!cont) return;
  if (!unsoldIds.size) { cont.innerHTML = ''; return; }
  const items = allPlayers.filter(p => unsoldIds.has(p.id));
  const SIL = window._SIL_ADMIN || '';
  cont.innerHTML = `<div class="unsold-queue-panel">
    <div class="unsold-queue-title">
      📭 Unsold Queue
      <span class="uq-count">${items.length} player${items.length !== 1 ? 's' : ''} awaiting re-launch</span>
    </div>
    <div class="unsold-queue-list">
      ${items.map(p => `
        <div class="uq-item">
          <img src="${p.image_url || SIL}" alt=""
            onerror="this.onerror=null;this.src='${SIL}'">
          <span class="uq-name">${p.name}</span>
          <span class="uq-meta">${p.role || '—'} · ${p.ipl_team || '—'} · ₹${p.base_price}Cr</span>
          <div class="uq-actions">
            <button class="btn btn-sm btn-start" onclick="startAuction('${p.id}')">↻ Re-launch</button>
            <button class="btn btn-sm btn-ghost" title="Remove unsold mark"
              onclick="undoUnsold('${p.id}')">↩</button>
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}

// ─── TEAMS ────────────────────────────────────────────────────
async function loadTeams() {
  await safeLoad(async () => {
    const { data: teams, error } = await sb.from('teams')
      .select('id,team_name,purse_remaining,is_advantage_holder,rtm_cards_total,rtm_cards_used')
      .order('team_name');
    if (error) throw new Error(error.message);
    allTeams = teams || [];

    const { data: squad } = await sb.from('team_players')
      .select('team_id, player:players_master(is_overseas)');
    const counts = {}, osCounts = {};
    (squad||[]).forEach(r => {
      counts[r.team_id]    = (counts[r.team_id]   || 0) + 1;
      if (r.player?.is_overseas) osCounts[r.team_id] = (osCounts[r.team_id]||0) + 1;
    });

    // Store squad counts on allTeams for sort access
    allTeams = allTeams.map(t => ({...t, playerCount: counts[t.id]||0, osCount: osCounts[t.id]||0}));
    renderAdminTeams();

    const sel = el('squad-team-select');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">Select Team…</option>' +
        allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');
      if (cur) sel.value = cur;
    }
  }, 'loadTeams');
}

// ─── ADMIN TEAMS SORT & RENDER ──────────────────────────────
let _adminTeamsSort = { key: 'purse_remaining', dir: 'desc' };

function adminSortTeams(key) {
  if (_adminTeamsSort.key === key) _adminTeamsSort.dir = _adminTeamsSort.dir === 'asc' ? 'desc' : 'asc';
  else { _adminTeamsSort.key = key; _adminTeamsSort.dir = key === 'team_name' ? 'asc' : 'desc'; }
  renderAdminTeams();
}

function renderAdminTeams() {
  const tbody = el('teams-tbody'); if (!tbody) return;
  const { key, dir } = _adminTeamsSort;
  const sorted = [...allTeams].sort((a, b) => {
    let va = a[key] ?? '', vb = b[key] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return dir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // Update header sort indicators
  const keyMap = { team_name:'ath-name', purse_remaining:'ath-purse', playerCount:'ath-squad', osCount:'ath-os' };
  Object.entries(keyMap).forEach(([k, id]) => {
    const th = el(id); if (!th) return;
    th.classList.remove('sort-asc','sort-desc');
    if (k === key) th.classList.add('sort-' + dir);
  });

  tbody.innerHTML = sorted.map(t => {
    const rtmTotal = (t.rtm_cards_total != null) ? t.rtm_cards_total : 0;
    const rtmRem   = Math.max(0, rtmTotal - (t.rtm_cards_used||0));
    const purse    = Number(t.purse_remaining);
    const purseColor = purse <= 5 ? 'var(--red)' : purse <= 10 ? '#f6ad55' : 'var(--gold)';
    const squadCount = t.playerCount || 0;
    const osCount    = t.osCount    || 0;
    return `<tr>
      <td>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;">${t.team_name}</span>
        ${t.is_advantage_holder ? ' <span class="tag tag-advantage" style="font-size:10px;">⭐ ADV</span>' : ''}
        ${rtmRem > 0 ? ` <span class="tag tag-rtm" style="font-size:10px;">🔄×${rtmRem}</span>` : ''}
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:800;color:${purseColor};white-space:nowrap;">
        ₹${purse.toFixed(1)}<span style="font-size:11px;font-weight:500;color:var(--muted);"> Cr</span>
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;white-space:nowrap;">
        ${squadCount}<span style="color:var(--muted);font-size:12px;font-weight:400;">/12</span>
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;white-space:nowrap;">
        ${osCount}<span style="color:var(--muted);font-size:12px;font-weight:400;">/4</span>
      </td>
    </tr>`;
  }).join('');
}

// ─── STATS ────────────────────────────────────────────────────
async function updateStats() {
  // Always fetch fresh from DB — prevents admin/team panel discrepancy
  try {
    const [{ data: tpRows }, { data: stateRow }] = await Promise.all([
      sb.from('team_players').select('sold_price,is_retained'),
      sb.from('auction_state').select('unsold_player_ids').eq('id',1).maybeSingle()
    ]);
    const total         = allPlayers.length;
    const auctionSold   = (tpRows||[]).filter(r => !r.is_retained).length;
    const retainedCount = (tpRows||[]).filter(r => r.is_retained).length;
    const sold          = auctionSold; // "sold" count = auction wins only (not retentions)
    const unsold        = (stateRow?.unsold_player_ids||[]).length;
    const remain        = Math.max(0, total - auctionSold - retainedCount - unsold);
    // Spent = sum of ALL costs (auction + retentions) for accurate purse reconciliation
    const spent = (tpRows||[]).reduce((s,r) => s + Number(r.sold_price||0), 0);
    el('stat-total').textContent     = total;
    el('stat-sold').textContent      = sold;
    el('stat-unsold').textContent    = unsold;
    el('stat-remaining').textContent = remain;
    el('stat-spent').textContent     = spent.toFixed(2);
  } catch(e) {
    // Fallback to in-memory
    const total = allPlayers.length;
    const sold  = Object.keys(soldMap).filter(k => !soldMap[k].is_retained).length;
    const unsold = unsoldIds.size;
    el('stat-total').textContent     = total;
    el('stat-sold').textContent      = sold;
    el('stat-unsold').textContent    = unsold;
    el('stat-remaining').textContent = Math.max(0, total - sold - unsold);
    el('stat-spent').textContent     = Object.values(soldMap).reduce((s,r) => s + Number(r.sold_price||0), 0).toFixed(2);
  }
}

// ─── HISTORY ──────────────────────────────────────────────────
async function loadHistory() {
  await safeLoad(async () => {
    const { data: sold, error: se } = await sb.from('team_players')
      .select('player_id,sold_price,sold_at,team_id,is_retained,is_rtm,team:teams(team_name),player:players_master(name,role,ipl_team,base_price,is_overseas,is_uncapped,set_no,set_name)');
    if (se) throw new Error(se.message);

    const soldEntries = (sold||[]).map(r => ({
      player_name: r.player?.name    || '?',
      role:        r.player?.role    || '?',
      ipl_team:    r.player?.ipl_team|| '—',
      base_price:  Number(r.player?.base_price||0),
      is_overseas: r.player?.is_overseas||false,
      is_uncapped: r.player?.is_uncapped||false,
      set_no:      r.player?.set_no  || '—',
      set_name:    r.player?.set_name|| '—',
      sold_to:     r.team?.team_name || '?',
      team_id:     r.team_id,
      sold_price:  r.sold_price,
      sold_at:     r.sold_at,
      is_retained: r.is_retained||false,
      is_rtm:      r.is_rtm||false,
      status:      'sold',
    }));

    const { data: ul } = await sb.from('unsold_log')
      .select('player_id,logged_at,player:players_master(name,role,ipl_team,base_price,is_overseas,is_uncapped,set_no,set_name)');
    const unsoldEntries = (ul||[]).map(r => ({
      player_name: r.player?.name    || '?',
      role:        r.player?.role    || '?',
      ipl_team:    r.player?.ipl_team|| '—',
      base_price:  Number(r.player?.base_price||0),
      is_overseas: r.player?.is_overseas||false,
      is_uncapped: r.player?.is_uncapped||false,
      set_no:      r.player?.set_no  || '—',
      set_name:    r.player?.set_name|| '—',
      sold_to:'—', team_id:null, sold_price:null,
      sold_at: r.logged_at, status:'unsold', player_id: r.player_id,
    }));

    if (ul) {
      unsoldLogMap = {};
      (ul||[]).forEach(r => { unsoldLogMap[r.player_id] = { logged_at: r.logged_at }; });
    }
    auctionHistory = [...soldEntries, ...unsoldEntries];
    renderHistory();
  }, 'loadHistory');
}

function clearHistoryFilters() {
  const ids = ['history-search','history-filter','history-role','history-set','history-date'];
  ids.forEach(id => { const e = el(id); if (e) e.value = ''; });
  renderHistory();
}

function _populateHistorySetFilter() {
  const sel = el('history-set'); if (!sel) return;
  const cur = sel.value;
  const sets = [...new Set(auctionHistory.map(r => r.set_name).filter(s => s && s !== '—'))].sort();
  sel.innerHTML = '<option value="">All Sets</option>' +
    sets.map(s => `<option value="${s}">${s}</option>`).join('');
  if (cur) sel.value = cur;
}

function renderHistory() {
  _populateHistorySetFilter();
  const q    = (el('history-search')?.value  || '').toLowerCase();
  const fil  =  el('history-filter')?.value  || '';
  const rolF =  el('history-role')?.value    || '';
  const setF =  el('history-set')?.value     || '';
  const datF =  el('history-date')?.value    || '';  // YYYY-MM-DD
  const tbody = el('history-tbody');

  let list = auctionHistory.filter(r => {
    if (fil  && r.status   !== fil)  return false;
    if (rolF && r.role     !== rolF) return false;
    if (setF && r.set_name !== setF) return false;
    if (datF && r.sold_at) {
      // Compare date portion only in local time
      const rowDate = new Date(r.sold_at).toLocaleDateString('en-CA'); // YYYY-MM-DD
      if (rowDate !== datF) return false;
    }
    if (q && !r.player_name.toLowerCase().includes(q) &&
             !(r.sold_to||'').toLowerCase().includes(q) &&
             !(r.ipl_team||'').toLowerCase().includes(q) &&
             !(r.set_name||'').toLowerCase().includes(q)) return false;
    return true;
  });

  list.sort((a, b) => {
    let va = a[hSortKey]??'', vb = b[hSortKey]??'';
    if (hSortKey === 'sold_at')   { va = va ? new Date(va).getTime():0; vb = vb ? new Date(vb).getTime():0; }
    else if (hSortKey === 'sold_price' || hSortKey === 'base_price') { va=Number(va)||0; vb=Number(vb)||0; }
    else if (typeof va==='string') { va=va.toLowerCase(); vb=vb.toLowerCase(); }
    return hSortDir === 'asc' ? (va>vb?1:-1) : (va<vb?1:-1);
  });

  document.querySelectorAll('#history-thead th[data-hkey]').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    if (th.dataset.hkey === hSortKey) th.classList.add('sort-' + hSortDir);
  });

  if (!list.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">No records yet</td></tr>'; return; }

  tbody.innerHTML = list.map(r => {
    const ts = r.sold_at ? new Date(r.sold_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
    const undoBtn = r.status==='sold'
      ? `<button class="btn btn-sm btn-ghost" onclick="undoSaleByPlayer('${r.player_name.replace(/'/g,"\\'")}','${(r.sold_to||'').replace(/'/g,"\\'")}',${r.sold_price!=null?r.sold_price:0})" title="Undo this sale">↩</button>`
      : `<button class="btn btn-sm btn-ghost" onclick="undoUnsoldByName('${r.player_name.replace(/'/g,"\\'")}')">↩</button>`;
    const retTag = r.is_retained ? '<span class="tag tag-retained" style="font-size:10px;">RTN</span> ' : '';
    const rtmTag = r.is_rtm     ? '<span class="tag tag-rtm"      style="font-size:10px;">RTM</span> ' : '';
    return `<tr>
      <td style="max-width:160px;"><strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.player_name}</strong>
        <div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:2px;">${retTag}${rtmTag}
        ${r.is_overseas?'<span class="tag tag-overseas" style="font-size:10px;">OS</span>':''}
        ${r.is_uncapped?'<span class="tag tag-uncapped" style="font-size:10px;">UC</span>':''}</div>
      </td>
      <td style="white-space:nowrap;font-size:13px;">${r.role}</td>
      <td style="white-space:nowrap;font-size:12px;color:var(--muted);">${r.ipl_team}</td>
      <td style="white-space:nowrap;">₹${r.base_price}</td>
      <td style="white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${r.sold_to}</td>
      <td style="white-space:nowrap;color:var(--gold);font-weight:700;">${r.sold_price!=null?fmt(r.sold_price):'—'}</td>
      <td style="white-space:nowrap;">${r.status==='sold'?'<span class="tag tag-sold">Sold</span>':'<span class="tag tag-unsold">Unsold</span>'}</td>
      <td style="font-size:12px;font-family:'Barlow Condensed',sans-serif;font-weight:700;text-align:center;white-space:nowrap;">${r.set_no||'—'}</td>
      <td style="font-size:12px;color:var(--muted);white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis;">${r.set_name||'—'}</td>
      <td style="font-size:12px;color:var(--muted);white-space:nowrap;">${ts}</td>
      <td>${undoBtn}</td>
    </tr>`;
  }).join('');
}

function hSortBy(key) {
  hSortDir = (hSortKey===key && hSortDir==='desc') ? 'asc' : 'desc';
  hSortKey = key; renderHistory();
}
function sortHistory(key) { hSortBy(key); }

// ─── EXPORT HISTORY CSV ───────────────────────────────────────
function exportHistoryCSV() {
  try {
    const q    = (el('history-search')?.value  || '').toLowerCase();
    const fil  =  el('history-filter')?.value  || '';
    const rolF =  el('history-role')?.value    || '';
    let list = auctionHistory.filter(r => {
      if (fil  && r.status !== fil)  return false;
      if (rolF && r.role   !== rolF) return false;
      if (q && !r.player_name.toLowerCase().includes(q) &&
               !(r.sold_to||'').toLowerCase().includes(q) &&
               !(r.ipl_team||'').toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) => {
      let va = a[hSortKey]??'', vb = b[hSortKey]??'';
      if (hSortKey === 'sold_at') { va = va?new Date(va).getTime():0; vb = vb?new Date(vb).getTime():0; }
      else if (['sold_price','base_price'].includes(hSortKey)) { va=Number(va)||0; vb=Number(vb)||0; }
      else if (typeof va==='string') { va=va.toLowerCase(); vb=vb.toLowerCase(); }
      return hSortDir === 'asc' ? (va>vb?1:-1) : (va<vb?1:-1);
    });
    const headers = ['#','Player','Role','IPL Team','Base (Cr)','Sold To','Sold Price (Cr)','Status','Time','Retained','RTM','Overseas','Uncapped'];
    const rows = list.map((r,i) => {
      const ts = r.sold_at ? new Date(r.sold_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
      return [i+1,r.player_name,r.role,r.ipl_team,r.base_price,r.sold_to,r.sold_price!=null?Number(r.sold_price).toFixed(2):'—',r.status,ts,r.is_retained?'Yes':'',r.is_rtm?'Yes':'',r.is_overseas?'Yes':'',r.is_uncapped?'Yes':''];
    });
    const csv = [headers,...rows].map(row => row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
    a.download = 'BFL_Auction_History.csv'; a.click();
    toast('CSV Exported', 'History file downloaded successfully', 'success');
  } catch(e) { toast('Export Failed', 'Could not generate file', 'error'); }
}

// ─── EXPORT HISTORY PDF ───────────────────────────────────────
function exportHistoryPDF() {
  try {
    const q    = (el('history-search')?.value  || '').toLowerCase();
    const fil  =  el('history-filter')?.value  || '';
    const rolF =  el('history-role')?.value    || '';
    let list = auctionHistory.filter(r => {
      if (fil  && r.status !== fil)  return false;
      if (rolF && r.role   !== rolF) return false;
      if (q && !r.player_name.toLowerCase().includes(q) &&
               !(r.sold_to||'').toLowerCase().includes(q) &&
               !(r.ipl_team||'').toLowerCase().includes(q)) return false;
      return true;
    });
    const soldList   = list.filter(r => r.status === 'sold');
    const unsoldList = list.filter(r => r.status === 'unsold');
    const totalSpent = soldList.reduce((s,r) => s+Number(r.sold_price||0),0);
    const rows_html  = list.sort((a,b) => {
      const ta = a.sold_at?new Date(a.sold_at).getTime():0;
      const tb = b.sold_at?new Date(b.sold_at).getTime():0;
      return tb - ta;
    }).map((r,i) => {
      const ts = r.sold_at ? new Date(r.sold_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
      const tags=[r.is_retained?'RTN':'',r.is_rtm?'RTM':'',r.is_overseas?'OS':'',r.is_uncapped?'UC':''].filter(Boolean).join(' ');
      const isSold = r.status === 'sold';
      return `<tr>
        <td>${i+1}</td>
        <td><strong>${r.player_name}</strong>${tags?`<br><small style="color:#999;">${tags}</small>`:''}</td>
        <td>${r.role}</td>
        <td>${r.ipl_team}</td>
        <td>₹${r.base_price}</td>
        <td>${r.sold_to||'—'}</td>
        <td style="font-weight:${isSold?'700':'400'};color:${isSold?'#b7791f':'#999'};">${r.sold_price!=null?'₹'+Number(r.sold_price).toFixed(2):'—'}</td>
        <td><span style="background:${isSold?'#e6f4e6':'#f5f5f5'};color:${isSold?'#276749':'#777'};padding:2px 6px;border-radius:3px;font-size:11px;">${r.status.toUpperCase()}</span></td>
        <td style="font-size:11px;color:#888;">${ts}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>BFL 2026 — Auction History</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:20px;}
        h1{font-size:20px;margin-bottom:4px;}
        .sub{font-size:11px;color:#666;margin-bottom:14px;}
        .stat-row{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;}
        .stat{background:#f7f7f7;border:1px solid #ddd;border-radius:5px;padding:8px 14px;text-align:center;min-width:80px;}
        .stat-val{font-size:18px;font-weight:700;color:#b7791f;}
        .stat-lbl{font-size:10px;color:#666;text-transform:uppercase;}
        table{width:100%;border-collapse:collapse;}
        th{background:#1a1a2e;color:#f0b429;padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;}
        td{padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;}
        @media print{body{padding:8px;} .no-print{display:none!important;}}
      </style></head><body>
      <h1>🏏 BFL IPL 2026 — Auction History</h1>
      <div class="sub">Generated ${new Date().toLocaleString('en-IN')}</div>
      <div class="stat-row">
        <div class="stat"><div class="stat-val">${list.length}</div><div class="stat-lbl">Total</div></div>
        <div class="stat"><div class="stat-val">${soldList.length}</div><div class="stat-lbl">Sold</div></div>
        <div class="stat"><div class="stat-val">${unsoldList.length}</div><div class="stat-lbl">Unsold</div></div>
        <div class="stat"><div class="stat-val">₹${totalSpent.toFixed(1)}</div><div class="stat-lbl">Total Spent Cr</div></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Player</th><th>Role</th><th>IPL</th><th>Base</th><th>Sold To</th><th>Price</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>${rows_html}</tbody>
      </table>
      <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
    const w = window.open('','_blank'); if (w) { w.document.write(html); w.document.close(); }
    toast('PDF Ready', 'History report opened in new tab', 'success');
  } catch(e) { toast('PDF Failed', 'Could not generate report', 'error'); }
}

// ─── EXPORT ALL SQUADS PDF ────────────────────────────────────
async function exportAllSquadsPDF() {
  try {
    const { data: allSquads } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,team_id,team:teams(team_name,purse_remaining,is_advantage_holder,rtm_cards_total,rtm_cards_used),player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)');
    if (!allSquads) { toast('No Data', 'No squad data available to export', 'warn'); return; }
    const byTeam = {};
    allSquads.forEach(r => {
      const tn = r.team?.team_name||r.team_id;
      if (!byTeam[tn]) byTeam[tn] = { team: r.team, players: [] };
      byTeam[tn].players.push(r);
    });
    const sections = Object.entries(byTeam).sort(([a],[b])=>a.localeCompare(b)).map(([tn,td]) => {
      const players = td.players.sort((a,b) => (a.player?.name||'').localeCompare(b.player?.name||''));
      const spent = players.reduce((s,r)=>s+Number(r.sold_price||0),0);
      const os  = players.filter(r=>r.player?.is_overseas).length;
      const uc  = players.filter(r=>r.player?.is_uncapped).length;
      const rtn = players.filter(r=>r.is_retained).length;
      const purse = Number(td.team?.purse_remaining||0);
      const rows_html = players.map((tp,i) => {
        const p = tp.player||{};
        const tags=[tp.is_retained?'RTN':'',tp.is_rtm?'RTM':'',p.is_overseas?'OS':'',p.is_uncapped?'UC':''].filter(Boolean).join(' ');
        return `<tr style="${tp.is_retained?'background:#fffbeb;':''}">
          <td>${i+1}</td><td><strong>${p.name||'?'}</strong>${tags?`<br><small style="color:#999;">${tags}</small>`:''}</td>
          <td>${p.role||'—'}</td><td>${p.ipl_team||'—'}</td>
          <td style="text-align:center;color:${avgTier(p.bfl_avg).color};font-weight:700;">${avgTier(p.bfl_avg).label}</td>
          <td>₹${p.base_price||0}</td>
          <td style="font-weight:700;color:#b7791f;">₹${Number(tp.sold_price||0).toFixed(2)}</td>
        </tr>`;
      }).join('');
      return `<div class="team-block">
        <h2>${tn} ${td.team?.is_advantage_holder?'⭐':''}</h2>
        <div class="team-stats">
          <span>Players: <strong>${players.length}/12</strong></span>
          <span>Spent: <strong>₹${spent.toFixed(1)} Cr</strong></span>
          <span>Remaining: <strong>₹${purse.toFixed(1)} Cr</strong></span>
          <span>OS: <strong>${os}/4</strong></span>
          <span>UC: <strong>${uc}</strong></span>
          <span>RTN: <strong>${rtn}</strong></span>
        </div>
        <table><thead><tr><th>#</th><th>Player</th><th>Role</th><th>IPL Team</th><th>IPL 25 Avg</th><th>Base</th><th>Paid</th></tr></thead>
        <tbody>${rows_html}</tbody></table>
      </div>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>BFL 2026 — All Team Squads</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:20px;}
        h1{font-size:20px;margin-bottom:4px;}
        .sub{font-size:11px;color:#666;margin-bottom:16px;}
        .team-block{margin-bottom:28px;page-break-inside:avoid;}
        .team-block h2{font-size:15px;margin-bottom:6px;color:#1a1a2e;border-bottom:2px solid #f0b429;padding-bottom:4px;}
        .team-stats{display:flex;gap:14px;font-size:11px;margin-bottom:8px;flex-wrap:wrap;color:#555;}
        .team-stats strong{color:#1a1a1a;}
        table{width:100%;border-collapse:collapse;margin-bottom:4px;}
        th{background:#1a1a2e;color:#f0b429;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;}
        td{padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top;}
        @media print{.team-block{page-break-inside:avoid;} body{padding:10px;}}
      </style></head><body>
      <h1>🏏 BFL IPL 2026 — All Team Squads</h1>
      <div class="sub">Generated ${new Date().toLocaleString('en-IN')} · ${Object.keys(byTeam).length} teams</div>
      ${sections}
      <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
    const w = window.open('','_blank'); if (w) { w.document.write(html); w.document.close(); }
    toast('PDF Ready', 'All squads report opened in new tab', 'success');
  } catch(e) { toast('PDF Failed', e.message, 'error'); console.error(e); }
}

// ─── EXPORT ALL SQUADS CSV ────────────────────────────────────
async function exportAllSquadsCSV() {
  try {
    const { data: allSquads } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,team_id,team:teams(team_name),player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)');
    if (!allSquads) { toast('No squad data','warn'); return; }
    const headers = ['BFL Team','#','Player','Role','IPL Team','IPL 25 Avg','Base (Cr)','Paid (Cr)','Retained','RTM','Overseas','Uncapped'];
    const byTeam = {};
    allSquads.forEach(r => {
      const tn = r.team?.team_name||r.team_id;
      if (!byTeam[tn]) byTeam[tn] = [];
      byTeam[tn].push(r);
    });
    const rows = [];
    Object.entries(byTeam).sort(([a],[b])=>a.localeCompare(b)).forEach(([tn,players]) => {
      players.sort((a,b)=>(a.player?.name||'').localeCompare(b.player?.name||''));
      players.forEach((r,i) => {
        const p = r.player||{};
        rows.push([tn,i+1,p.name||'?',p.role||'?',p.ipl_team||'?',
          p.bfl_avg?Number(p.bfl_avg).toFixed(1):'—',p.base_price||0,
          Number(r.sold_price||0).toFixed(2),r.is_retained?'Yes':'',r.is_rtm?'Yes':'',
          p.is_overseas?'Yes':'',p.is_uncapped?'Yes':'']);
      });
    });
    const csv = [headers,...rows].map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
    a.download='BFL_All_Squads.csv'; a.click();
    toast('CSV Exported', 'All squads file downloaded', 'success');
  } catch(e) { toast('CSV Failed', 'Could not generate CSV file', 'error'); }
}

// ─── EXPORT SINGLE TEAM SQUAD PDF (admin) ────────────────────
async function exportTeamSquadPDF() {
  const teamId = el('squad-team-select')?.value;
  if (!teamId) { toast('No Team Selected', 'Please select a team first', 'warn'); return; }
  const team = allTeams.find(t => t.id === teamId);
  try {
    const { data: rows } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)')
      .eq('team_id', teamId);
    const list = (rows||[]).sort((a,b)=>(a.player?.name||'').localeCompare(b.player?.name||''));
    const totalSpent = list.reduce((s,r)=>s+Number(r.sold_price||0),0);
    const os  = list.filter(r=>r.player?.is_overseas).length;
    const uc  = list.filter(r=>r.player?.is_uncapped).length;
    const rtn = list.filter(r=>r.is_retained).length;
    const rows_html = list.map((tp,i) => {
      const p = tp.player||{};
      const tags=[tp.is_retained?'RTN':'',tp.is_rtm?'RTM':'',p.is_overseas?'OS':'',p.is_uncapped?'UC':''].filter(Boolean).join(' ');
      return `<tr style="${tp.is_retained?'background:#fffbeb;':''}">
        <td>${i+1}</td><td><strong>${p.name||'?'}</strong>${tags?`<br><small style="color:#999;">${tags}</small>`:''}</td>
        <td>${p.role||'—'}</td><td>${p.ipl_team||'—'}</td>
        <td style="text-align:center;">${p.bfl_avg?Number(p.bfl_avg).toFixed(1):'—'}</td>
        <td>₹${p.base_price||0}</td>
        <td style="font-weight:700;color:#b7791f;">₹${Number(tp.sold_price||0).toFixed(2)}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>${team?.team_name||'Team'} — BFL 2026 Squad</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:20px;}
        h1{font-size:20px;margin-bottom:4px;} .sub{font-size:11px;color:#666;margin-bottom:14px;}
        .stat-row{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;}
        .stat{background:#f7f7f7;border:1px solid #ddd;border-radius:5px;padding:8px 14px;text-align:center;min-width:80px;}
        .stat-val{font-size:18px;font-weight:700;color:#b7791f;}
        .stat-lbl{font-size:10px;color:#666;text-transform:uppercase;}
        table{width:100%;border-collapse:collapse;}
        th{background:#1a1a2e;color:#f0b429;padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase;}
        td{padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;}
        @media print{body{padding:8px;}}
      </style></head><body>
      <h1>🏏 ${team?.team_name||'Team'}${team?.is_advantage_holder?' ⭐':''}</h1>
      <div class="sub">BFL IPL 2026 Auction Squad · Generated ${new Date().toLocaleString('en-IN')}</div>
      <div class="stat-row">
        <div class="stat"><div class="stat-val">${list.length}/12</div><div class="stat-lbl">Players</div></div>
        <div class="stat"><div class="stat-val">₹${totalSpent.toFixed(1)}</div><div class="stat-lbl">Total Spent</div></div>
        <div class="stat"><div class="stat-val">₹${Number(team?.purse_remaining||0).toFixed(1)}</div><div class="stat-lbl">Remaining</div></div>
        <div class="stat"><div class="stat-val">${os}/4</div><div class="stat-lbl">Overseas</div></div>
        <div class="stat"><div class="stat-val">${uc}</div><div class="stat-lbl">Uncapped</div></div>
        <div class="stat"><div class="stat-val">${rtn}</div><div class="stat-lbl">Retained</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Player</th><th>Role</th><th>IPL Team</th><th>IPL 25 Avg</th><th>Base</th><th>Paid</th></tr></thead>
      <tbody>${rows_html}</tbody></table>
      <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
    const w = window.open('','_blank'); if (w) { w.document.write(html); w.document.close(); }
    toast('PDF Ready', 'Squad report opened in new tab', 'success');
  } catch(e) { toast('PDF failed','error'); }
}

// ─── SQUADS TAB ───────────────────────────────────────────────
async function renderSquadView() {
  const teamId = el('squad-team-select').value;
  const cont   = el('squad-view-content');
  if (!teamId) { cont.innerHTML = '<div class="empty-cell">Select a team above.</div>'; return; }
  cont.innerHTML = '<div class="empty-cell">Loading…</div>';

  const { data: rows, error } = await sb.from('team_players')
    .select('sold_price,sold_at,is_retained,is_rtm,player:players_master(id,name,role,ipl_team,is_overseas,is_uncapped,is_rtm_eligible,base_price)')
    .eq('team_id', teamId);
  if (error) { cont.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }

  const team = allTeams.find(t => t.id === teamId);
  squadRows  = (rows||[]).map(r => ({ ...r.player, sold_price: r.sold_price, sold_at: r.sold_at, is_retained: r.is_retained||false, is_rtm: r.is_rtm||false }));
  renderSquadTable(team);
}

function renderSquadTable(team) {
  const cont = el('squad-view-content');

  const sqSearch = (el('squad-search')?.value||'').toLowerCase();
  const sqRole   = el('squad-role-filter')?.value||'';
  const sqOsOnly = el('squad-os-filter')?.checked||false;
  const sqUcOnly = el('squad-uc-filter')?.checked||false;

  let list = squadRows.filter(p => {
    if (sqRole && p.role !== sqRole) return false;
    if (sqOsOnly && !p.is_overseas)  return false;
    if (sqUcOnly && !p.is_uncapped)  return false;
    if (sqSearch && !p.name.toLowerCase().includes(sqSearch) &&
                    !(p.ipl_team||'').toLowerCase().includes(sqSearch)) return false;
    return true;
  });

  list.sort((a,b) => {
    let va = a[sqSortKey]??'', vb = b[sqSortKey]??'';
    if (typeof va==='string') { va=va.toLowerCase(); vb=vb.toLowerCase(); }
    else { va=Number(va)||0; vb=Number(vb)||0; }
    return sqSortDir==='asc'?(va>vb?1:-1):(va<vb?1:-1);
  });

  const spent  = squadRows.reduce((s,r)=>s+Number(r.sold_price||0),0);
  const os     = squadRows.filter(r=>r.is_overseas).length;
  const rtn    = squadRows.filter(r=>r.is_retained).length;
  const purse  = Number(team?.purse_remaining||0);
  const rtmTotal = (team?.rtm_cards_total != null) ? team.rtm_cards_total : 0;
  const rtmRem   = Math.max(0, rtmTotal - (team?.rtm_cards_used||0));

  // Only rebuild stat bar + filters once — prevents flicker on every filter keystroke
  if (!el('squad-stat-bar')) {
    cont.innerHTML = `
      <div id="squad-stat-bar" class="stats-row" style="margin-bottom:14px;">
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-count">${squadRows.length}/12</div><div class="stat-chip-lbl">Players</div></div>
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-spent">&#8377;${spent.toFixed(1)}</div><div class="stat-chip-lbl">Spent Cr</div></div>
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-purse">&#8377;${purse.toFixed(1)}</div><div class="stat-chip-lbl">Remaining</div></div>
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-os">${os}/4</div><div class="stat-chip-lbl">Overseas</div></div>
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-rtn">${rtn}</div><div class="stat-chip-lbl">Retained</div></div>
        <div class="stat-chip"><div class="stat-chip-val" id="sq-chip-rtm">${rtmRem}</div><div class="stat-chip-lbl">RTM Left</div></div>
      </div>
      <div id="squad-filter-bar" class="filters-bar" style="margin-bottom:10px;">
        <input class="form-input" type="text" id="squad-search" placeholder="Search..." style="width:160px;" oninput="renderSquadTableOnly()">
        <select class="form-input" id="squad-role-filter" style="width:140px;" onchange="renderSquadTableOnly()">
          <option value="">All Roles</option>
          <option>Batter</option><option>Bowler</option><option>All-Rounder</option><option>Wicket-Keeper</option>
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:var(--muted);cursor:pointer;">
          <input type="checkbox" id="squad-os-filter" onchange="renderSquadTableOnly()"> OS only
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:13px;color:var(--muted);cursor:pointer;">
          <input type="checkbox" id="squad-uc-filter" onchange="renderSquadTableOnly()"> UC only
        </label>
      </div>
      <div id="squad-table-area"></div>
      <div id="squad-comp-area"></div>`;
  } else {
    // Update stat chips in-place — no DOM rebuild, no flicker
    const sc = (id,v) => { const e=el(id); if(e) e.textContent=v; };
    sc('sq-chip-count', squadRows.length+'/12');
    sc('sq-chip-spent', '\u20B9'+spent.toFixed(1));
    sc('sq-chip-purse', '\u20B9'+purse.toFixed(1));
    sc('sq-chip-os',    os+'/4');
    sc('sq-chip-rtn',   rtn);
    sc('sq-chip-rtm',   rtmRem);
  }

  // Re-render only the table body
  const tableArea = el('squad-table-area'); if (!tableArea) return;
  tableArea.innerHTML = !list.length ? '<div class="empty-cell">No players match filter</div>' : `
    <div class="table-wrap" style="max-height:360px;overflow:auto;">
      <table class="data-table" style="min-width:520px;">
        <thead><tr>
          <th style="width:28px;">#</th>
          <th onclick="sqSortBy('name')">Name</th>
          <th onclick="sqSortBy('role')">Role</th>
          <th onclick="sqSortBy('ipl_team')">IPL Team</th>
          <th onclick="sqSortBy('base_price')">Base</th>
          <th onclick="sqSortBy('sold_price')">Paid</th>
          <th>Tags</th>
        </tr></thead>
        <tbody>
          ${list.map((p,i)=>{
            let tags='';
            if(p.is_retained) tags+='<span class="tag tag-retained">RTN</span> ';
            if(p.is_rtm)      tags+='<span class="tag tag-rtm">RTM</span> ';
            if(p.is_overseas) tags+='<span class="tag tag-overseas">OS</span> ';
            if(p.is_uncapped) tags+='<span class="tag tag-uncapped">UC</span>';
            return '<tr class="'+(p.is_retained?'row-retained':'')+'">' +
              '<td>'+(i+1)+'</td>' +
              '<td><strong>'+p.name+'</strong></td>' +
              '<td>'+p.role+'</td>' +
              '<td>'+(p.ipl_team||'&mdash;')+'</td>' +
              '<td>&#8377;'+p.base_price+'</td>' +
              '<td style="color:var(--gold);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;">&#8377;'+Number(p.sold_price).toFixed(2)+'</td>' +
              '<td>'+(tags||'&mdash;')+'</td>' +
              '</tr>';
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const compArea = el('squad-comp-area');
  if (compArea) renderAdminSquadComp(squadRows.map(r=>r), team, compArea);
}

function renderSquadTableOnly() {
  const team = allTeams.find(t => t.id === el('squad-team-select')?.value);
  renderSquadTable(team);
}
function sqSortBy(key) {
  sqSortDir = (sqSortKey===key && sqSortDir==='asc') ? 'desc' : 'asc';
  sqSortKey = key; renderSquadTableOnly();
}

// ─── Squad composition validator (IPL rules) ──────────────────
function renderAdminSquadComp(players, team, container) {
  if (!container) return;
  if (!players.length) { container.innerHTML = ''; return; }

  const wk   = players.filter(p => p.role === 'Wicket-Keeper').length;
  const bat  = players.filter(p => p.role === 'Batter').length;
  const bowl = players.filter(p => p.role === 'Bowler').length;
  const ar   = players.filter(p => p.role === 'All-Rounder').length;
  const uc   = players.filter(p => p.is_uncapped).length;
  const os   = players.filter(p => p.is_overseas).length;
  const total= players.length;
  const isAdv = team?.is_advantage_holder;

  // IPL team limit
  const iplCounts = {};
  players.forEach(p => {
    if (p.ipl_team) iplCounts[p.ipl_team] = (iplCounts[p.ipl_team]||0) + 1;
  });
  const iplViolations = isAdv ? [] : Object.entries(iplCounts).filter(([,c]) => c > 3).map(([t]) => t);

  const issues = [];
  if (wk < 1)   issues.push(`Need ${1-wk} more WK`);
  if (bat < 2)  issues.push(`Need ${2-bat} more BAT`);
  if (bowl < 3) issues.push(`Need ${3-bowl} more BOWL`);
  if (ar < 2)   issues.push(`Need ${2-ar} more AR`);
  if (uc < 1)   issues.push('Need 1+ Uncapped');
  if (os > 4)   issues.push(`OS limit (${os}/4)`);
  if (total > 12) issues.push(`Over limit (${total}/12)`);
  iplViolations.forEach(t => issues.push(`Max 3 from ${t}`));

  const allMet = !issues.length;
  const complete = total === 12 && allMet;
  const meaningful = total >= 8;

  const roleDefs = [
    { label:'WK',   val:wk,   min:1 },
    { label:'BAT',  val:bat,  min:2 },
    { label:'BOWL', val:bowl, min:3 },
    { label:'AR',   val:ar,   min:2 },
    { label:'UC',   val:uc,   min:1 },
    { label:'OS',   val:os,   max:4 },
    { label:'TOTAL',val:total,min:12,max:12 },
  ];

  container.innerHTML = `<div class="squad-comp-bar" style="margin-top:10px;">
    <div class="squad-comp-header">
      <span class="${complete?'squad-comp-ok':(allMet&&meaningful)?'squad-comp-ok':'squad-comp-warn'}">
        ${complete ? '✓ Squad Complete' : (allMet&&meaningful) ? '✓ Requirements Met' : issues.length ? '⚠ '+issues.length+' issue(s)' : `Building (${total}/12)`}
      </span>
      <span style="font-size:11px;opacity:0.6;">${total}/12 players · ${os}/4 OS${isAdv?' · Advantage (IPL limit exempt)':''}</span>
    </div>
    <div class="squad-role-grid">
      ${roleDefs.map(r => {
        let ok;
        if (r.min !== undefined && r.max !== undefined) ok = r.val >= r.min && r.val <= r.max;
        else if (r.max) ok = r.val <= r.max;
        else ok = r.val >= r.min;
        return `<div class="squad-role-chip ${ok?'met':'unmet'}">
          <div class="squad-role-chip-val">${r.val}${r.max?'/'+r.max:''}</div>
          <div class="squad-role-chip-lbl">${r.label}</div>
        </div>`;
      }).join('')}
    </div>
    ${issues.length?`<div class="squad-issues-list">${issues.map(i=>`<span class="squad-issue-tag">${i}</span>`).join('')}</div>`:''}
  </div>`;
}

// ─── TABS ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  el('tab-'+name)?.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick')?.includes("'"+name+"'")) b.classList.add('active');
  });
  if (name === 'history')    renderHistory();
  if (name === 'sets')       renderSetLauncher();
  if (name === 'retentions') renderRetentionView();
  if (name === 'rtmsetup')   initRTMSetup();
}

// ─── REALTIME — single channel ────────────────────────────────
function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);

  realtimeChannel = sb.channel('admin-v7')
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_state' }, () => {
      dbt('state', async () => {
        await loadAuctionState();
        await loadTeams();
        renderPlayerList();
        updateStats();
      }, 250);
    })
    .on('postgres_changes', { event:'*', schema:'public', table:'team_players' }, () => {
      dbt('players', async () => {
        await loadPlayers(); await loadTeams(); await loadHistory(); updateStats();
      }, 350);
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'unsold_log' }, () => {
      dbt('players', async () => {
        await loadPlayers(); await loadHistory(); updateStats();
      }, 350);
    })
    .on('system', {}, p => {
      if (p.status === 'SUBSCRIBED') setConn('connected');
      if (['CHANNEL_ERROR','TIMED_OUT'].includes(p.status)) {
        setConn('reconnecting'); setTimeout(subscribeRealtime, 5000);
      }
    })
    .subscribe(s => { if (s === 'SUBSCRIBED') setConn('connected'); });
}

// ─── UI HELPERS ───────────────────────────────────────────────
function setConn(state) {
  const dot = el('conn-dot'); if (!dot) return;
  dot.className = 'conn-dot ' + state;
  dot.title = {connected:'Connected',reconnecting:'Reconnecting…',error:'Error'}[state]||state;
}
// ── Toast config ─────────────────────────────────────────────
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/></svg>',
  rtm:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>',
};
const TOAST_TITLES = {
  success: 'Success', error: 'Error Occurred',
  warn: 'Warning', info: 'Info', rtm: 'RTM Opportunity',
};
const TOAST_DURATION = { success:4000, error:6000, warn:5000, info:4000, rtm:8000 };
const _knownTypes = ['success','error','warn','info','rtm'];

function _stripEmoji(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/^[\s\u00B7\-]+/, '').replace(/\s{2,}/g, ' ').trim();
}
function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(titleOrMsg, subtitleOrType, typeArg) {
  const c = el('toast-container'); if (!c) return;
  let title, sub, t;
  if (_knownTypes.includes(subtitleOrType) && !typeArg) {
    t = subtitleOrType; title = TOAST_TITLES[t]; sub = _stripEmoji(titleOrMsg);
  } else if (typeArg && _knownTypes.includes(typeArg)) {
    t = typeArg; title = _stripEmoji(titleOrMsg); sub = _stripEmoji(subtitleOrType);
  } else {
    t = 'info'; title = TOAST_TITLES.info; sub = _stripEmoji(titleOrMsg);
  }
  const dur = TOAST_DURATION[t] || 4000;
  const d = document.createElement('div');
  d.className = 'toast toast-' + t;
  d.style.setProperty('--toast-dur', dur + 'ms');
  d.innerHTML =
    '<div class="toast-icon">' + (TOAST_ICONS[t]||'') + '</div>' +
    '<div class="toast-body">' +
      '<div class="toast-title">' + _esc(title) + '</div>' +
      (sub ? '<div class="toast-sub">' + _esc(sub) + '</div>' : '') +
    '</div>' +
    '<button class="toast-close" onclick="this.closest(\'.toast\').remove()">&#x2715;</button>' +
    '<div class="toast-progress"></div>';
  c.appendChild(d);
  while (c.children.length > 5) c.removeChild(c.firstChild);
  setTimeout(() => d.classList.add('toast-exit'), dur - 350);
  setTimeout(() => d.remove(), dur + 200);
}
function showError(msg) {
  const e = el('admin-error');
  if (e) { e.textContent = msg; setTimeout(() => { if(e.textContent===msg) e.textContent=''; }, 8000); }
  toast('Error Occurred', msg, 'error');
  console.error('[Admin]', msg);
}
function clearError()   { const e=el('admin-error'); if(e) e.textContent=''; }

// ─── QUICK-LAUNCH ─────────────────────────────────────────────
function quickLaunchSearch(q) {
  const dd = el('ql-dropdown');
  if (!dd) return;
  _qlFocusIdx = -1;
  q = (q || '').trim();
  if (!q) { dd.innerHTML = ''; dd.classList.remove('open'); return; }
  const lq = q.toLowerCase();
  const SIL = window._SIL_ADMIN || '';
  const results = allPlayers.filter(p => {
    if (soldMap[p.id]) return false; // skip sold
    return p.name.toLowerCase().includes(lq)
        || (p.role || '').toLowerCase().includes(lq)
        || (p.ipl_team || '').toLowerCase().includes(lq)
        || (p.set_name || '').toLowerCase().includes(lq);
  }).slice(0, 10);

  if (!results.length) {
    dd.innerHTML = '<div class="ql-empty">No available players match "' + q + '"</div>';
    dd.classList.add('open'); return;
  }
  dd.innerHTML = results.map((p, i) => {
    const isUnsold = unsoldIds.has(p.id);
    return `<div class="ql-item" data-idx="${i}" data-id="${p.id}"
        onclick="qlLaunch('${p.id}')"
        onmouseover="_qlFocusIdx=${i};qlHighlight()">
      <img src="${p.image_url || SIL}" alt=""
        onerror="this.onerror=null;this.src='${SIL}'">
      <span class="ql-item-name">${p.name}</span>
      <span class="ql-item-meta">${p.role || '?'} · ${p.ipl_team || '?'} · ₹${p.base_price}Cr</span>
      ${isUnsold ? '<span class="ql-unsold-badge">Unsold</span>' : ''}
    </div>`;
  }).join('');
  dd.classList.add('open');
}

function qlHighlight() {
  const dd = el('ql-dropdown'); if (!dd) return;
  dd.querySelectorAll('.ql-item').forEach((el, i) => {
    el.classList.toggle('active', i === _qlFocusIdx);
  });
}

function qlKey(e) {
  const dd = el('ql-dropdown');
  if (!dd || !dd.classList.contains('open')) return;
  const items = [...dd.querySelectorAll('.ql-item[data-id]')];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _qlFocusIdx = Math.min(_qlFocusIdx + 1, items.length - 1);
    qlHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _qlFocusIdx = Math.max(_qlFocusIdx - 1, 0);
    qlHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = dd.querySelector('.ql-item.active') || items[0];
    if (active) qlLaunch(active.dataset.id);
  } else if (e.key === 'Escape') {
    dd.classList.remove('open');
    const inp = el('ql-input'); if (inp) inp.value = '';
  }
}

async function qlLaunch(playerId) {
  const dd = el('ql-dropdown'), inp = el('ql-input');
  if (dd) dd.classList.remove('open');
  if (inp) inp.value = '';
  if (!playerId) return;
  const p = allPlayers.find(x => x.id === playerId);
  if (!p) return;
  const label = unsoldIds.has(p.id) ? 'Re-launch' : 'Start';
  if (!await confirm2(
    `**${label} auction** for:

${p.name} (${p.role || '?'} · ${p.ipl_team || '?'})
Base price: ₹${p.base_price} Cr`,
    { title: label + ' Auction', icon: '▶', danger: false }
  )) return;
  await startAuction(playerId);
}

// Close dropdown on outside click
document.addEventListener('click', e => {
  const wrap = e.target.closest('.quick-launch-wrap');
  if (!wrap) { const dd = el('ql-dropdown'); if (dd) dd.classList.remove('open'); }
});

init();

// ═══════════════════════════════════════════════════════════════
//  SET-WISE AUCTION
// ═══════════════════════════════════════════════════════════════
async function loadSetGroups() {
  const avail = allPlayers.filter(p => !soldMap[p.id] && !unsoldIds.has(p.id));
  const groups = {};
  avail.forEach(p => {
    const s = p.set_name || 'Uncategorised';
    if (!groups[s]) groups[s] = [];
    groups[s].push(p);
  });
  return groups;
}

async function renderSetLauncher() {
  const cont = el('set-launcher'); if (!cont) return;
  cont.innerHTML = '<div class="empty-cell">Loading…</div>';
  const groups = await loadSetGroups();
  const sets   = Object.keys(groups).sort();
  const isSetLive = currentState?.status === 'set_live';
  const liveSet   = currentState?.current_set_name || '';

  if (!sets.length && !isSetLive) {
    cont.innerHTML = '<div class="empty-cell">All players auctioned or no sets defined.</div>'; return;
  }

  let html = '';
  if (isSetLive && activeSetSlots.length) html += renderLiveSetPanel();

  for (const sName of sets) {
    const players = groups[sName];
    const isActive = isSetLive && liveSet === sName;
    const chips = players.slice(0,6).map(p =>
      `<div class="set-player-chip">
        <img src="${p.image_url||''}" onerror="this.style.display='none'" alt="">
        <span>${p.name}</span>
        <span style="color:var(--muted);font-size:10px;">${p.role}</span>
      </div>`
    ).join('') + (players.length>6?`<span style="color:var(--muted);font-size:12px;">+${players.length-6} more</span>`:'');

    html += `<div class="set-launch-card${isActive?' is-live':''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div>
          <span style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;color:var(--gold);">${sName}</span>
          <span style="color:var(--muted);font-size:13px;margin-left:8px;">${players.length} player${players.length!==1?'s':''}</span>
          ${isActive?'<span class="tag tag-live" style="margin-left:8px;">LIVE</span>':''}
        </div>
        ${!isActive?`<button class="btn btn-gold btn-sm" onclick="launchSetAuction('${sName.replace(/'/g,"\\'")}')">⚡ Launch ${players.length} players</button>`:''}
      </div>
      <div class="set-players">${chips}</div>
    </div>`;
  }
  cont.innerHTML = html || '<div class="empty-cell">No available sets.</div>';
}

function renderLiveSetPanel() {
  if (!activeSetSlots.length) return '';
  const endMs = Math.max(...activeSetSlots.map(s => new Date(s.bid_timer_end).getTime()));

  // Start the live countdown ticker
  clearInterval(adminSetTimerInterval);
  adminSetTimerInterval = setInterval(() => {
    const t = document.getElementById('admin-set-timer');
    if (!t) { clearInterval(adminSetTimerInterval); return; }
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    t.textContent = rem + 's';
    t.className = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
    if (rem <= 0) clearInterval(adminSetTimerInterval);
  }, 250);

  const initRem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));

  const slotCards = activeSetSlots.map(slot => {
    const player  = allPlayers.find(p => p.id === slot.player_id) || {};
    const hasBid  = slot.current_highest_bid > 0;
    const has2nd  = slot.second_highest_bid > 0;
    const leadTeam  = slot._highest_team?.team_name || '—';
    const secondTeam = slot._second_team?.team_name || '';
    return `<div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;padding:12px;flex:1;min-width:160px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <img src="${player.image_url||''}" onerror="this.style.display='none'" alt=""
          style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--border);">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:14px;">${player.name||'?'}</div>
          <div style="font-size:11px;color:var(--muted);">${player.role||''}</div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:700;color:${hasBid?'var(--gold)':'var(--muted)'};">
        ${hasBid ? fmt(slot.current_highest_bid) : 'No bids'}
      </div>
      ${hasBid ? `<div style="font-size:11px;color:var(--muted);">${leadTeam}</div>` : ''}
      ${has2nd ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;">2nd: ${fmt(slot.second_highest_bid)}${secondTeam?' · '+secondTeam:''}</div>` : ''}
    </div>`;
  }).join('');

  return `<div style="background:rgba(240,180,41,0.05);border:2px solid var(--gold-dim);border-radius:10px;padding:16px;margin-bottom:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
      <div>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;color:var(--gold);">SET LIVE: ${currentState?.current_set_name||''}</span>
        <span style="color:var(--muted);font-size:13px;margin-left:8px;">${activeSetSlots.length} players</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="text-align:center;">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;">Timer</div>
          <div id="admin-set-timer" class="timer${initRem<=5?' timer-critical':initRem<=10?' timer-warning':''}" style="font-size:34px;">${initRem}s</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="closeSetAuction()">🔨 Close Set</button>
        <button class="btn-cancel-set" onclick="cancelSetAuction()" title="Stop set auction without selling — returns all players to available pool">✕ Cancel Set</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">${slotCards}</div>
  </div>`;
}

async function launchSetAuction(setName) {
  if (!await confirm2(`Launch all **${setName}** players simultaneously?\nAll teams bid on any player at the same time.`, {title:`Launch: ${setName}`,icon:'⚡'})) return;
  clearError();
  const { data, error } = await sb.rpc('start_set_auction', { p_set_name: setName });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error||'Error');
  toast('Set Launched', setName + ' is live with ' + data.player_count + ' players', 'success');
  await loadAuctionState();
  await loadSetSlots(setName);
  subscribeSetSlots(setName);
  await renderSetLauncher();
}

async function closeSetAuction() {
  if (!await confirm2('Players with bids → **SOLD**. No bids → **UNSOLD**.', {title:'Close Set',icon:'🔨',danger:true})) return;
  clearError();
  const setName = currentState?.current_set_name;
  if (!setName) return showError('No active set auction');
  const { data, error } = await sb.rpc('close_set_auction', { p_set_name: setName });
  if (error) return showError(error.message);
  if (!data?.success) return showError(data?.error||'Error');
  toast('Set Complete', data.sold + ' sold, ' + data.unsold + ' unsold', 'success');
  clearInterval(adminSetTimerInterval);
  if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
  activeSetSlots = [];
  await Promise.all([loadPlayers(), loadTeams(), loadHistory(), loadAuctionState()]);
  await updateStats(); renderSetLauncher();
}

async function cancelSetAuction() {
  const setName = currentState?.current_set_name;
  if (!setName) return showError('No active set auction');
  if (!await confirm2(
    `Cancel the **${setName}** set auction?\n\nAll players return to the available pool. No sales recorded.`,
    { title:'Cancel Set Auction', danger:true, icon:'✕' }
  )) return;
  clearError();

  // Set auction_state back to waiting, clear set_name
  const { error: stateErr } = await sb.from('auction_state')
    .update({ status:'waiting', current_set_name: null, current_player_id: null,
              current_highest_bid: 0, current_highest_team_id: null,
              second_highest_bid: 0, second_highest_team_id: null,
              bid_timer_end: null, rtm_pending: false })
    .eq('id', 1);
  if (stateErr) return showError(stateErr.message);

  // Return all live slots back to waiting
  const { error: slotsErr } = await sb.from('auction_slots')
    .update({ status: 'waiting', current_highest_bid: 0,
              current_highest_team_id: null, second_highest_bid: 0,
              second_highest_team_id: null, bid_timer_end: null })
    .eq('set_name', setName).eq('status', 'live');
  if (slotsErr) console.warn('Slots reset warn:', slotsErr.message);

  toast('Set Cancelled', setName + ' cancelled — players returned to pool', 'warn');
  clearInterval(adminSetTimerInterval);
  if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
  activeSetSlots = [];
  await Promise.all([loadPlayers(), loadTeams(), loadAuctionState()]);
  await updateStats();
  await renderSetLauncher();
}

async function loadSetSlots(setName) {
  const { data, error } = await sb.from('auction_slots')
    .select('*, highest_team:teams!auction_slots_current_highest_team_id_fkey(team_name), second_team:teams!auction_slots_second_highest_team_id_fkey(team_name)')
    .eq('set_name', setName).eq('status', 'live');
  if (error) { console.warn('[SetSlots]', error.message); return; }
  activeSetSlots = (data||[]).map(s => ({ ...s, _highest_team: s.highest_team, _second_team: s.second_team }));
}

function subscribeSetSlots(setName) {
  if (setSlotChannel) sb.removeChannel(setSlotChannel);
  setSlotChannel = sb.channel('set-slots-' + setName)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_slots', filter:'set_name=eq.'+setName }, async () => {
      await loadSetSlots(setName);
      const tab = el('tab-sets');
      if (tab?.classList.contains('active')) renderSetLauncher();
    }).subscribe();
}

// ═══════════════════════════════════════════════════════════════
//  RETENTION TAB
// ═══════════════════════════════════════════════════════════════
const RETENTION_COSTS = { 1: 15, 2: 10, 3: 5 };

async function renderRetentionView() {
  const cont = el('retention-content'); if (!cont) return;
  cont.innerHTML = '<div class="empty-cell">Loading…</div>';

  // Graceful degradation if is_retained col missing
  let retentions, error;
  ({ data: retentions, error } = await sb.from('team_players')
    .select('team_id,player_id,sold_price,retention_slot,is_retained,player:players_master(name,role,ipl_team,is_overseas,is_uncapped),team:teams(team_name,purse_remaining,rtm_cards_total,rtm_cards_used)')
    .eq('is_retained', true).order('team_id'));
  if (error) {
    cont.innerHTML = `<div class="error-msg">${error.message}<br><small>Run 12_fix_set_live.sql first.</small></div>`;
    return;
  }

  const byTeam = {};
  (retentions||[]).forEach(r => {
    const tn = r.team?.team_name || r.team_id;
    if (!byTeam[tn]) byTeam[tn] = { purse: r.team?.purse_remaining, rtm_total: r.team?.rtm_cards_total||0, rtm_used: r.team?.rtm_cards_used||0, players: [] };
    byTeam[tn].players.push(r);
  });

  const addForm = `
    <div class="card" style="margin-bottom:14px;">
      <div class="card-title">➕ Add Retention / RTM</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div>
          <div class="form-label">Team</div>
          <select class="form-input" id="ret-team" style="width:180px;">
            <option value="">Select…</option>
            ${allTeams.map(t=>`<option value="${t.id}">${t.team_name}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="form-label">Player</div>
          <select class="form-input" id="ret-player" style="width:200px;">
            <option value="">Select…</option>
            ${allPlayers.map(p=>`<option value="${p.id}">${p.name} (${p.role}${p.is_overseas?',OS':''}${p.is_uncapped?',UC':''})</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="form-label">Slot (Retention Cost)</div>
          <select class="form-input" id="ret-slot" style="width:180px;">
            <option value="1">Slot 1 — ₹15 Cr (capped)</option>
            <option value="2">Slot 2 — ₹10 Cr (capped)</option>
            <option value="3">Slot 3 — ₹5 Cr (uncapped)</option>
          </select>
        </div>
        <button class="btn btn-gold btn-sm" onclick="addRetention()">Add</button>
      </div>
      <div class="info-msg" style="margin-top:8px;">
        <strong style="color:var(--gold);">IPL RTM Rules:</strong><br>
        Retain 3 players → <strong>0 RTM cards</strong> · Retain 2 → <strong>1 RTM card</strong> · Retain 1 → <strong>2 RTM cards</strong> · Retain 0 → <strong>3 RTM cards</strong><br>
        <span style="color:var(--muted);font-size:11px;">Max 2 capped players + max 1 uncapped player across retentions. RTM applies to players from your previous season's squad.</span>
      </div>
      <div id="ret-error" class="error-msg"></div>
    </div>`;

  if (!Object.keys(byTeam).length) {
    cont.innerHTML = addForm + '<div class="empty-cell">No retentions yet.</div>'; return;
  }

  const tables = Object.entries(byTeam).map(([teamName, td]) => {
    const rtmRem = td.rtm_total - td.rtm_used;
    return `<div style="margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;color:var(--gold);">${teamName}</div>
        <span style="color:var(--muted);font-size:13px;">Purse ₹${Number(td.purse||0).toFixed(2)} Cr</span>
        ${rtmRem>0?`<span class="tag tag-rtm">RTM ×${rtmRem} remaining</span>`:'<span class="tag tag-unsold">No RTM cards</span>'}
      </div>
      <table class="data-table">
        <thead><tr><th>Slot</th><th>Player</th><th>Role</th><th>Cost</th><th>Tags</th><th></th></tr></thead>
        <tbody>
          ${td.players.map(r=>`<tr>
            <td>Slot ${r.retention_slot||'?'}</td>
            <td><strong>${r.player?.name||'?'}</strong></td>
            <td>${r.player?.role||'?'}</td>
            <td>${fmt(r.sold_price)}</td>
            <td>${r.player?.is_overseas?'<span class="tag tag-overseas">OS</span> ':''}${r.player?.is_uncapped?'<span class="tag tag-uncapped">UC</span>':''}</td>
            <td><button class="btn btn-sm btn-ghost" onclick="removeRetention('${r.player_id}','${r.team_id}',${r.sold_price})">Remove</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');

  cont.innerHTML = addForm + tables;
}

async function addRetention() {
  const teamId   = el('ret-team')?.value;
  const playerId = el('ret-player')?.value;
  const slot     = parseInt(el('ret-slot')?.value || '1');
  const price    = RETENTION_COSTS[slot] || 15;
  const errEl    = el('ret-error');
  if (!teamId || !playerId) { errEl.textContent = 'Select team and player.'; return; }
  errEl.textContent = '';
  const { data, error } = await sb.rpc('add_retention', { p_team_id:teamId, p_player_id:playerId, p_price:price, p_slot:slot });
  if (error) { errEl.textContent = error.message; return; }
  if (!data?.success) { errEl.textContent = data?.error||'Error'; return; }
  toast('Retention Added', 'Slot ' + slot + ' — ' + price + ' Cr', 'success');
  await Promise.all([loadTeams(), loadPlayers(), renderRetentionView()]); updateStats();
}

async function removeRetention(playerId, teamId, price) {
  if (!await confirm2('Remove retention? Purse ₹'+Number(price).toFixed(2)+' Cr will be **refunded**.', {title:'Remove Retention',icon:'🗑'})) return;
  // Try RPC first (also clears players_master.is_retained), fallback to manual
  const { data, error } = await sb.rpc('remove_retention', { p_player_id: playerId, p_team_id: teamId });
  if (error || !data?.success) {
    // Fallback manual removal
    await sb.from('team_players').delete().eq('player_id', playerId).eq('is_retained', true);
    await sb.from('players_master').update({ is_retained: false }).eq('id', playerId);
    const { data: t } = await sb.from('teams').select('purse_remaining').eq('id', teamId).single();
    if (t) await sb.from('teams').update({ purse_remaining: Number(t.purse_remaining)+Number(price) }).eq('id', teamId);
  }
  toast('Retention Removed', Number(price).toFixed(2) + ' Cr refunded to team', 'warn');
  await Promise.all([loadTeams(), loadPlayers(), renderRetentionView()]); updateStats();
}
// ─────────────────────────────────────────────────────────────
//  RTM SETUP TAB — Assign prev_bfl_team to players
// ─────────────────────────────────────────────────────────────

let rtmPlayers   = [];   // all non-retained players from players_master
let rtmTeamNames = [];   // team names for dropdown

async function initRTMSetup() {
  // Load all non-retained players
  const { data: players } = await sb
    .from('players_master')
    .select('id,name,role,ipl_team,prev_bfl_team,is_rtm_eligible,is_retained,is_overseas,is_uncapped,bfl_avg')
    .eq('is_retained', false)
    .order('name');
  rtmPlayers = players || [];

  // Load team names for dropdown
  if (!rtmTeamNames.length) {
    rtmTeamNames = allTeams.map(t => t.team_name).sort();
  }

  // Populate team filter
  const sel = el('rtm-team-filter');
  if (sel) {
    sel.innerHTML = '<option value="">All Teams</option>' +
      rtmTeamNames.map(n => `<option value="${n}">${n}</option>`).join('') +
      '<option value="__none__">— Not Assigned —</option>';
  }

  renderRTMSetup();
}

function renderRTMSetup() {
  const cont   = el('rtm-setup-content');
  if (!cont) return;

  const q      = (el('rtm-search')?.value || '').toLowerCase();
  const teamF  =  el('rtm-team-filter')?.value  || '';
  const statF  =  el('rtm-status-filter')?.value || '';

  let list = rtmPlayers.filter(p => {
    if (q     && !p.name.toLowerCase().includes(q)) return false;
    if (teamF === '__none__') { if (p.prev_bfl_team) return false; }
    else if (teamF && p.prev_bfl_team !== teamF) return false;
    if (statF === 'assigned'   && !p.prev_bfl_team) return false;
    if (statF === 'unassigned' &&  p.prev_bfl_team) return false;
    return true;
  });

  const assigned = rtmPlayers.filter(p => p.prev_bfl_team).length;

  cont.innerHTML = `
    <div style="margin-bottom:10px;font-size:12px;color:var(--muted);">
      Showing <strong style="color:var(--text);">${list.length}</strong> players &nbsp;·&nbsp;
      <strong style="color:var(--gold);">${assigned}</strong> of ${rtmPlayers.length} assigned
    </div>
    <div class="table-wrap" style="max-height:520px;overflow:auto;">
      <table class="data-table">
        <thead><tr>
          <th>Player</th><th>Role</th><th>IPL Team</th>
          <th>IPL 25 Avg</th><th>OS/UC</th>
          <th style="min-width:200px;">Prev BFL Team (for RTM)</th>
          <th>RTM</th>
        </tr></thead>
        <tbody>
          ${list.map(p => {
            const tags = [p.is_overseas?'OS':'',p.is_uncapped?'UC':''].filter(Boolean).join(' ');
            const teamOpts = '<option value="">— None —</option>' +
              rtmTeamNames.map(n =>
                `<option value="${n}" ${p.prev_bfl_team===n?'selected':''}>${n}</option>`
              ).join('');
            const rtmBadge = p.is_rtm_eligible
              ? '<span class="tag tag-rtm">✓ RTM</span>'
              : '<span style="color:var(--muted);font-size:11px;">—</span>';
            return `<tr>
              <td><strong>${p.name}</strong></td>
              <td style="font-size:12px;">${p.role}</td>
              <td style="font-size:12px;color:var(--muted);">${p.ipl_team||'—'}</td>
              <td style="font-size:12px;">${p.bfl_avg?Number(p.bfl_avg).toFixed(1):'—'}</td>
              <td style="font-size:11px;color:var(--muted);">${tags||'—'}</td>
              <td>
                <select class="form-input" style="width:100%;font-size:13px;padding:5px 8px;"
                  onchange="setPrevBFLTeam('${p.id}', this.value, this)">
                  ${teamOpts}
                </select>
              </td>
              <td>${rtmBadge}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted);">
      💡 Setting a Prev BFL Team automatically marks the player as RTM Eligible.
      Clearing it removes RTM eligibility.
    </div>`;
}

async function setPrevBFLTeam(playerId, teamName, selectEl) {
  const prevVal = selectEl.dataset.prevVal ?? selectEl.value;
  selectEl.disabled = true;

  const updates = teamName
    ? { prev_bfl_team: teamName, is_rtm_eligible: true  }
    : { prev_bfl_team: null,     is_rtm_eligible: false };

  const { error } = await sb
    .from('players_master')
    .update(updates)
    .eq('id', playerId);

  selectEl.disabled = false;

  if (error) {
    toast('Update Failed', error.message, 'error');
    return;
  }

  // Update local cache
  const idx = rtmPlayers.findIndex(p => p.id === playerId);
  if (idx >= 0) {
    rtmPlayers[idx].prev_bfl_team  = teamName || null;
    rtmPlayers[idx].is_rtm_eligible = !!teamName;
  }
  selectEl.dataset.prevVal = teamName;

  // Update RTM badge in same row
  const row = selectEl.closest('tr');
  if (row) {
    const badge = row.querySelector('td:last-child');
    if (badge) {
      badge.innerHTML = teamName
        ? '<span class="tag tag-rtm">✓ RTM</span>'
        : '<span style="color:var(--muted);font-size:11px;">—</span>';
    }
  }

  toast(
    teamName ? 'RTM Assigned' : 'RTM Removed',
    teamName ? (teamName.split(' ').pop() + ' assigned RTM eligibility') : 'RTM eligibility cleared',
    teamName ? 'success' : 'warn'
  );

  // Also reload main player list if visible
  await loadPlayers();
}

// Hook into switchTab to lazy-load RTM setup
const _origSwitchTab = typeof switchTab === 'function' ? switchTab : null;