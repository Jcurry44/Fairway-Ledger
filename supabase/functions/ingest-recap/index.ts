// Trusted voice-service ingress. Deploy with `supabase functions deploy
// ingest-recap --no-verify-jwt` and set DRAFT_INGEST_SECRET in Supabase.
// The secret must live only in the voice service's server-side secret store.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const encoder = new TextEncoder();
async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await request.text();
  const secret = Deno.env.get("DRAFT_INGEST_SECRET") || "";
  const given = request.headers.get("x-fairway-signature") || "";
  if (!secret || given.length !== 64 || given !== await hmac(secret, raw)) return new Response("Unauthorized", { status: 401 });
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
