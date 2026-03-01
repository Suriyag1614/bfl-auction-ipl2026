// ═══════════════════════════════════════════════════════════════
//  AUCTION.JS v12 — All issues fixed
//  • Set-live shown in main live-auction block (not set-launcher tab)
//  • Second-highest bid shown in every set slot card
//  • Set launcher: zero flicker (DOM patch, no innerHTML rebuild)
//  • RTM: full flow — team sees RTM screen, accept/decline works
//  • Timer: 12s client-side grace after display hits 0
//  • forEach fix: never pass [] for postgres uuid[] via .update()
// ═══════════════════════════════════════════════════════════════

let timerInterval    = null;
let setTimerInterval = null;
let realtimeChannel  = null;
let setSlotChannel   = null;
let pollInterval     = null;
let myTeam           = null;
let currentState     = null;
let _lastStateHash   = '';
let _lastSlotsHash   = '';
let _isRendering     = false;
let _squadLoading    = false;

const SIL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%23111520' rx='40'/%3E%3Ccircle cx='40' cy='28' r='14' fill='%2364748b'/%3E%3Cellipse cx='40' cy='70' rx='22' ry='18' fill='%2364748b'/%3E%3C/svg%3E";
window._SIL = SIL;

const el     = id => document.getElementById(id);
const show   = id => { const e=el(id); if(e) e.style.display=''; };
const hide   = id => { const e=el(id); if(e) e.style.display='none'; };
const fmt    = v  => '₹' + Number(v).toFixed(2) + ' Cr';
const imgSrc = u  => u || SIL;

const stateHash = s => !s ? '' :
  [s.status, s.current_player_id, s.current_highest_bid,
   s.current_highest_team_id, s.bid_timer_end, s.rtm_pending,
   s.rtm_team_id, s.last_player_result, s.last_player_id,
   s.last_sold_price, s.current_set_name,
   (s.unsold_player_ids||[]).length].join('|');

function toast(msg, type='info') {
  const c = el('toast-container'); if (!c) return;
  const d = document.createElement('div');
  d.className = 'toast toast-' + type; d.textContent = msg; c.appendChild(d);
  setTimeout(() => d.classList.add('toast-exit'), 3200);
  setTimeout(() => d.remove(), 3700);
}

async function doLogout() { stopPolling(); await sb.auth.signOut(); location.href = 'index.html'; }

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { data:{ session } } = await sb.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  if (session.user.app_metadata?.role === 'admin') { location.href = 'admin.html'; return; }
  const { data: team } = await sb.from('teams')
    .select('*').eq('user_id', session.user.id).maybeSingle();
  if (!team) { location.href = 'index.html'; return; }
  myTeam = team;
  await Promise.all([fetchState(), loadSquad(), loadStats()]);
  revealUI(); startPolling(); subscribeRealtime();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchState(); });
}

function revealUI() {
  hide('auction-skeleton'); hide('stats-skeleton'); hide('squad-skeleton');
  show('stats-real'); show('squad-table-wrap');
  const tn = el('team-name'); if (tn) tn.textContent = myTeam.team_name;
  updatePurseDisplay(); if (myTeam.is_advantage_holder) show('advantage-badge');
  updateRTMBadge();
}

function updateRTMBadge() {
  const rtmTotal = myTeam.rtm_cards_total || 0;
  const rtmUsed  = myTeam.rtm_cards_used  || 0;
  const rem = Math.max(0, rtmTotal - rtmUsed);
  const b = el('rtm-badge');
  if (b) { b.textContent = 'RTM ×' + rem; b.style.display = rem > 0 ? 'inline-block' : 'none'; }
}

function updatePurseDisplay() {
  const pd = el('purse-display');
  if (pd) {
    pd.textContent = fmt(myTeam.purse_remaining);
    pd.classList.add('purse-updated');
    setTimeout(() => pd.classList.remove('purse-updated'), 500);
  }
}

