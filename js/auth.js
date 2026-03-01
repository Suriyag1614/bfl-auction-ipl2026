async function redirectByRole(user) {
  const isAdmin = user.app_metadata?.role === 'admin';
  if (isAdmin) { window.location.href = 'admin.html'; return null; }

  const { data: team } = await sb
    .from('teams').select('id').eq('user_id', user.id).maybeSingle();
  if (team) { window.location.href = 'auction.html'; return null; }

  await sb.auth.signOut();
  return 'No team account linked to this user.';
}

// Auto-redirect if already signed in
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await redirectByRole(session.user);
})();

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errEl    = document.getElementById('auth-error');
  const btn      = document.getElementById('login-btn');

  errEl.textContent = '';
  btn.disabled      = true;
  btn.textContent   = 'Signing in...';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    errEl.textContent = error.message;
    btn.disabled      = false;
    btn.textContent   = 'Sign In';
    return;
  }

  const msg = await redirectByRole(data.user);
  if (msg) {
    errEl.textContent = msg;
    btn.disabled      = false;
    btn.textContent   = 'Sign In';
  }
});