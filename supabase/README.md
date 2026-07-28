# Shared voice-recap inbox setup

The phone app uses Supabase Auth (email magic link) and the `voice_recap_drafts`
table above. Row-level security makes a draft readable only by its authenticated
owner; the client contains only the Supabase project URL and publishable anon
key, never a service-role key or voice-ingest secret.

1. In **Authentication → URL Configuration**, set Site URL to
   `https://jcurry44.github.io/Fairway-Ledger/` and add that exact URL as a
   Redirect URL. In **Authentication → Providers → Email**, leave email
   confirmation enabled. Do not enable GitHub auth or any paid add-on.
2. In **SQL Editor → New query**, paste and run the complete contents of
   `migrations/20260728_voice_recap_inbox.sql`. The table must show RLS as
   enabled in **Database → Tables**.
3. Install the free Supabase CLI on a trusted development machine, authenticate
   as the project owner, link project ref `vodtsentyuehvddattkf`, then run:
   `supabase functions deploy ingest-recap --no-verify-jwt` and
   `supabase secrets set DRAFT_INGEST_SECRET=<new-random-secret>`.
   Put the same secret only in the voice system's server-side secret store.
   Configure its server-side action to HMAC-sign the exact JSON body and POST
   `{ userId, draft }` to
   `https://vodtsentyuehvddattkf.supabase.co/functions/v1/ingest-recap`.
4. Publish this Fairway Ledger build. In **Profile → Shared voice recaps**,
   enter project URL `https://vodtsentyuehvddattkf.supabase.co`, the
   **publishable/anon** key from **Project Settings → API**, and your email.
   Open the email link on the same phone. The profile card then displays the
   non-secret `Voice-service routing ID`; configure the voice service to use
   that UUID as `userId` for this golfer only.

The ingest action must send the full contract from `lib/voice-recap.js`:
`round` (canonical holes and metadata) plus `recap.summary`, every per-hole
`recap.holeNarration`, and `recap.coaching`. A score-only payload is rejected
by the app review layer. The July 28 Deerwood recovery should be re-sent by
the voice system from its original validated recap; the old short hash link
does not contain enough data to reconstruct narration or coaching.
