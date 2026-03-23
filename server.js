/**
 * ╔══════════════════════════════════════════════════╗
 * ║     Lite Jito Wrapper — QuickNode Lil' JIT      ║
 * ║         Agent-First API + Solana Pay             ║
 * ╚══════════════════════════════════════════════════╝
 *
 * Env vars (Railway dashboard):
 *   QUICKNODE_ENDPOINT  – QN HTTP RPC (Lil' JIT add-on)
 *   BOT_TOKEN           – Telegram BotFather token
 *   RAILWAY_PUBLIC_URL  – https://xxx.up.railway.app
 *   PAYMENT_WALLET      – SOL address receiving payments
 *   ADMIN_CHAT_ID       – your Telegram chat ID (1146284589)
 *   ADMIN_SECRET        – secret for admin endpoints
 *   PORT                – set by Railway automatically
 */

"use strict";

const express        = require("express");
const { Telegraf }   = require("telegraf");
const { Connection, PublicKey, Keypair, clusterApiUrl } = require("@solana/web3.js");
const { encodeURL, findReference, validateTransfer }    = require("@solana/pay");
const BigNumber      = require("bignumber.js");
const fs             = require("fs");
const path           = require("path");
const { v4: uuidv4 } = require("uuid");
const crypto         = require("crypto");

const PORT           = process.env.PORT              || 3000;
const QN_ENDPOINT    = process.env.QUICKNODE_ENDPOINT || clusterApiUrl("devnet");
const BOT_TOKEN      = process.env.BOT_TOKEN         || "";
const BASE_URL       = (process.env.RAILWAY_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PAYMENT_WALLET = process.env.PAYMENT_WALLET    || "";
const ADMIN_CHAT_ID  = Number(process.env.ADMIN_CHAT_ID || 0);

const FREE_LIMIT              = 5;
const PAYMENT_EXPIRES_SECONDS = 300;

const TIERS = {
  monthly:  { sol: 0.08, days: 30, label: "Monthly",  description: "30-day unlimited" },
  lifetime: { sol: 0.80, days: -1, label: "Lifetime", description: "Permanent unlimited" },
};

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  apikeys: path.join(DATA_DIR, "apikeys.json"),
  usage:   path.join(DATA_DIR, "usage.json"),
  bundles: path.join(DATA_DIR, "bundles.json"),
  events:  path.join(DATA_DIR, "events.json"),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let apikeys    = readJSON(FILES.apikeys, {});
let usage      = readJSON(FILES.usage, {});
let bundleLogs = readJSON(FILES.bundles, []);
let eventLogs  = readJSON(FILES.events, []);
const pendingRefs = {};

function persist() {
  writeJSON(FILES.apikeys, apikeys);
  writeJSON(FILES.usage, usage);
  writeJSON(FILES.bundles, bundleLogs.slice(-2000));
  writeJSON(FILES.events, eventLogs.slice(-1000));
}

function logBundle(entry) {
  const row = {
    timestamp:     Date.now(),
    ts:            new Date().toISOString(),
    apiKey:        entry.apiKey ? entry.apiKey.slice(0, 8) + "…" : "free",
    ip:            entry.ip,
    tier:          entry.tier,
    simResult:     entry.simResult,
    submitSuccess: entry.submitSuccess,
    landSuccess:   entry.landSuccess,
    tip:           entry.tip    ?? null,
    txCount:       entry.txCount ?? 1,
    bundleId:      entry.bundleId ?? null,
  };
  bundleLogs.push(row);
  persist();
  console.log(`[BUNDLE] ${row.ts} key=${row.apiKey} sim=${row.simResult} submit=${row.submitSuccess} land=${row.landSuccess}`);
  return row;
}

function logEvent(type, data = {}) {
  const entry = { ts: new Date().toISOString(), type, ...data };
  eventLogs.push(entry);
  persist();
  console.log(`[${type}]`, data);
  return entry;
}

function generateApiKey() {
  return "jw_" + crypto.randomBytes(24).toString("hex");
}

function validateApiKey(req) {
  const auth = req.headers["authorization"] || "";
  const key  = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!key) return { valid: false, key: null, reason: "missing_auth" };
  const entry = apikeys[key];
  if (!entry) return { valid: false, key, reason: "invalid_key" };
  if (entry.tier === "lifetime") return { valid: true, key, entry };
  if (entry.expires && new Date(entry.expires) < new Date())
    return { valid: false, key, reason: "key_expired", expiredAt: entry.expires };
  return { valid: true, key, entry };
}