// ── Polling ───────────────────────────────────────────────────
function startPolling() { stopPolling(); pollInterval = setInterval(fetchState, 2000); }
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

    // Fetch RTM team name if pending
    if (state.rtm_team_id) {
      const { data: rt } = await sb.from('teams')
        .select('team_name,id').eq('id', state.rtm_team_id).maybeSingle();
      state.rtm_team = rt || null;
    } else { state.rtm_team = null; }

    // Fetch last player for banner
    if (state.last_player_id) {
      const { data: lp } = await sb.from('players_master')
        .select('id,name,role,image_url').eq('id', state.last_player_id).maybeSingle();
      state.last_player = lp || null;
    } else { state.last_player = null; }

    // Second team fallback if FK join didn't resolve
    if (!state.second_team && state.second_highest_team_id) {
      const { data: st2 } = await sb.from('teams')
        .select('team_name').eq('id', state.second_highest_team_id).maybeSingle();
      state.second_team = st2 || null;
    }

    // For set_live: also poll slots for bid changes
    if (state.status === 'set_live' && state.current_set_name) {
      const { data: slots } = await sb.from('auction_slots')
        .select('id,current_highest_bid,current_highest_team_id,second_highest_bid,second_highest_team_id,bid_timer_end')
        .eq('set_name', state.current_set_name).eq('status', 'live');
      const sh = (slots||[]).map(s =>
        s.id+':'+s.current_highest_bid+':'+s.current_highest_team_id+':'+s.second_highest_bid
      ).join('|');
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

// ── Apply state ───────────────────────────────────────────────
async function applyState(state) {
  const statusEl = el('auction-status');
  if (statusEl) {
    const labels = { waiting:'Waiting', live:'LIVE', sold:'Sold', paused:'Paused', set_live:'SET LIVE' };
    statusEl.textContent = state.rtm_pending ? 'RTM' : (labels[state.status] || state.status);
    statusEl.className   = 'status-badge status-' + (state.rtm_pending ? 'rtm' : state.status);
  }

  // Banner — always rendered above everything
  renderLastResult(state);

  // Always refresh purse from DB
  await refreshPurse();

  if (state.rtm_pending) {
    // RTM pending — show RTM screen (hides player-card, set-auction-view, no-auction)
    stopTimer(); stopSetTimer();
    hide('player-card'); hide('no-auction');
    // Set auction view repurposed: show set-auction-view with RTM content
    hide('set-auction-view');
    renderRTMPending(state);

  } else if (state.status === 'set_live') {
    // ── SET LIVE shown in the MAIN player-card area ──
    // This means teams don't have to scroll to a separate tab
    stopTimer();
    hide('no-auction'); hide('rtm-pending');
    hide('set-auction-view'); // hide old separate set view
    show('player-card');      // reuse player-card container
    await renderSetInPlayerCard(state);

  } else if ((state.status === 'live' || state.status === 'paused') && state.current_player) {
    stopSetTimer();
    hide('set-auction-view'); hide('no-auction'); hide('rtm-pending');
    renderLivePlayer(state, state.status === 'paused');

  } else {
    // Waiting / post-sell
    stopTimer(); stopSetTimer();
    if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
    hide('player-card'); hide('set-auction-view'); hide('rtm-pending');
    show('no-auction');

    const noMsg = el('no-auction-msg');
    if (noMsg) {
      if (state.last_player_result === 'set_done') {
        noMsg.innerHTML = `⚡ <strong>Set complete</strong> — ${state.last_sold_to_team || ''}`;
      } else if (state.last_player_result === 'sold' && state.last_player) {
        noMsg.innerHTML = `✅ <strong>${state.last_player.name}</strong> sold to <strong>${state.last_sold_to_team}</strong> for <strong>${fmt(state.last_sold_price)}</strong>`;
      } else if (state.last_player_result === 'unsold' && state.last_player) {
        noMsg.innerHTML = `📭 <strong>${state.last_player.name}</strong> went <strong>unsold</strong>`;
      } else if (state.status === 'paused') {
        noMsg.textContent = '⏸ Auction is paused';
      } else {
        noMsg.textContent = '⏳ Waiting for admin to start next player…';
      }
    }
    await Promise.all([loadSquad(), loadStats()]);
    renderMiniHistory('mini-history-wrap');
  }
}

// ── RTM pending screen ────────────────────────────────────────
function renderRTMPending(state) {
  const cont = el('rtm-pending'); if (!cont) return;
  show('rtm-pending');
  const isRTMTeam = state.rtm_team?.id === myTeam?.id;
  const price = fmt(state.rtm_match_price || 0);
  const p = state.current_player;
  cont.innerHTML = `
    <div class="rtm-banner">
      <div class="rtm-icon">🔄</div>
      <div class="rtm-title">RTM OPPORTUNITY</div>
      <div class="rtm-body">
        <img src="${imgSrc(p?.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="" class="rtm-player-img">
        <div style="flex:1;min-width:0;">
          <div class="rtm-player-name">${p?.name || '—'}</div>
          <div class="rtm-player-sub">${p?.role || ''} · ${p?.ipl_team || ''}</div>
          <div class="rtm-price">Winning bid: <strong>${price}</strong></div>
          <div class="rtm-team-msg">${isRTMTeam
            ? `<span style="color:var(--gold);">✦ Your franchise can RTM at ${price}!</span>`
            : `<span style="color:var(--muted);">Waiting for <strong>${state.rtm_team?.team_name || '—'}</strong> to decide…</span>`
          }</div>
        </div>
      </div>
      ${isRTMTeam ? `
        <div class="rtm-actions">
          <button class="btn btn-gold" onclick="exerciseRTM(true)">✓ Exercise RTM — Match ${price}</button>
          <button class="btn btn-ghost" onclick="exerciseRTM(false)">✗ Decline RTM</button>
        </div>` : ''}
    </div>`;
}

async function exerciseRTM(accept) {
  const { data, error } = await sb.rpc('exercise_rtm', { p_accept: accept });
  if (error || !data?.success) {
    toast(error?.message || data?.error || 'RTM error', 'error'); return;
  }
  toast(accept ? '✓ RTM exercised!' : 'RTM declined.', accept ? 'success' : 'info');
  _lastStateHash = '';
  await fetchState();
}

// ── Set auction rendered inside player-card area ──────────────
// Zero flicker: only patches changed DOM nodes, never rebuilds the whole grid
async function renderSetInPlayerCard(state) {
  // Fetch full slot data
  const { data: slots, error } = await sb.from('auction_slots')
    .select(`*,
      player:players_master(id,name,role,ipl_team,base_price,image_url,is_overseas,is_uncapped,is_rtm_eligible,is_retained),
      highest_team:teams!auction_slots_current_highest_team_id_fkey(team_name,id),
      second_team:teams!auction_slots_second_highest_team_id_fkey(team_name,id)`)
    .eq('set_name', state.current_set_name).eq('status', 'live');

  if (error) { console.warn('[renderSetInPlayerCard]', error.message); return; }

  if (!slots?.length) {
    // All closed — wait for state to update
    el('player-card').innerHTML = `<div class="no-auction-msg">⚡ ${state.current_set_name} — closing…</div>`;
    return;
  }

  const latestEnd = slots.reduce((mx,s) =>
    Math.max(mx, s.bid_timer_end ? new Date(s.bid_timer_end).getTime() : 0), 0);

  // Update top bid panel stats with top bid across all slots
  const topSlot = slots.reduce((b,s) => (s.current_highest_bid||0)>(b.current_highest_bid||0)?s:b, slots[0]);
  const cbEl = el('current-bid'), ltEl = el('leading-team');
  if (cbEl) cbEl.textContent = (topSlot?.current_highest_bid||0) > 0
    ? `${fmt(topSlot.current_highest_bid)} (${topSlot.player?.name||''})` : 'Set Auction Live';
  if (ltEl) {
    const isTopMe = topSlot?.current_highest_team_id === myTeam?.id;
    ltEl.textContent = topSlot?.highest_team
      ? topSlot.highest_team.team_name + (isTopMe ? ' 🟢' : '') : '—';
    ltEl.style.color = isTopMe ? 'var(--green)' : '';
  }

  const cardId = s => 'set-card-' + s.id;
  const existingGrid = el('set-slots-grid');

  if (!existingGrid) {
    // ── First render — build full HTML inside player-card ──
    const cards = slots.map(slot => {
      const p = slot.player || {};
      const isMe  = slot.current_highest_team_id === myTeam?.id;
      const hasBid = slot.current_highest_bid > 0;
      const has2nd = slot.second_highest_bid > 0;
      const next  = hasBid ? Number(slot.current_highest_bid)+0.25 : Number(p.base_price||0);
      let tags = '';
      if (p.is_overseas) tags += '<span class="tag tag-overseas">OS</span>';
      if (p.is_uncapped) tags += '<span class="tag tag-uncapped">UC</span>';
      if (p.is_retained) tags += '<span class="tag tag-retained">RTN</span>';
      if (p.is_rtm_eligible && !p.is_retained) tags += '<span class="tag tag-rtm">RTM</span>';

      const bidArea = isMe
        ? `<div class="set-slot-actions" id="sa-${slot.id}">
             <div style="font-size:13px;color:var(--green);font-weight:700;flex:1;">✓ You: ${fmt(slot.current_highest_bid)}</div>
             <button class="btn btn-ghost btn-sm" onclick="undoSetBid('${slot.id}')">↩ Undo</button>
           </div>`
        : `<div class="set-slot-actions" id="sa-${slot.id}">
             <input type="number" class="form-input" id="sbid-${slot.id}"
               value="${next.toFixed(2)}" min="${next.toFixed(2)}" step="0.25">
             <button class="btn btn-gold btn-sm" onclick="placeSetBid('${slot.id}')">Bid</button>
           </div>`;

      return `<div class="team-slot-card${isMe?' leading':''}" id="${cardId(slot)}">
        <div class="set-slot-header">
          <img src="${imgSrc(p.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
          <div class="set-slot-info">
            <div class="set-slot-name">${p.name||'?'}</div>
            <div class="set-slot-meta">${p.role||''} · Base ${fmt(p.base_price)}</div>
            ${tags?`<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px;">${tags}</div>`:''}
          </div>
        </div>
        <div class="set-slot-bid" id="sb-${slot.id}">
          <div class="set-slot-bid-label">Highest Bid</div>
          <div class="set-slot-bid-val ${isMe?'bid-me':'bid-other'}">
            ${hasBid?fmt(slot.current_highest_bid):'<span class="bid-none">No bids</span>'}
          </div>
          ${hasBid?`<div class="set-slot-bid-team">${slot.highest_team?.team_name||''}${isMe?' 🟢':''}</div>`:''}
          ${has2nd?`<div class="set-slot-bid-2nd">2nd: ${fmt(slot.second_highest_bid)} · ${slot.second_team?.team_name||'?'}</div>`:''}
        </div>
        ${bidArea}
        <div id="serr-${slot.id}" class="error-msg" style="font-size:11px;min-height:0;"></div>
      </div>`;
    }).join('');

    // Write into player-card — preserve the player-card structure but replace inner content
    el('player-card').innerHTML = `
      <div class="set-auction-header" style="margin-bottom:12px;">
        <div>
          <span class="set-auction-title">⚡ ${state.current_set_name||''}</span>
          <span class="set-auction-sub" style="margin-left:8px;color:var(--muted);font-size:13px;">${slots.length} players — bid simultaneously</span>
        </div>
        <div class="set-timer-wrap">
          <div class="set-timer-label">Timer</div>
          <span class="timer" id="set-timer">—</span>
        </div>
      </div>
      <div class="bid-area" style="display:none;"></div>
      <div style="margin-bottom:10px;">
        <div class="bid-stat" style="display:inline-block;margin-right:16px;">
          <div class="bid-stat-label">Top Bid</div>
          <div class="bid-stat-value" id="current-bid">—</div>
          <div class="bid-stat-sub" id="leading-team">—</div>
        </div>
      </div>
      <div class="team-set-slots-grid" id="set-slots-grid">${cards}</div>`;

  } else {
    // ── Subsequent renders — patch ONLY changed data (zero flicker) ──
    slots.forEach(slot => {
      const p      = slot.player || {};
      const isMe   = slot.current_highest_team_id === myTeam?.id;
      const hasBid = slot.current_highest_bid > 0;
      const has2nd = slot.second_highest_bid > 0;
      const next   = hasBid ? Number(slot.current_highest_bid)+0.25 : Number(p.base_price||0);

      const card = document.getElementById(cardId(slot));
      if (!card) return; // slot missing — will show on next full render

      // Patch card class (leading indicator)
      card.className = 'team-slot-card' + (isMe ? ' leading' : '');

      // Patch bid display div
      const bidDiv = document.getElementById('sb-' + slot.id);
      if (bidDiv) {
        bidDiv.innerHTML = `
          <div class="set-slot-bid-label">Highest Bid</div>
          <div class="set-slot-bid-val ${isMe?'bid-me':'bid-other'}">
            ${hasBid?fmt(slot.current_highest_bid):'<span class="bid-none">No bids</span>'}
          </div>
          ${hasBid?`<div class="set-slot-bid-team">${slot.highest_team?.team_name||''}${isMe?' 🟢':''}</div>`:''}
          ${has2nd?`<div class="set-slot-bid-2nd">2nd: ${fmt(slot.second_highest_bid)} · ${slot.second_team?.team_name||'?'}</div>`:''}`;
      }

      // Patch action area (only if leading state changed)
      const sa = document.getElementById('sa-' + slot.id);
      if (sa) {
        const hasInput = !!document.getElementById('sbid-' + slot.id);
        if (isMe && hasInput) {
          // Was not leading → now leading
          sa.innerHTML = `<div style="font-size:13px;color:var(--green);font-weight:700;flex:1;">✓ You: ${fmt(slot.current_highest_bid)}</div>
            <button class="btn btn-ghost btn-sm" onclick="undoSetBid('${slot.id}')">↩ Undo</button>`;
        } else if (!isMe && !hasInput) {
          // Was leading → no longer leading
          sa.innerHTML = `<input type="number" class="form-input" id="sbid-${slot.id}"
            value="${next.toFixed(2)}" min="${next.toFixed(2)}" step="0.25">
            <button class="btn btn-gold btn-sm" onclick="placeSetBid('${slot.id}')">Bid</button>`;
        } else if (isMe && !hasInput) {
          // Still leading — update amount text only
          const amountEl = sa.querySelector('div');
          if (amountEl) amountEl.textContent = '✓ You: ' + fmt(slot.current_highest_bid);
        } else if (!isMe && hasInput) {
          // Still not leading — bump input minimum if outbid
          const inp = document.getElementById('sbid-' + slot.id);
          if (inp && !inp.matches(':focus')) {
            inp.min = next.toFixed(2);
            if (parseFloat(inp.value) < next) inp.value = next.toFixed(2);
          }
        }
      }
    });
  }

  startSetTimer(latestEnd);
  subscribeSetSlots(state.current_set_name);
}

// ── Live single-player card ───────────────────────────────────
function renderLivePlayer(state, paused) {
  const p    = state.current_player;
  const isMe = state.current_highest_team_id === myTeam?.id;

  // Restore player-card HTML if it was replaced by set auction view
  if (!el('player-img')) {
    el('player-card').innerHTML = `
      <div class="player-card-inner">
        <img id="player-img" class="player-avatar-lg" src="" alt="" style="display:none;"
          onerror="this.onerror=null;if(window._SIL){this.src=window._SIL;}else{this.style.display='none';}">
        <div class="player-info-text">
          <div id="player-name" class="player-name">—</div>
          <div class="player-meta">
            <span>🎭 <span id="player-role">—</span></span>
            <span>🏏 <span id="player-team">—</span></span>
            <span>📁 <span id="player-set">—</span></span>
            <span>💰 Base: <span id="player-base">—</span></span>
          </div>
          <div id="player-flags" class="player-flags"></div>
        </div>
      </div>
      <div class="bid-area">
        <div class="timer-wrap">
          <div class="timer-label">Time Left</div>
          <div class="timer" id="timer">—</div>
        </div>
        <div class="bid-stats">
          <div class="bid-stat">
            <div class="bid-stat-label">Highest Bid</div>
            <div class="bid-stat-value" id="current-bid">—</div>
            <div class="bid-stat-sub" id="leading-team">—</div>
          </div>
          <div class="bid-stat">
            <div class="bid-stat-label">2nd Highest</div>
            <div class="bid-stat-value second" id="second-bid">—</div>
            <div class="bid-stat-sub" id="second-team">—</div>
          </div>
        </div>
        <div class="bid-row">
          <input class="form-input" type="number" id="bid-input" placeholder="Amount (Cr)" step="0.25" min="0.5">
          <button class="btn btn-gold" id="bid-btn" onclick="placeBid()">Bid</button>
          <button class="btn btn-ghost" id="undo-bid-btn" onclick="undoBid()" style="display:none;">↩ Undo</button>
        </div>
        <div id="bid-error" class="error-msg"></div>
        <div class="info-msg">Bids must be multiples of ₹0.25 Cr · Press Enter to bid</div>
      </div>
      <div id="mini-history-wrap-live"></div>`;
  }

  const img = el('player-img');
  if (img) { img.src = imgSrc(p.image_url); img.onerror = () => { img.src = SIL; }; img.style.display = 'block'; }
  el('player-name').textContent = p.name;
  el('player-role').textContent = p.role;
  el('player-team').textContent = p.ipl_team || '—';
  el('player-base').textContent = fmt(p.base_price);
  el('player-set').textContent  = p.set_name  || '—';

  let flags = p.is_overseas
    ? '<span class="tag tag-overseas">Overseas</span>'
    : '<span class="tag tag-indian">Indian</span>';
  flags += p.is_uncapped
    ? ' <span class="tag tag-uncapped">Uncapped</span>'
    : ' <span class="tag tag-capped">Capped</span>';
  if (p.is_retained)                       flags += ' <span class="tag tag-retained">Retained (RTN)</span>';
  if (p.is_rtm_eligible && !p.is_retained) flags += ' <span class="tag tag-rtm">RTM Eligible</span>';
  el('player-flags').innerHTML = flags;

  const hasBid = state.current_highest_bid > 0;
  el('current-bid').textContent = hasBid ? fmt(state.current_highest_bid) : 'No bids yet';
  const leadEl = el('leading-team');
  if (leadEl) {
    leadEl.textContent = state.highest_team
      ? state.highest_team.team_name + (isMe ? ' 🟢 (You)' : '') : '—';
    leadEl.style.color = isMe ? 'var(--green)' : '';
  }
  el('second-bid').textContent  = state.second_highest_bid > 0 ? fmt(state.second_highest_bid) : '—';
  el('second-team').textContent = state.second_team?.team_name || '—';

  const next = hasBid ? Number(state.current_highest_bid)+0.25 : Number(p.base_price);
  const bidInput = el('bid-input');
  if (bidInput) { bidInput.value = next.toFixed(2); bidInput.min = next.toFixed(2); bidInput.step = '0.25'; }

  const bidBtn  = el('bid-btn');
  const undoBtn = el('undo-bid-btn');
  if (isMe) {
    if (bidBtn)  bidBtn.style.display = 'none';
    if (undoBtn) undoBtn.style.display = (state.prev_bid_team_purse != null && !paused) ? 'inline-flex' : 'none';
    if (bidInput) bidInput.disabled = true;
  } else {
    if (bidBtn)  { bidBtn.style.display = ''; bidBtn.disabled = paused; }
    if (undoBtn) undoBtn.style.display = 'none';
    if (bidInput) bidInput.disabled = paused;
  }
  const errEl = el('bid-error'); if (errEl) errEl.textContent = '';

  hide('no-auction'); hide('set-auction-view'); hide('rtm-pending'); show('player-card');

  if (paused) {
    stopTimer(); const t = el('timer'); if (t) { t.textContent = 'Paused'; t.className = 'timer'; }
  } else {
    startTimer(state.bid_timer_end);
  }
}

// ── Last result banner ────────────────────────────────────────
function renderLastResult(state) {
  const cont = el('last-result-container'); if (!cont) return;
  if (!state.last_player_result) { cont.innerHTML = ''; return; }

  if (state.last_player_result === 'set_done') {
    cont.innerHTML = `
      <div class="last-result-banner sold-banner">
        <div style="font-size:22px;margin-right:10px;">⚡</div>
        <div style="flex:1;min-width:0;">
          <div class="lr-name">Set Auction Complete</div>
          <div class="lr-detail">${state.last_sold_to_team || ''}</div>
        </div>
        <div class="lr-price lr-sold">DONE</div>
      </div>`; return;
  }

  const p = state.last_player;
  const sold = state.last_player_result === 'sold';
  cont.innerHTML = `
    <div class="last-result-banner ${sold?'sold-banner':'unsold-banner'}">
      <img src="${imgSrc(p?.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
      <div style="flex:1;min-width:0;">
        <div class="lr-name">${p?.name||'Unknown'}</div>
        <div class="lr-detail">${p?.role||''}${sold
          ? ' · Sold to <strong>'+(state.last_sold_to_team||'?')+'</strong>'
          : ' · Unsold'}</div>
      </div>
      <div class="lr-price ${sold?'lr-sold':'lr-unsold'}">
        ${sold ? fmt(state.last_sold_price) : 'UNSOLD'}
      </div>
    </div>`;
}

// ── Mini history ──────────────────────────────────────────────
async function renderMiniHistory(wrapId) {
  const wrap = el(wrapId); if (!wrap) return;
  try {
    const [{ data: sold }, { data: ul }] = await Promise.all([
      sb.from('team_players')
        .select('sold_price,sold_at,is_retained,is_rtm,team:teams(team_name),player:players_master(name,role,image_url)')
        .order('sold_at', { ascending: false }).limit(6),
      sb.from('unsold_log')
        .select('logged_at,player:players_master(name,role,image_url)')
        .order('logged_at', { ascending: false }).limit(4)
    ]);
    const items = [
      ...(sold||[]).map(r => ({ name:r.player?.name||'?', role:r.player?.role||'', img:r.player?.image_url||'',
        price:r.sold_price, team:r.team?.team_name||'', ts:r.sold_at, status:'sold',
        isRTM: r.is_rtm, isRetained: r.is_retained })),
      ...(ul||[]).map(r => ({ name:r.player?.name||'?', role:r.player?.role||'', img:r.player?.image_url||'',
        price:null, team:'', ts:r.logged_at, status:'unsold' }))
    ].sort((a,b) => new Date(b.ts)-new Date(a.ts)).slice(0,6);

    if (!items.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="mini-history">
      <div class="mini-history-title">Recent Results</div>
      ${items.map(r => `<div class="mini-history-item">
        <img src="${imgSrc(r.img)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
        <div class="mh-name">${r.name}<span class="mh-role"> · ${r.role}</span>${r.isRTM?'<span class="tag tag-rtm" style="font-size:10px;padding:1px 4px;margin-left:4px;">RTM</span>':''}</div>
        ${r.status==='sold'
          ? `<div class="mh-team">${r.team}</div><div class="mh-price sold-price">${fmt(r.price)}</div>`
          : `<div class="mh-price unsold-price">Unsold</div>`}
      </div>`).join('')}
    </div>`;
  } catch(e) { console.warn('[MiniHistory]', e.message); }
}

// ── Timer ─────────────────────────────────────────────────────
function startTimer(endTime) {
  stopTimer();
  const endMs = new Date(endTime).getTime();
  function tick() {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t = el('timer'); if (!t) { stopTimer(); return; }
    t.textContent = rem + 's';
    t.className = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
  }
  tick(); timerInterval = setInterval(tick, 300);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

function startSetTimer(endMs) {
  stopSetTimer();
  if (!endMs) return;
  function tick() {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t = el('set-timer'); if (!t) { stopSetTimer(); return; }
    t.textContent = rem + 's';
    t.className = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
  }
  tick(); setTimerInterval = setInterval(tick, 300);
}
function stopSetTimer() { clearInterval(setTimerInterval); setTimerInterval = null; }

// ── Set slot realtime subscription ───────────────────────────
function subscribeSetSlots(setName) {
  if (setSlotChannel) return; // already subscribed
  setSlotChannel = sb.channel('set-slots-v12-' + setName)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_slots',
      filter:'set_name=eq.'+setName }, () => {
      _lastSlotsHash = ''; _lastStateHash = ''; fetchState();
    }).subscribe();
}

// ── Bid actions (single-player) ───────────────────────────────
async function placeBid() {
  const errEl   = el('bid-error');
  const bidBtn  = el('bid-btn');
  const input   = el('bid-input');
  if (!input || !bidBtn) return;
  errEl.textContent = '';

  const raw    = parseFloat(input.value);
  if (isNaN(raw) || raw <= 0) { errEl.textContent = 'Enter a valid amount'; return; }
  const amount = Math.round(raw / 0.25) * 0.25;
  if (Math.abs(amount - raw) > 0.001) {
    errEl.textContent = 'Bid must be a multiple of ₹0.25 Cr'; input.value = amount.toFixed(2); return;
  }
  if (amount > myTeam.purse_remaining) {
    errEl.textContent = 'Insufficient purse (' + fmt(myTeam.purse_remaining) + ')'; return;
  }

  bidBtn.disabled = true; bidBtn.textContent = '…';
  const { data, error } = await sb.rpc('place_bid', { bid_amount: amount });
  bidBtn.disabled = false; bidBtn.textContent = 'Bid';
  if (error)          { errEl.textContent = error.message; return; }
  if (!data?.success) { errEl.textContent = data?.error || 'Error'; return; }

  bidBtn.style.display = 'none'; input.disabled = true;
  const undoBtn = el('undo-bid-btn'); if (undoBtn) undoBtn.style.display = 'inline-flex';
  input.classList.add('bid-success-flash');
  setTimeout(() => input.classList.remove('bid-success-flash'), 600);
  toast('✓ Bid: ' + fmt(amount), 'success');
  _lastStateHash = ''; fetchState();
}

async function undoBid() {
  const btn = el('undo-bid-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const { data, error } = await sb.rpc('undo_bid');
  if (btn) { btn.disabled = false; btn.textContent = '↩ Undo'; }
  if (error || !data?.success) { toast(error?.message || data?.error || 'Cannot undo', 'warn'); return; }
  const bidBtn = el('bid-btn'); if (bidBtn) { bidBtn.style.display = ''; bidBtn.disabled = false; }
  const input  = el('bid-input'); if (input) input.disabled = false;
  if (btn) btn.style.display = 'none';
  toast('↩ Bid undone', 'info');
  _lastStateHash = ''; await fetchState();
}

// ── Set bid actions ───────────────────────────────────────────
async function placeSetBid(slotId) {
  const inp    = document.getElementById('sbid-' + slotId);
  const errEl  = document.getElementById('serr-' + slotId);
  const btn    = inp?.nextElementSibling;
  if (!inp) return;
  if (errEl) errEl.textContent = '';

  const raw    = parseFloat(inp.value);
  if (isNaN(raw) || raw <= 0) { if(errEl) errEl.textContent = 'Enter valid amount'; return; }
  const amount = Math.round(raw / 0.25) * 0.25;
  if (Math.abs(amount - raw) > 0.001) {
    if(errEl) errEl.textContent = 'Must be multiple of ₹0.25 Cr';
    inp.value = amount.toFixed(2); return;
  }
  if (amount > myTeam.purse_remaining) {
    if(errEl) errEl.textContent = 'Insufficient purse'; return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const { data, error } = await sb.rpc('place_set_bid', { p_slot_id: slotId, bid_amount: amount });
  if (btn) { btn.disabled = false; btn.textContent = 'Bid'; }
  if (error || !data?.success) {
    if(errEl) errEl.textContent = error?.message || data?.error || 'Error'; return;
  }
  toast('✓ Set bid: ' + fmt(amount), 'success');
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = ''; fetchState();
}

async function undoSetBid(slotId) {
  const { data, error } = await sb.rpc('undo_set_bid', { p_slot_id: slotId });
  if (error || !data?.success) { toast(error?.message || data?.error || 'Cannot undo', 'warn'); return; }
  toast('↩ Set bid undone', 'info');
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = ''; fetchState();
}

// ── Purse refresh ─────────────────────────────────────────────
async function refreshPurse() {
  try {
    const { data: t } = await sb.from('teams')
      .select('purse_remaining,rtm_cards_total,rtm_cards_used').eq('id', myTeam.id).single();
    if (!t) return;
    myTeam.purse_remaining = t.purse_remaining;
    myTeam.rtm_cards_total = t.rtm_cards_total;
    myTeam.rtm_cards_used  = t.rtm_cards_used;
    updatePurseDisplay(); updateRTMBadge();
  } catch(e) { console.warn('[refreshPurse]', e.message); }
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const { count: total } = await sb.from('players_master').select('*', { count:'exact', head:true });
    const { data: soldRows } = await sb.from('team_players').select('sold_price');
    const soldCount = soldRows?.length || 0;
    const spent     = (soldRows||[]).reduce((s,r) => s+Number(r.sold_price||0), 0);
    const { data: st } = await sb.from('auction_state').select('unsold_player_ids').eq('id',1).maybeSingle();
    const unsoldArr  = st?.unsold_player_ids;
    const unsoldCount = Array.isArray(unsoldArr) ? unsoldArr.length : 0;
    if (el('as-total'))     el('as-total').textContent     = total || 0;
    if (el('as-sold'))      el('as-sold').textContent      = soldCount;
    if (el('as-unsold'))    el('as-unsold').textContent    = unsoldCount;
    if (el('as-remaining')) el('as-remaining').textContent = Math.max(0,(total||0)-soldCount-unsoldCount);
    if (el('as-spent'))     el('as-spent').textContent     = spent.toFixed(2);
  } catch(e) { console.warn('[Stats]', e.message); }
}

// ── Squad ─────────────────────────────────────────────────────
async function loadSquad() {
  if (_squadLoading) return; _squadLoading = true;
  try {
    const { data: rows, error } = await sb.from('team_players')
      .select('sold_price,is_retained,is_rtm,player:players_master(name,role,ipl_team,is_overseas,is_uncapped,base_price)')
      .eq('team_id', myTeam.id);
    const list = error ? [] : (rows || []);

    const auctionSpent = list.filter(r => !r.is_retained).reduce((s,r) => s+Number(r.sold_price||0), 0);
    const retainSpent  = list.filter(r =>  r.is_retained).reduce((s,r) => s+Number(r.sold_price||0), 0);
    if (el('squad-spent')) {
      el('squad-spent').textContent = retainSpent > 0
        ? `₹${auctionSpent.toFixed(2)} + ₹${retainSpent.toFixed(2)} RTN`
        : `₹${(auctionSpent).toFixed(2)} Cr spent`;
    }
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
      let tags = '';
      if (tp.is_retained) tags += '<span class="tag tag-retained">RTN</span> ';
      if (tp.is_rtm)      tags += '<span class="tag tag-rtm">RTM</span> ';
      if (p.is_overseas)  tags += '<span class="tag tag-overseas">OS</span> ';
      if (p.is_uncapped)  tags += '<span class="tag tag-uncapped">UC</span>';
      return `<tr class="${tp.is_retained?'row-retained':''}">
        <td style="font-size:12px;color:var(--muted);width:28px;">${i+1}</td>
        <td><div style="font-weight:700;font-size:14px;">${p.name||'?'}</div>
          ${tags?`<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${tags}</div>`:''}</td>
        <td style="font-size:13px;color:var(--text2);">${p.role||'—'}</td>
        <td style="font-size:12px;color:var(--muted);">${p.ipl_team||'—'}</td>
        <td style="font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--gold);white-space:nowrap;">${fmt(tp.sold_price)}</td>
      </tr>`;
    }).join('');

    renderSquadComp(list.map(r => ({ ...r.player, is_retained: r.is_retained||false })));
  } catch(e) { console.warn('[loadSquad]', e.message); }
  finally { _squadLoading = false; }
}

function renderSquadComp(players) {
  const cont = el('squad-comp'); if (!cont) return;
  if (!players.length) { cont.innerHTML = ''; return; }
  const wk=players.filter(p=>p.role==='Wicket-Keeper').length;
  const bat=players.filter(p=>p.role==='Batsman').length;
  const bowl=players.filter(p=>p.role==='Bowler').length;
  const ar=players.filter(p=>p.role==='All-Rounder').length;
  const os=players.filter(p=>p.is_overseas).length;
  const issues=[];
  if(wk<1)issues.push(`Need ${1-wk} WK`);
  if(bat<3)issues.push(`Need ${3-bat} BAT`);
  if(bowl<3)issues.push(`Need ${3-bowl} BOWL`);
  if(ar<2)issues.push(`Need ${2-ar} AR`);
  if(os>4)issues.push('Too many Overseas');
  cont.innerHTML = `<div class="${issues.length?'squad-warning':'squad-ok'}" style="border-radius:6px;margin-top:6px;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
      <span>${issues.length?'⚠ '+issues.join(' · '):'✓ Squad OK'}</span>
      <span style="font-size:11px;opacity:0.7;">WK:${wk} · BAT:${bat} · BOWL:${bowl} · AR:${ar} · OS:${os}/4</span>
    </div></div>`;
}

// ── Realtime ──────────────────────────────────────────────────
function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel('team-v12-' + myTeam.id)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_state' }, () => {
      _lastStateHash = ''; fetchState();
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'teams', filter:'id=eq.'+myTeam.id }, payload => {
      if (payload.new?.purse_remaining !== undefined) {
        myTeam.purse_remaining = payload.new.purse_remaining;
        myTeam.rtm_cards_total = payload.new.rtm_cards_total ?? myTeam.rtm_cards_total;
        myTeam.rtm_cards_used  = payload.new.rtm_cards_used  ?? myTeam.rtm_cards_used;
        updatePurseDisplay(); updateRTMBadge();
      }
    })
    .on('postgres_changes', { event:'*', schema:'public', table:'team_players' }, () => {
      loadSquad(); loadStats();
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'unsold_log' }, () => {
      loadStats();
    })
    .on('system', {}, p => {
      if (['CHANNEL_ERROR','TIMED_OUT'].includes(p.status)) setTimeout(subscribeRealtime, 8000);
    }).subscribe();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement === el('bid-input')) placeBid();
});

init();