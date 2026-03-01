// ═══════════════════════════════════════════════════════════════
//  AUCTION.JS v11 — All issues fixed
//  - RTM display: 0 retained=3 RTM, 1=2, 2=1, 3=0
//  - Purse: live from teams table via realtime + poll
//  - Timer: no client-side lockout, server grace 7s
//  - Sold banner: always visible, always current
//  - Set auction: no flicker, bid/undo per slot
//  - Second team name: fetched correctly
//  - Waiting message: rich text with last result info
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

// Include last_sold_price so banner updates even if same player re-auctioned
const stateHash = s => !s ? '' :
  [s.status, s.current_player_id, s.current_highest_bid,
   s.current_highest_team_id, s.bid_timer_end, s.rtm_pending,
   s.rtm_team_id, s.last_player_result, s.last_player_id,
   s.last_sold_price, s.current_set_name,
   (s.unsold_player_ids||[]).length].join('|');

function toast(msg, type='info') {
  const c = el('toast-container'); if (!c) return;
  const d = document.createElement('div');
  d.className = 'toast toast-' + type;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.classList.add('toast-exit'), 3200);
  setTimeout(() => d.remove(), 3700);
}

async function doLogout() {
  stopPolling();
  await sb.auth.signOut();
  location.href = 'index.html';
}

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
  revealUI();
  startPolling();
  subscribeRealtime();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchState();
  });
}

function revealUI() {
  hide('auction-skeleton'); hide('stats-skeleton'); hide('squad-skeleton');
  show('stats-real'); show('squad-table-wrap');
  const tn = el('team-name'); if (tn) tn.textContent = myTeam.team_name;
  updatePurseDisplay();
  if (myTeam.is_advantage_holder) show('advantage-badge');
  updateRTMBadge();
}

// RTM left = rtm_cards_total - rtm_cards_used
// IPL rule: 3 retained → 0 RTM, 2 → 1, 1 → 2, 0 → 3
// rtm_cards_total is set by compute_rtm_cards() in SQL
function updateRTMBadge() {
  const total = myTeam.rtm_cards_total || 0;
  const used  = myTeam.rtm_cards_used  || 0;
  const rem   = Math.max(0, total - used);
  const b = el('rtm-badge');
  if (b) {
    b.textContent    = 'RTM ×' + rem;
    b.style.display  = rem > 0 ? 'inline-block' : 'none';
  }
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
function startPolling() {
  stopPolling();
  pollInterval = setInterval(fetchState, 2000);
}
function stopPolling() {
  clearInterval(pollInterval); pollInterval = null;
}

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

    // Fetch RTM team name
    if (state.rtm_team_id) {
      const { data: rt } = await sb.from('teams')
        .select('team_name,id').eq('id', state.rtm_team_id).maybeSingle();
      state.rtm_team = rt || null;
    } else {
      state.rtm_team = null;
    }

    // Fetch last player info for banner
    if (state.last_player_id) {
      const { data: lp } = await sb.from('players_master')
        .select('id,name,role,image_url').eq('id', state.last_player_id).maybeSingle();
      state.last_player = lp || null;
    } else {
      state.last_player = null;
    }

    // If second_team join didn't resolve (FK alias mismatch), fetch separately
    if (!state.second_team && state.second_highest_team_id) {
      const { data: st2 } = await sb.from('teams')
        .select('team_name').eq('id', state.second_highest_team_id).maybeSingle();
      state.second_team = st2 || null;
    }

    // For set_live: check slots changed without auction_state changing
    if (state.status === 'set_live' && state.current_set_name) {
      const { data: slots } = await sb.from('auction_slots')
        .select('id,current_highest_bid,current_highest_team_id,bid_timer_end')
        .eq('set_name', state.current_set_name).eq('status', 'live');
      const sh = (slots||[]).map(s =>
        s.id + ':' + s.current_highest_bid + ':' + s.current_highest_team_id
      ).join('|');
      if (sh !== _lastSlotsHash) {
        _lastSlotsHash = sh;
        _lastStateHash = ''; // force full re-render
      }
    }

    const hash = stateHash(state);
    if (hash === _lastStateHash) return;
    _lastStateHash = hash;

    currentState = state;
    _isRendering = true;
    try { await applyState(state); }
    finally { _isRendering = false; }
  } catch(e) {
    console.warn('[fetchState]', e.message);
  }
}

