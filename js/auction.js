// ═══════════════════════════════════════════════════════════════
//  AUCTION.JS v25
//  1.  All v24 features preserved
//  2.  Last-sold banner: IPL team color + logo + animations
//  3.  Advanced player bid card (bfl_avg, role, OS, UC, etc.)
//  4.  Squad validation: WK/BAT/BOWL/AR/UC/OS/IPL-limit/12 total
//  5.  Team PDF export (squad with all player details)
// ═══════════════════════════════════════════════════════════════

let timerInterval    = null;
let setTimerInterval = null;
let rtmTimerInterval = null;
let realtimeChannel  = null;
let setSlotChannel   = null;
let pollInterval     = null;
let myTeam           = null;
let currentState     = null;
let _lastStateHash   = '';
let _lastSlotsHash   = '';
let _isRendering     = false;
let _lastAppliedStatus = '';
let _squadLoading    = false;
let _teamsCache      = [];
let _rtmAlerted      = false;
let _lastSquadData   = [];
let _wasLeading      = false;  // track lead state for outbid alert
let _connState       = 'connected';
let _prevPurse       = null;  // for purse delta display
let _reconnectTimer  = null;
let _reconnectCount  = 0;
let _bidTs           = 0;

const SIL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%23111520' rx='40'/%3E%3Ccircle cx='40' cy='28' r='14' fill='%2364748b'/%3E%3Cellipse cx='40' cy='70' rx='22' ry='18' fill='%2364748b'/%3E%3C/svg%3E";
window._SIL = SIL;

const dbt = (key, fn, ms=400) => { clearTimeout(_dbt[key]); _dbt[key] = setTimeout(fn, ms); };
const _dbt = {};

const el     = id => document.getElementById(id);
const show   = id => { const e=el(id); if(e) e.style.display=''; };
const hide   = id => { const e=el(id); if(e) e.style.display='none'; };
const fmt    = v  => '₹' + Number(v).toFixed(2) + ' Cr';
const playerCountry = p => { if (!p) return '—'; return p.country || (p.is_overseas ? 'Overseas' : 'India'); };
const imgSrc = u  => u || SIL;

const stateHash = s => !s ? '' :
  [s.status, s.current_player_id, s.current_highest_bid,
   s.current_highest_team_id, s.bid_timer_end, s.rtm_pending,
   s.rtm_team_id, s.last_player_result, s.last_player_id,
   s.last_sold_price, s.current_set_name, s.rtm_deadline,
   (s.unsold_player_ids||[]).length].join('|');

// ── IPL team helpers ──────────────────────────────────────────
function getIPLColors(code) {
  const map = {
    CSK:  { primary:'#f7c948', secondary:'#00184e', glow:'rgba(247,201,72,0.3)' },
    MI:   { primary:'#005da0', secondary:'#d1ab3e', glow:'rgba(0,93,160,0.35)' },
    RCB:  { primary:'#d41620', secondary:'#1a1a1a', glow:'rgba(212,22,32,0.35)' },
    KKR:  { primary:'#6a1bac', secondary:'#b08c3c', glow:'rgba(106,27,172,0.35)' },
    SRH:  { primary:'#f26522', secondary:'#1a1a1a', glow:'rgba(242,101,34,0.35)' },
    DC:   { primary:'#004c93', secondary:'#ef2826', glow:'rgba(0,76,147,0.35)' },
    PBKS: { primary:'#aa192f', secondary:'#dbbe6c', glow:'rgba(170,25,47,0.35)' },
    RR:   { primary:'#2d62a4', secondary:'#e83f5b', glow:'rgba(45,98,164,0.35)' },
    GT:   { primary:'#1c3e6e', secondary:'#c8a84b', glow:'rgba(28,62,110,0.35)' },
    LSG:  { primary:'#00b4d8', secondary:'#c6a200', glow:'rgba(0,180,216,0.35)' },
  };
  return map[(code||'').toUpperCase()] || null;
}
function getIPLLogoUrl(code) {
  if (!code) return null;
  const c = (code||'').trim().toUpperCase();
  // Local images folder — e.g. images/CSKoutline.png
  return `images/${c}outline.png`;
}

// IPL 25 Fantasy Avg tier helper (max observed ~154)
function avgTier(v) {
  if (!v) return { cls:'', label:'—', color:'var(--muted)' };
  const n = Number(v);
  if (n >= 120) return { cls:'avg-elite',  label:n.toFixed(1), color:'#fbbf24', badge:'Elite' };
  if (n >=  90) return { cls:'avg-good',   label:n.toFixed(1), color:'var(--green)', badge:'Good' };
  if (n >=  60) return { cls:'avg-fair',   label:n.toFixed(1), color:'#60a5fa', badge:'Fair' };
  return         { cls:'avg-weak',   label:n.toFixed(1), color:'#94a3b8', badge:'Weak' };
}

function applyIPLCSSVars(el, code) {
  const colors = getIPLColors(code);
  if (!colors) {
    el.style.removeProperty('--ipl-primary');
    el.style.removeProperty('--ipl-secondary');
    el.style.removeProperty('--ipl-primary-glow');
    return;
  }
  el.style.setProperty('--ipl-primary',      colors.primary);
  el.style.setProperty('--ipl-secondary',    colors.secondary);
  el.style.setProperty('--ipl-primary-glow', colors.glow);
}

// ── Sound alert ───────────────────────────────────────────────
function playRTMAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880 + i * 220;
      g.gain.setValueAtTime(0.35, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
    });
  } catch(e) {}
}

function playOutbidAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Two descending tones — "you lost it" feel
    [[400, 0], [300, 0.18]].forEach(([freq, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.3, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.35);
    });
  } catch(e) {}
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

async function doLogout() { stopPolling(); await sb.auth.signOut(); location.href = 'index.html'; }

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { data:{ session } } = await sb.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  if (session.user.app_metadata?.role === 'admin') { location.href = 'admin.html'; return; }
  const { data: team } = await sb.from('teams').select('*').eq('user_id', session.user.id).maybeSingle();
  if (!team) { location.href = 'index.html'; return; }
  myTeam = team;
  await Promise.all([fetchState(), loadSquad(), loadStats(), loadAllTeams()]);
  revealUI(); startPolling(); subscribeRealtime();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { fetchState(); loadAllTeams(); }
  });
}

function revealUI() {
  hide('auction-skeleton'); hide('stats-skeleton'); hide('squad-skeleton');
  show('stats-real'); show('squad-table-wrap'); show('role-pool-wrap');
  const tn = el('team-name'); if (tn) tn.textContent = myTeam.team_name;
  updatePurseDisplay();
  if (myTeam.is_advantage_holder) show('advantage-badge');
  updateRTMBadge();
}

function updateRTMBadge() {
  const rem = Math.max(0, (myTeam.rtm_cards_total||0) - (myTeam.rtm_cards_used||0));
  const b = el('rtm-badge');
  if (b) { b.textContent = 'RTM ×' + rem; b.style.display = rem > 0 ? 'inline-block' : 'none'; }
}
function updatePurseDisplay() {
  const pd = el('purse-display');
  if (pd) {
    const purse = Number(myTeam.purse_remaining);
    const delta = _prevPurse !== null ? purse - _prevPurse : 0;
    _prevPurse = purse;
    // Show delta badge briefly
    if (delta < -0.001) {
      const badge = document.createElement('span');
      badge.className = 'purse-delta';
      badge.textContent = '−₹' + Math.abs(delta).toFixed(2);
      pd.parentNode?.appendChild(badge);
      setTimeout(() => badge.remove(), 2200);
    }
    pd.textContent = fmt(purse);
    pd.classList.add('purse-updated');
    setTimeout(() => pd.classList.remove('purse-updated'), 500);
    pd.classList.toggle('purse-critical', purse <= 5);
    pd.classList.toggle('purse-low',      purse > 5 && purse <= 10);
  }
}

// ── Polling ───────────────────────────────────────────────────
function startPolling() { stopPolling(); pollInterval = setInterval(fetchState, 2500); }
function stopPolling()  { clearInterval(pollInterval); pollInterval = null; }

// ── Core state fetch ──────────────────────────────────────────
async function fetchState() {
  if (_isRendering) return;
  try {
    const { data: state, error } = await sb.from('auction_state')
      .select(`*,
        current_player:players_master!auction_state_current_player_id_fkey(*),
        highest_team:teams!auction_state_current_highest_team_id_fkey(team_name,id),
        second_team:teams!auction_state_second_highest_team_id_fkey(team_name)`)
      .eq('id', 1).maybeSingle();
    if (error || !state) return;

    if (state.rtm_team_id) {
      const { data: rt } = await sb.from('teams').select('team_name,id').eq('id', state.rtm_team_id).maybeSingle();
      state.rtm_team = rt || null;
    } else { state.rtm_team = null; }

    if (state.last_player_id) {
      const { data: lp } = await sb.from('players_master')
        .select('id,name,role,image_url,ipl_team,bfl_avg,is_overseas,is_uncapped,country').eq('id', state.last_player_id).maybeSingle();
      state.last_player = lp || null;
    } else { state.last_player = null; }

    if (!state.second_team && state.second_highest_team_id) {
      const { data: st2 } = await sb.from('teams').select('team_name').eq('id', state.second_highest_team_id).maybeSingle();
      state.second_team = st2 || null;
    }

    if (state.status === 'set_live' && state.current_set_name) {
      const { data: slots } = await sb.from('auction_slots')
        .select('id,current_highest_bid,current_highest_team_id,second_highest_bid,second_highest_team_id,bid_timer_end')
        .eq('set_name', state.current_set_name).eq('status', 'live');
      const sh = (slots||[]).map(s => s.id+':'+s.current_highest_bid+':'+s.current_highest_team_id+':'+s.second_highest_bid).join('|');
      if (sh !== _lastSlotsHash) { _lastSlotsHash = sh; _lastStateHash = ''; }
    }

    const hash = stateHash(state);
    if (hash === _lastStateHash) return;
    _lastStateHash = hash;
    currentState = state;
    _isRendering = true;
    try { await applyState(state); }
    finally { _isRendering = false; }
  } catch(e) { console.warn('[fetchState]', e.message); }
}


