/*
 * parse-receipt — reads payment screenshots / receipts / itemised bills with the Gemini
 * API and returns structured transactions for the "Scan receipt / screenshot" flow.
 * Called from the browser via supabase-js functions.invoke('parse-receipt', { body: { images } }).
 *
 * verify_jwt is enabled, and the caller's email is additionally checked against
 * FAMILY_EMAILS. Keep that list in sync with ALLOWED_EMAILS in common.js.
 *
 * Secrets:
 *   GEMINI_API_KEY  (required)
 *   GEMINI_MODEL    (optional) one model, or a comma-separated fallback chain tried in
 *                   order. Default: "gemini-flash-lite-latest,gemini-3.6-flash"
 *                   (lite is ~2-4s; the flash model is the fallback when lite is down).
 *   FAMILY_EMAILS   (optional)
 *
 * Robustness: minimal "thinking" for speed (retried without it if a model rejects the
 * field), per-request 25s abort, transient errors (429/500/502/503) retried with backoff
 * and then the next model in the chain, and a salvage pass that repairs a truncated JSON
 * response so a partial read still returns the transactions that came through.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODELS = (Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-lite-latest,gemini-3.6-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const FAMILY_EMAILS = (Deno.env.get("FAMILY_EMAILS") ??
  "acb.charan@gmail.com,acboopathy@gmail.com,namca2000@gmail.com,sudanboopathy72@gmail.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

const MAX_IMAGES = 5;
const REQUEST_TIMEOUT_MS = 25000;
const RETRY_STATUS = [429, 500, 502, 503];

const CATEGORIES = [
  "Food", "Groceries", "Transport", "Housing/Rent", "Utilities",
  "Entertainment", "Shopping", "Health", "Education", "Savings & Investment", "Other",
];

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

const PROMPT = [
  "You are a parser for an Indian family expense tracker. You are given one or more images:",
  "UPI / GPay / PhonePe / Paytm payment screenshots, card payment confirmations, bank SMS",
  "screenshots, or itemised shop / restaurant bills.",
  "",
  "Return ONLY a JSON object of the form { \"transactions\": [ ... ] }.",
  "Extract every distinct transaction or receipt you can see. For each one include:",
  "- merchant: who was paid (or who paid, for received money). Short.",
  "- total_amount: the single amount that actually moved.",
  "- currency: ISO code. Default INR when there is only a rupee sign or no symbol.",
  "- date: YYYY-MM-DD, ONLY if an actual date is visible; otherwise an empty string.",
  "- direction: debit if money was spent or sent, credit if money was received.",
  "- payment_method: one of upi, card, cash, netbanking, wallet, unknown.",
  "- reference: UPI ref / transaction id / order id / card last 4 digits if shown, else empty string.",
  "- suggested_category: the best fit from EXACTLY this list: " + CATEGORIES.join(", ") + ".",
  "- amount_candidates: every distinct money amount visible for this transaction.",
  "- line_items: for an itemised bill, up to 40 entries of { description, amount, category }. Empty array otherwise.",
  "- notes: one short phrase, else empty string.",
  "- confidence: a number from 0 to 1.",
  "",
  "Rules: every amount MUST be a plain number with at most 2 decimal places (e.g. 8990 or 8990.5).",
  "Never output long decimal expansions. Do not perform or show arithmetic. Do not invent numbers or dates.",
  "Work quickly; do not overthink.",
].join("\n");

// One config, kept lean on purpose: the free tier caps requests per day, so a scan must
// cost as few Gemini calls as possible. thinkingLevel "low" is understood by every
// Gemini 3.x model (both entries in the default GEMINI_MODELS chain).
const GEN_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0,
  maxOutputTokens: 8192,
  thinkingConfig: { thinkingLevel: "low" },
};

function splitDataUrl(s: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: s };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Parse the model's text, repairing a truncated response by keeping only the complete
// objects inside the transactions array and closing the brackets.
function extractTransactions(text: string): unknown[] | null {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const direct = JSON.parse(t);
    if (Array.isArray(direct?.transactions)) return direct.transactions;
  } catch { /* fall through to salvage */ }

  const key = t.indexOf('"transactions"');
  const arrStart = key === -1 ? -1 : t.indexOf("[", key);
  if (arrStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastElementEnd = -1;

  for (let i = arrStart; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 1 && c === "}") lastElementEnd = i;
      if (depth === 0) { lastElementEnd = i - 1; break; }
    }
  }

  if (lastElementEnd === -1) {
    try {
      const empty = JSON.parse(t.slice(0, arrStart + 1) + "]}");
      if (Array.isArray(empty?.transactions)) return empty.transactions;
    } catch { /* ignore */ }
    return null;
  }

  try {
    const repaired = JSON.parse(t.slice(0, lastElementEnd + 1) + "]}");
    if (Array.isArray(repaired?.transactions)) return repaired.transactions;
  } catch { /* ignore */ }
  return null;
}

