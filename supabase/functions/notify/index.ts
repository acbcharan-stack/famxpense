// Sends trade/investment notification emails via Resend. Triggered by pg_cron (see
// notify_setup.sql), never called directly by the frontend.
//
// POST body: { "type": "expiry" | "monthly" }
//   expiry  — daily check: any open trade whose target date has passed gets one alert,
//             then is marked notified_at so it isn't re-sent tomorrow.
//   monthly — a single digest email summarizing all trades and investments.
//
// Auth: a shared secret in the `x-cron-secret` header (not a Supabase JWT — this function
// is deployed with --no-verify-jwt since only pg_cron calls it).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL")!;
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function fmtMoney(n: unknown) {
  const v = Number(n) || 0;
  return (v < 0 ? "-" : "") + "₹" + Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Mirrors tradeTargetDate() in common.js.
function targetDate(trade: any): Date {
  const d = new Date(trade.trade_date + "T00:00:00Z");
  const n = Number(trade.period_value) || 0;
  if (trade.period_unit === "weeks") d.setUTCDate(d.getUTCDate() + n * 7);
  else if (trade.period_unit === "months") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function tradeGain(t: any) {
  const invested = Number(t.invested_amount) || 0;
  const exit = Number(t.exit_amount) || 0;
  const amount = exit - invested;
  const percent = invested > 0 ? (amount / invested) * 100 : 0;
  return { amount, percent };
}

async function sendEmail(subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject, html }),
  });
  if (!res.ok) {
    console.error("Resend send failed:", res.status, await res.text());
  }
}

// One open trade past its target date = one alert email, then it's marked notified_at
// so it doesn't fire again tomorrow (re-editing the trade's date/period clears the flag
// naturally since it's a fresh row state, but simplest is: notified once, ever).
async function checkExpiries() {
  const { data: trades, error } = await sb
    .from("trades")
    .select("*")
    .eq("status", "open")
    .is("notified_at", null);
  if (error) throw error;

  const today = new Date();
  const due = (trades || []).filter((t) => targetDate(t) <= today);

  for (const t of due) {
    const td = targetDate(t);
    await sendEmail(
      `Trade window closed: ${t.symbol}`,
      `<p><strong>${t.symbol}</strong> — invested ${fmtMoney(t.invested_amount)} on ${t.trade_date}.</p>
       <p>Target was <strong>${t.target_percent}%</strong> by <strong>${isoDate(td)}</strong> (${t.period_value} ${t.period_unit}).</p>
       <p>Time to check whether it delivered — log the exit (or keep holding) in the Trading tab.</p>`,
    );
    await sb.from("trades").update({ notified_at: new Date().toISOString() }).eq("id", t.id);
  }

  return due.length;
}

async function monthlyDigest() {
  const [{ data: trades }, { data: investments }] = await Promise.all([
    sb.from("trades").select("*"),
    sb.from("investments").select("*"),
  ]);

  const open = (trades || []).filter((t) => t.status === "open");
  const closed = (trades || []).filter((t) => t.status === "closed");

  const investedClosed = closed.reduce((s, t) => s + (Number(t.invested_amount) || 0), 0);
  const realizedGain = closed.reduce((s, t) => s + tradeGain(t).amount, 0);
  const realizedPct = investedClosed > 0 ? (realizedGain / investedClosed) * 100 : 0;
  const wins = closed.filter((t) => tradeGain(t).percent >= (Number(t.target_percent) || 0)).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const openInvested = open.reduce((s, t) => s + (Number(t.invested_amount) || 0), 0);

  const openRows = open
    .map((t) => {
      const td = targetDate(t);
      const daysLeft = Math.round((td.getTime() - Date.now()) / 86400000);
      const statusLabel = daysLeft < 0 ? `Overdue ${Math.abs(daysLeft)}d` : `${daysLeft}d left`;
      return `<tr><td>${t.symbol}</td><td>${fmtMoney(t.invested_amount)}</td><td>${t.target_percent}%</td><td>${statusLabel}</td></tr>`;
    })
    .join("");

  const investedTotal = (investments || []).reduce((s, inv) => s + (Number(inv.amount) || 0), 0);
  const investRows = (investments || [])
    .map((inv) => `<tr><td>${inv.name || inv.type}</td><td>${inv.type}</td><td>${fmtMoney(inv.amount)}</td><td>${inv.annual_return}%</td></tr>`)
    .join("");

  const html = `
    <h2>Monthly trading &amp; investment check-in</h2>
    <h3>Trades</h3>
    <p>Realized P&amp;L: <strong>${fmtMoney(realizedGain)}</strong> (${realizedPct.toFixed(2)}%) across ${closed.length} closed trades — win rate ${winRate.toFixed(0)}%.</p>
    <p>Open positions: ${open.length}, ${fmtMoney(openInvested)} invested.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Symbol</th><th>Invested</th><th>Target</th><th>Status</th></tr>
      ${openRows || '<tr><td colspan="4">No open trades</td></tr>'}
    </table>
    <h3>Investments</h3>
    <p>Total invested: <strong>${fmtMoney(investedTotal)}</strong> across ${(investments || []).length} investments.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Name</th><th>Type</th><th>Invested</th><th>Return</th></tr>
      ${investRows || '<tr><td colspan="4">No investments yet</td></tr>'}
    </table>
  `;

  await sendEmail("Monthly trading & investment check-in", html);
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type = body.type === "monthly" ? "monthly" : "expiry";

  try {
    if (type === "monthly") {
      await monthlyDigest();
      return Response.json({ ok: true, type });
    }
    const count = await checkExpiries();
    return Response.json({ ok: true, type, alertsSent: count });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
