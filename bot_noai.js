require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const axios = require("axios");
const bs58 = require("bs58");

const CFG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  WALLET_KEY: process.env.WALLET_PRIVATE_KEY,
  ADMIN_IDS: (process.env.ADMIN_IDS || "").split(",").map(Number),
  RPC: process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
  BUY_SOL: 0.05,
  TAKE_PROFIT: 100,
  STOP_LOSS: 30,
  MAX_HOLD_MIN: 90,
  SLIPPAGE_BPS: 3000,
  MAX_POSITIONS: 5,
  SCAN_MS: 25000,
  POS_CHECK_MS: 15000,
  MIN_MC: 15000,
  MAX_MC: 800000,
  MIN_LIQ: 8000,
  MIN_HOLDERS: 40,
  MIN_AGE_MIN: 5,
  MAX_AGE_MIN: 180,
  MAX_DEV_PCT: 15,
  MIN_PRICE_CHG_5M: 2,
  MAX_PRICE_CHG_5M: 40,
};

const bot = new TelegramBot(CFG.TELEGRAM_TOKEN, { polling: true });
const conn = new Connection(CFG.RPC, "confirmed");

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_KEY));
  console.log("Wallet: " + wallet.publicKey.toBase58());
} catch(e) {
  console.error("Bad wallet key: " + e.message);
  process.exit(1);
}

const STATE = {
  active: false,
  autoTrade: false,
  positions: {},
  seen: new Set(),
  blacklist: new Set(),
  scanTimer: null,
  posTimer: null,
  solPrice: 180,
  stats: { scans: 0, passed: 0, bought: 0, sold: 0, wins: 0, losses: 0, pnl: 0 },
};

function log(m) { console.log("[" + new Date().toLocaleTimeString() + "] " + m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isAdmin(id) { return CFG.ADMIN_IDS.includes(id); }

function broadcast(text, kb) {
  for (const id of CFG.ADMIN_IDS) {
    bot.sendMessage(id, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...(kb ? { reply_markup: kb } : {})
    }).catch(() => {});
  }
}

async function updateSolPrice() {
  try {
    const r = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { timeout: 5000 });
    STATE.solPrice = r.data?.solana?.usd || 180;
  } catch {}
}

async function fetchPumpNew() {
  try {
    const r = await axios.get("https://frontend-api.pump.fun/coins/latest", {
      params: { limit: 30, includeNsfw: false },
      timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" }
    });
    return (r.data || []).map(t => ({ ...t, _src: "PumpFun" }));
  } catch { return []; }
}

async function fetchPumpTrending() {
  try {
    const r = await axios.get("https://frontend-api.pump.fun/coins/king-of-the-hill", {
      params: { limit: 15, includeNsfw: false },
      timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" }
    });
    return (r.data || []).map(t => ({ ...t, _src: "PumpFun-Hot" }));
  } catch { return []; }
}

async function fetchDex() {
  try {
    const r = await axios.get("https://api.dexscreener.com/latest/dex/search?q=solana+meme", { timeout: 8000 });
    return (r.data?.pairs || []).filter(p => p.chainId === "solana").slice(0, 25).map(p => ({
      mint: p.baseToken?.address,
      name: p.baseToken?.name || "Unknown",
      symbol: p.baseToken?.symbol || "???",
      usd_market_cap: parseFloat(p.marketCap || 0),
      virtual_sol_reserves: parseFloat(p.liquidity?.usd || 0) / STATE.solPrice,
      holder_count: p.txns?.h24?.buys || 0,
      created_timestamp: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : new Date(Date.now() - 30 * 60000).toISOString(),
      dev_holding_pct: 0,
      twitter: p.info?.socials?.find(s => s.type === "twitter")?.url || "",
      telegram: p.info?.socials?.find(s => s.type === "telegram")?.url || "",
      volume5m: parseFloat(p.volume?.m5 || 0),
      priceChange5m: parseFloat(p.priceChange?.m5 || 0),
      priceChange1h: parseFloat(p.priceChange?.h1 || 0),
      buys5m: p.txns?.m5?.buys || 0,
      sells5m: p.txns?.m5?.sells || 0,
      pairUrl: p.url || ("https://dexscreener.com/solana/" + (p.pairAddress || "")),
      _src: "DexScreener",
    }));
  } catch { return []; }
}

async function getDexDetail(mint) {
  try {
    const r = await axios.get("https://api.dexscreener.com/latest/dex/tokens/" + mint, { timeout: 6000 });
    return r.data?.pairs?.[0] || null;
  } catch { return null; }
}

