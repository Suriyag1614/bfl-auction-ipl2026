# IPL AUCTION SYSTEM — DEPLOYMENT GUIDE

## PREREQUISITES
- Supabase account (free tier works)
- Static hosting: Netlify / Vercel / GitHub Pages

---

## STEP 1 — SUPABASE PROJECT

1. Go to https://supabase.com → New Project
2. Note your **Project URL** and **Anon Key** (Settings → API)

---

## STEP 2 — DATABASE SETUP

In Supabase SQL Editor, run the SQL files **in order**:

1. `sql/01_schema.sql`   — Creates all tables
2. `sql/02_rls.sql`      — Enables RLS + policies
3. `sql/03_rpc.sql`      — Creates all RPC functions
4. `sql/04_sample_data.sql` — Adds sample players

---

## STEP 3 — CREATE AUTH USERS

In Supabase Dashboard → Authentication → Users → Invite User

Create **12 users**:
- 1 admin user (e.g. `admin@ipl-auction.com`)
- 11 team users (one per team)

---

## STEP 4 — INSERT ADMIN + TEAMS

After creating users, run in SQL Editor:

```sql
-- Admin (replace with actual UUID from auth.users)
INSERT INTO admin_users (user_id) VALUES ('<admin_user_uuid>');

-- Teams (replace user_id values with actual UUIDs)
INSERT INTO teams (user_id, team_name, owner_name, purse_remaining, is_advantage_holder) VALUES
  ('<uuid_1>', 'Mumbai Mavericks',   'Rahul Mehta',    100, true),
  ('<uuid_2>', 'Delhi Dragons',      'Priya Singh',    100, true),
  ('<uuid_3>', 'Chennai Chiefs',     'Amit Kumar',     100, false),
  -- ... add all 11 teams
  ;
```

> To find UUIDs: Supabase → Authentication → Users → copy `id` column

---

## STEP 5 — ENABLE REALTIME

In Supabase → Database → Replication:
- Enable replication for table: `auction_state`

Or the SQL in `03_rpc.sql` does this automatically.

---

## STEP 6 — CONFIGURE FRONTEND

Edit `js/supabaseClient.js`:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

---

## STEP 7 — DEPLOY FRONTEND

**Option A: Netlify (recommended)**
1. `netlify deploy --dir=. --prod`
2. Or drag-drop folder at netlify.com/drop

**Option B: Vercel**
1. `vercel --prod`

**Option C: GitHub Pages**
1. Push to repo
2. Enable Pages in repo Settings

---

## STEP 8 — CONFIGURE SUPABASE AUTH REDIRECT

Supabase → Authentication → URL Configuration:
- Site URL: `https://your-deployed-domain.com`
- Redirect URLs: `https://your-deployed-domain.com/auction.html`

---

## USAGE

### Admin Flow
1. Login at `/index.html` with admin email
2. Redirected to `/admin.html`
3. Find player in list → click **Start**
4. Monitor live bids, timer, leading team
5. After timer expires → click **Force Sell**
6. Repeat for next player

### Team Flow
1. Login at `/index.html` with team email
2. Redirected to `/auction.html`
3. Wait for admin to start auction
4. See player details, current bid, timer
5. Enter bid amount → click **Bid**
6. UI updates in real-time across all users

---

## ADVANTAGE HOLDER RULE

Teams with `is_advantage_holder = true` bypass the IPL franchise cap (max 3 players per franchise). This is set per team in the `teams` table.

---

## AUCTION RULES SUMMARY

| Rule | Value |
|------|-------|
| Purse | ₹100 Cr |
| Max squad | 12 players |
| Max overseas | 4 players |
| Min uncapped | 1 player |
| Timer | 20 seconds |
| Timer reset on bid | Yes |
| Max from same IPL team | 3 (unless advantage holder) |

---

## SECURITY NOTES

- All bid validation runs server-side in `place_bid()` RPC
- Teams cannot read other teams' data (RLS enforced)
- Teams cannot write directly to any table
- Admin functions check `is_admin()` inside RPC
- Auth tokens are handled by Supabase client
