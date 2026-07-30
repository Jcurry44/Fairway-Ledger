# Voice postgame brief → Fairway Ledger

How the spoken postgame brief reaches the app, end to end:

```
You talk through the round (ChatGPT voice, "Sol")
  → the GPT builds the full brief and confirms it back to you
  → its Action POSTs { userId, draft } to the ingest-recap edge function
  → the function verifies the secret and inserts a pending row (RLS-private)
  → Fairway Ledger's inbox shows the draft; you review and tap Apply
```

The app is the authority on course facts: at Apply time it overwrites each
hole's number/label/par/yards with the selected route's canonical values, so
the voice side only has to carry scores, stats it actually heard, and the
narrative. A score-only payload is rejected — the recap and coaching ARE the
product.

## Setup checklist (do once, in order — about 10 minutes)

Six steps, each naming exactly where it happens and how to tell it worked.
Steps 1-4 are one-time Supabase dashboard config; step 5 is in the app; step
6 is in ChatGPT. Do them in this order — later steps depend on earlier ones.

1. **Deploy the ingest function.** Supabase dashboard → **Edge Functions →
   Deploy a new function → Via Editor**, name it `ingest-recap`, paste in
   `functions/ingest-recap/index.ts`, deploy, then open the function's
   details and turn **Enforce JWT verification OFF** (callers authenticate
   with the ingest secret instead — with verification on, the platform
   rejects them before the function runs).
   *Worked when:* the function list shows `ingest-recap` as deployed and its
   details panel shows JWT verification **Off**.
2. **Set the ingest secret.** Same dashboard → **Edge Functions → Secrets →
   Add secret**, name `DRAFT_INGEST_SECRET`, value = the string staged in
   `supabase/.secret.local` (open that file locally and copy it — it is
   git-ignored on purpose, never paste its contents anywhere that gets
   committed or logged).
   *Worked when:* `DRAFT_INGEST_SECRET` appears in the Secrets list.
3. **Add the 6-digit code to the sign-in email.** **Authentication → Email
   Templates → Magic Link**, add `{{ .Token }}` to the body, e.g.
   `<p>Your sign-in code: {{ .Token }}</p>` above the link, and Save.
   *Worked when:* the template editor shows `{{ .Token }}` in the saved
   body (or: request a sign-in email in step 5 and confirm it contains a
   6-digit code).
4. **Confirm the Site URL.** **Authentication → URL Configuration** → Site
   URL is `https://jcurry44.github.io/Fairway-Ledger/`, and that same URL
   is also present under Redirect URLs.
   *Worked when:* both fields show that exact URL (trailing slash
   included).
5. **Sign in from the app.** In Fairway Ledger, **Profile → Shared voice
   recaps** → enter your email → **Save & send sign-in email** → open the
   email → type the 6-digit code into **Sign in with code**.
   *Worked when:* the Profile card now shows a **Voice-service routing ID**
   (a UUID) — copy it, you need it for step 6.
6. **Build the GPT.** ChatGPT → **My GPTs → Create a GPT** (name it e.g.
   *Fairway Caddie*):
   1. Paste the instruction block below into **Instructions**, replacing
      `ROUTING_ID_HERE` with the routing ID from step 5.
   2. **Create new action** → paste the OpenAPI schema below.
   3. Action **Authentication → API Key → Bearer**, paste the same
      `DRAFT_INGEST_SECRET` value from step 2. (The secret lives in the
      GPT's server-side auth config — it is never visible in chat and
      never in this repo.)
   4. Save the GPT (visibility: **Only me**).
   *Worked when:* the GPT saves without error and shows one action,
   `submitRecap`, pointed at `.../functions/v1/ingest-recap`.

### End-to-end smoke check (run once, after all six steps)