function technicalScore(t) {
  const mc = t.usd_market_cap || 0;
  const liq = (t.virtual_sol_reserves || 0) * STATE.solPrice;
  const holders = t.holder_count || 0;
  const ageMins = (Date.now() - new Date(t.created_timestamp).getTime()) / 60000;
  const devPct = t.dev_holding_pct || 0;
  const ch5 = t.priceChange5m || 0;
  const buys = t.buys5m || 0;
  const sells = t.sells5m || 0;
  const ratio = sells > 0 ? buys / sells : buys > 0 ? 10 : 0;

  if (mc < CFG.MIN_MC) return { score: 0, decision: "AVOID", signals: [], fails: ["MC low"] };
  if (mc > CFG.MAX_MC) return { score: 0, decision: "AVOID", signals: [], fails: ["MC high"] };
  if (liq < CFG.MIN_LIQ) return { score: 0, decision: "AVOID", signals: [], fails: ["Low liq"] };
  if (holders < CFG.MIN_HOLDERS) return { score: 0, decision: "AVOID", signals: [], fails: ["Few holders"] };
  if (ageMins < CFG.MIN_AGE_MIN) return { score: 0, decision: "AVOID", signals: [], fails: ["Too new"] };
  if (ageMins > CFG.MAX_AGE_MIN) return { score: 0, decision: "AVOID", signals: [], fails: ["Too old"] };
  if (devPct > CFG.MAX_DEV_PCT) return { score: 0, decision: "AVOID", signals: [], fails: ["Dev holds too much"] };
  if (ch5 > CFG.MAX_PRICE_CHG_5M) return { score: 0, decision: "AVOID", signals: [], fails: ["Pump too strong"] };
  if (ch5 < CFG.MIN_PRICE_CHG_5M) return { score: 0, decision: "AVOID", signals: [], fails: ["No momentum"] };

  let score = 0;
  const signals = [];

  if (mc >= 20000 && mc <= 150000) { score += 25; signals.push("MC ideal"); }
  else if (mc <= 300000) { score += 15; signals.push("MC good"); }

  if (liq >= 20000) { score += 20; signals.push("Strong liq"); }
  else if (liq >= 10000) { score += 12; }

  if (ch5 >= 8 && ch5 <= 25) { score += 20; signals.push("Strong momentum"); }
  else if (ch5 >= 4) { score += 12; }

  if (ratio >= 2.5) { score += 20; signals.push("Buy pressure"); }
  else if (ratio >= 1.5) { score += 12; }
  else if (ratio < 1) { score -= 10; }

  if (t.volume5m >= 10000) { score += 15; signals.push("High volume"); }
  else if (t.volume5m >= 4000) { score += 8; }

  if (holders >= 300) { score += 10; }
  else if (holders >= 150) { score += 7; }
  else if (holders >= 80) { score += 4; }

  if (ageMins >= 10 && ageMins <= 60) { score += 10; signals.push("Good timing"); }
  else if (ageMins <= 90) { score += 5; }

  if (t.twitter && t.telegram) { score += 8; signals.push("Has socials"); }
  else if (t.twitter || t.telegram) { score += 4; }

  if (buys >= 15) { score += 8; signals.push("Active buys"); }
  else if (buys >= 8) { score += 4; }

  const decision = score >= 70 ? "BUY" : score >= 50 ? "WATCH" : "AVOID";
  return { score, decision, signals, mc, liq, holders, ageMins, ch5, ratio };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function jupBuy(mint, solAmt) {
  try {
    const lamps = Math.floor(solAmt * LAMPORTS_PER_SOL);
    const q = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: { inputMint: SOL_MINT, outputMint: mint, amount: lamps, slippageBps: CFG.SLIPPAGE_BPS },
      timeout: 12000
    });
    const s = await axios.post("https://quote-api.jup.ag/v6/swap", {
      quoteResponse: q.data,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 50000,
    }, { timeout: 12000 });
    const tx = Transaction.from(Buffer.from(s.data.swapTransaction, "base64"));
    tx.partialSign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig, outAmount: parseInt(q.data.outAmount) };
  } catch(e) { return { ok: false, err: e.message }; }
}

