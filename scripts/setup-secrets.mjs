#!/usr/bin/env node
// One-time secret setup (PRD 16.3 c/d, 16.4). Run it in YOUR terminal:
//   node scripts/setup-secrets.mjs https://market-monitor.<subdomain>.workers.dev
//
// - Asks for the Alpaca key id, Alpaca secret and Telegram bot token at hidden prompts.
// - Checks each one against its provider (read-only calls).
// - Finds your Telegram chat id from the message you sent the bot.
// - Generates the webhook secret and the dashboard access code locally.
// - Sends everything straight to the Worker secret store (`wrangler secret bulk` via stdin).
// - Registers the Telegram webhook with the secret header (FR-5.2).
// - Shows the dashboard access code ONCE, here in the terminal.
// Nothing is written to disk, logged or printed except the access code.
//
//   --rotate-dashboard   only replace DASHBOARD_ACCESS_CODE ("sign out everywhere", S-8)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import readline from "node:readline";

const args = process.argv.slice(2);
const rotateOnly = args.includes("--rotate-dashboard");
const baseUrl = (args.find((a) => a.startsWith("https://")) || "").replace(/\/+$/, "");

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("  (received)\n");
      resolve(answer.trim());
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

const token = (bytes) => randomBytes(bytes).toString("base64url"); // A-Z a-z 0-9 _ - only

function putSecrets(obj) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["wrangler", "secret", "bulk"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      // Print only wrangler's summary lines, never the input.
      const summary = out.split("\n").filter((l) => /success|uploaded|finished|error|fail/i.test(l)).join("\n");
      if (summary) console.log(summary);
      code === 0 ? resolve() : reject(new Error(`wrangler secret bulk exited with ${code}`));
    });
    p.stdin.end(JSON.stringify(obj));
  });
}

async function tg(botToken, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

function showCode(code) {
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(" DASHBOARD ACCESS CODE (shown once; save it in your password manager):\n");
  console.log("   " + code);
  console.log("\n You type it once on the phone when the dashboard asks.");
  console.log("────────────────────────────────────────────────────────────\n");
}

async function main() {
  if (rotateOnly) {
    const code = token(32);
    await putSecrets({ DASHBOARD_ACCESS_CODE: code });
    showCode(code);
    console.log("✔ Old code no longer works on any device.");
    return;
  }
  if (!baseUrl) die("Give the Worker address, e.g. node scripts/setup-secrets.mjs https://market-monitor.example.workers.dev");

  console.log("Market Monitor secret setup. Input is hidden; paste and press Enter.\n");

  // Alpaca
  const keyId = await askHidden("Alpaca API key ID: ");
  const secret = await askHidden("Alpaca secret key: ");
  if (!keyId || !secret) die("Both Alpaca values are needed.");
  const ar = await fetch("https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL&feed=iex", {
    headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
    signal: AbortSignal.timeout(15000),
  }).catch((e) => die(`Could not reach Alpaca: ${e.message}`));
  if (ar.status === 401 || ar.status === 403) die(`Alpaca rejected the keys (HTTP ${ar.status}). Check you copied the paper-account data keys.`);
  if (!ar.ok) die(`Alpaca answered HTTP ${ar.status}.`);
  console.log("✔ Alpaca keys work (free IEX data).");

  // Telegram
  const botToken = await askHidden("Telegram bot token (from BotFather): ");
  let me;
  try { me = await tg(botToken, "getMe"); } catch (e) { die(`Telegram rejected the token: ${e.message}`); }
  console.log(`✔ Bot found: @${me.username}`);
  await tg(botToken, "deleteWebhook", { drop_pending_updates: false }); // getUpdates needs no webhook
  const updates = await tg(botToken, "getUpdates", { limit: 100, allowed_updates: ["message"] });
  const chats = new Map();
  for (const u of updates) {
    const c = u.message?.chat;
    if (c && c.type === "private") chats.set(String(c.id), c.first_name || c.username || "you");
  }
  if (chats.size === 0) die(`No message found. Open @${me.username} in Telegram, send it "hi", then run this again.`);
  let chatId = [...chats.keys()][0];
  if (chats.size > 1) {
    const list = [...chats.entries()];
    list.forEach(([, name], i) => console.log(`  ${i + 1}) ${name}`));
    const pick = Number(await ask("Which one is you? Number: "));
    if (!list[pick - 1]) die("No such choice.");
    chatId = list[pick - 1][0];
  }
  console.log("✔ Your chat found.");

  // Generated secrets
  const webhookSecret = token(32);
  const dashboardCode = token(32);

  console.log("\nSaving to the Cloudflare Worker secret store…");
  await putSecrets({
    ALPACA_KEY_ID: keyId,
    ALPACA_SECRET_KEY: secret,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_CHAT_ID: chatId,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    DASHBOARD_ACCESS_CODE: dashboardCode,
  });
  console.log("✔ Secrets stored.");

  await tg(botToken, "setWebhook", {
    url: `${baseUrl}/tg/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  console.log("✔ Telegram webhook registered.");

  showCode(dashboardCode);
  console.log(`Done. Send /test to @${me.username} to hear a test alert.`);
}

main().catch((e) => die(e.message));