function issueApiKey(type, ip, ref) {
  const key     = generateApiKey();
  const tierCfg = TIERS[type];
  const expires = type === "lifetime"
    ? null
    : new Date(Date.now() + tierCfg.days * 86_400_000).toISOString();
  apikeys[key] = { tier: type, ip, expires, createdAt: new Date().toISOString(), ref };
  persist();
  logEvent("KEY_ISSUED", { type, ip, ref, keyPrefix: key.slice(0, 10) });
  return { key, expires };
}

function todayUTC()        { return new Date().toISOString().slice(0, 10); }
function usageKey(id)      { return `${id}:${todayUTC()}`; }
function getUsageCount(id) { return usage[usageKey(id)] || 0; }
function incrementUsage(id) {
  const k = usageKey(id);
  usage[k] = (usage[k] || 0) + 1;
  writeJSON(FILES.usage, usage);
  return usage[k];
}

function scheduleMidnightReset() {
  const now     = new Date();
  const next    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const msUntil = next.getTime() - now.getTime();
  setTimeout(() => {
    const today = todayUTC();
    for (const k of Object.keys(usage)) {
      if (!k.endsWith(today)) delete usage[k];
    }
    writeJSON(FILES.usage, usage);
    logEvent("MIDNIGHT_RESET", { today });
    scheduleMidnightReset();
  }, msUntil);
  console.log(`[RESET] Next midnight reset in ${Math.round(msUntil / 60000)}m`);
}
scheduleMidnightReset();

async function jitoRequest(method, params = []) {
  const res = await fetch(QN_ENDPOINT, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function getTipFloor()          { return jitoRequest("getTipFloor"); }
async function simulateBundle(txns)   { return jitoRequest("simulateBundle", [{ transactions: txns }]); }
async function sendBundleRPC(txns)    { return jitoRequest("sendBundle", [txns]); }
async function getBundleStatuses(ids) { return jitoRequest("getBundleStatuses", [ids]); }

async function pollLandSuccess(bundleId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const result = await getBundleStatuses([bundleId]);
      const status = result?.value?.[0]?.confirmation_status;
      if (status === "confirmed" || status === "finalized") return true;
      if (status === "failed") return false;
    } catch (e) {
      console.error("[pollLand]", e.message);
    }
  }
  return false;
}

const connection = new Connection(QN_ENDPOINT, "confirmed");

function buildPaymentOptions(ip) {
  if (!PAYMENT_WALLET) throw new Error("PAYMENT_WALLET env var not set");
  return Object.entries(TIERS).map(([type, cfg]) => {
    const ref        = uuidv4();
    const kp         = Keypair.generate();
    const reference  = kp.publicKey;
    const refBase58  = reference.toBase58();
    const payUrl     = encodeURL({
      recipient: new PublicKey(PAYMENT_WALLET),
      amount:    new BigNumber(cfg.sol),
      reference,
      label:     `Jito Wrapper ${cfg.label}`,
      message:   `${cfg.label} access`,
      memo:      ref,
    }).toString();
    pendingRefs[ref] = { type, sol: cfg.sol, ip, referenceBase58: refBase58, createdAt: Date.now() };
    setTimeout(() => { delete pendingRefs[ref]; }, PAYMENT_EXPIRES_SECONDS * 1000);
    return { type, amount: cfg.sol, currency: "SOL", payTo: PAYMENT_WALLET, reference: ref, payUrl, description: cfg.description };
  });
}

async function verifyPaymentOnChain(sig, ref, type) {
  const pending = pendingRefs[ref];
  if (!pending)              return { ok: false, error: "reference_not_found_or_expired" };
  if (pending.type !== type) return { ok: false, error: "type_mismatch" };
  try {
    const reference = new PublicKey(pending.referenceBase58);
    await validateTransfer(
      connection, sig,
      { recipient: new PublicKey(PAYMENT_WALLET), amount: new BigNumber(pending.sol), reference },
      { commitment: "confirmed" }
    );
    return { ok: true, pending };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/status", (req, res) => {
  const auth       = validateApiKey(req);
  const ip         = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress;
  const identifier = auth.valid ? auth.key : ip;
  const count      = getUsageCount(identifier);
  if (!auth.valid && auth.reason === "key_expired") {
    return res.status(401).json({ error: "subscription_expired", expiredAt: auth.expiredAt, renewUrl: `${BASE_URL}/upgrade` });
  }
  res.json({
    authenticated:    auth.valid,
    tier:             auth.valid ? auth.entry.tier : "free",
    expires:          auth.valid ? (auth.entry.expires ?? null) : null,
    bundlesUsedToday: count,
    freeLimit:        auth.valid ? null : FREE_LIMIT,
    unlimited:        auth.valid,
  });
});

