// Trusted voice-service ingress. Deploy from the Supabase dashboard editor
// (Edge Functions → Deploy a new function) with "Enforce JWT verification"
// turned OFF, or via CLI with `--no-verify-jwt`. Set DRAFT_INGEST_SECRET in
// Edge Functions → Secrets; the secret lives only there and in the voice
// service's server-side auth config — never in this repo or the browser.
//
// Callers authenticate with ANY of:
//   - Authorization: Bearer <DRAFT_INGEST_SECRET>      (ChatGPT Action, "API Key" → Bearer)
//   - x-fairway-secret: <DRAFT_INGEST_SECRET>          (ChatGPT Action, "API Key" → Custom)
//   - x-fairway-signature: hex HMAC-SHA256(secret, raw body)   (server-side senders)
// A static secret is accepted because GPT Actions cannot compute an HMAC over
// the body; worst case for a leaked secret is a fake draft appearing in the
// owner's review inbox, which apply-time review already guards.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const encoder = new TextEncoder();

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compare via SHA-256 digests so string-equality timing never walks the secret.
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function secretsMatch(given: string, expected: string) {
  return Boolean(given) && Boolean(expected) && (await sha256Hex(given)) === (await sha256Hex(expected));
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await request.text();
  const secret = Deno.env.get("DRAFT_INGEST_SECRET") || "";
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerSecret = (request.headers.get("x-fairway-secret") || "").trim();
  const signature = (request.headers.get("x-fairway-signature") || "").trim();
  const authorized = Boolean(secret) && (
    await secretsMatch(bearer, secret)
    || await secretsMatch(headerSecret, secret)
    || (signature.length === 64 && await secretsMatch(signature, await hmacHex(secret, raw)))
  );
  if (!authorized) return new Response("Unauthorized", { status: 401 });
  let body: { userId?: string; draft?: unknown };
  try { body = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!body.userId || !body.draft || typeof body.draft !== "object") return new Response("userId and draft are required", { status: 400 });
  const draft = body.draft as { round?: { date?: unknown; courseId?: unknown; tee?: unknown; holes?: unknown }; recap?: { summary?: unknown; coaching?: unknown; holeNarration?: unknown } };
  const hasRichRecap = Boolean(
    (typeof draft.recap?.summary === "string" && draft.recap.summary.trim())
    || (Array.isArray(draft.recap?.coaching) && draft.recap.coaching.length)
    || (Array.isArray(draft.recap?.holeNarration) && draft.recap.holeNarration.length)
  );
  if (!draft.round?.date || !draft.round.courseId || !draft.round.tee || !Array.isArray(draft.round.holes) || !draft.round.holes.length || !hasRichRecap) {
    return new Response("A full recap, canonical round metadata, and scored holes are required", { status: 422 });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await supabase.from("voice_recap_drafts").insert({ user_id: body.userId, payload: body.draft, status: "pending" }).select("id, created_at").single();
  if (error) return new Response("Could not save draft", { status: 500 });
  return Response.json({ id: data.id, createdAt: data.created_at }, { status: 201 });
});