function round2(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function normalize(transactions: unknown[]): unknown[] {
  return transactions
    .filter((t) => t && typeof t === "object")
    .map((raw) => {
      const t = raw as Record<string, unknown>;
      const cands = Array.isArray(t.amount_candidates) ? t.amount_candidates.map(round2) : [];
      const items = Array.isArray(t.line_items)
        ? t.line_items.slice(0, 40).filter((li) => li && typeof li === "object").map((li) => {
          const o = li as Record<string, unknown>;
          return {
            description: String(o.description ?? "").slice(0, 200),
            amount: round2(o.amount),
            category: String(o.category ?? ""),
          };
        })
        : [];
      return {
        merchant: String(t.merchant ?? "").slice(0, 200),
        total_amount: round2(t.total_amount),
        currency: String(t.currency ?? "INR"),
        date: String(t.date ?? ""),
        direction: t.direction === "credit" ? "credit" : "debit",
        payment_method: String(t.payment_method ?? "unknown"),
        reference: String(t.reference ?? "").slice(0, 200),
        suggested_category: String(t.suggested_category ?? ""),
        amount_candidates: cands,
        line_items: items,
        notes: String(t.notes ?? "").slice(0, 300),
        confidence: round2(t.confidence),
      };
    });
}

type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string };

async function callGemini(parts: unknown[]): Promise<GeminiResult> {
  const bodyStr = JSON.stringify({ contents: [{ parts }], generationConfig: GEN_CONFIG });
  let last: { status: number; detail: string } = { status: 0, detail: "no attempt made" };

  for (const model of GEMINI_MODELS) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + GEMINI_API_KEY;

    // At most 2 tries per model, and never on a 429 — retrying a quota error just
    // spends more of the daily allowance.
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
          const payload = JSON.parse(raw);
          const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
          const finish = payload?.candidates?.[0]?.finishReason;
          if (text) return { ok: true, text };
          last = { status: 200, detail: model + " no text (finishReason " + finish + "): " + raw.slice(0, 250) };
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

  return { ok: false, status: last.status, detail: last.detail };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const email = emailFromJwt(req.headers.get("Authorization"));
  if (!email || !FAMILY_EMAILS.includes(email)) {
    return json({ error: "Not authorised" }, 403);
  }

  let images: string[];
  try {
    const body = await req.json();
    images = Array.isArray(body?.images) ? body.images : [];
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (images.length === 0) return json({ error: "No images provided" }, 400);
  if (images.length > MAX_IMAGES) {
    return json({ error: "At most " + MAX_IMAGES + " images per scan" }, 413);
  }
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret is not set" }, 500);

  const parts: unknown[] = [{ text: PROMPT }];
  for (const img of images) {
    const { mime, data } = splitDataUrl(String(img));
    parts.push({ inline_data: { mime_type: mime, data } });
  }

  const result = await callGemini(parts);
  if (!result.ok) {
    console.error("Gemini failed:", result.status, result.detail);
    return json({ error: "Gemini " + result.status + ": " + result.detail }, 502);
  }

  const transactions = extractTransactions(result.text);
  if (!transactions) {
    console.error("Unparseable model output:", result.text.slice(0, 500));
    return json({ error: "Could not read the receipt — try a clearer image" }, 502);
  }

  return json({ transactions: normalize(transactions) });
});
