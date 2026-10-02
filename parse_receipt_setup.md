# Receipt / screenshot scanning — setup

The **Add expense → 📷 Scan receipt / screenshot** button sends the picked images to the
`parse-receipt` Supabase Edge Function, which asks Google's Gemini API to read them and
returns structured transactions for review. The Gemini API key lives only in the function
(a Supabase secret) — it is never shipped to the browser.

## One-time setup

1. **Get a free Gemini API key**
   Go to <https://aistudio.google.com/apikey> → **Create API key** → *Create API key in
   new project*. The free tier needs no billing and is plenty for family use.

2. **Store it as a Supabase secret**
   ```
   npx supabase secrets set GEMINI_API_KEY=your_key_here --project-ref pxjryedxetccuxqclbjz
   ```
   Optional overrides:
   ```
   npx supabase secrets set GEMINI_MODEL="gemini-flash-lite-latest,gemini-3.6-flash" --project-ref pxjryedxetccuxqclbjz
   npx supabase secrets set FAMILY_EMAILS="a@x.com,b@x.com" --project-ref pxjryedxetccuxqclbjz
   ```
   `GEMINI_MODEL` is a comma-separated fallback chain (first that works wins). It already
   defaults to `gemini-flash-lite-latest,gemini-3.6-flash` — lite for speed (~2-4s), the
   flash model as backup. `FAMILY_EMAILS` defaults to the four emails in `common.js`.

3. **Deploy the function**
   ```
   npx supabase functions deploy parse-receipt --project-ref pxjryedxetccuxqclbjz
   ```
   `verify_jwt = true` (in `supabase/config.toml`) means only signed-in family accounts
   can call it.

4. **Frontend** — `index.html` / `app.js` / `common.js` / `styles.css` changes deploy
   automatically when you push to `main` (Vercel).

## Local testing (optional)

```
echo "GEMINI_API_KEY=your_key_here" > supabase/functions/.env
npx supabase functions serve parse-receipt --env-file supabase/functions/.env
```
Then POST `{ "images": ["data:image/jpeg;base64,..."] }` with a valid `Authorization:
Bearer <family user token>` header and expect `{ "transactions": [ ... ] }`.

## How it behaves

- Up to 5 images per scan; each is downscaled to ~1100px JPEG in the browser first.
- One card per detected transaction. Nothing is written until you press **Save**.
- Amount chips let you pick between subtotal / total / total+tip when several are detected.
- Itemised bills: tick **"Add ticked items as separate expenses"** to split one bill into
  multiple expense rows (each with its own category); otherwise it saves as one row.
- `credit` (money received) transactions show a badge but can still be saved.