// ── Lightweight bid stats update (no DOM re-render) ───────────
function updateLiveBidStats(state) {
  const p = state.current_player; if (!p) return;
  const isLeading = state.current_highest_team_id === myTeam?.id;
  const hasBid    = state.current_highest_bid > 0;

  // Leading team label
  const leadEl = el('leading-team-label');
  if (leadEl) {
    leadEl.textContent = hasBid ? (state.highest_team?.team_name || '—') : '—';
    leadEl.style.color = isLeading ? 'var(--green)' : '';
  }
  // Bid amount
  const bidEl = el('current-bid-display');
  if (bidEl) bidEl.textContent = hasBid ? fmt(state.current_highest_bid) : '—';

  // Was-leading flag for outbid toast
  if (hasBid && !isLeading && _wasLeading) {
    _wasLeading = false;
    toast('Outbid', 'Now leading: ' + fmt(state.current_highest_bid) + ' by ' + (state.highest_team?.team_name||'?'), 'warn');
  }
  if (isLeading) _wasLeading = true;

  // Bid input floor
  const inp = el('bid-input');
  if (inp && !inp.matches(':focus')) {
    const next = Math.max(
      Number(p.base_price||0),
      hasBid ? Number(state.current_highest_bid)+0.25 : Number(p.base_price||0)
    );
    if (parseFloat(inp.value) < next) inp.value = next.toFixed(2);
    inp.min = next.toFixed(2);
  }
}
// ── Apply state ───────────────────────────────────────────────
let _lastPurseHash = '';
async function applyState(state) {
  const statusEl = el('auction-status');
  if (statusEl) {
    const labels = { waiting:'Waiting', live:'LIVE', sold:'Sold', paused:'Paused', set_live:'SET LIVE' };
    statusEl.textContent = state.rtm_pending ? 'RTM' : (labels[state.status] || state.status);
    statusEl.className   = 'status-badge status-' + (state.rtm_pending ? 'rtm' : state.status);
  }

  renderLastResult(state);
  // Only refresh purse when it may have changed: team is leading, or just got outbid
  const purseHash = (state.current_highest_team_id||'')+(state.current_highest_bid||0)+(state.status||'');
  if (purseHash !== _lastPurseHash) { _lastPurseHash = purseHash; await refreshPurse(); }

  if (state.rtm_pending) {
    stopTimer(); stopSetTimer();
    hide('player-card'); hide('no-auction'); hide('set-auction-view');
    renderRTMPending(state);

  } else if (state.status === 'set_live') {
    stopTimer(); stopRTMTimer();
    _rtmAlerted = false;
    hide('no-auction'); hide('rtm-pending'); hide('set-auction-view');
    show('player-card');
    await renderSetInPlayerCard(state);

  } else if ((state.status === 'live' || state.status === 'paused') && state.current_player) {
    stopSetTimer(); stopRTMTimer();
    _rtmAlerted = false;
    if (state.current_player_id !== currentState?._prevPlayerId) { _wasLeading = false; }
    hide('set-auction-view'); hide('no-auction'); hide('rtm-pending');
    renderLivePlayer(state, state.status === 'paused');
    if (state.current_player_id) loadBidHistory(state.current_player_id);

  } else {
    stopTimer(); stopSetTimer(); stopRTMTimer();
    _rtmAlerted = false;
    if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
    hide('player-card'); hide('set-auction-view'); hide('rtm-pending');
    show('no-auction');

    const noMsg = el('no-auction-msg');
    if (noMsg) {
      if (state.last_player_result === 'set_done')
        noMsg.innerHTML = '<strong>Set Complete</strong> — ' + (state.last_sold_to_team||'');
      else if (state.last_player_result === 'sold' && state.last_player)
        noMsg.innerHTML = '<strong>' + state.last_player.name + '</strong> sold to <strong>' + state.last_sold_to_team + '</strong> for <strong>' + fmt(state.last_sold_price) + '</strong>';
      else if (state.last_player_result === 'unsold' && state.last_player)
        noMsg.innerHTML = '<strong>' + state.last_player.name + '</strong> went <strong>unsold</strong>';
      else if (state.status === 'paused')
        noMsg.textContent = 'Auction is paused';
      else
        noMsg.textContent = 'Waiting for admin to start next player…';
    }
    await Promise.all([loadSquad(), loadStats()]);
    renderMiniHistory('mini-history-wrap');
  }
  // Only re-render all-teams table when it's likely visible (not during live bidding)
  if (state.status !== 'live' && state.status !== 'set_live') {
    loadAllTeams();
  }
}

// ── Last result banner with IPL team colors ───────────────────
let _lastResultHash = '';
function renderLastResult(state) {
  const cont = el('last-result-container'); if (!cont) return;
  const lrHash = (state.last_player_result||'')+'|'+(state.last_player?.id||'')+'|'+(state.last_sold_to_team||'')+'|'+(state.last_sold_price||'');
  if (lrHash === _lastResultHash) return;
  _lastResultHash = lrHash;
  if (!state.last_player_result) { cont.innerHTML = ''; return; }

  if (state.last_player_result === 'set_done') {
    cont.innerHTML = `<div class="last-result-banner sold-banner">
      <div class="lr-set-badge">SET</div>
      <div style="flex:1;min-width:0;"><div class="lr-name">Set Complete</div>
        <div class="lr-detail">${state.last_sold_to_team||''}</div></div>
      <div class="lr-price lr-sold">DONE</div></div>`; return;
  }

  const p = state.last_player;
  const sold = state.last_player_result === 'sold';
  const iplCode  = p?.ipl_team || '';

  // Use WINNING BFL TEAM color/logo (not player's IPL team)
  // BFL team names match IPL codes (GT, MI, CSK etc) — extract from team name
  const winningTeam = sold ? (state.last_sold_to_team || '') : '';
  const winCode = (function(name) {
    if (!name) return null;
    const u = name.toUpperCase();
    const m = [['GUJARAT','GT'],['MUMBAI','MI'],['PUNJAB','PBKS'],['CHENNAI','CSK'],
               ['KOLKATA','KKR'],['DELHI','DC'],['RAJASTHAN','RR'],['SUNRISERS','SRH'],
               ['ROYAL','RCB'],['LUCKNOW','LSG']].find(([k]) => u.includes(k));
    return m ? m[1] : null;
  })(winningTeam);
  const colors   = sold ? (getIPLColors(winCode) || getIPLColors(iplCode)) : null;
  const logoUrl  = sold ? getIPLLogoUrl(winCode) : null;

  const banner = document.createElement('div');
  banner.className = `last-result-banner ${sold ? 'sold-banner' : 'unsold-banner'}`;
  if (sold && colors) {
    banner.style.setProperty('--ipl-primary',      colors.primary);
    banner.style.setProperty('--ipl-secondary',    colors.secondary);
    banner.style.setProperty('--ipl-primary-glow', colors.glow);
  }

  const logoHTML = (sold && logoUrl)
    ? `<img class="banner-ipl-logo" src="${logoUrl}"
         onerror="this.style.display='none'" alt="${winningTeam}" title="${winningTeam}">`
    : '';

  banner.innerHTML = `
    <img src="${imgSrc(p?.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt=""
      style="width:50px;height:50px;border-radius:50%;object-fit:cover;flex-shrink:0;
             border:2px solid ${sold&&colors?colors.primary:'var(--border2)'};">
    ${logoHTML}
    <div style="flex:1;min-width:0;">
      <div class="lr-name">${p?.name||'Unknown'}</div>
      <div class="lr-detail">${p?.role||''}
        ${iplCode ? `<span style="color:var(--muted);font-weight:700;"> · ${iplCode}</span>` : ''}
        ${sold ? ` · Sold to <strong style="color:${colors?colors.primary:'inherit'}">${winningTeam||'?'}</strong>` : ' · Unsold'}
      </div>
    </div>
    <div class="lr-price ${sold?'lr-sold':'lr-unsold'}" ${sold&&colors?`style="color:${colors.primary};"`:''}>${sold ? fmt(state.last_sold_price) : 'UNSOLD'}</div>`;

  cont.innerHTML = '';
  cont.appendChild(banner);
}