async function jupSell(mint, tokenAmt) {
  try {
    const q = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: { inputMint: mint, outputMint: SOL_MINT, amount: tokenAmt, slippageBps: CFG.SLIPPAGE_BPS },
      timeout: 12000
    });
    const s = await axios.post("https://quote-api.jup.ag/v6/swap", {
      quoteResponse: q.data,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 50000,
    }, { timeout: 12000 });
    const tx = Transaction.from(Buffer.from(s.data.swapTransaction, "base64"));
    tx.partialSign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig, solOut: parseInt(q.data.outAmount) / LAMPORTS_PER_SOL };
  } catch(e) { return { ok: false, err: e.message }; }
}

async function getBalance() {
  const b = await conn.getBalance(wallet.publicKey);
  return b / LAMPORTS_PER_SOL;
}

async function checkPositions() {
  for (const [mint, pos] of Object.entries(STATE.positions)) {
    try {
      const dx = await getDexDetail(mint);
      let curMC = pos.mcAtBuy;
      if (dx?.marketCap) curMC = parseFloat(dx.marketCap);
      const pnlPct = ((curMC - pos.mcAtBuy) / pos.mcAtBuy) * 100;
      const heldMins = (Date.now() - pos.buyTime) / 60000;
      let exit = null;
      if (pnlPct >= CFG.TAKE_PROFIT) exit = { why: "Take Profit +" + pnlPct.toFixed(1) + "%", win: true };
      else if (pnlPct <= -CFG.STOP_LOSS) exit = { why: "Stop Loss " + pnlPct.toFixed(1) + "%", win: false };
      else if (heldMins >= CFG.MAX_HOLD_MIN) exit = { why: "Max hold " + Math.round(heldMins) + "min", win: pnlPct >= 0 };
      if (exit) {
        const res = await jupSell(mint, pos.tokenAmount);
        if (res.ok) {
          const realPnl = res.solOut - pos.solSpent;
          const realPnlPct = (realPnl / pos.solSpent) * 100;
          STATE.stats.pnl += realPnl;
          STATE.stats.sold++;
          if (exit.win) STATE.stats.wins++; else STATE.stats.losses++;
          delete STATE.positions[mint];
          broadcast(
            (exit.win ? "PROFIT" : "LOSS") + " *" + pos.symbol + "*\n" +
            exit.why + "\n" +
            "In: `" + pos.solSpent + " SOL`\n" +
            "Out: `" + res.solOut.toFixed(4) + " SOL`\n" +
            "PnL: `" + (realPnlPct >= 0 ? "+" : "") + realPnlPct.toFixed(1) + "%`\n" +
            "[TX](https://solscan.io/tx/" + res.sig + ")"
          );
        }
      }
    } catch(e) { log("Monitor err: " + e.message); }
  }
}

