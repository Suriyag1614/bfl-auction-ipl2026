// ─────────────────────────────────────────────────────────────
//  modal.js — Custom confirm / alert / prompt popups
//  Replaces all window.confirm() / window.alert() calls
// ─────────────────────────────────────────────────────────────

(function () {

// ── Inject modal HTML once ────────────────────────────────────
const MODAL_HTML = `
<div id="modal-overlay" style="display:none;">
  <div id="modal-box">
    <div id="modal-icon-wrap"></div>
    <div id="modal-title"></div>
    <div id="modal-body"></div>
    <div id="modal-footer"></div>
  </div>
</div>`;

// ── Inject CSS once ───────────────────────────────────────────
const MODAL_CSS = `
#modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(4px);
  z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  animation: modal-fade-in 0.15s ease;
}
@keyframes modal-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
#modal-box {
  background: #111520;
  border: 1px solid #1e2535;
  border-radius: 12px;
  width: 100%; max-width: 420px;
  padding: 28px 28px 22px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
  animation: modal-slide-up 0.18s ease;
  position: relative;
}
@keyframes modal-slide-up {
  from { transform: translateY(18px) scale(0.97); opacity: 0; }
  to   { transform: translateY(0)    scale(1);    opacity: 1; }
}
#modal-icon-wrap {
  text-align: center;
  margin-bottom: 10px;
  font-size: 36px;
  line-height: 1;
}
#modal-title {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 20px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.5px; color: #e2e8f0;
  text-align: center; margin-bottom: 8px;
}
#modal-body {
  font-size: 14px; color: #64748b; line-height: 1.6;
  text-align: center; margin-bottom: 22px;
  white-space: pre-line;
}
#modal-body strong { color: #e2e8f0; }
#modal-footer {
  display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
}
.modal-btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; padding: 9px 22px;
  border: none; border-radius: 8px;
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 15px; font-weight: 700;
  letter-spacing: 0.5px; text-transform: uppercase;
  cursor: pointer; transition: opacity 0.15s, transform 0.1s;
  min-width: 110px;
}
.modal-btn:hover  { opacity: 0.87; }
.modal-btn:active { transform: scale(0.97); }
.modal-btn-cancel  { background: transparent; border: 1px solid #1e2535; color: #64748b; }
.modal-btn-cancel:hover { border-color: #64748b; color: #e2e8f0; opacity: 1; }
.modal-btn-confirm { background: #f0b429; color: #000; }
.modal-btn-danger  { background: #e53e3e; color: #fff; }
.modal-btn-ok      { background: #f0b429; color: #000; }
.modal-divider { border: none; border-top: 1px solid #1e2535; margin: 0 -28px 18px; }`;

function injectModal() {
  if (document.getElementById('modal-overlay')) return;
  const style = document.createElement('style');
  style.textContent = MODAL_CSS;
  document.head.appendChild(style);
  const wrap = document.createElement('div');
  wrap.innerHTML = MODAL_HTML;
  document.body.appendChild(wrap.firstElementChild);
}

// ── Core show function ────────────────────────────────────────
function showModal({ icon='', title='', body='', buttons=[], danger=false }) {
  injectModal();
  return new Promise(resolve => {
    const overlay  = document.getElementById('modal-overlay');
    const iconEl   = document.getElementById('modal-icon-wrap');
    const titleEl  = document.getElementById('modal-title');
    const bodyEl   = document.getElementById('modal-body');
    const footerEl = document.getElementById('modal-footer');

    iconEl.textContent  = icon;
    iconEl.style.display = icon ? '' : 'none';
    titleEl.textContent = title;
    // Convert markdown-style **bold** to <strong>
    bodyEl.innerHTML = body.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    footerEl.innerHTML = '';

    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.className = 'modal-btn ' + (btn.class || 'modal-btn-ok');
      b.textContent = btn.label;
      b.onclick = () => {
        close();
        resolve(btn.value !== undefined ? btn.value : btn.label);
      };
      footerEl.appendChild(b);
    });

    // Close on overlay click
    function onOverlay(e) { if (e.target === overlay) { close(); resolve(false); } }
    overlay.addEventListener('click', onOverlay);

    // Close on Escape
    function onKey(e) { if (e.key === 'Escape') { close(); resolve(false); } }
    document.addEventListener('keydown', onKey);

    function close() {
      overlay.style.display = 'none';
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
    }

    overlay.style.display = 'flex';
    // Focus first button
    setTimeout(() => footerEl.querySelector('.modal-btn')?.focus(), 50);
  });
}

// ── Public API ────────────────────────────────────────────────

/** Standard confirm: returns true/false */
window.confirm2 = function(message, { title='Confirm', danger=false, icon='' } = {}) {
  const autoIcon = icon || (danger ? '⚠️' : '💬');
  return showModal({
    icon:  autoIcon,
    title: title,
    body:  message,
    buttons: [
      { label:'Cancel',  class:'modal-btn-cancel',  value:false },
      { label:'Confirm', class: danger ? 'modal-btn-danger' : 'modal-btn-confirm', value:true },
    ],
    danger,
  });
};

/** Alert (info only, one OK button) */
window.alert2 = function(message, { title='Notice', icon='ℹ️' } = {}) {
  return showModal({
    icon, title, body: message,
    buttons: [{ label:'OK', class:'modal-btn-ok', value:true }],
  });
};

/** Two-step destructive confirm — shows two modals in sequence */
window.confirmDanger = async function(msg1, msg2, title='Are You Sure?') {
  const first = await confirm2(msg1, { title, danger:true, icon:'⚠️' });
  if (!first) return false;
  return confirm2(msg2, { title:'Final Confirmation', danger:true, icon:'🚨' });
};

})();