app.post("/sendBundle", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress;
  const { transactions, simulate, tipLamports } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: "transactions array required" });

  const auth = validateApiKey(req);

  if (!auth.valid && auth.reason === "key_expired")
    return res.status(401).json({ error: "subscription_expired", expiredAt: auth.expiredAt, renewUrl: `${BASE_URL}/upgrade` });

  if (!auth.valid && auth.reason === "invalid_key")
    return res.status(401).json({ error: "invalid_api_key" });

  const identifier = auth.valid ? auth.key : ip;
  const count      = getUsageCount(identifier);

  if (!auth.valid && count >= FREE_LIMIT) {
    logEvent("RATE_LIMITED", { ip, count });
    let options;
    try { options = buildPaymentOptions(ip); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(402).json({ error: "payment_required", freeUsed: count, freeLimit: FREE_LIMIT, options, activateAt: `${BASE_URL}/activate`, expires_in: PAYMENT_EXPIRES_SECONDS });
  }

  let simResult = "skipped";
  if (simulate) {
    try {
      await simulateBundle(transactions);
      simResult = "success";
    } catch (e) {
      simResult = "fail";
      logBundle({ apiKey: auth.key, ip, tier: auth.valid ? auth.entry.tier : "free", simResult, submitSuccess: false, landSuccess: false, tip: tipLamports ?? null, txCount: transactions.length });
      return res.status(400).json({ error: `Simulation failed: ${e.message}` });
    }
  }

  let bundleId = null, submitSuccess = false;
  try {
    bundleId      = await sendBundleRPC(transactions);
    submitSuccess = true;

    if (!auth.valid) {
      const newCount = incrementUsage(identifier);
      if (newCount === FREE_LIMIT) {
        let upgradeOptions = null;
        try { upgradeOptions = buildPaymentOptions(ip); } catch { /* skip */ }
        const body = { ok: true, bundleId, submitSuccess, warning: "free_limit_reached", message: `Bundle ${FREE_LIMIT}/${FREE_LIMIT} sent. Next request will require payment.`, activateAt: `${BASE_URL}/activate`, expires_in: PAYMENT_EXPIRES_SECONDS };
        if (upgradeOptions) body.options = upgradeOptions;
        if (bundleId) {
          pollLandSuccess(bundleId).then(landSuccess => {
            logBundle({ apiKey: null, ip, tier: "free", simResult, submitSuccess, landSuccess, tip: tipLamports ?? null, txCount: transactions.length, bundleId });
          });
        }
        return res.json(body);
      }
    }

    if (bundleId) {
      pollLandSuccess(bundleId).then(landSuccess => {
        logBundle({ apiKey: auth.key, ip, tier: auth.valid ? auth.entry.tier : "free", simResult, submitSuccess, landSuccess, tip: tipLamports ?? null, txCount: transactions.length, bundleId });
      });
    } else {
      logBundle({ apiKey: auth.key, ip, tier: auth.valid ? auth.entry.tier : "free", simResult, submitSuccess, landSuccess: false, tip: tipLamports ?? null, txCount: transactions.length });
    }

    res.json({ ok: true, bundleId, submitSuccess });

  } catch (err) {
    logBundle({ apiKey: auth.key, ip, tier: auth.valid ? auth.entry.tier : "free", simResult, submitSuccess: false, landSuccess: false, tip: tipLamports ?? null, txCount: transactions.length });
    res.status(500).json({ error: err.message });
  }
});

