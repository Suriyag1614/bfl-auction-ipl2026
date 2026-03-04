// auth.js  — BFL IPL 2026  v25
// Works with the new login system where emails are:
//   <team_uuid>@bfl.auction   (for team accounts)
//   admin@bfl.auction          (for auctioneer)
// This file handles redirect-on-load for already-signed-in users.

async function redirectByRole(user) {
  // Admin check: role is set in app_metadata by 03_auth_setup.sql
  const isAdmin = user.app_metadata?.role === 'admin'
               || user.email === 'admin@bfl.auction';

  if (isAdmin) {
    window.location.href = 'admin.html';
    return null;
  }

  // Team check: look up by user_id
  const { data: team } = await sb
    .from('teams')
    .select('id, team_name')
    .eq('user_id', user.id)
    .maybeSingle();

  if (team) {
    window.location.href = 'auction.html';
    return null;
  }

  // Fallback: email might be <team_id>@bfl.auction — try to link on the fly
  if (user.email && user.email.endsWith('@bfl.auction') && user.email !== 'admin@bfl.auction') {
    const teamId = user.email.replace('@bfl.auction', '');
    const { data: teamById } = await sb
      .from('teams').select('id').eq('id', teamId).maybeSingle();
    if (teamById) {
      // Link user_id to team (shouldn't normally happen post-setup, but safe)
      await sb.from('teams').update({ user_id: user.id }).eq('id', teamId);
      window.location.href = 'auction.html';
      return null;
    }
  }

  await sb.auth.signOut();
  return 'No team account linked. Please contact the auctioneer.';
}

// Auto-redirect if already signed in
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await redirectByRole(session.user);
})();