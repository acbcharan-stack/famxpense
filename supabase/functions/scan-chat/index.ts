/*
 * scan-chat — a chat about the receipts/bills just scanned. The browser sends the chat so far,
 * the current draft transactions and (optionally) the scaled images; Gemini answers questions
 * and/or returns edits to the draft. Nothing is saved here — the browser applies the edits.
 *
 * Secrets: GEMINI_API_KEY (required), GEMINI_MODEL (optional chain), FAMILY_EMAILS (optional).
 * Keep FAMILY_EMAILS in sync with parse-receipt and ALLOWED_EMAILS in common.js.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODELS = (Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-lite-latest,gemini-3.6-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const FAMILY_EMAILS = (Deno.env.get("FAMILY_EMAILS") ??
  "acb.charan@gmail.com,acboopathy@gmail.com,namca2000@gmail.com,sudanboopathy72@gmail.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

const MAX_IMAGES = 5;
const MAX_MESSAGES = 20;
const REQUEST_TIMEOUT_MS = 25000;
const RETRY_STATUS = [429, 500, 502, 503];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function emailFromJwt(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  try {
    let seg = authHeader.slice(7).split(".")[1] ?? "";
    seg = seg.replace(/-/g, "+").replace(/_/g, "/");
    while (seg.length % 4) seg += "=";
    const claims = JSON.parse(atob(seg));
    const email = claims.email ?? claims.user_metadata?.email ?? null;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

function splitDataUrl(s: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: s };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function systemPrompt(categories: string[], profileNames: string[], drafts: unknown): string {
  return [
    "You help a family review receipts / bills / payment screenshots they just scanned into an",
    "expense tracker (amounts in rupees unless shown otherwise). The images (if attached) are the",
    "originals. DRAFT below is the list of transactions currently on screen, not yet saved.",
    "",
    "You can (a) answer questions about the bills, and (b) edit the draft when asked.",
    'Return ONLY JSON: { "reply": string, "updates": [ ... ] }.',
    "- reply: short, friendly, plain text (no markdown). Say what you changed, if anything.",
    "- updates: empty array unless the user asked for a change. Each entry is { \"id\": <draft id> }",
    "  plus ONLY the fields to change from: merchant (string), amount (number), date (YYYY-MM-DD),",
    "  category (one of: " + categories.join(", ") + "), direction (\"debit\" or \"credit\"),",
    "  profile (one of: " + profileNames.join(", ") + "), note (string), included (false to drop it).",
    "Never invent ids, numbers or dates. If a request is unclear, ask in reply and leave updates empty.",
    "Amounts are plain numbers with at most 2 decimals. Do not show arithmetic.",
    "",
    "DRAFT: " + JSON.stringify(drafts),
  ].join("\n");
}

type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string };

async function callGemini(body: unknown): Promise<GeminiResult> {
  const bodyStr = JSON.stringify(body);
  let last = { status: 0, detail: "no attempt made" };

  for (const model of GEMINI_MODELS) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + GEMINI_API_KEY;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(2000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        last = { status: 0, detail: model + ": " + String(err) };
        continue;
      }
      clearTimeout(timer);
      const raw = await res.text();
      if (res.ok) {
        try {
          const text = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return { ok: true, text };
          last = { status: 200, detail: model + " no text: " + raw.slice(0, 250) };
        } catch {
          last = { status: 200, detail: model + " non-JSON: " + raw.slice(0, 250) };
        }
        break;
      }
      last = { status: res.status, detail: model + " -> " + raw.slice(0, 400) };
      if (res.status === 429) {
        return { ok: false, status: 429, detail: "Daily free-tier limit reached — wait a bit or add billing to the Google Cloud project." };
      }
      if (!RETRY_STATUS.includes(res.status)) break;
    }
  }
  return { ok: false, ...last };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const email = emailFromJwt(req.headers.get("Authorization"));
  if (!email || !FAMILY_EMAILS.includes(email)) return json({ error: "Not authorised" }, 403);
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret is not set" }, 500);

  let messages: { role: string; text: string }[];
  let images: string[];
  let drafts: unknown;
  let categories: string[];
  let profileNames: string[];
  try {
    const body = await req.json();
    messages = (Array.isArray(body?.messages) ? body.messages : []).slice(-MAX_MESSAGES)
      .map((m: Record<string, unknown>) => ({
        role: m.role === "assistant" ? "model" : "user",
        text: String(m.text ?? "").slice(0, 2000),
      }));
    images = (Array.isArray(body?.images) ? body.images : []).slice(0, MAX_IMAGES);
    drafts = Array.isArray(body?.drafts) ? body.drafts.slice(0, 30) : [];
    categories = (Array.isArray(body?.categories) ? body.categories : []).map(String);
    profileNames = (Array.isArray(body?.profiles) ? body.profiles : []).map(String);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "No question provided" }, 400);
  }

  // Images ride along on the first user turn only, so the model sees the originals once.
  const contents = messages.map((m, i) => {
    const parts: unknown[] = [{ text: m.text }];
    if (i === 0 && m.role === "user") {
      for (const img of images) {
        const { mime, data } = splitDataUrl(String(img));
        parts.push({ inline_data: { mime_type: mime, data } });
      }
    }
    return { role: m.role, parts };
  });
  if (contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(scan)" }] });

  const result = await callGemini({
    systemInstruction: { parts: [{ text: systemPrompt(categories, profileNames, drafts) }] },
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  if (!result.ok) {
    console.error("Gemini failed:", result.status, result.detail);
    return json({ error: "Gemini " + result.status + ": " + result.detail }, 502);
  }

  let parsed: { reply?: unknown; updates?: unknown } = {};
  try {
    parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    return json({ reply: result.text.slice(0, 600), updates: [] });
  }
  const updates = Array.isArray(parsed.updates)
    ? parsed.updates.filter((u) => u && typeof u === "object" && "id" in u)
    : [];
  return json({ reply: String(parsed.reply ?? "").slice(0, 1500), updates });
});