app.get("/upgrade", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress;
  try {
    const options = buildPaymentOptions(ip);
    res.json({ message: "Send SOL to activate. POST /activate with { sig, ref, type }.", options, activateAt: `${BASE_URL}/activate`, expires_in: PAYMENT_EXPIRES_SECONDS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/activate", async (req, res) => {
  const { sig, ref, type } = req.body;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress;
  if (!sig || !ref || !type) return res.status(400).json({ error: "sig, ref, and type are required" });
  if (!TIERS[type]) return res.status(400).json({ error: "type must be 'monthly' or 'lifetime'" });
  const v = await verifyPaymentOnChain(sig, ref, type);
  if (!v.ok) {
    logEvent("ACTIVATE_FAIL", { ip, ref, type, reason: v.error });
    return res.status(402).json({ error: "payment_verification_failed", reason: v.error, message: "Ensure the tx is confirmed and amounts match exactly." });
  }
  const { key, expires } = issueApiKey(type, ip, ref);
  delete pendingRefs[ref];
  logEvent("ACTIVATED", { ip, type, ref, keyPrefix: key.slice(0, 10) });
  if (bot && ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `💰 *New activation*\nType: ${type}\nIP: \`${ip}\`\nKey: \`${key.slice(0, 12)}…\``, { parse_mode: "Markdown" }).catch(() => {});
  }
  res.json({ status: "activated", apiKey: key, tier: type, expires, usage: `Authorization: Bearer ${key}` });
});

app.get("/tipFloor", async (_, res) => {
  try { res.json({ ok: true, tipFloor: await getTipFloor() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/whitelist", (req, res) => {
  const { type, ip, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });
  const { key, expires } = issueApiKey(type || "monthly", ip || "admin", "manual");
  res.json({ ok: true, apiKey: key, expires });
});

let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const isAdmin = ctx => !ADMIN_CHAT_ID || ctx.chat.id === ADMIN_CHAT_ID;

  bot.start(ctx => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    ctx.reply("*Jito Wrapper Admin*\n\n/logs — last 5 bundles\n/stats — subs, revenue, land rate\n/tipfloor — current Jito tip floor", { parse_mode: "Markdown" });
  });

  bot.command("logs", ctx => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const recent = bundleLogs.slice(-5).reverse();
    if (!recent.length) return ctx.reply("No bundle logs yet.");
    const total  = bundleLogs.length;
    const landed = bundleLogs.filter(b => b.landSuccess).length;
    const rate   = total ? Math.round((landed / total) * 100) : 0;
    const lines  = recent.map(b => `${b.ts.slice(11,19)} | ${b.tier} | sim:${b.simResult[0]} sub:${b.submitSuccess?1:0} land:${b.landSuccess?1:0}`).join("\n");
    ctx.reply(`*Last 5 Bundles*\nTotal: ${total} | Landed: ${landed} (${rate}%)\n\`\`\`\n${lines}\n\`\`\``, { parse_mode: "Markdown" });
  });

  bot.command("stats", ctx => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const all           = Object.values(apikeys);
    const activeMonthly = all.filter(k => k.tier === "monthly" && k.expires && new Date(k.expires) > new Date());
    const lifetime      = all.filter(k => k.tier === "lifetime");
    const revenue       = (activeMonthly.length * TIERS.monthly.sol) + (lifetime.length * TIERS.lifetime.sol);
    const total         = bundleLogs.length;
    const landed        = bundleLogs.filter(b => b.landSuccess).length;
    const landRate      = total ? Math.round((landed / total) * 100) : 0;
    ctx.reply(`*Admin Stats*\n\nActive monthly: ${activeMonthly.length}\nLifetime keys: ${lifetime.length}\nTotal keys ever: ${all.length}\nEst. SOL received: ${revenue.toFixed(2)}\n\nTotal bundles: ${total}\nLand rate: ${landRate}%`, { parse_mode: "Markdown" });
  });

  bot.command("tipfloor", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    try { ctx.reply(`Tip floor: \`${JSON.stringify(await getTipFloor())}\``, { parse_mode: "Markdown" }); }
    catch (err) { ctx.reply(`Error: ${err.message}`); }
  });

  const webhookPath = `/tg/${BOT_TOKEN}`;
  app.use(bot.webhookCallback(webhookPath));

  app.listen(PORT, async () => {
    console.log(`\n🚀 Jito Wrapper | port ${PORT} | ${BASE_URL}`);
    try {
      await bot.telegram.setWebhook(`${BASE_URL}${webhookPath}`);
      console.log(`[Bot] Webhook registered`);
    } catch (e) {
      console.error("[Bot] Webhook error:", e.message);
    }
  });

} else {
  app.listen(PORT, () => {
    console.log(`\n🚀 Jito Wrapper | port ${PORT} | set BOT_TOKEN for Telegram`);
  });
}

process.on("SIGTERM", () => { persist(); process.exit(0); });
