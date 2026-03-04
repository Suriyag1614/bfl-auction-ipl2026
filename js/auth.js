// auth.js  — BFL IPL 2026  v25
// Redirect already-logged-in users to the correct page.
// Emails: team_name@bfl.in (teams) | admin@bfl.in (auctioneer)

async function redirectByRole(user) {
  const isAdmin = user.app_metadata?.role === 'admin'
               || user.email === 'admin@bfl.in';

  if (isAdmin) { window.location.href = 'admin.html'; return null; }

  const { data: team } = await sb
    .from('teams').select('id,team_name')
    .eq('user_id', user.id).maybeSingle();

  if (team) { window.location.href = 'auction.html'; return null; }

  await sb.auth.signOut();
  return 'No team linked. Contact the auctioneer.';
}

// Auto-redirect if already signed in
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await redirectByRole(session.user);
})();