// ── Apply state ───────────────────────────────────────────────
async function applyState(state) {
  // Status badge
  const statusEl = el('auction-status');
  if (statusEl) {
    const labels = { waiting:'Waiting', live:'LIVE', sold:'Sold', paused:'Paused', set_live:'SET LIVE' };
    statusEl.textContent = state.rtm_pending ? 'RTM' : (labels[state.status] || state.status);
    statusEl.className   = 'status-badge status-' + (state.rtm_pending ? 'rtm' : state.status);
  }

  // Sold/unsold banner — always rendered, lives outside conditional sections
  renderLastResult(state);

  // Purse — always refresh from DB
  await refreshPurse();

  if (state.rtm_pending) {
    stopTimer();
    hide('player-card'); hide('no-auction'); hide('set-auction-view');
    renderRTMPending(state);

  } else if (state.status === 'set_live') {
    stopTimer();
    hide('player-card'); hide('no-auction'); hide('rtm-pending');
    await renderSetAuction(state);

  } else if ((state.status === 'live' || state.status === 'paused') && state.current_player) {
    hide('set-auction-view'); hide('no-auction'); hide('rtm-pending');
    renderLivePlayer(state, state.status === 'paused');

  } else {
    // Waiting / post-sell / post-unsold
    stopTimer();
    if (setSlotChannel) { sb.removeChannel(setSlotChannel); setSlotChannel = null; }
    hide('player-card'); hide('set-auction-view'); hide('rtm-pending');
    show('no-auction');

    // Rich waiting message
    const noMsg = el('no-auction-msg');
    if (noMsg) {
      if (state.last_player_result === 'set_done') {
        noMsg.innerHTML =
          `⚡ <strong>Set done</strong> — ${state.last_sold_to_team || ''}`;
      } else if (state.last_player_result === 'sold' && state.last_player) {
        noMsg.innerHTML =
          `✅ <strong>${state.last_player.name}</strong> sold to <strong>${state.last_sold_to_team}</strong> for <strong>${fmt(state.last_sold_price)}</strong>`;
      } else if (state.last_player_result === 'unsold' && state.last_player) {
        noMsg.innerHTML =
          `📭 <strong>${state.last_player.name}</strong> went <strong>unsold</strong>`;
      } else if (state.status === 'sold') {
        noMsg.textContent = '✅ Sold — next player coming up…';
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

// ── Live single-player card ───────────────────────────────────
function renderLivePlayer(state, paused) {
  const p    = state.current_player;
  const isMe = state.current_highest_team_id === myTeam?.id;

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
  if (p.is_retained)                        flags += ' <span class="tag tag-retained">Retained (RTN)</span>';
  if (p.is_rtm_eligible && !p.is_retained)  flags += ' <span class="tag tag-rtm">RTM Eligible</span>';
  el('player-flags').innerHTML = flags;

  const hasBid = state.current_highest_bid > 0;
  el('current-bid').textContent  = hasBid ? fmt(state.current_highest_bid) : 'No bids yet';
  const leadEl = el('leading-team');
  if (leadEl) {
    leadEl.textContent = state.highest_team
      ? state.highest_team.team_name + (isMe ? ' 🟢 (You)' : '') : '—';
    leadEl.style.color = isMe ? 'var(--green)' : '';
  }

  // second_team is a joined alias — it has .team_name directly
  el('second-bid').textContent  = state.second_highest_bid > 0 ? fmt(state.second_highest_bid) : '—';
  el('second-team').textContent = state.second_team?.team_name || '—';

  const next = hasBid ? Number(state.current_highest_bid) + 0.25 : Number(p.base_price);
  const bidInput = el('bid-input');
  bidInput.value = next.toFixed(2);
  bidInput.min   = next.toFixed(2);
  bidInput.step  = '0.25';

  const bidBtn  = el('bid-btn');
  const undoBtn = el('undo-bid-btn');

  if (isMe) {
    // I'm leading — show undo, hide bid
    if (bidBtn)  { bidBtn.style.display = 'none'; }
    if (undoBtn) {
      const canUndo = state.prev_bid_team_purse != null && !paused;
      undoBtn.style.display = canUndo ? 'inline-flex' : 'none';
    }
    bidInput.disabled = true;
  } else {
    // Not leading — show bid, hide undo
    if (bidBtn) {
      bidBtn.style.display = '';
      bidBtn.disabled = paused;
    }
    if (undoBtn) undoBtn.style.display = 'none';
    bidInput.disabled = paused;
  }
  el('bid-error').textContent = '';

  hide('no-auction'); hide('set-auction-view'); hide('rtm-pending'); show('player-card');

  if (paused) {
    stopTimer();
    const t = el('timer'); if (t) { t.textContent = 'Paused'; t.className = 'timer'; }
  } else {
    startTimer(state.bid_timer_end);
  }
}

// ── Last sold / unsold banner ─────────────────────────────────
// Lives in #last-result-container which is always in the DOM (outside conditional divs)
function renderLastResult(state) {
  const cont = el('last-result-container'); if (!cont) return;
  if (!state.last_player_result) { cont.innerHTML = ''; return; }

  // Set auction result — summary banner (multiple players)
  if (state.last_player_result === 'set_done') {
    cont.innerHTML = `
      <div class="last-result-banner sold-banner">
        <div style="font-size:22px;margin-right:10px;">⚡</div>
        <div style="flex:1;min-width:0;">
          <div class="lr-name">Set Auction Complete</div>
          <div class="lr-detail">${state.last_sold_to_team || ''}</div>
        </div>
        <div class="lr-price lr-sold">DONE</div>
      </div>`;
    return;
  }

  // Single-player result
  const p    = state.last_player;
  const sold = state.last_player_result === 'sold';
  cont.innerHTML = `
    <div class="last-result-banner ${sold ? 'sold-banner' : 'unsold-banner'}">
      <img src="${imgSrc(p?.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
      <div style="flex:1;min-width:0;">
        <div class="lr-name">${p?.name || 'Unknown'}</div>
        <div class="lr-detail">${p?.role || ''}${sold
          ? ' · Sold to <strong>' + (state.last_sold_to_team || '?') + '</strong>'
          : ' · Unsold'}</div>
      </div>
      <div class="lr-price ${sold ? 'lr-sold' : 'lr-unsold'}">
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
        .select('sold_price,sold_at,team:teams(team_name),player:players_master(name,role,image_url)')
        .order('sold_at', { ascending: false }).limit(6),
      sb.from('unsold_log')
        .select('logged_at,player:players_master(name,role,image_url)')
        .order('logged_at', { ascending: false }).limit(4)
    ]);
    const items = [
      ...(sold||[]).map(r => ({ name:r.player?.name||'?', role:r.player?.role||'', img:r.player?.image_url||'', price:r.sold_price, team:r.team?.team_name||'', ts:r.sold_at, status:'sold' })),
      ...(ul||[]).map(r   => ({ name:r.player?.name||'?', role:r.player?.role||'', img:r.player?.image_url||'', price:null, team:'', ts:r.logged_at, status:'unsold' }))
    ].sort((a,b) => new Date(b.ts) - new Date(a.ts)).slice(0, 6);

    if (!items.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="mini-history">
      <div class="mini-history-title">Recent Results</div>
      ${items.map(r => `<div class="mini-history-item">
        <img src="${imgSrc(r.img)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
        <div class="mh-name">${r.name}<span class="mh-role"> · ${r.role}</span></div>
        ${r.status === 'sold'
          ? `<div class="mh-team">${r.team}</div><div class="mh-price sold-price">${fmt(r.price)}</div>`
          : `<div class="mh-price unsold-price">Unsold</div>`}
      </div>`).join('')}
    </div>`;
  } catch(e) { console.warn('[MiniHistory]', e.message); }
}

// ── Set auction ───────────────────────────────────────────────
// Smart DOM patching — only update changed slot data, no full re-render (no flicker)
async function renderSetAuction(state) {
  const cont = el('set-auction-view'); if (!cont) return;
  show('set-auction-view');

  const { data: slots, error } = await sb.from('auction_slots')
    .select(`*,
      player:players_master(id,name,role,ipl_team,base_price,image_url,is_overseas,is_uncapped,is_rtm_eligible,is_retained),
      highest_team:teams!auction_slots_current_highest_team_id_fkey(team_name,id)`)
    .eq('set_name', state.current_set_name).eq('status', 'live');

  if (error) { console.warn('[renderSetAuction]', error.message); return; }
  if (!slots?.length) {
    cont.innerHTML = `<div class="no-auction-msg">⚡ ${state.current_set_name} — all slots closed…</div>`;
    return;
  }

  const latestEnd = slots.reduce((mx,s) => Math.max(mx, new Date(s.bid_timer_end||0).getTime()), 0);

  // Update the top current-bid panel with the highest set bid across all slots
  const topSlot = slots.reduce((best, s) =>
    (s.current_highest_bid || 0) > (best.current_highest_bid || 0) ? s : best, slots[0]);
  const topBid   = topSlot?.current_highest_bid || 0;
  const topTeam  = topSlot?.highest_team;
  const topIsMe  = topSlot?.current_highest_team_id === myTeam?.id;
  const cbEl = el('current-bid'), ltEl = el('leading-team');
  if (cbEl) cbEl.textContent = topBid > 0 ? `${fmt(topBid)} (${topSlot?.player?.name || ''})` : 'Set Auction Live';
  if (ltEl) { ltEl.textContent = topTeam ? topTeam.team_name + (topIsMe ? ' 🟢' : '') : '—'; ltEl.style.color = topIsMe ? 'var(--green)' : ''; }

  const cardId = s => 'set-card-' + s.id;

  // Build expected HTML per slot card (no input values — those stay intact)
  const makeCard = slot => {
    const p     = slot.player || {};
    const isMe  = slot.current_highest_team_id === myTeam?.id;
    const hasBid = slot.current_highest_bid > 0;
    const next  = hasBid ? Number(slot.current_highest_bid) + 0.25 : Number(p.base_price || 0);
    let tags = '';
    if (p.is_overseas) tags += '<span class="tag tag-overseas">OS</span> ';
    if (p.is_uncapped) tags += '<span class="tag tag-uncapped">UC</span> ';
    if (p.is_retained) tags += '<span class="tag tag-retained">RTN</span> ';
    if (p.is_rtm_eligible && !p.is_retained) tags += '<span class="tag tag-rtm">RTM</span>';

    return { isMe, hasBid, next, tags, p, slot };
  };

  // Check if grid already exists
  const existingGrid = cont.querySelector('.team-set-slots-grid');
  if (!existingGrid) {
    // First render — build full HTML
    const cards = slots.map(slot => {
      const { isMe, hasBid, next, tags, p } = makeCard(slot);
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

      return `<div class="team-slot-card${isMe ? ' leading' : ''}" id="${cardId(slot)}">
        <div class="set-slot-header">
          <img src="${imgSrc(p.image_url)}" onerror="this.onerror=null;this.src=window._SIL" alt="">
          <div class="set-slot-info">
            <div class="set-slot-name">${p.name || '?'}</div>
            <div class="set-slot-meta">${p.role || ''} · Base ${fmt(p.base_price)}</div>
            ${tags ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;">${tags}</div>` : ''}
          </div>
        </div>
        <div class="set-slot-bid" id="sb-${slot.id}">
          <div class="set-slot-bid-label">Highest Bid</div>
          <div class="set-slot-bid-val ${isMe ? 'bid-me' : 'bid-other'}">
            ${hasBid ? fmt(slot.current_highest_bid) : '<span class="bid-none">No bids</span>'}
          </div>
          ${hasBid ? `<div class="set-slot-bid-team">${slot.highest_team?.team_name || ''}${isMe ? ' 🟢' : ''}</div>` : ''}
        </div>
        ${bidArea}
        <div id="serr-${slot.id}" class="error-msg" style="font-size:11px;min-height:0;"></div>
      </div>`;
    }).join('');

    cont.innerHTML = `<div class="set-auction-header">
      <div>
        <span class="set-auction-title">⚡ ${state.current_set_name || ''}</span>
        <span class="set-auction-sub">${slots.length} players — bid on any simultaneously</span>
      </div>
      <div class="set-timer-wrap">
        <div class="set-timer-label">Shared Timer</div>
        <span class="timer" id="set-timer">—</span>
      </div>
    </div>
    <div class="team-set-slots-grid">${cards}</div>`;
  } else {
    // Subsequent renders — patch only bid data per slot (no full rebuild = no flicker)
    slots.forEach(slot => {
      const { isMe, hasBid, next, slot: s } = makeCard(slot);
      const card = document.getElementById(cardId(slot));
      if (!card) return; // new slot — will appear on next full render

      // Update card leading class
      card.className = 'team-slot-card' + (isMe ? ' leading' : '');

      // Update bid display
      const bidDiv = document.getElementById('sb-' + slot.id);
      if (bidDiv) bidDiv.innerHTML = `
        <div class="set-slot-bid-label">Highest Bid</div>
        <div class="set-slot-bid-val ${isMe ? 'bid-me' : 'bid-other'}">
          ${hasBid ? fmt(slot.current_highest_bid) : '<span class="bid-none">No bids</span>'}
        </div>
        ${hasBid ? `<div class="set-slot-bid-team">${slot.highest_team?.team_name || ''}${isMe ? ' 🟢' : ''}</div>` : ''}`;

      // Patch action area only if leading state changed
      const sa = document.getElementById('sa-' + slot.id);
      if (sa) {
        const wasMe = sa.querySelector('.btn-ghost') !== null && sa.children[0]?.style.color === '';
        // Check current action area type
        const hasInput = !!document.getElementById('sbid-' + slot.id);
        if (isMe && hasInput) {
          // Transition: not leading → leading
          sa.innerHTML = `<div style="font-size:13px;color:var(--green);font-weight:700;flex:1;">✓ You: ${fmt(slot.current_highest_bid)}</div>
            <button class="btn btn-ghost btn-sm" onclick="undoSetBid('${slot.id}')">↩ Undo</button>`;
        } else if (!isMe && !hasInput) {
          // Transition: leading → not leading
          sa.innerHTML = `<input type="number" class="form-input" id="sbid-${slot.id}"
            value="${next.toFixed(2)}" min="${next.toFixed(2)}" step="0.25">
            <button class="btn btn-gold btn-sm" onclick="placeSetBid('${slot.id}')">Bid</button>`;
        } else if (isMe && !hasInput) {
          // Still leading — update amount shown
          const amountEl = sa.querySelector('div');
          if (amountEl) amountEl.textContent = '✓ You: ' + fmt(slot.current_highest_bid);
        } else if (!isMe && hasInput) {
          // Still not leading — update input min/value to new minimum
          const inp = document.getElementById('sbid-' + slot.id);
          if (inp && !inp.disabled) {
            inp.min = next.toFixed(2);
            // Only bump value if it's below new minimum
            if (parseFloat(inp.value) < next) inp.value = next.toFixed(2);
          }
        }
      }
    });
  }

  startSetTimer(latestEnd);
  subscribeSetSlots(state.current_set_name);
}

function startSetTimer(endMs) {
  clearInterval(setTimerInterval);
  if (!endMs) return;
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t = el('set-timer'); if (!t) { clearInterval(setTimerInterval); return; }
    t.textContent = rem + 's';
    t.className = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
  };
  tick(); setTimerInterval = setInterval(tick, 250);
}

function subscribeSetSlots(setName) {
  if (setSlotChannel) sb.removeChannel(setSlotChannel);
  setSlotChannel = sb.channel('team-slots-' + setName + '-' + myTeam.id)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_slots', filter:'set_name=eq.' + setName }, () => {
      if (currentState?.status === 'set_live') { _lastSlotsHash = ''; _lastStateHash = ''; }
    }).subscribe();
}

async function placeSetBid(slotId) {
  const inp = el('sbid-' + slotId), errEl = el('serr-' + slotId);
  if (!inp) return;
  const raw    = parseFloat(inp.value);
  const amount = Math.round(raw / 0.25) * 0.25; // snap to nearest 0.25
  inp.value = amount.toFixed(2);
  if (errEl) errEl.textContent = '';
  if (isNaN(amount) || amount <= 0) { if (errEl) errEl.textContent = 'Invalid amount'; return; }
  if (Math.abs(amount - raw) > 0.001) { if (errEl) errEl.textContent = 'Bid must be a multiple of ₹0.25 Cr'; return; }
  if (amount > myTeam.purse_remaining) { if (errEl) errEl.textContent = 'Insufficient purse (' + fmt(myTeam.purse_remaining) + ')'; return; }
  const btn = inp.nextElementSibling;
  if (btn)  { btn.disabled = true; btn.textContent = '…'; }
  inp.disabled = true;
  const { data, error } = await sb.rpc('place_set_bid', { p_slot_id: slotId, bid_amount: amount });
  if (error || !data?.success) {
    if (btn) { btn.disabled = false; btn.textContent = 'Bid'; }
    inp.disabled = false;
    if (errEl) errEl.textContent = error?.message || data?.error || 'Error';
    return;
  }
  toast('Bid: ' + fmt(amount), 'success');
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = '';
  fetchState();
}

async function undoSetBid(slotId) {
  const { data, error } = await sb.rpc('undo_set_bid', { p_slot_id: slotId });
  if (error || !data?.success) { toast(error?.message || data?.error || 'Cannot undo', 'warn'); return; }
  toast('↩ Set bid undone', 'info');
  await refreshPurse();
  _lastSlotsHash = ''; _lastStateHash = '';
  fetchState();
}

// ── Timer ─────────────────────────────────────────────────────
// NO client-side bid lockout based on time.
// Server has 7s grace — keep showing 0 until server kills auction.
function startTimer(endTime) {
  stopTimer();
  const endMs = new Date(endTime).getTime();
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    const t = el('timer'); if (!t) return;
    t.textContent = rem + 's';
    t.className   = 'timer' + (rem <= 5 ? ' timer-critical' : rem <= 10 ? ' timer-warning' : '');
  };
  tick(); timerInterval = setInterval(tick, 250);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

// ── Single-player bidding ─────────────────────────────────────
async function placeBid() {
  const input = el('bid-input'), errEl = el('bid-error'), btn = el('bid-btn');
  const raw    = parseFloat(input.value);
  const amount = Math.round(raw / 0.25) * 0.25; // snap to nearest 0.25
  input.value  = amount.toFixed(2);
  errEl.textContent = '';
  if (isNaN(amount) || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; return; }
  if (Math.abs(amount - raw) > 0.001) { errEl.textContent = 'Bid must be a multiple of ₹0.25 Cr (0.25, 0.50, 0.75, 1.00…)'; return; }
  if (amount > myTeam.purse_remaining) {
    errEl.textContent = 'Insufficient purse (' + fmt(myTeam.purse_remaining) + ')'; return;
  }
  btn.disabled = true; btn.textContent = '…';
  const { data, error } = await sb.rpc('place_bid', { bid_amount: amount });
  btn.disabled = false; btn.textContent = 'Bid';
  if (error)          { errEl.textContent = error.message;    return; }
  if (!data?.success) { errEl.textContent = data?.error || 'Error'; return; }

  // Optimistic UI: show undo, hide bid, don't wait for poll
  btn.style.display = 'none';
  input.disabled = true;
  const undoBtn = el('undo-bid-btn');
  if (undoBtn) undoBtn.style.display = 'inline-flex';
  input.classList.add('bid-success-flash');
  setTimeout(() => input.classList.remove('bid-success-flash'), 600);
  toast('✓ Bid: ' + fmt(amount), 'success');

  // Note: single-player purse deducted only at force_sell, not here
  _lastStateHash = '';
  fetchState(); // gets new bid_timer_end from server
}

async function undoBid() {
  const btn = el('undo-bid-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const { data, error } = await sb.rpc('undo_bid');
  if (btn) { btn.disabled = false; btn.textContent = '↩ Undo'; }
  if (error || !data?.success) { toast(error?.message || data?.error || 'Cannot undo', 'warn'); return; }

  // Revert UI optimistically
  const bidBtn = el('bid-btn');
  if (bidBtn) { bidBtn.style.display = ''; bidBtn.disabled = false; }
  const input = el('bid-input');
  if (input) input.disabled = false;
  if (btn) btn.style.display = 'none';

  toast('↩ Bid undone', 'info');
  _lastStateHash = '';
  await fetchState();
}

// ── Purse refresh ─────────────────────────────────────────────
async function refreshPurse() {
  try {
    const { data: t } = await sb.from('teams')
      .select('purse_remaining,rtm_cards_total,rtm_cards_used')
      .eq('id', myTeam.id).single();
    if (!t) return;
    myTeam.purse_remaining = t.purse_remaining;
    myTeam.rtm_cards_total = t.rtm_cards_total;
    myTeam.rtm_cards_used  = t.rtm_cards_used;
    updatePurseDisplay();
    updateRTMBadge();
  } catch(e) { console.warn('[refreshPurse]', e.message); }
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const { count: total } = await sb.from('players_master').select('*', { count:'exact', head:true });
    const { data: soldRows } = await sb.from('team_players').select('sold_price');
    const soldCount = soldRows?.length || 0;
    const spent     = (soldRows||[]).reduce((s,r) => s + Number(r.sold_price||0), 0);
    const { data: st } = await sb.from('auction_state').select('unsold_player_ids').eq('id',1).maybeSingle();
    const unsoldCount = (st?.unsold_player_ids||[]).length;
    if (el('as-total'))     el('as-total').textContent     = total || 0;
    if (el('as-sold'))      el('as-sold').textContent      = soldCount;
    if (el('as-unsold'))    el('as-unsold').textContent    = unsoldCount;
    if (el('as-remaining')) el('as-remaining').textContent = Math.max(0, (total||0) - soldCount - unsoldCount);
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

    // Spent = sum of ALL costs including retentions
    // Also derive from purse to catch any drift: 100 - current_purse
    const spentFromRows = list.reduce((s,r) => s + Number(r.sold_price||0), 0);
    const spentFromPurse = Math.max(0, 100 - Number(myTeam.purse_remaining||0));
    // Use purse-derived as it reflects actual DB state; show both if discrepancy
    const auctionSpent = list.filter(r => !r.is_retained).reduce((s,r) => s + Number(r.sold_price||0), 0);
    const retainSpent  = list.filter(r => r.is_retained).reduce((s,r) => s + Number(r.sold_price||0), 0);
    const totalSpent   = auctionSpent + retainSpent;
    if (el('squad-spent')) {
      el('squad-spent').textContent = retainSpent > 0
        ? `₹${auctionSpent.toFixed(2)} + ₹${retainSpent.toFixed(2)} RTN spent`
        : `₹${totalSpent.toFixed(2)} Cr spent`;
    }
    if (el('squad-count')) el('squad-count').textContent = list.length + ' / 12';
    hide('squad-skeleton'); show('squad-table-wrap');

    const tbody = el('squad-tbody');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No players yet</td></tr>';
      renderSquadComp([]); return;
    }

    list.sort((a,b) => {
      if ((b.is_retained||0) !== (a.is_retained||0)) return (b.is_retained?1:0) - (a.is_retained?1:0);
      return (a.player?.name||'').localeCompare(b.player?.name||'');
    });

    tbody.innerHTML = list.map((tp, i) => {
      const p = tp.player || {};
      let tags = '';
      if (tp.is_retained) tags += '<span class="tag tag-retained">RTN</span> ';
      if (tp.is_rtm)      tags += '<span class="tag tag-rtm">RTM</span> ';
      if (p.is_overseas)  tags += '<span class="tag tag-overseas">OS</span> ';
      if (p.is_uncapped)  tags += '<span class="tag tag-uncapped">UC</span>';
      return `<tr class="${tp.is_retained ? 'row-retained' : ''}">
        <td style="font-size:12px;color:var(--muted);width:28px;">${i+1}</td>
        <td>
          <div style="font-weight:700;font-size:14px;">${p.name||'?'}</div>
          ${tags ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${tags}</div>` : ''}
        </td>
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
  const wk   = players.filter(p => p.role === 'Wicket-Keeper').length;
  const bat  = players.filter(p => p.role === 'Batsman').length;
  const bowl = players.filter(p => p.role === 'Bowler').length;
  const ar   = players.filter(p => p.role === 'All-Rounder').length;
  const os   = players.filter(p => p.is_overseas).length;
  const issues = [];
  if (wk < 1)  issues.push(`Need ${1-wk} WK`);
  if (bat < 3) issues.push(`Need ${3-bat} BAT`);
  if (bowl < 3) issues.push(`Need ${3-bowl} BOWL`);
  if (ar < 2)  issues.push(`Need ${2-ar} AR`);
  if (os > 4)  issues.push('Too many Overseas');
  cont.innerHTML = `<div class="${issues.length ? 'squad-warning' : 'squad-ok'}" style="border-radius:6px;margin-top:6px;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
      <span>${issues.length ? '⚠ ' + issues.join(' · ') : '✓ Squad OK'}</span>
      <span style="font-size:11px;opacity:0.7;font-family:'Barlow Condensed',sans-serif;">
        WK:${wk} · BAT:${bat} · BOWL:${bowl} · AR:${ar} · OS:${os}/4
      </span>
    </div>
  </div>`;
}

// ── Realtime ──────────────────────────────────────────────────
function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel('team-v11-' + myTeam.id)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'auction_state' }, () => {
      _lastStateHash = ''; fetchState();
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'teams', filter:'id=eq.' + myTeam.id }, payload => {
      // Instant purse update from realtime
      if (payload.new?.purse_remaining !== undefined) {
        myTeam.purse_remaining = payload.new.purse_remaining;
        myTeam.rtm_cards_total = payload.new.rtm_cards_total ?? myTeam.rtm_cards_total;
        myTeam.rtm_cards_used  = payload.new.rtm_cards_used  ?? myTeam.rtm_cards_used;
        updatePurseDisplay();
        updateRTMBadge();
      }
    })
    .on('postgres_changes', { event:'*', schema:'public', table:'team_players' }, () => {
      loadSquad(); loadStats();
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'unsold_log' }, () => {
      loadStats();
    })
    .on('system', {}, p => {
      if (['CHANNEL_ERROR','TIMED_OUT'].includes(p.status)) {
        setTimeout(subscribeRealtime, 8000);
      }
    }).subscribe();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement === el('bid-input')) placeBid();
});

init();