async function scan() {
  if (!STATE.active) return;
  STATE.stats.scans++;
  await updateSolPrice();
  if (Object.keys(STATE.positions).length >= CFG.MAX_POSITIONS) return;
  log("Scan #" + STATE.stats.scans + " SOL=$" + STATE.solPrice);

  const [pNew, pTrend, dex] = await Promise.all([fetchPumpNew(), fetchPumpTrending(), fetchDex()]);
  const all = [...new Map([...pNew, ...pTrend, ...dex].filter(t => t.mint).map(t => [t.mint, t])).values()];
  log("Tokens: " + all.length);

  for (const token of all) {
    if (!STATE.active) break;
    if (STATE.seen.has(token.mint)) continue;
    STATE.seen.add(token.mint);
    if (STATE.seen.size > 3000) STATE.seen.clear();
    if (STATE.blacklist.has(token.mint)) continue;
    if (STATE.positions[token.mint]) continue;

    if (!token.priceChange5m) {
      const dx = await getDexDetail(token.mint);
      if (dx) {
        token.priceChange5m = parseFloat(dx.priceChange?.m5 || 0);
        token.volume5m = parseFloat(dx.volume?.m5 || 0);
        token.buys5m = dx.txns?.m5?.buys || 0;
        token.sells5m = dx.txns?.m5?.sells || 0;
        token.pairUrl = dx.url || token.pairUrl;
        if (dx.marketCap) token.usd_market_cap = parseFloat(dx.marketCap);
      }
    }

    const ta = technicalScore(token);
    log(ta.decision + " " + token.symbol + " score:" + ta.score);
    if (ta.decision === "AVOID") continue;

    STATE.stats.passed++;
    const mc = Math.round(token.usd_market_cap || 0);
    const liq = Math.round((token.virtual_sol_reserves || 0) * STATE.solPrice);
    const age = Math.round((Date.now() - new Date(token.created_timestamp).getTime()) / 60000);

    const alertMsg =
      (ta.decision === "BUY" ? "BUY" : "WATCH") + " *" + token.name + "* `" + token.symbol + "`\n" +
      token._src + "\n" +
      "MC: `$" + mc.toLocaleString() + "` Liq: `$" + liq.toLocaleString() + "`\n" +
      "Holders: `" + (token.holder_count || 0) + "` Age: `" + age + "min`\n" +
      "5m: `" + (ta.ch5 >= 0 ? "+" : "") + ta.ch5 + "%`\n" +
      "Score: `" + ta.score + "/100`\n" +
      "`" + token.mint + "`\n" +
      "[PumpFun](https://pump.fun/" + token.mint + ") | [DEX](" + (token.pairUrl || "https://dexscreener.com/solana/" + token.mint) + ")";

    const kb = {
      inline_keyboard: [[
        { text: "BUY " + CFG.BUY_SOL + " SOL", callback_data: "B_" + token.mint + "_" + token.symbol },
        { text: "Blacklist", callback_data: "BL_" + token.mint },
      ]]
    };

    broadcast(alertMsg, kb);

    if (STATE.autoTrade && ta.decision === "BUY" && ta.score >= 70) {
      const bal = await getBalance();
      if (bal >= CFG.BUY_SOL + 0.015) {
        log("Auto buying " + token.symbol);
        const res = await jupBuy(token.mint, CFG.BUY_SOL);
        if (res.ok) {
          STATE.positions[token.mint] = {
            symbol: token.symbol,
            buyTime: Date.now(),
            solSpent: CFG.BUY_SOL,
            tokenAmount: res.outAmount,
            mcAtBuy: token.usd_market_cap || 0,
            pairUrl: token.pairUrl,
            src: token._src,
          };
          STATE.stats.bought++;
          broadcast(
            "BOUGHT *" + token.name + "* `" + token.symbol + "`\n" +
            "`" + CFG.BUY_SOL + " SOL`\n" +
            "Score: `" + ta.score + "/100`\n" +
            "TP: `+" + CFG.TAKE_PROFIT + "%` SL: `-" + CFG.STOP_LOSS + "%`\n" +
            "[TX](https://solscan.io/tx/" + res.sig + ")"
          );
        } else {
          broadcast("Buy failed " + token.symbol + ": " + res.err);
        }
      } else {
        broadcast("Low balance: " + bal.toFixed(3) + " SOL");
      }
    }
    await sleep(1000);
  }
}

bot.onText(/\/start$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id,
    "*Ultimate Meme Bot*\n" +
    "/on - Start scanning\n" +
    "/off - Stop\n" +
    "/auto - Toggle auto trade\n" +
    "/scan - Manual scan\n" +
    "/wallet - Balance\n" +
    "/pos - Open positions\n" +
    "/stats - Statistics\n" +
    "/settings - Settings\n" +
    "/sell SYMBOL - Manual sell\n" +
    "/buy 0.05 - Set buy amount\n" +
    "/tp 100 - Take profit %\n" +
    "/sl 30 - Stop loss %",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/on$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  if (STATE.active) return bot.sendMessage(msg.chat.id, "Already running");
  STATE.active = true;
  STATE.scanTimer = setInterval(scan, CFG.SCAN_MS);
  STATE.posTimer = setInterval(checkPositions, CFG.POS_CHECK_MS);
  bot.sendMessage(msg.chat.id, "Bot started! Scanning PumpFun + DexScreener every " + (CFG.SCAN_MS/1000) + "s\nSend /auto to enable auto trading");
  scan();
});

bot.onText(/\/off$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  STATE.active = false;
  clearInterval(STATE.scanTimer);
  clearInterval(STATE.posTimer);
  bot.sendMessage(msg.chat.id, "Bot stopped");
});

bot.onText(/\/auto$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  STATE.autoTrade = !STATE.autoTrade;
  bot.sendMessage(msg.chat.id,
    STATE.autoTrade
      ? "Auto trade ON - buys at score 70+, sells at TP/SL"
      : "Auto trade OFF - alerts only"
  );
});