// ── Advanced player bid card ──────────────────────────────────
function renderLivePlayer(state, paused) {
  const p = state.current_player;
  const isMe = state.current_highest_team_id === myTeam?.id;
  const colors = getIPLColors(p.ipl_team);
  const logoUrl = getIPLLogoUrl(p.ipl_team);

  // Rebuild card HTML if needed
  if (!el('player-img')) {
    const avgVal = p.bfl_avg ? Number(p.bfl_avg).toFixed(1) : '—';
    const avgClass = p.bfl_avg > 100 ? 'good' : p.bfl_avg > 50 ? '' : 'warn';

    const card = el('player-card');
    card.innerHTML = `
      <div class="adv-player-card" id="adv-player-wrap">
        <div class="adv-card-ipl-band" id="adv-ipl-band"></div>
        <div class="adv-card-body">
          <div class="adv-card-photo-col">
            <img id="player-img" class="adv-card-avatar" src="" alt=""
              onerror="this.onerror=null;this.src=window._SIL;">
            <img id="adv-ipl-logo" class="adv-card-ipl-logo" src="" alt="" style="display:none;"
              onerror="this.style.display='none'">
          </div>
          <div class="adv-card-info-col">
            <div id="player-name" class="adv-card-name">—</div>
            <div class="adv-card-meta-row" id="player-meta-row"></div>
            <div id="player-flags" class="player-flags" style="margin-bottom:8px;"></div>
            <div class="adv-card-stats-grid" id="adv-stats-grid"></div>
          </div>
        </div>
      </div>
      <div class="bid-area" style="margin-top:14px;">
        <div class="timer-wrap"><div class="timer-label">Time Left</div><div class="timer" id="timer">—</div><div class="timer-progress-track"></div><div class="timer-progress-bar tp-green" id="timer-bar"></div></div>
        <div class="bid-stats">
          <div class="bid-stat"><div class="bid-stat-label">Highest Bid</div><div class="bid-stat-value" id="current-bid">—</div><div class="bid-stat-sub" id="leading-team">—</div></div>
          <div class="bid-stat"><div class="bid-stat-label">2nd Highest</div><div class="bid-stat-value second" id="second-bid">—</div><div class="bid-stat-sub" id="second-team">—</div></div>
        </div>
        <div class="bid-row">
          <input class="form-input" type="number" id="bid-input" placeholder="Amount (Cr)" step="0.25" min="0.5" inputmode="decimal">
          <button class="btn btn-gold" id="bid-btn" onclick="placeBid()">Bid</button>
          <button class="btn btn-ghost" id="undo-bid-btn" onclick="undoBid()" style="display:none;">↩ Undo</button>
        </div>
        <div id="bid-error" class="error-msg"></div>
        <div class="bid-latency" id="bid-latency"></div>
        <div class="info-msg" style="font-size:11px;">Bids must be ×0.25 Cr increments · Enter to submit · <kbd style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:9px;font-family:monospace;">B</kbd> to focus</div>
      </div>
      <div id="bid-history-wrap"></div>
      <div id="mini-history-wrap-live"></div>`;
  }

  // Update avatar
  const img = el('player-img');
  if (img) { img.src = imgSrc(p.image_url); img.style.display = 'block'; }

  // IPL styling
  const wrap = el('adv-player-wrap');
  const band = el('adv-ipl-band');
  if (colors && wrap) {
    wrap.style.setProperty('--ipl-primary', colors.primary);
    wrap.style.setProperty('--ipl-secondary', colors.secondary);
    wrap.style.setProperty('--ipl-primary-glow', colors.glow);
    if (band) band.style.background = colors.primary;
    if (img)  img.style.borderColor = colors.primary;
  }
  const logoEl = el('adv-ipl-logo');
  if (logoEl && logoUrl) {
    logoEl.src = logoUrl; logoEl.style.display = 'block';
    logoEl.onerror = () => { logoEl.style.display = 'none'; };
  }

  // Player name
  const nameEl = el('player-name');
  if (nameEl) nameEl.textContent = p.name;

  // Only rebuild meta/flags/stats when player changes (avoid flicker on bid updates)
  const _samePlayer = el('player-card')?.dataset.renderedFor === String(p.id);
  if (!_samePlayer && el('player-card')) el('player-card').dataset.renderedFor = String(p.id);

  // Meta row
  const metaRow = el('player-meta-row');
  if (metaRow && !_samePlayer) {
    metaRow.innerHTML = [
      { icon:'', label:'Role',    val: p.role || '—' },
      { icon:'',    label:'IPL',     val: p.ipl_team || '—', color: colors?.primary },
      { icon:'', label:'Set',     val: p.set_name || '—' },
      { icon:'', label:'Base',    val: fmt(p.base_price) },
    ].map(m => `<div class="adv-card-meta-badge">${m.icon} <strong${m.color?` style="color:${m.color}"`:''}>${m.val}</strong></div>`).join('');
  } // end !_samePlayer meta row

  // Flags (only rebuild when player changes)
  if (!_samePlayer) {
  let flags = p.is_overseas
    ? '<span class="tag tag-overseas">Overseas</span>'
    : '<span class="tag tag-indian">Indian</span>';
  flags += p.is_uncapped
    ? ' <span class="tag tag-uncapped">Uncapped</span>'
    : ' <span class="tag tag-capped">Capped</span>';
  if (p.is_retained) flags += ' <span class="tag tag-retained">Retained</span>';
  if (p.is_rtm_eligible && !p.is_retained) flags += ' <span class="tag tag-rtm">RTM Eligible</span>';
  const flagsEl = el('player-flags'); if (flagsEl) flagsEl.innerHTML = flags;
  } // end !_samePlayer flags block

  // Stats grid — only rebuild when player changes
  const statsGrid = el('adv-stats-grid');
  if (statsGrid && !_samePlayer) {
    const tier = avgTier(p.bfl_avg);
    const roleShort = { 'Batter':'BAT', 'Bowler':'BOWL', 'All-Rounder':'AR', 'Wicket-Keeper':'WK' }[p.role] || p.role?.substring(0,4) || '—';
    statsGrid.innerHTML = [
      { val: tier.label,                               cls: tier.cls,                       icon:'', lbl: 'IPL 25 Avg' },
      { val: (p.role||'—').toUpperCase(),                cls: '',                             icon:'', lbl: 'Role' },
      { val: (playerCountry(p)||'—').toUpperCase(),      cls: p.is_overseas ? 'warn' : 'good',icon:'', lbl: 'Country' },
      { val: p.is_uncapped ? 'UNCAPPED' : 'CAPPED',      cls: p.is_uncapped ? 'good' : '',    icon:'', lbl: 'Status' },
    ].map((s,i) => `<div class="adv-stat" style="animation-delay:${i*0.05}s">
      <div class="adv-stat-val ${s.cls}"${colors&&s.lbl==='IPL'?` style="color:${colors.primary}"`:''}>${s.val}</div>
      <div class="adv-stat-lbl">${s.icon} ${s.lbl}</div>
    </div>`).join('');
  }

  // Bid data
  const hasBid = state.current_highest_bid > 0;
  el('current-bid').textContent = hasBid ? fmt(state.current_highest_bid) : 'No bids yet';
  const leadEl = el('leading-team');
  if (leadEl) {
    leadEl.textContent = state.highest_team
      ? state.highest_team.team_name + (isMe ? ' — You' : '') : '—';
    leadEl.style.color = isMe ? 'var(--green)' : '';
  }
  // Outbid alert: fire when you lose the lead
  if (_wasLeading && !isMe && hasBid) {
    toast('Outbid', 'Now leading: ' + fmt(state.current_highest_bid) + ' by ' + (state.highest_team?.team_name||'?'), 'warn');
    playOutbidAlert();
  }
  _wasLeading = isMe;
  el('second-bid').textContent  = state.second_highest_bid > 0 ? fmt(state.second_highest_bid) : '—';
  el('second-team').textContent = state.second_team?.team_name || '—';

  const next = hasBid ? Number(state.current_highest_bid)+0.25 : Number(p.base_price);
  const bidInput = el('bid-input');
  if (bidInput) {
    // Always refresh min — if someone outbid you, stale value would be rejected by server
    const newMin = next.toFixed(2);
    bidInput.min = newMin;
    // Only auto-update value if user isn't actively typing and current value is now too low
    if (!bidInput.matches(':focus') && parseFloat(bidInput.value) < next) {
      bidInput.value = newMin;
    }
    bidInput.step = '0.25';
  }

  const bidBtn = el('bid-btn'), undoBtn = el('undo-bid-btn');
  // Guard: squad full or OS limit reached
  const mySquadCount = _lastSquadData.length;
  const myOSCount    = _lastSquadData.filter(r => r.player?.is_overseas).length;
  const slotsLeft    = 12 - mySquadCount;
  const squadFull    = mySquadCount >= 12;
  const osBlocked    = p.is_overseas && myOSCount >= 4;

  // Role-limit check: can squad be legally completed if we skip this role?
  // Count remaining available players per role to warn if role gap unfillable
  let roleBlocked = false, roleBlockMsg = '';
  if (!squadFull && slotsLeft > 0) {
    const roleCounts = {};
    _lastSquadData.forEach(r => { if (r.player?.role) roleCounts[r.player.role] = (roleCounts[r.player.role]||0)+1; });
    const needed = {
      'Wicket-Keeper': Math.max(0, 1 - (roleCounts['Wicket-Keeper']||0)),
      'Batter':        Math.max(0, 2 - (roleCounts['Batter']||0)),
      'Bowler':        Math.max(0, 3 - (roleCounts['Bowler']||0)),
      'All-Rounder':   Math.max(0, 2 - (roleCounts['All-Rounder']||0)),
    };
    const totalNeeded = Object.values(needed).reduce((a,b)=>a+b,0);
    // If bidding on this player would leave too few slots for mandatory roles
    if (p.role && needed[p.role] === 0 && totalNeeded >= slotsLeft) {
      roleBlocked = true;
      roleBlockMsg = `Role cap: need ${totalNeeded} mandatory role(s) in ${slotsLeft} slot(s) left`;
    }
  }

  const bidBlocked = squadFull || osBlocked || roleBlocked;

  const errEl = el('bid-error');
  if (bidBlocked && errEl) {
    errEl.textContent = squadFull ? `Squad full (${mySquadCount}/12) — cannot bid`
      : osBlocked ? `Overseas limit (${myOSCount}/4) — cannot bid on overseas players`
      : roleBlockMsg;
  } else if (errEl && (errEl.textContent.includes('Squad full') || errEl.textContent.includes('Overseas') || errEl.textContent.includes('Role cap'))) {
    errEl.textContent = '';
  }

  if (isMe) {
    if (bidBtn)  bidBtn.style.display  = 'none';
    if (undoBtn) undoBtn.style.display = (state.prev_bid_team_purse != null && !paused) ? 'inline-flex' : 'none';
    if (bidInput) bidInput.disabled = true;
  } else {
    if (bidBtn)  { bidBtn.style.display = ''; bidBtn.disabled = paused || bidBlocked; }
    if (undoBtn) undoBtn.style.display = 'none';
    if (bidInput) bidInput.disabled = paused || bidBlocked;
  }

  hide('no-auction'); hide('set-auction-view'); hide('rtm-pending'); show('player-card');
  if (paused) { stopTimer(); const t = el('timer'); if (t) { t.textContent = 'Paused'; t.className = 'timer'; } }
  else startTimer(state.bid_timer_end);
}

