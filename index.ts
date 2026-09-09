/*
 * parse-receipt — reads payment screenshots / receipts / itemised bills with the Gemini
 * API and returns structured transactions for the "Scan receipt / screenshot" flow.
 * Called from the browser via supabase-js functions.invoke('parse-receipt', { body: { images } }).
 *
 * verify_jwt is enabled, and the caller's email is additionally checked against
 * FAMILY_EMAILS. Keep that list in sync with ALLOWED_EMAILS in common.js.
 *
 * Secrets: GEMINI_API_KEY (required), GEMINI_MODEL (optional), FAMILY_EMAILS (optional).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const FAMILY_EMAILS = (Deno.env.get("FAMILY_EMAILS") ??
  "acb.charan@gmail.com,acboopathy@gmail.com,namca2000@gmail.com,sudanboopathy72@gmail.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

const MAX_IMAGES = 5;

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
  "Extract every distinct transaction or receipt you can see. For each one return:",
  "- merchant: who was paid (or who paid, for received money). Keep it short.",
  "- total_amount: the single amount that actually moved, as a number (grand total after tax and tip).",
  "- currency: ISO code. Default INR when there is only a rupee sign or no symbol.",
  "- date: transaction date as YYYY-MM-DD, ONLY if an actual date is visible; otherwise an empty string.",
  "- direction: debit if money was spent or sent, credit if money was received.",
  "- payment_method: one of upi, card, cash, netbanking, wallet, unknown.",
  "- reference: UPI ref / transaction id / order id / card last 4 digits if shown, else empty string.",
  "- suggested_category: the best fit from EXACTLY this list: " + CATEGORIES.join(", ") + ".",
  "- amount_candidates: every distinct money amount visible for this transaction (subtotal, tax, tip, delivery, total) as numbers.",
  "- line_items: for an itemised bill, one entry per line with description, amount (number), category. Empty array if not itemised.",
  "- notes: anything else useful in one short phrase, else empty string.",
  "- confidence: 0 to 1, how sure you are of total_amount.",
  "",
  "Never invent numbers or dates. If a field is unknown use an empty string, empty array, or 0. Return only the JSON object.",
].join("\n");

const responseSchema = {
  type: "OBJECT",
  properties: {
    transactions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          merchant: { type: "STRING" },
          total_amount: { type: "NUMBER" },
          currency: { type: "STRING" },
          date: { type: "STRING" },
          direction: { type: "STRING", enum: ["debit", "credit"] },
          payment_method: {
            type: "STRING",
            enum: ["upi", "card", "cash", "netbanking", "wallet", "unknown"],
          },
          reference: { type: "STRING" },
          suggested_category: { type: "STRING", enum: CATEGORIES },
          amount_candidates: { type: "ARRAY", items: { type: "NUMBER" } },
          line_items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                description: { type: "STRING" },
                amount: { type: "NUMBER" },
                category: { type: "STRING" },
              },
              required: ["description", "amount"],
            },
          },
          notes: { type: "STRING" },
          confidence: { type: "NUMBER" },
        },
        required: ["merchant", "total_amount", "direction", "suggested_category"],
      },
    },
  },
  required: ["transactions"],
};

function splitDataUrl(s: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: s };
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

  const parts: unknown[] = [{ text: PROMPT }];
  for (const img of images) {
    const { mime, data } = splitDataUrl(String(img));
    parts.push({ inline_data: { mime_type: mime, data } });
  }

  let geminiRes: Response;
  try {
    geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        GEMINI_MODEL + ":generateContent?key=" + GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0,
          },
        }),
      },
    );
  } catch (err) {
    console.error("Gemini fetch failed:", err);
    return json({ error: "Could not reach Gemini" }, 502);
  }

  if (!geminiRes.ok) {
    console.error("Gemini error:", geminiRes.status, await geminiRes.text());
    return json({ error: "Gemini could not process the image" }, 502);
  }

  const payload = await geminiRes.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error("Gemini returned no text:", JSON.stringify(payload).slice(0, 500));
    return json({ error: "Could not read the image" }, 502);
  }

  let parsed: { transactions?: unknown[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Gemini JSON parse failed:", text.slice(0, 500));
    return json({ error: "Could not read the image" }, 502);
  }

  return json({
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
  });
});