Open the *Fairway Caddie* GPT and talk through a short round (even a fake
2-3 hole one). Confirm the totals when it reads them back, let it call
`submitRecap`. You should hear back that the brief is waiting in the inbox —
no 401/404/422/500 (see Troubleshooting below if you do). Then open Fairway
Ledger, **Profile → Refresh inbox**, confirm the draft appears, tap **Apply**,
and confirm it lands as a saved round with the recap attached. That closes
the loop from voice to the app.

## GPT instructions (paste verbatim, then set the routing ID)

```
You are Fairway Caddie, Joe's post-round golf brief partner. After a round at
Deerwood Golf Course (three nines: Buck, Doe, Fawn), Joe talks through his
round. Your job: capture it faithfully, coach him honestly, and deliver the
finished brief to his Fairway Ledger app with the submitRecap action.

CONVERSATION
- Open by getting the frame: date, which nines (order matters), tee
  (Red/White/Blue), 9 or 18 holes.
- Walk the holes in order. For each: the score (required) and the story. When
  he states putts, penalties, fairway result, bunkers, clubs, or first-putt
  distance, capture them. NEVER invent or infer a stat he did not say — a
  missing stat stays absent. Scores are sacred: if unsure, ask again.
- Listen like a caddie: note patterns (misses, tendencies, momentum) as he
  talks. Push back gently where his read of a hole doesn't match his own
  telling of it.
- When all holes are in, deliver the spoken brief: the round's story in 3-5
  sentences, the 2-4 patterns that decided the score, what he did well, and
  one specific cue for the next round. Keep it vivid and concrete — this
  narrative is the product, not filler around the numbers.
- Read the total back ("Buck out in 44, Doe in in 41 — 85 total, correct?").
  Only after he confirms, call submitRecap once.

SUBMIT CONTRACT (submitRecap body)
- userId: exactly "ROUTING_ID_HERE"
- draft.source: { "kind": "voice", "capturedAt": "<ISO timestamp>" }
- draft.round:
  - date: "YYYY-MM-DD" (confirm it; never guess the year)
  - courseId: 18 holes → "deerwood-<front>-<back>-<tee>" (front/back from
    buck|doe|fawn in played order); 9 holes → "deerwood-<nine>-<tee>".
    Tee is lowercase red|white|blue. Example: "deerwood-buck-doe-white".
  - tee: "Red" | "White" | "Blue"
  - wind (optional, short), tag (optional, short), note (optional round note)
  - holes: one object per hole in played order, numbered 1..N:
    { "number": 1, "score": 5 } plus ONLY what he actually said, from:
    putts (0-10), penalties (0-10), fairway ("hit"|"left"|"right"|"short"|
    "long"), gir (true|false), bunker ("none"|"fairway"|"greenside"|"both"),
    firstPuttDistance (feet), fringePutts, teeClub ("Driver"), clubsHit
    (["Driver","8i"]), approachNote, result, missContext, note
- draft.recap:
  - title: the round's verdict in one line, like a headline — "An 85 that was
    two swings from the 70s", not "July 28 recap". It leads the brief.
  - summary: the round's story, 3-6 sentences, written like a caddie who was
    there. Not a stat recitation.
  - coaching: 2-4 strings — the patterns that decided the score.
  - nextRoundCue: THE one thought for next round, a single sentence. It gets
    its own card at the end of the brief — make it specific and memorable.
  - holeNarration: EVERY hole he narrated:
    { "holeNumber": 1, "label": "Buck 1", "narration": "<what happened, his
    words tightened up>", "coaching": "<per-hole insight, when you have one>" }
    Labels: "<Nine> <1-9>", e.g. "Buck 1" ... "Doe 9".

RULES
- One submit per confirmed round. On success ("id" returned), tell him the
  brief is waiting in Fairway Ledger's inbox.
- If the action errors, read the status: 401 = secret/auth problem, 404 =
  function missing, 422 = payload incomplete (usually a missing summary or
  holes), 500 = wrong routing ID. Say what failed; do not silently retry.
- Never fabricate a score, stat, or quote. The app rejects score-only
  payloads by design — always carry the full narrative you built together.
```