// ── RTM pending screen ────────────────────────────────────────
function renderRTMPending(state) {
  const cont = el('rtm-pending'); if (!cont) return;
  show('rtm-pending');
  const isRTMTeam = state.rtm_team?.id === myTeam?.id;
  const price = fmt(state.rtm_match_price || 0);
  const p = state.current_player;

  if (isRTMTeam && !_rtmAlerted) {
    _rtmAlerted = true;
    playRTMAlert();
    document.body.style.transition = 'background 0.2s';
    document.body.style.background = 'rgba(240,180,41,0.15)';
    setTimeout(() => { document.body.style.background = ''; }, 800);
  }
  if (!state.rtm_pending) _rtmAlerted = false;

  const deadlineMs = state.rtm_deadline ? new Date(state.rtm_deadline).getTime() : null;
  const remInit = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : null;

  cont.innerHTML = `
    <div class="rtm-banner${isRTMTeam?' rtm-my-turn':''}">
      <div class="rtm-icon">RTM</div>
      <div class="rtm-title">RTM OPPORTUNITY</div>
      ${deadlineMs ? `
        <div style="text-align:center;margin-bottom:10px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);">Time to Decide</div>
          <div id="rtm-countdown" class="timer${(remInit||60)<=10?' timer-critical':(remInit||60)<=20?' timer-warning':''}"
            style="font-size:32px;display:inline-block;">${remInit||60}s</div>
        </div>` : ''}
      <div class="rtm-body">
        <img src="${imgSrc(p?.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="" class="rtm-player-img">
        <div style="flex:1;min-width:0;">
          <div class="rtm-player-name">${p?.name||'—'}</div>
          <div class="rtm-player-sub">${p?.role||''} · ${p?.ipl_team||''}${p?.prev_bfl_team?' · Prev BFL: '+p.prev_bfl_team:''}</div>
          <div class="rtm-price">Winning bid: <strong>${price}</strong></div>
          <div class="rtm-team-msg">${isRTMTeam
            ? `<span style="color:var(--gold);font-weight:800;">Your franchise can RTM at ${price}</span>`
            : `<span style="color:var(--muted);">Waiting for <strong>${state.rtm_team?.team_name||'—'}</strong> to decide…</span>`
          }</div>
        </div>
      </div>
      ${isRTMTeam ? `
        <div class="rtm-actions">
          <button class="btn btn-gold rtm-hold-btn" id="rtm-accept-btn"
            onmousedown="startRTMHold(true)" ontouchstart="startRTMHold(true)"
            onmouseup="cancelRTMHold()" ontouchend="cancelRTMHold()"
            onmouseleave="cancelRTMHold()">
            <span class="rtm-hold-fill" id="rtm-hold-fill"></span>
            Exercise RTM — Match ${price}
          </button>
          <button class="btn btn-ghost" onclick="exerciseRTM(false)">Decline RTM</button>
        </div>
        <div class="rtm-hold-hint">Hold button for 2s to confirm RTM</div>` : ''}
    </div>`;

  if (deadlineMs) startRTMTimer(deadlineMs);
}

let _rtmInFlight = false;
let _rtmHoldTimer = null;

function startRTMHold(accept) {
  const fill = document.getElementById('rtm-hold-fill');
  const btn  = document.getElementById('rtm-accept-btn');
  if (!fill || !btn) { exerciseRTM(accept); return; }
  btn.classList.add('holding');
  _rtmHoldTimer = setTimeout(() => {
    btn.classList.remove('holding');
    exerciseRTM(accept);
  }, 1800);
}
function cancelRTMHold() {
  clearTimeout(_rtmHoldTimer);
  const btn = document.getElementById('rtm-accept-btn');
  if (btn) btn.classList.remove('holding');
}