bot.onText(/\/scan$/, async msg => {
  if (!isAdmin(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id, "Manual scan...");
  const was = STATE.active;
  STATE.active = true;
  await scan();
  STATE.active = was;
});

bot.onText(/\/wallet$/, async msg => {
  if (!isAdmin(msg.chat.id)) return;
  const sol = await getBalance();
  bot.sendMessage(msg.chat.id,
    "*Wallet*\n`" + wallet.publicKey.toBase58() + "`\n\nSOL: `" + sol.toFixed(4) + "`\nUSD: `~$" + (sol * STATE.solPrice).toFixed(2) + "`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/pos$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  const entries = Object.entries(STATE.positions);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "No open positions");
  let txt = "*Open Positions*\n";
  for (const [mint, p] of entries) {
    const mins = Math.round((Date.now() - p.buyTime) / 60000);
    txt += "*" + p.symbol + "* " + p.solSpent + " SOL - " + mins + "min\n";
  }
  bot.sendMessage(msg.chat.id, txt, { parse_mode: "Markdown" });
});

bot.onText(/\/stats$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  const s = STATE.stats;
  const wr = s.sold > 0 ? ((s.wins / s.sold) * 100).toFixed(0) : 0;
  bot.sendMessage(msg.chat.id,
    "*Stats*\n" +
    "Scans: `" + s.scans + "`\n" +
    "Passed filters: `" + s.passed + "`\n" +
    "Bought: `" + s.bought + "`\n" +
    "Sold: `" + s.sold + "`\n" +
    "Wins/Losses: `" + s.wins + "/" + s.losses + "`\n" +
    "Win rate: `" + wr + "%`\n" +
    "PnL: `" + (s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(4) + " SOL`\n" +
    "Auto trade: `" + (STATE.autoTrade ? "ON" : "OFF") + "`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/settings$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id,
    "*Settings*\n" +
    "Buy: `" + CFG.BUY_SOL + " SOL`\n" +
    "TP: `+" + CFG.TAKE_PROFIT + "%`\n" +
    "SL: `-" + CFG.STOP_LOSS + "%`\n" +
    "Max hold: `" + CFG.MAX_HOLD_MIN + "min`\n" +
    "MC range: `$" + CFG.MIN_MC.toLocaleString() + "-$" + CFG.MAX_MC.toLocaleString() + "`\n" +
    "Min liq: `$" + CFG.MIN_LIQ.toLocaleString() + "`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/buy (.+)/, (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  const v = parseFloat(m[1]);
  if (isNaN(v) || v < 0.001) return bot.sendMessage(msg.chat.id, "Min 0.001 SOL");
  CFG.BUY_SOL = v;
  bot.sendMessage(msg.chat.id, "Buy amount: `" + v + " SOL`", { parse_mode: "Markdown" });
});

bot.onText(/\/tp (.+)/, (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  CFG.TAKE_PROFIT = parseFloat(m[1]);
  bot.sendMessage(msg.chat.id, "TP: `+" + CFG.TAKE_PROFIT + "%`", { parse_mode: "Markdown" });
});

bot.onText(/\/sl (.+)/, (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  CFG.STOP_LOSS = parseFloat(m[1]);
  bot.sendMessage(msg.chat.id, "SL: `-" + CFG.STOP_LOSS + "%`", { parse_mode: "Markdown" });
});

bot.onText(/\/sell (.+)/, async (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  const sym = m[1].toUpperCase();
  const entry = Object.entries(STATE.positions).find(([, p]) => p.symbol === sym);
  if (!entry) return bot.sendMessage(msg.chat.id, "No position for " + sym);
  const [mint, pos] = entry;
  bot.sendMessage(msg.chat.id, "Selling " + sym + "...");
  const res = await jupSell(mint, pos.tokenAmount);
  if (res.ok) {
    const pnl = ((res.solOut - pos.solSpent) / pos.solSpent) * 100;
    STATE.stats.pnl += res.solOut - pos.solSpent;
    STATE.stats.sold++;
    pnl >= 0 ? STATE.stats.wins++ : STATE.stats.losses++;
    delete STATE.positions[mint];
    bot.sendMessage(msg.chat.id,
      "Sold *" + sym + "*\n`" + res.solOut.toFixed(4) + " SOL`\nPnL: `" + (pnl >= 0 ? "+" : "") + pnl.toFixed(1) + "%`\n[TX](https://solscan.io/tx/" + res.sig + ")",
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } else {
    bot.sendMessage(msg.chat.id, "Sell failed: " + res.err);
  }
});

bot.on("callback_query", async q => {
  const id = q.message.chat.id;
  if (!isAdmin(id)) return;
  const parts = q.data.split("_");
  const act = parts[0];
  const mint = parts[1];
  const sym = parts[2] || "TOKEN";

  if (act === "B") {
    bot.answerCallbackQuery(q.id, { text: "Buying..." });