## Action OpenAPI schema (paste verbatim)

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Fairway Ledger voice recap inbox", "version": "1.1.0" },
  "servers": [{ "url": "https://vodtsentyuehvddattkf.supabase.co/functions/v1" }],
  "paths": {
    "/ingest-recap": {
      "post": {
        "operationId": "submitRecap",
        "summary": "Deliver a confirmed postgame brief to the Fairway Ledger inbox",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["userId", "draft"],
                "properties": {
                  "userId": { "type": "string", "description": "Fairway Ledger voice-service routing ID (UUID from the app's Profile card)" },
                  "draft": {
                    "type": "object",
                    "required": ["round", "recap"],
                    "properties": {
                      "source": {
                        "type": "object",
                        "properties": {
                          "kind": { "type": "string" },
                          "capturedAt": { "type": "string" }
                        }
                      },
                      "round": {
                        "type": "object",
                        "required": ["date", "courseId", "tee", "holes"],
                        "properties": {
                          "date": { "type": "string", "description": "YYYY-MM-DD" },
                          "courseId": { "type": "string", "description": "e.g. deerwood-buck-doe-white" },
                          "tee": { "type": "string", "enum": ["Red", "White", "Blue"] },
                          "wind": { "type": "string" },
                          "tag": { "type": "string" },
                          "note": { "type": "string" },
                          "holes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "required": ["number", "score"],
                              "properties": {
                                "number": { "type": "integer" },
                                "score": { "type": "integer" },
                                "putts": { "type": "integer" },
                                "penalties": { "type": "integer" },
                                "fairway": { "type": "string", "enum": ["hit", "left", "right", "short", "long"] },
                                "gir": { "type": "boolean" },
                                "bunker": { "type": "string", "enum": ["none", "fairway", "greenside", "both"] },
                                "firstPuttDistance": { "type": "number" },
                                "fringePutts": { "type": "integer" },
                                "teeClub": { "type": "string" },
                                "clubsHit": { "type": "array", "items": { "type": "string" } },
                                "approachNote": { "type": "string" },
                                "result": { "type": "string" },
                                "missContext": { "type": "string" },
                                "note": { "type": "string" }
                              }
                            }
                          }
                        }
                      },
                      "recap": {
                        "type": "object",
                        "required": ["summary", "holeNarration"],
                        "properties": {
                          "title": { "type": "string" },
                          "summary": { "type": "string" },
                          "coaching": { "type": "array", "items": { "type": "string" } },
                          "nextRoundCue": { "type": "string" },
                          "holeNarration": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "required": ["holeNumber", "narration"],
                              "properties": {
                                "holeNumber": { "type": "integer" },
                                "label": { "type": "string" },
                                "narration": { "type": "string" },
                                "coaching": { "type": "string" }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Draft accepted into the inbox" },
          "401": { "description": "Bad or missing ingest secret" },
          "422": { "description": "Score-only or incomplete payload" }
        }
      }
    }
  }
}
```

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| Action gets 401 | Secret mismatch, or the function still enforces JWT verification | Re-paste the secret in the GPT action auth; turn Enforce JWT verification off on the function |
| Action gets 404 | Function not deployed | `supabase/README.md` step 4 |
| Action gets 422 | Payload missing summary/narration or round basics | The GPT must send the full brief, never scores alone |
| Action gets 500 | `userId` is not a real signed-in user | Copy the routing ID from the app's Profile card exactly |
| Draft never appears in the app | Not signed in on the phone, or draft already archived | Profile → send sign-in email → enter the 6-digit code, then Refresh inbox |
| Sign-in email has no code | Magic Link template lacks the token | `supabase/README.md` step 2 |

## Recovering the July 28 Deerwood round

The original short hash link carried scores only. In the ChatGPT thread that
holds the full July 28 brief, ask the GPT to resubmit that round through
submitRecap using the contract above — it still has the narration and
coaching in context. Review and Apply it from the app inbox like any other
draft.