async function exerciseRTM(accept) {
  if (_rtmInFlight) return;
  _rtmInFlight = true;
  // Disable both buttons immediately
  document.querySelectorAll('.rtm-actions .btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
  const { data, error } = await sb.rpc('exercise_rtm', { p_accept: accept });
  _rtmInFlight = false;
  if (error || !data?.success) {
    document.querySelectorAll('.rtm-actions .btn').forEach(b => { b.disabled = false; b.style.opacity = ''; });
    toast('RTM Error', error?.message || data?.error || 'RTM action failed', 'error'); return;
  }
  _rtmAlerted = false;
  toast(accept ? 'RTM Exercised' : 'RTM Declined', accept ? 'Player retained at match price' : 'Player goes to winning bidder', accept ? 'success' : 'info');
  _lastStateHash = ''; _lastAppliedStatus = ''; _lastAppliedStatus = ''; await fetchState();
}

// ── Set auction inside player-card ────────────────────────────
async function renderSetInPlayerCard(state) {
  const { data: slots, error } = await sb.from('auction_slots')
    .select(`*,
      player:players_master(id,name,role,ipl_team,base_price,image_url,is_overseas,is_uncapped,is_rtm_eligible,is_retained,bfl_avg,country),
      highest_team:teams!auction_slots_current_highest_team_id_fkey(team_name,id),
      second_team:teams!auction_slots_second_highest_team_id_fkey(team_name,id)`)
    .eq('set_name', state.current_set_name).eq('status', 'live');
  if (error) { console.warn('[renderSetInPlayerCard]', error.message); return; }
  if (!slots?.length) {
    el('player-card').innerHTML = `<div class="no-auction-msg"><span class="set-closing-badge">SET</span> ${state.current_set_name} — closing…</div>`;
    return;
  }

  const latestEnd = slots.reduce((mx,s) => Math.max(mx, s.bid_timer_end ? new Date(s.bid_timer_end).getTime() : 0), 0);

  const existingGrid = el('set-slots-grid');
  if (!existingGrid) {
    const cards = slots.map(slot => buildSlotCardHTML(slot)).join('');
    el('player-card').innerHTML = `
      <div class="set-auction-header" style="margin-bottom:12px;">
        <div>
          <span class="set-live-label">${state.current_set_name||''}</span>
          <span style="margin-left:8px;color:var(--muted);font-size:13px;">${slots.length} players — bid simultaneously</span>
        </div>
        <div class="set-timer-wrap">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);">Timer</div>
          <span class="timer" id="set-timer">—</span>
          <div class="timer-progress-track"></div><div class="timer-progress-bar tp-green" id="set-timer-bar"></div>
        </div>
      </div>
      <div class="team-set-slots-grid" id="set-slots-grid">${cards}</div>`;
  } else {
    slots.forEach(slot => patchSlotCard(slot));
  }

  startSetTimer(latestEnd);
  subscribeSetSlots(state.current_set_name);
}

function buildSlotCardHTML(slot) {
  const p      = slot.player || {};
  const isMe   = slot.current_highest_team_id === myTeam?.id;
  const hasBid = slot.current_highest_bid > 0;
  const next   = hasBid ? Number(slot.current_highest_bid) + 0.25 : Number(p.base_price || 0);
  const colors  = getIPLColors(p.ipl_team);
  const logoUrl = getIPLLogoUrl(p.ipl_team);

  const primary  = colors ? colors.primary   : '#f0b429';
  const glow     = colors ? colors.glow      : 'rgba(240,180,41,0.25)';
  const secondary= colors ? colors.secondary : '#1a1a2e';

  // Tags
  let tagParts = [];
  if (p.is_overseas)               tagParts.push('<span class="tag tag-overseas">OS</span>');
  if (p.is_uncapped)               tagParts.push('<span class="tag tag-uncapped">UC</span>');
  if (p.is_retained)               tagParts.push('<span class="tag tag-retained">RTN</span>');
  if (p.is_rtm_eligible && !p.is_retained) tagParts.push('<span class="tag tag-rtm">RTM</span>');
  const tags = tagParts.join('');

  const _t      = avgTier(p.bfl_avg);
  const avg     = _t.label;
  const avgColor = _t.color;
  const roleShort = {'Batter':'BAT','Bowler':'BOWL','All-Rounder':'AR','Wicket-Keeper':'WK'}[p.role] || (p.role||'—').substring(0,3);
  const origin  = (playerCountry(p)||'—').toUpperCase();

  // Bid area
  const bidArea = isMe
    ? `<div class="sc-bid-action" id="sa-${slot.id}">
         <div class="sc-winning">
           <span class="sc-winning-icon">✓</span>
           <span class="sc-winning-label">Leading</span>
           <span class="sc-winning-amt">${fmt(slot.current_highest_bid)}</span>
         </div>
         <button class="btn btn-ghost btn-sm sc-undo-btn" onclick="undoSetBid('${slot.id}')">↩</button>
       </div>`
    : `<div class="sc-bid-action" id="sa-${slot.id}">
         <input type="number" class="form-input sc-bid-input" id="sbid-${slot.id}"
           value="${next.toFixed(2)}" min="${next.toFixed(2)}" step="0.25" inputmode="decimal">
         <button class="btn btn-gold btn-sm sc-bid-btn" onclick="placeSetBid('${slot.id}')">Bid</button>
       </div>`;

  return `<div class="sc-card${isMe?' sc-leading':''}" id="set-card-${slot.id}"
    style="--sc-primary:${primary};--sc-glow:${glow};--sc-secondary:${secondary};">

    <!-- Coloured top band -->
    <div class="sc-band"></div>

    <!-- Header: avatar + name block -->
    <div class="sc-header">
      <div class="sc-avatar-wrap">
        <img class="sc-avatar" src="${imgSrc(p.image_url)}"
          onerror="this.onerror=null;this.src=window._SIL" alt="">
        ${logoUrl ? `<img class="sc-team-logo" src="${logoUrl}"
          onerror="this.style.display='none'" alt="${p.ipl_team||''}">` : ''}
      </div>
      <div class="sc-identity">
        <div class="sc-name">${p.name || '?'}</div>
        <div class="sc-sub" style="color:${primary};">${p.ipl_team || '—'} · Base ${fmt(p.base_price)}</div>
        ${tags ? `<div class="sc-tags">${tags}</div>` : ''}
      </div>
    </div>

    <!-- Stats strip: BFL Avg · Role · Origin -->
    <div class="sc-stats">
      <div class="sc-stat">
        <span class="sc-stat-val" style="color:${avgColor};">${avg}</span>
        <span class="sc-stat-lbl">IPL 25 Avg</span>
      </div>
      <div class="sc-stat-div"></div>
      <div class="sc-stat">
        <span class="sc-stat-val">${roleShort}</span>
        <span class="sc-stat-lbl">Role</span>
      </div>
      <div class="sc-stat-div"></div>
      <div class="sc-stat">
        <span class="sc-stat-val">${origin}</span>
        <span class="sc-stat-lbl">Origin</span>
      </div>
    </div>

    <!-- Bid display -->
    <div class="sc-bids" id="sb-${slot.id}">${buildSlotBidHTML(slot)}</div>

    <!-- Bid action -->
    ${bidArea}

    <div id="serr-${slot.id}" class="error-msg" style="font-size:11px;min-height:0;margin-top:3px;"></div>
  </div>`;
}

function buildSlotBidHTML(slot) {
  const isMe   = slot.current_highest_team_id === myTeam?.id;
  const hasBid = slot.current_highest_bid > 0;
  const has2nd = slot.second_highest_bid > 0;
  return `<div class="sc-bid-row">
    <div class="sc-bid-col">
      <div class="sc-bid-lbl">Highest</div>
      <div class="sc-bid-amt${isMe?' sc-bid-me':hasBid?' sc-bid-other':''}">
        ${hasBid ? fmt(slot.current_highest_bid) : '<span class="sc-no-bid">—</span>'}
      </div>
      <div class="sc-bid-team">${hasBid ? (slot.highest_team?.team_name||'')+(isMe?' ✓':'') : ''}</div>
    </div>
    <div class="sc-bid-sep"></div>
    <div class="sc-bid-col">
      <div class="sc-bid-lbl">2nd</div>
      <div class="sc-bid-amt sc-bid-2nd">
        ${has2nd ? fmt(slot.second_highest_bid) : '<span class="sc-no-bid">—</span>'}
      </div>
      <div class="sc-bid-team">${has2nd ? slot.second_team?.team_name||'' : ''}</div>
    </div>
  </div>`;
}

function patchSlotCard(slot) {
  const isMe   = slot.current_highest_team_id === myTeam?.id;
  const hasBid = slot.current_highest_bid > 0;
  const next   = hasBid ? Number(slot.current_highest_bid)+0.25 : Number(slot.player?.base_price||0);
  const card = document.getElementById('set-card-'+slot.id); if (!card) return;
  // Show "WON" state if set is closed (status != live)
  if (slot.status === 'closed' || slot.status === 'sold') {
    card.className = 'sc-card' + (isMe ? ' sc-won' : '');
    if (isMe) {
      let wonBadge = card.querySelector('.sc-won-badge');
      if (!wonBadge) { wonBadge = document.createElement('div'); wonBadge.className='sc-won-badge'; card.appendChild(wonBadge); }
      wonBadge.textContent = '✓ WON — ' + (hasBid ? '₹'+Number(slot.current_highest_bid).toFixed(2)+' Cr' : '');
    }
    return;
  }
  card.className = 'sc-card' + (isMe ? ' sc-leading' : '');
  const bidDiv = document.getElementById('sb-'+slot.id);
  if (bidDiv) bidDiv.innerHTML = buildSlotBidHTML(slot);
  const sa = document.getElementById('sa-'+slot.id);
  if (sa) {
    if (isMe) {
      // Team is leading this slot — always show Leading state + undo button
      sa.innerHTML = `<div class="sc-bid-action"><div class="sc-winning"><span class="sc-winning-icon">✓</span><span class="sc-winning-label">Leading</span><span class="sc-winning-amt">${fmt(slot.current_highest_bid)}</span></div><button class="btn btn-ghost btn-sm sc-undo-btn" onclick="undoSetBid('${slot.id}')">↩</button></div>`;
    } else {
      // Not leading — show bid input, preserve typed value if user is actively typing
      const existing = document.getElementById('sbid-'+slot.id);
      if (existing && existing.matches(':focus')) {
        // User is typing — just update the minimum, don't rebuild
        existing.min = next.toFixed(2);
        if (parseFloat(existing.value) < next) existing.value = next.toFixed(2);
      } else {
        sa.innerHTML = `<div class="sc-bid-action"><input type="number" class="form-input sc-bid-input" id="sbid-${slot.id}" value="${next.toFixed(2)}" min="${next.toFixed(2)}" step="0.25" inputmode="decimal"><button class="btn btn-gold btn-sm sc-bid-btn" onclick="placeSetBid('${slot.id}')">Bid</button></div>`;
      }
    }
  }
}

// ── Bid history ───────────────────────────────────────────────
async function loadBidHistory(playerId) {
  const wrap = el('bid-history-wrap'); if (!wrap || !playerId) return;
  try {
    const { data: bids } = await sb.from('bid_log')
      .select('bid_amount,bid_at,team:teams(team_name)')
      .eq('player_id', playerId).order('bid_at', { ascending: false }).limit(8);
    if (!bids?.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="bid-history">
      <div class="bid-history-title">Bid History</div>
      ${bids.map(b => `<div class="bid-history-row">
        <span class="bh-team">${b.team?.team_name||'?'}</span>
        <span class="bh-amount">${fmt(b.bid_amount)}</span>
      </div>`).join('')}
    </div>`;
  } catch(e) { wrap.innerHTML = ''; }
}

// ── Mini history ──────────────────────────────────────────────
async function renderMiniHistory(wrapId) {
  const wrap = el(wrapId); if (!wrap) return;
  try {
    const [{data:sold},{data:ul}] = await Promise.all([
      sb.from('team_players').select('sold_price,sold_at,is_rtm,team:teams(team_name),player:players_master(name,role,image_url)').order('sold_at',{ascending:false}).limit(6),
      sb.from('unsold_log').select('logged_at,player:players_master(name,role,image_url)').order('logged_at',{ascending:false}).limit(4)
    ]);
    const items = [
      ...(sold||[]).map(r => ({name:r.player?.name||'?',role:r.player?.role||'',img:r.player?.image_url||'',price:r.sold_price,team:r.team?.team_name||'',ts:r.sold_at,status:'sold',isRTM:r.is_rtm})),
      ...(ul||[]).map(r   => ({name:r.player?.name||'?',role:r.player?.role||'',img:r.player?.image_url||'',price:null,team:'',ts:r.logged_at,status:'unsold'}))
    ].sort((a,b)=>new Date(b.ts)-new Date(a.ts)).slice(0,6);
    if (!items.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="mini-history"><div class="mini-history-title">Recent Results</div>
      ${items.map(r=>`<div class="mini-history-item">
        <img src="${imgSrc(r.img)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
        <div class="mh-name">${r.name}<span class="mh-role"> · ${r.role}</span>${r.isRTM?'<span class="tag tag-rtm" style="font-size:10px;padding:1px 4px;margin-left:4px;">RTM</span>':''}</div>
        ${r.status==='sold'?`<div class="mh-team">${r.team}</div><div class="mh-price sold-price">${fmt(r.price)}</div>`:`<div class="mh-price unsold-price">Unsold</div>`}
      </div>`).join('')}</div>`;
  } catch(e) { console.warn('[MiniHistory]', e.message); }
}

// ── All-Teams Leaderboard ─────────────────────────────────────
let _allTeamsSort = { key: 'purse_remaining', dir: 'desc' };

function sortAllTeams(key) {
  if (_allTeamsSort.key === key) _allTeamsSort.dir = _allTeamsSort.dir === 'asc' ? 'desc' : 'asc';
  else { _allTeamsSort.key = key; _allTeamsSort.dir = key === 'team_name' ? 'asc' : 'desc'; }
  renderAllTeams();
}
let _allTeamsHash = '';
async function loadAllTeams() {
  try {
    const { data: teams } = await sb.from('teams')
      .select('id,team_name,purse_remaining,is_advantage_holder,rtm_cards_total,rtm_cards_used')
      .order('team_name');
    if (!teams) return;
    const { data: squad } = await sb.from('team_players')
      .select('team_id,player:players_master(is_overseas)');
    const counts = {}, osCounts = {};
    (squad||[]).forEach(r => {
      counts[r.team_id]   = (counts[r.team_id]   || 0) + 1;
      if (r.player?.is_overseas) osCounts[r.team_id] = (osCounts[r.team_id] || 0) + 1;
    });
    _teamsCache = teams.map(t => ({
      ...t, playerCount: counts[t.id]||0, osCount: osCounts[t.id]||0
    }));
    renderAllTeams();
  } catch(e) { console.warn('[loadAllTeams]', e.message); }
}

function renderAllTeams() {
  const cont = el('all-teams-table'); if (!cont) return;
  if (!_teamsCache.length) { cont.innerHTML = '<tr><td colspan="4" class="empty-cell">Loading…</td></tr>'; return; }

  const { key, dir } = _allTeamsSort;
  const sorted = [..._teamsCache].sort((a, b) => {
    let va = a[key] ?? '', vb = b[key] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return dir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // Update header sort indicators
  ['col-team','col-purse','col-sq','col-os'].forEach((cls, i) => {
    const keys = ['team_name','purse_remaining','playerCount','osCount'];
    const th = document.querySelector(`.all-teams-table-inner thead th:nth-child(${i+1})`);
    if (!th) return;
    th.classList.remove('sort-asc','sort-desc');
    if (keys[i] === key) th.classList.add('sort-' + dir);
  });

  cont.innerHTML = sorted.map(t => {
    const rtmRem = Math.max(0, (t.rtm_cards_total||0) - (t.rtm_cards_used||0));
    const isMe   = t.id === myTeam?.id;
    const purse  = Number(t.purse_remaining);
    const purseColor = purse <= 5 ? 'var(--red)' : purse <= 10 ? '#f6ad55' : 'var(--gold)';
    return `<tr class="${isMe?'row-mine':''}">
      <td>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:${isMe?'800':'700'};font-size:14px;">${t.team_name}</span>
        ${t.is_advantage_holder?' <span class="tag tag-advantage" style="font-size:9px;padding:1px 4px;">⭐</span>':''}
        ${rtmRem>0?` <span class="tag tag-rtm" style="font-size:9px;padding:1px 4px;">RTM×${rtmRem}</span>`:''}
        ${isMe?' <span style="font-size:10px;color:var(--gold);font-style:italic;">(you)</span>':''}
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:15px;color:${purseColor};white-space:nowrap;">
        ₹${purse.toFixed(1)}<span style="font-size:11px;font-weight:500;color:var(--muted);"> Cr</span>
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;white-space:nowrap;">
        ${t.playerCount}<span style="color:var(--muted);font-size:11px;font-weight:400;">/12</span>
      </td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;white-space:nowrap;">
        ${t.osCount}<span style="color:var(--muted);font-size:11px;font-weight:400;">/4</span>
      </td>
    </tr>`;
  }).join('');
}

// ── Timers ────────────────────────────────────────────────────
let _timerEndMs = 0, _timerTotalSec = 60;
function startTimer(endTime) {
  const newEndMs = new Date(endTime).getTime();
  // Only reset totalSec when this is a fresh timer (end time changed by >2s)
  if (Math.abs(newEndMs - _timerEndMs) > 2000) {
    _timerEndMs   = newEndMs;
    _timerTotalSec = Math.max(1, Math.ceil((newEndMs - Date.now()) / 1000));
  }
  stopTimer();
  const endMs    = newEndMs;
  const totalSec = _timerTotalSec;
  function tick() {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t   = el('timer'); if (!t) { stopTimer(); return; }
    t.textContent = rem + 's';
    t.className   = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
    const pct = Math.max(0, Math.min(100, (rem / totalSec) * 100));
    const bar = el('timer-bar');
    if (bar) {
      bar.style.width = pct + '%';
      bar.className = 'timer-progress-bar ' + (rem <= 5 ? 'tp-red' : rem <= 10 ? 'tp-amber' : 'tp-green');
    }
  }
  tick(); timerInterval = setInterval(tick, 500);
}

// ── Auction Day countdown (team page) ────────────────────────
let _dayCountdownInterval = null;
function _startDayCountdown(dayEndIso) {
  clearInterval(_dayCountdownInterval);
  const lbl = el('as-day-cd');
  if (!lbl) return;
  if (!dayEndIso) { lbl.textContent = ''; return; }
  const endMs = new Date(dayEndIso).getTime();
  function tick() {
    const rem = endMs - Date.now();
    if (rem <= 0) { lbl.textContent = 'Ended'; clearInterval(_dayCountdownInterval); return; }
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    lbl.textContent = (h > 0 ? h + 'h ' : '') + String(m).padStart(2,'0') + 'm ' + String(s).padStart(2,'0') + 's';
  }
  tick();
  _dayCountdownInterval = setInterval(tick, 1000);
}
function stopTimer()    { clearInterval(timerInterval);    timerInterval    = null; }

let _setTimerEndMs = 0, _setTimerTotalSec = 60;
function startSetTimer(endMs) {
  stopSetTimer(); if (!endMs) return;
  if (Math.abs(endMs - _setTimerEndMs) > 2000) {
    _setTimerEndMs    = endMs;
    _setTimerTotalSec = Math.max(1, Math.ceil((endMs - Date.now()) / 1000));
  }
  const totalSetSec = _setTimerTotalSec;
  function tick() {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t   = el('set-timer'); if (!t) { stopSetTimer(); return; }
    t.textContent = rem + 's';
    t.className   = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
    const pct    = Math.max(0, Math.min(100, (rem / totalSetSec) * 100));
    const setBar = el('set-timer-bar');
    if (setBar) {
      setBar.style.width = pct + '%';
      setBar.className = 'timer-progress-bar ' + (rem <= 5 ? 'tp-red' : rem <= 10 ? 'tp-amber' : 'tp-green');
    }
  }
  tick(); setTimerInterval = setInterval(tick, 500);
}
function stopSetTimer() { clearInterval(setTimerInterval); setTimerInterval = null; }

function startRTMTimer(deadlineMs) {
  stopRTMTimer();
  function tick() {
    const rem = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
    const t = el('rtm-countdown'); if (!t) { stopRTMTimer(); return; }
    t.textContent = rem + 's';
    t.className = 'timer ' + (rem <= 10 ? 'timer-critical' : rem <= 20 ? 'timer-warning' : '');
    t.style.display = 'inline-block';
    if (rem <= 0) stopRTMTimer();
  }
  tick(); rtmTimerInterval = setInterval(tick, 500);
}
function stopRTMTimer() { clearInterval(rtmTimerInterval); rtmTimerInterval = null; }

// ── Set slot realtime ─────────────────────────────────────────
function subscribeSetSlots(setName) {
  if (setSlotChannel) return;
  setSlotChannel = sb.channel('set-slots-v25-' + setName)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_slots', filter:'set_name=eq.'+setName }, () => {
      _lastSlotsHash = ''; _lastStateHash = ''; _lastAppliedStatus = ''; fetchState();
    }).subscribe();
}

// ── Bid actions ───────────────────────────────────────────────
async function placeBid() {
  const errEl = el('bid-error'), bidBtn = el('bid-btn'), input = el('bid-input');
  if (!input || !bidBtn) return;
  errEl.textContent = '';
  const raw = parseFloat(input.value);
  if (isNaN(raw) || raw <= 0) { errEl.textContent = 'Enter a valid amount'; toast('Invalid Bid', 'Please enter a valid bid amount', 'warn'); return; }
  const amount = Math.round(raw / 0.25) * 0.25;
  if (Math.abs(amount - raw) > 0.001) { errEl.textContent = 'Must be 0.25 Cr increments'; input.value = amount.toFixed(2); toast('Invalid Amount', 'Bids must be in 0.25 Cr increments', 'warn'); return; }
  if (amount > myTeam.purse_remaining) { errEl.textContent = 'Insufficient purse'; toast('Insufficient Purse', 'Bid of ' + fmt(amount) + ' exceeds remaining ' + fmt(myTeam.purse_remaining), 'error'); return; }
  if (bidBtn._inFlight) return; bidBtn._inFlight = true;
  bidBtn.disabled = true; bidBtn.classList.add('pending'); bidBtn.textContent = 'Placing…';
  _bidTs = Date.now();
  const { data, error } = await sb.rpc('place_bid', { bid_amount: amount });
  const ms = Date.now() - _bidTs;
  bidBtn._inFlight = false;
  bidBtn.disabled = false; bidBtn.classList.remove('pending'); bidBtn.textContent = 'Bid';
  const latEl = el('bid-latency');
  if (latEl) {
    const cls = ms < 400 ? 'fast' : ms < 1200 ? 'slow' : 'veryslow';
    latEl.className = 'bid-latency ' + cls;
    latEl.textContent = 'Server response: ' + ms + 'ms';
    setTimeout(() => { if (latEl) { latEl.textContent = ''; latEl.className = 'bid-latency'; } }, 5000);
  }
  if (error)          { errEl.textContent = error.message; toast('Bid Rejected', error.message, 'error'); return; }
  if (!data?.success) { errEl.textContent = data?.error||'Error'; toast('Bid Rejected', data?.error||'Server error', 'error'); return; }
  bidBtn.style.display = 'none'; input.disabled = true;
  const undoBtn = el('undo-bid-btn'); if (undoBtn) undoBtn.style.display = 'inline-flex';
  input.classList.add('bid-success-flash');
  setTimeout(() => input.classList.remove('bid-success-flash'), 600);
  toast('Bid Placed', fmt(amount) + ' — you are leading', 'success');
  _lastStateHash = ''; _lastAppliedStatus = ''; _lastAppliedStatus = ''; fetchState();
}

async function undoBid() {
  const btn = el('undo-bid-btn');
  if (btn && btn._inFlight) return; if (btn) { btn._inFlight = true; btn.disabled = true; btn.textContent = 'Placing…'; }
  const { data, error } = await sb.rpc('undo_bid');
  if (btn) { btn.disabled = false; btn.textContent = '↩ Undo'; }
  if (error || !data?.success) { toast('Cannot Undo', error?.message||data?.error||'Undo not available', 'warn'); return; }
  const bidBtn = el('bid-btn'); if (bidBtn) { bidBtn.style.display = ''; bidBtn.disabled = false; }
  const input  = el('bid-input'); if (input) input.disabled = false;
  if (btn) btn.style.display = 'none';
  toast('Bid Undone', 'Your bid has been reversed', 'info');
  _lastStateHash = ''; _lastAppliedStatus = ''; _lastAppliedStatus = ''; await fetchState();
}

async function placeSetBid(slotId) {
  const inp = document.getElementById('sbid-'+slotId);
  const errEl = document.getElementById('serr-'+slotId);
  const btn = inp?.nextElementSibling;
  if (!inp) return; if (errEl) errEl.textContent = '';
  const raw = parseFloat(inp.value);
  if (isNaN(raw) || raw <= 0) { if (errEl) errEl.textContent = 'Enter a valid bid amount'; toast('Invalid Bid', 'Please enter a valid amount', 'warn'); return; }
  const amount = Math.round(raw / 0.25) * 0.25;
  if (Math.abs(amount - raw) > 0.001) { if (errEl) errEl.textContent = 'Bids must be in 0.25 Cr increments'; inp.value = amount.toFixed(2); toast('Invalid Amount', 'Bids must be in 0.25 Cr increments', 'warn'); return; }

  // Cross-slot purse check: sum all sc-leading cards (excluding this slot)
  const myCurrentWinningBids = (currentState?.status === 'set_live')
    ? Array.from(document.querySelectorAll('[id^="set-card-"].sc-leading')).reduce((sum, card) => {
        const cardSlotId = card.id.replace('set-card-', '');
        if (cardSlotId === String(slotId)) return sum; // exclude this slot (replacing my bid)
        // Read stored bid value from data attribute set when bidding
        const storedBid = parseFloat(card.dataset.myBid || '0');
        return sum + storedBid;
      }, 0)
    : 0;

  const totalCommitted = amount + myCurrentWinningBids;
  if (totalCommitted > myTeam.purse_remaining) {
    if (errEl) errEl.textContent = `Total across all slots (₹${totalCommitted.toFixed(2)} Cr) exceeds purse (₹${myTeam.purse_remaining.toFixed(2)} Cr)`;
    return;
  }

  if (btn && btn._inFlight) return; if (btn) { btn._inFlight = true; btn.disabled = true; btn.textContent = 'Placing…'; }
  const { data, error } = await sb.rpc('place_set_bid', { p_slot_id: slotId, bid_amount: amount });
  if (btn) { btn._inFlight = false; btn.disabled = false; btn.textContent = 'Bid'; }
  if (error || !data?.success) { if (errEl) errEl.textContent = error?.message||data?.error||'Error'; return; }
  toast('Set Bid Placed', fmt(amount) + ' on ' + (document.getElementById('set-card-'+slotId)?.querySelector('.sc-name')?.textContent||'player'), 'success');
  // Store bid amount on card for cross-slot purse calculation
  const bidCard = document.getElementById('set-card-'+slotId);
  if (bidCard) bidCard.dataset.myBid = amount;
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = ''; _lastAppliedStatus = ''; fetchState();
}

async function undoSetBid(slotId) {
  const btn = document.querySelector(`#set-card-${slotId} .sc-undo-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const { data, error } = await sb.rpc('undo_set_bid', { p_slot_id: slotId });
  if (btn) { btn.disabled = false; btn.textContent = '↩'; }
  if (error || !data?.success) {
    toast('Cannot Undo', error?.message||data?.error||'Undo not available', 'warn'); return;
  }
  // Clear stored bid on this card so cross-slot purse calc is accurate
  const card = document.getElementById('set-card-' + slotId);
  if (card) { card.dataset.myBid = '0'; card.classList.remove('sc-leading'); }
  toast('Set Bid Undone', 'Your bid has been reversed', 'info');
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = ''; _lastAppliedStatus = ''; await fetchState();
}

// ── Purse refresh ─────────────────────────────────────────────
async function refreshPurse() {
  try {
    const { data: t } = await sb.from('teams')
      .select('purse_remaining,rtm_cards_total,rtm_cards_used').eq('id', myTeam.id).single();
    if (!t) return;
    // Only update DOM if values actually changed
    const changed = t.purse_remaining !== myTeam.purse_remaining ||
                    t.rtm_cards_total !== myTeam.rtm_cards_total ||
                    t.rtm_cards_used  !== myTeam.rtm_cards_used;
    myTeam.purse_remaining = t.purse_remaining;
    myTeam.rtm_cards_total = t.rtm_cards_total;
    myTeam.rtm_cards_used  = t.rtm_cards_used;
    if (changed) { updatePurseDisplay(); updateRTMBadge(); }
  } catch(e) { console.warn('[refreshPurse]', e.message); }
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const [{ data: allP }, { data: soldRows }, { data: st }] = await Promise.all([
      sb.from('players_master').select('id,role'),
      sb.from('team_players').select('sold_price,player_id'),
      sb.from('auction_state').select('unsold_player_ids').eq('id',1).maybeSingle()
    ]);
    // Fetch auction_day/day_end separately — silently skip if columns not yet created
    let auctionDay = null, dayEnd = null;
    try {
      const { data: dayRow, error: dayErr } = await sb.from('auction_state')
        .select('auction_day,day_end').eq('id',1).maybeSingle();
      if (!dayErr) {
        auctionDay = dayRow?.auction_day ?? null;
        dayEnd     = dayRow?.day_end ?? null;
      }
    } catch(_) {}
    const soldIds    = new Set((soldRows||[]).map(r => r.player_id));
    const soldCount  = soldIds.size;
    const spent      = (soldRows||[]).reduce((s,r) => s+Number(r.sold_price||0), 0);
    const unsoldIds2 = new Set(Array.isArray(st?.unsold_player_ids) ? st.unsold_player_ids : []);
    const unsoldCount = unsoldIds2.size;
    const total = (allP||[]).length;

    // Auction day chip
    const dayEl = el('as-day');
    if (dayEl) {
      const d = auctionDay;
      dayEl.textContent = d ? 'Day ' + d : '—';
      const chip = dayEl.closest('.stat-chip');
      if (chip) chip.style.borderColor = d ? 'var(--gold-dim)' : '';
    }
    // Day countdown chip — start/update live countdown
    _startDayCountdown(dayEnd);

    if (el('as-total'))     el('as-total').textContent     = total;
    if (el('as-sold'))      el('as-sold').textContent      = soldCount;
    if (el('as-unsold'))    el('as-unsold').textContent    = unsoldCount;
    if (el('as-remaining')) el('as-remaining').textContent = Math.max(0, total - soldCount - unsoldCount);
    if (el('as-spent'))     el('as-spent').textContent     = spent.toFixed(2);

    // Role pool — fill individual stat chips
    const rolePool = {};
    (allP||[]).forEach(p => {
      if (!soldIds.has(p.id) && !unsoldIds2.has(p.id))
        rolePool[p.role] = (rolePool[p.role]||0) + 1;
    });
    const rpMap = {
      'Wicket-Keeper': 'rp-wk',
      'Batter':        'rp-bat',
      'Bowler':        'rp-bowl',
      'All-Rounder':   'rp-ar',
    };
    const chipMap = {
      'Wicket-Keeper': 'as-wk',
      'Batter':        'as-bat',
      'Bowler':        'as-bowl',
      'All-Rounder':   'as-ar',
    };
    Object.entries(rpMap).forEach(([role, valId]) => {
      const n = rolePool[role] || 0;
      const valEl = el(valId);
      if (valEl) valEl.textContent = n;
      const chipEl = el(chipMap[role]);
      if (chipEl) {
        // Colour the chip border + value by scarcity
        const color = n === 0 ? 'var(--red)' : n <= 2 ? '#f6ad55' : '';
        const chipVal = chipEl.querySelector('.stat-chip-val');
        if (chipVal) chipVal.style.color = color || 'var(--gold)';
        chipEl.style.borderColor = n === 0 ? 'rgba(229,62,62,0.4)' : n <= 2 ? 'rgba(246,173,85,0.4)' : '';
      }
    });
  } catch(e) { console.warn('[Stats]', e.message); }
}

function renderRolePool(pool) { /* legacy stub — now rendered inline in loadStats */ }

// ── Squad with full validation ────────────────────────────────
async function loadSquad() {
  if (_squadLoading) return; _squadLoading = true;
  try {
    const { data: rows, error } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)')
      .eq('team_id', myTeam.id);
    const list = error ? [] : (rows || []);
    _lastSquadData = list;
    const auctionSpent = list.filter(r=>!r.is_retained).reduce((s,r)=>s+Number(r.sold_price||0),0);
    const retainSpent  = list.filter(r=> r.is_retained).reduce((s,r)=>s+Number(r.sold_price||0),0);
    if (el('squad-spent')) el('squad-spent').textContent = retainSpent > 0
      ? `₹${auctionSpent.toFixed(2)} + ₹${retainSpent.toFixed(2)} RTN`
      : `₹${auctionSpent.toFixed(2)} Cr spent`;
    if (el('squad-count')) el('squad-count').textContent = list.length + ' / 12';
    hide('squad-skeleton'); show('squad-table-wrap');
    const tbody = el('squad-tbody'); if (!tbody) return;
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No players yet</td></tr>'; renderSquadComp([]); return; }
    list.sort((a,b) => {
      if ((b.is_retained?1:0) !== (a.is_retained?1:0)) return (b.is_retained?1:0)-(a.is_retained?1:0);
      return (a.player?.name||'').localeCompare(b.player?.name||'');
    });
    tbody.innerHTML = list.map((tp,i) => {
      const p = tp.player || {};
      const roleShort = { 'Batter':'BAT', 'Bowler':'BOWL', 'All-Rounder':'AR', 'Wicket-Keeper':'WK' }[p.role] || p.role?.substring(0,4) || '—';
      let tags = '';
      if (tp.is_retained) tags += '<span class="tag tag-retained">RTN</span> ';
      if (tp.is_rtm)      tags += '<span class="tag tag-rtm">RTM</span> ';
      if (p.is_overseas)  tags += '<span class="tag tag-overseas">OS</span> ';
      if (p.is_uncapped)  tags += '<span class="tag tag-uncapped">UC</span>';
      return `<tr class="${tp.is_retained?'row-retained':''}">
        <td style="font-size:12px;color:var(--muted);text-align:center;">${i+1}</td>
        <td>
          <div style="font-weight:700;font-size:13px;line-height:1.2;">${p.name||'?'}</div>
          ${tags?`<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:2px;">${tags}</div>`:''}
        </td>
        <td style="font-size:13px;color:var(--text2);font-weight:600;">${roleShort}</td>
        <td style="font-size:12px;color:var(--muted);">${p.ipl_team||'—'}</td>
        <td style="font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--gold);font-size:14px;white-space:nowrap;">₹${Number(tp.sold_price).toFixed(2)}</td>
      </tr>`;
    }).join('');
    renderSquadComp(list.map(r => ({...r.player, is_retained: r.is_retained||false})));
  } catch(e) { console.warn('[loadSquad]', e.message); }
  finally { _squadLoading = false; }
}

// ── Squad composition validator ───────────────────────────────
function renderSquadComp(players) {
  const cont = el('squad-comp'); if (!cont) return;
  if (!players.length) { cont.innerHTML = ''; return; }

  const wk   = players.filter(p => p.role === 'Wicket-Keeper').length;
  const bat  = players.filter(p => p.role === 'Batter').length;
  const bowl = players.filter(p => p.role === 'Bowler').length;
  const ar   = players.filter(p => p.role === 'All-Rounder').length;
  const uc   = players.filter(p => p.is_uncapped).length;
  const os   = players.filter(p => p.is_overseas).length;
  const total= players.length;

  // IPL team count check (max 3 per IPL team, advantage holders exempt)
  const iplCounts = {};
  const isAdv = myTeam?.is_advantage_holder;
  players.forEach(p => {
    if (p.ipl_team) iplCounts[p.ipl_team] = (iplCounts[p.ipl_team]||0) + 1;
  });
  const iplViolations = isAdv ? [] : Object.entries(iplCounts).filter(([t,c]) => c > 3).map(([t]) => t);

  const issues = [];
  if (wk < 1)   issues.push(`Need ${1-wk} more WK`);
  if (bat < 2)  issues.push(`Need ${2-bat} more BAT`);
  if (bowl < 3) issues.push(`Need ${3-bowl} more BOWL`);
  if (ar < 2)   issues.push(`Need ${2-ar} more AR`);
  if (uc < 1)   issues.push('Need 1+ Uncapped');
  if (os > 4)   issues.push(`OS limit exceeded (${os}/4)`);
  if (total > 12) issues.push(`Too many players (${total}/12)`);
  iplViolations.forEach(t => issues.push(`Max 3 from ${t}`));

  const allMet = !issues.length;
  const complete = total === 12 && allMet;
  // Don't show "Requirements Met" with too few players — misleading at e.g. 3/12
  const meaningful = total >= 8;

  const roleDefs = [
    { label:'WK',   val:wk,   min:1 },
    { label:'BAT',  val:bat,  min:2 },
    { label:'BOWL', val:bowl, min:3 },
    { label:'AR',   val:ar,   min:2 },
    { label:'UC',   val:uc,   min:1 },
    { label:'OS',   val:os,   max:4 },
  ];

  cont.innerHTML = `<div class="squad-comp-bar">
    <div class="squad-comp-header">
      <span class="${complete ? 'squad-comp-ok' : (allMet && meaningful) ? 'squad-comp-ok' : 'squad-comp-warn'}">
        ${complete ? '✓ Squad Complete' : (allMet && meaningful) ? '✓ Requirements Met' : issues.length ? '⚠ ' + issues.length + ' issue(s)' : `Building (${total}/12)`}
      </span>
      <span style="font-size:11px;opacity:0.6;">${total}/12 players</span>
    </div>
    <div class="squad-role-grid">
      ${roleDefs.map(r => {
        const ok = r.max ? r.val <= r.max : r.val >= r.min;
        return `<div class="squad-role-chip ${ok?'met':'unmet'}">
          <div class="squad-role-chip-val">${r.val}${r.max?'/'+r.max:''}</div>
          <div class="squad-role-chip-lbl">${r.label}</div>
        </div>`;
      }).join('')}
    </div>
    ${issues.length ? `<div class="squad-issues-list">${issues.map(i => `<span class="squad-issue-tag">${i}</span>`).join('')}</div>` : ''}
  </div>`;
}

// ── Export CSV ────────────────────────────────────────────────
async function exportSquadCSV() {
  try {
    const { data: rows } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)')
      .eq('team_id', myTeam.id);
    const lines = [['#','Player','Role','IPL Team','IPL 25 Avg','Base (Cr)','Paid (Cr)','Retained','RTM','Overseas','Uncapped']];
    (rows||[]).forEach((r,i) => {
      const p = r.player || {};
      lines.push([i+1,p.name||'?',p.role||'?',p.ipl_team||'?',
        p.bfl_avg ? Number(p.bfl_avg).toFixed(1) : '—',
        p.base_price||0, Number(r.sold_price||0).toFixed(2),
        r.is_retained?'Yes':'',r.is_rtm?'Yes':'',
        p.is_overseas?'Yes':'',p.is_uncapped?'Yes':'']);
    });
    const csv = lines.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv);
    a.download = (myTeam.team_name||'squad').replace(/\s+/g,'_') + '_squad.csv';
    a.click();
    toast('CSV Exported', 'Squad file downloaded successfully', 'success');
  } catch(e) { toast('Export Failed', 'Could not generate the file', 'error'); }
}

// ── Export PDF (team squad) ───────────────────────────────────
async function exportSquadPDF() {
  try {
    const { data: rows } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price,bfl_avg)')
      .eq('team_id', myTeam.id);
    const list = (rows||[]);
    list.sort((a,b) => {
      if ((b.is_retained?1:0) !== (a.is_retained?1:0)) return (b.is_retained?1:0)-(a.is_retained?1:0);
      return (a.player?.name||'').localeCompare(b.player?.name||'');
    });
    const totalSpent = list.reduce((s,r)=>s+Number(r.sold_price||0),0);
    const os = list.filter(r=>r.player?.is_overseas).length;
    const uc = list.filter(r=>r.player?.is_uncapped).length;
    const rtn= list.filter(r=>r.is_retained).length;

    const rows_html = list.map((tp,i) => {
      const p = tp.player||{};
      const tags = [
        tp.is_retained ? 'RTN' : '',
        tp.is_rtm      ? 'RTM' : '',
        p.is_overseas  ? 'OS'  : '',
        p.is_uncapped  ? 'UC'  : '',
      ].filter(Boolean).join(' ');
      return `<tr style="${tp.is_retained?'background:#fffbeb;':''}">
        <td>${i+1}</td>
        <td><strong>${p.name||'?'}</strong></td>
        <td>${p.role||'—'}</td>
        <td>${p.ipl_team||'—'}</td>
        <td style="text-align:center;">${p.bfl_avg?Number(p.bfl_avg).toFixed(1):'—'}</td>
        <td>₹${p.base_price||0}</td>
        <td style="font-weight:700;color:#b7791f;">₹${Number(tp.sold_price||0).toFixed(2)}</td>
        <td style="font-size:11px;color:#666;">${tags}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>${myTeam.team_name} — BFL 2026 Squad</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:13px;color:#1a1a1a;margin:0;padding:24px;}
        h1{font-size:22px;margin-bottom:4px;color:#1a1a1a;}
        .sub{font-size:12px;color:#666;margin-bottom:16px;}
        .stat-row{display:flex;gap:16px;margin-bottom:18px;flex-wrap:wrap;}
        .stat{background:#f7f7f7;border:1px solid #ddd;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px;}
        .stat-val{font-size:20px;font-weight:700;color:#b7791f;}
        .stat-lbl{font-size:10px;color:#666;text-transform:uppercase;}
        table{width:100%;border-collapse:collapse;font-size:12px;}
        th{background:#1a1a2e;color:#f0b429;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;}
        td{padding:7px 10px;border-bottom:1px solid #eee;}
        @media print{body{padding:12px;}}
      </style></head><body>
      <h1>${myTeam.team_name}</h1>
      <div class="sub">BFL IPL 2026 Auction Squad · Generated ${new Date().toLocaleString('en-IN')}</div>
      <div class="stat-row">
        <div class="stat"><div class="stat-val">${list.length}/12</div><div class="stat-lbl">Players</div></div>
        <div class="stat"><div class="stat-val">₹${totalSpent.toFixed(1)}</div><div class="stat-lbl">Total Spent</div></div>
        <div class="stat"><div class="stat-val">₹${Number(myTeam.purse_remaining).toFixed(1)}</div><div class="stat-lbl">Remaining</div></div>
        <div class="stat"><div class="stat-val">${os}/4</div><div class="stat-lbl">Overseas</div></div>
        <div class="stat"><div class="stat-val">${uc}</div><div class="stat-lbl">Uncapped</div></div>
        <div class="stat"><div class="stat-val">${rtn}</div><div class="stat-lbl">Retained</div></div>
      </div>
      <div style="margin-bottom:16px;padding:12px 16px;background:#f7f7f7;border:1px solid #ddd;border-radius:8px;font-size:12px;"><strong>Squad Composition:</strong> WK: ${list.filter(r=>r.player?.role==='Wicket-Keeper').length}/1+ &nbsp;|&nbsp; BAT: ${list.filter(r=>r.player?.role==='Batter').length}/2+ &nbsp;|&nbsp; BOWL: ${list.filter(r=>r.player?.role==='Bowler').length}/3+ &nbsp;|&nbsp; AR: ${list.filter(r=>r.player?.role==='All-Rounder').length}/2+ &nbsp;|&nbsp; OS: ${os}/4 max &nbsp;|&nbsp; UC: ${uc}/1+</div>
      <table>
        <thead><tr><th>#</th><th>Player</th><th>Role</th><th>IPL Team</th><th>IPL 25 Avg</th><th>Base</th><th>Paid</th><th>Tags</th></tr></thead>
        <tbody>${rows_html}</tbody>
      </table>
      <script>window.onload=()=>window.print();<\/script>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    toast('PDF Ready', 'Squad report opened in new tab', 'success');
  } catch(e) { toast('PDF Failed', 'Could not generate squad report', 'error'); }
}

// ── Realtime ──────────────────────────────────────────────────
// ── Connection state ─────────────────────────────────────────
function setConnState(s) {
  if (_connState === s) return;
  const prev = _connState;
  _connState = s;
  const banner = el('conn-banner');
  const msg    = el('conn-banner-msg');
  if (!banner) return;
  if (s === 'connected') {
    banner.className = 'conn-banner hidden';
    if (prev !== 'connected') toast('Reconnected', 'Live updates restored', 'success');
    _reconnectCount = 0;
  } else if (s === 'reconnecting') {
    banner.className = 'conn-banner reconnecting';
    if (msg) msg.textContent = 'Reconnecting… bids will still go through via polling';
  } else {
    banner.className = 'conn-banner error';
    if (msg) msg.textContent = 'Connection lost — retrying automatically';
  }
}
function manualReconnect() {
  clearTimeout(_reconnectTimer);
  _reconnectCount = 0;
  setConnState('reconnecting');
  subscribeRealtime();
  _lastStateHash = ''; _lastAppliedStatus = '';
  fetchState();
}

function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel('team-v25-' + myTeam.id)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_state' }, () => {
      _lastStateHash = ''; _lastAppliedStatus = ''; _lastAppliedStatus = ''; fetchState();
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'teams', filter:'id=eq.'+myTeam.id }, payload => {
      if (payload.new?.purse_remaining !== undefined) {
        myTeam.purse_remaining = payload.new.purse_remaining;
        myTeam.rtm_cards_total = payload.new.rtm_cards_total ?? myTeam.rtm_cards_total;
        myTeam.rtm_cards_used  = payload.new.rtm_cards_used  ?? myTeam.rtm_cards_used;
        updatePurseDisplay(); updateRTMBadge();
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'teams' }, () => { dbt('allTeams', loadAllTeams, 800); })
    .on('postgres_changes', { event:'*', schema:'public', table:'team_players' }, () => {
      loadSquad(); loadStats(); loadAllTeams();
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'unsold_log' }, () => { loadStats(); })
    .on('system', {}, p => {
      if (p.status === 'SUBSCRIBED') {
        setConnState('connected');
      } else if (['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(p.status)) {
        _reconnectCount++;
        setConnState(_reconnectCount >= 3 ? 'error' : 'reconnecting');
        const delay = Math.min(3000 * Math.pow(2, Math.min(_reconnectCount - 1, 4)), 30000);
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
          if (realtimeChannel) { try { sb.removeChannel(realtimeChannel); } catch(_) {} realtimeChannel = null; }
          subscribeRealtime();
        }, delay);
      }
    }).subscribe(s => { if (s === 'SUBSCRIBED') setConnState('connected'); });
}

document.addEventListener('keydown', e => {
  // Enter on bid input → place bid
  if (e.key === 'Enter' && document.activeElement === el('bid-input')) { placeBid(); return; }
  // B → focus bid input (when not typing elsewhere)
  if (e.key === 'b' || e.key === 'B') {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      const inp = el('bid-input');
      if (inp && !inp.disabled) { e.preventDefault(); inp.focus(); inp.select(); inp.scrollIntoView({behavior:"smooth",block:"center"}); }
    }
  }
  // Escape → clear bid error, blur input
  if (e.key === 'Escape') {
    const err = el('bid-error'); if (err) err.textContent = '';
    document.activeElement?.blur();
  }
});

init();