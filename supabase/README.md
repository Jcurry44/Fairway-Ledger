# Shared voice-recap inbox setup

The phone app uses Supabase Auth (email sign-in) and the `voice_recap_drafts`
table. Row-level security makes a draft readable only by its authenticated
owner; the client contains only the Supabase project URL and publishable anon
key, never a service-role key or voice-ingest secret.

Status on the live project `vodtsentyuehvddattkf` as of 2026-07-29: the table
and RLS policies are applied and email auth is enabled (verified via REST).
The remaining setup is steps 2 and 4 below, then the voice side in
[`docs/VOICE_SETUP.md`](../docs/VOICE_SETUP.md).

1. **Auth URLs** — In **Authentication → URL Configuration**, set Site URL to
   `https://jcurry44.github.io/Fairway-Ledger/` and add that exact URL as a
   Redirect URL. In **Authentication → Providers → Email**, leave email
   confirmation enabled. (The code-based sign-in below works even if this is
   wrong, but correct URLs make the email link land in the app instead of the
   portfolio root.)
2. **Email code** — In **Authentication → Email Templates → Magic Link**, add
   the 6-digit code to the body, e.g.
   `<p>Your sign-in code: {{ .Token }}</p>` above the link. The app's
   "Sign in with code" field uses this; it is the reliable path on a phone
   because an installed PWA has its own storage partition and an emailed link
   opens in the browser instead.
3. **Table** — Already applied. For a fresh project: paste and run
   `migrations/20260728_voice_recap_inbox.sql` in **SQL Editor**, and confirm
   the table shows RLS enabled in **Database → Tables**.
4. **Ingest function** — In **Edge Functions → Deploy a new function → Via
   Editor**, name it `ingest-recap`, paste `functions/ingest-recap/index.ts`,
   and deploy. In the function's details, turn **Enforce JWT verification OFF**
   (callers authenticate with the ingest secret instead; with it on, the
   platform rejects them before the function runs). Then in **Edge Functions →
   Secrets**, add `DRAFT_INGEST_SECRET` = a long random value. No CLI or
   Docker needed. (CLI alternative:
   `supabase functions deploy ingest-recap --no-verify-jwt`.)
5. **Connect the app** — In **Profile → Shared voice recaps**, the project URL
   and publishable anon key are prefilled. Enter your email, tap **Save & send
   sign-in email**, then type the 6-digit code from the email into **Sign in
   with code**. The profile card then shows the non-secret
   `Voice-service routing ID` — that UUID is this golfer's `userId` for the
   voice service.
6. **Voice side** — Follow [`docs/VOICE_SETUP.md`](../docs/VOICE_SETUP.md) to
   create the ChatGPT postgame-brief GPT whose Action posts
   `{ userId, draft }` to
   `https://vodtsentyuehvddattkf.supabase.co/functions/v1/ingest-recap`
   with the ingest secret as its API key (Bearer). GPT Actions cannot compute
   HMAC signatures, so the function accepts the static secret; the
   `x-fairway-signature` HMAC header remains supported for server-side senders.

The ingest payload must carry the full contract from `lib/voice-recap.js`:
`round` (canonical holes and metadata) plus `recap.summary`, per-hole
`recap.holeNarration`, and `recap.coaching`. A score-only payload is rejected
by both the function (422) and the app review layer. The July 28 Deerwood
round should be re-sent by the voice system from its original validated recap;
the old short hash link does not contain enough data to reconstruct narration
or coaching.
