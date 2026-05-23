/**
╔══════════════════════════════════════════════════════╗
 * ║     🔥 ULTIMATE MEME BOT — NO AI / FREE VERSION     ║
 * ║     تحليل تقني بالكامل — بدون Anthropic API         ║
 * ║     PumpFun + DexScreener + Jupiter Swap            ║
 * ╚══════════════════════════════════════════════════════╝
 */

require("dotenv").config();
const TelegramBot  = require("node-telegram-bot-api");
const { Connection, Keypair, Transaction,
        LAMPORTS_PER_SOL }               = require("@solana/web3.js");
const axios  = require("axios");
const bs58   = require("bs58");

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const CFG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  WALLET_KEY:     process.env.WALLET_PRIVATE_KEY,
  ADMIN_IDS:      (process.env.ADMIN_IDS || "").split(",").map(Number),
  RPC:            process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",

  BUY_SOL:        0.05,
  TAKE_PROFIT:    100,   // +100%
  STOP_LOSS:      30,    // -30%
  MAX_HOLD_MIN:   90,
  SLIPPAGE_BPS:   3000,
  MAX_POSITIONS:  5,
  SCAN_MS:        25000,
  POS_CHECK_MS:   15000,

  // ── فلاتر تقنية صارمة (بديل AI) ──────────
  MIN_MC:           15000,
  MAX_MC:           800000,
  MIN_LIQ:          8000,
  MIN_HOLDERS:      40,
  MIN_AGE_MIN:      5,
  MAX_AGE_MIN:      180,
  MAX_DEV_PCT:      15,
  MIN_BUYS_5M:      5,      // minimum 5 buys in 5 minutes
  MAX_PRICE_CHG_5M: 40,     // max +40% in 5m (avoid top of pump)
  MIN_PRICE_CHG_5M: 2,      // min +2% momentum
  MIN_BUY_SELL_RATIO: 1.3,  // buys must be 1.3x more than sells
  MIN_VOLUME_5M:    2000,    // $2k min volume in 5m
};

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
const bot  = new TelegramBot(CFG.TELEGRAM_TOKEN, { polling: true });
const conn = new Connection(CFG.RPC, "confirmed");

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_KEY));
  console.log("✅ Wallet:", wallet.publicKey.toBase58());
} catch(e) {
  console.error("❌ خطأ في مفتاح المحفظة:", e.message);
  process.exit(1);
}

const STATE = {
  active:    false,
  autoTrade: false,
  positions: {},
  seen:      new Set(),
  blacklist: new Set(),
  scanTimer: null,
  posTimer:  null,
  solPrice:  180,
  stats:     { scans:0, passed:0, bought:0, sold:0, wins:0, losses:0, pnl:0 },
};

function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════
//  SOL PRICE
// ══════════════════════════════════════════════
async function updateSolPrice() {
  try {
    const r = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: 5000 }
    );
    STATE.solPrice = r.data?.solana?.usd || 180;
  } catch {}
}

// ══════════════════════════════════════════════
//  DATA SOURCES
// ══════════════════════════════════════════════
async function fetchPumpNew() {
  try {
    const r = await axios.get("https://frontend-api.pump.fun/coins/latest", {
      params: { limit: 30, includeNsfw: false },
      timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" }
    });
    return (r.data || []).map(t => ({ ...t, _src: "🟣 PumpFun" }));
  } catch { return []; }
}

async function fetchPumpTrending() {
  try {
    const r = await axios.get("https://frontend-api.pump.fun/coins/king-of-the-hill", {
      params: { limit: 15, includeNsfw: false },
      timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" }
    });
    return (r.data || []).map(t => ({ ...t, _src: "🔥 PumpFun" }));
  } catch { return []; }
}

async function fetchDexScreener() {
  try {
    const r = await axios.get(
      "https://api.dexscreener.com/latest/dex/search?q=solana+meme",
      { timeout: 8000 }
    );
    return (r.data?.pairs || [])
      .filter(p => p.chainId === "solana")
      .slice(0, 25)
      .map(p => ({
        mint:                 p.baseToken?.address,
        name:                 p.baseToken?.name || "Unknown",
        symbol:               p.baseToken?.symbol || "???",
        usd_market_cap:       parseFloat(p.marketCap || 0),
        virtual_sol_reserves: parseFloat(p.liquidity?.usd || 0) / STATE.solPrice,
        holder_count:         p.txns?.h24?.buys || 0,
        created_timestamp:    p.pairCreatedAt
                                ? new Date(p.pairCreatedAt).toISOString()
                                : new Date(Date.now() - 30 * 60000).toISOString(),
        dev_holding_pct:      0,
        twitter:              p.info?.socials?.find(s => s.type === "twitter")?.url || "",
        telegram:             p.info?.socials?.find(s => s.type === "telegram")?.url || "",
        volume5m:             parseFloat(p.volume?.m5 || 0),
        volume1h:             parseFloat(p.volume?.h1 || 0),
        priceChange5m:        parseFloat(p.priceChange?.m5 || 0),
        priceChange1h:        parseFloat(p.priceChange?.h1 || 0),
        buys5m:               p.txns?.m5?.buys || 0,
        sells5m:              p.txns?.m5?.sells || 0,
        pairUrl:              p.url || `https://dexscreener.com/solana/${p.pairAddress}`,
        _src:                 "📊 DexScreener",
      }));
  } catch { return []; }
}

async function getPumpDetail(mint) {
  try {
    const r = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`,
      { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } });
    return r.data;
  } catch { return null; }
}

async function getDexDetail(mint) {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 6000 }
    );
    return r.data?.pairs?.[0] || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  TECHNICAL SCORE  (بديل AI — مجاني 100%)
// ══════════════════════════════════════════════
function technicalScore(t) {
  let score   = 0;
  let signals = [];
  let fails   = [];

  const mc      = t.usd_market_cap || 0;
  const liq     = (t.virtual_sol_reserves || 0) * STATE.solPrice;
  const holders = t.holder_count || 0;
  const ageMins = (Date.now() - new Date(t.created_timestamp).getTime()) / 60000;
  const devPct  = t.dev_holding_pct || 0;
  const ch5     = t.priceChange5m || 0;
  const ch1h    = t.priceChange1h || 0;
  const vol5m   = t.volume5m || 0;
  const buys    = t.buys5m || 0;
  const sells   = t.sells5m || 0;
  const ratio   = sells > 0 ? buys / sells : buys > 0 ? 10 : 0;

  // ── Hard Fails (رفض فوري) ──────────────────
  if (mc < CFG.MIN_MC)            return { score: 0, decision: "AVOID", signals: [], fails: [`MC منخفض $${Math.round(mc)}`] };
  if (mc > CFG.MAX_MC)            return { score: 0, decision: "AVOID", signals: [], fails: [`MC مرتفع $${Math.round(mc)}`] };
  if (liq < CFG.MIN_LIQ)         return { score: 0, decision: "AVOID", signals: [], fails: [`سيولة ضعيفة $${Math.round(liq)}`] };
  if (holders < CFG.MIN_HOLDERS)  return { score: 0, decision: "AVOID", signals: [], fails: [`حاملون قليلون ${holders}`] };
  if (ageMins < CFG.MIN_AGE_MIN)  return { score: 0, decision: "AVOID", signals: [], fails: [`جديد جداً ${ageMins.toFixed(1)}د`] };
  if (ageMins > CFG.MAX_AGE_MIN)  return { score: 0, decision: "AVOID", signals: [], fails: [`قديم جداً ${Math.round(ageMins)}د`] };
  if (devPct > CFG.MAX_DEV_PCT)   return { score: 0, decision: "AVOID", signals: [], fails: [`Dev ${devPct}% ⚠️`] };
  if (ch5 > CFG.MAX_PRICE_CHG_5M) return { score: 0, decision: "AVOID", signals: [], fails: [`Pump قوي جداً +${ch5}%`] };
  if (ch5 < CFG.MIN_PRICE_CHG_5M) return { score: 0, decision: "AVOID", signals: [], fails: [`لا زخم ${ch5}%`] };

  // ── Scoring ────────────────────────────────

  // Market Cap في النطاق المثالي
  if (mc >= 20000 && mc <= 150000) { score += 25; signals.push("MC مثالي ✅"); }
  else if (mc <= 300000)           { score += 15; signals.push("MC جيد"); }

  // السيولة
  if (liq >= 20000)      { score += 20; signals.push("سيولة قوية 💧"); }
  else if (liq >= 10000) { score += 12; signals.push("سيولة كافية"); }
  else                   { score += 5; }

  // الزخم — تغيير السعر 5 دقائق
  if (ch5 >= 8 && ch5 <= 25)  { score += 20; signals.push(`زخم قوي +${ch5}% 🚀`); }
  else if (ch5 >= 4)           { score += 12; signals.push(`زخم +${ch5}%`); }
  else                         { score += 5; }

  // نسبة الشراء/البيع
  if (ratio >= 2.5)    { score += 20; signals.push(`ضغط شراء ${ratio.toFixed(1)}x 💚`); }
  else if (ratio >= 1.5) { score += 12; signals.push(`شراء > بيع`); }
  else if (ratio < 1)  { score -= 10; fails.push("ضغط بيع ⚠️"); }

  // حجم التداول 5 دقائق
  if (vol5m >= 10000)     { score += 15; signals.push(`حجم قوي $${Math.round(vol5m/1000)}k`); }
  else if (vol5m >= 4000) { score += 8; }

  // عدد الحاملين
  if (holders >= 300)     { score += 10; signals.push(`${holders} حامل 👥`); }
  else if (holders >= 150) { score += 7; }
  else if (holders >= 80)  { score += 4; }

  // العمر المثالي
  if (ageMins >= 10 && ageMins <= 60) { score += 10; signals.push("توقيت مثالي ⏱"); }
  else if (ageMins <= 90)              { score += 5; }

  // وسائل التواصل
  if (t.twitter && t.telegram) { score += 8; signals.push("Twitter+TG ✅"); }
  else if (t.twitter || t.telegram) { score += 4; }

  // اتجاه الساعة
  if (ch1h > 20)       { score += 5; signals.push(`1س +${ch1h}% 📈`); }
  else if (ch1h < -10) { score -= 5; fails.push(`1س ${ch1h}%`); }

  // صفقات نشطة
  if (buys >= 15)     { score += 8; signals.push(`${buys} صفقة شراء`); }
  else if (buys >= 8) { score += 4; }

  const decision = score >= 70 ? "BUY" : score >= 50 ? "WATCH" : "AVOID";

  return { score, decision, signals, fails, mc, liq, holders, ageMins, ch5, ratio, vol5m };
}

// ══════════════════════════════════════════════
//  JUPITER SWAP
// ══════════════════════════════════════════════
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function jupBuy(mint, solAmt) {
  try {
    const lamps = Math.floor(solAmt * LAMPORTS_PER_SOL);
    const q = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: { inputMint: SOL_MINT, outputMint: mint,
                amount: lamps, slippageBps: CFG.SLIPPAGE_BPS },
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
    const sig = await conn.sendRawTransaction(tx.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig, outAmount: parseInt(q.data.outAmount) };
  } catch(e) { return { ok: false, err: e.message }; }
}

async function jupSell(mint, tokenAmt) {
  try {
    const q = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: { inputMint: mint, outputMint: SOL_MINT,
                amount: tokenAmt, slippageBps: CFG.SLIPPAGE_BPS },
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
    const sig = await conn.sendRawTransaction(tx.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig, solOut: parseInt(q.data.outAmount) / LAMPORTS_PER_SOL };
  } catch(e) { return { ok: false, err: e.message }; }
}

async function getBalance() {
  const b = await conn.getBalance(wallet.publicKey);
  return b / LAMPORTS_PER_SOL;
}

// ══════════════════════════════════════════════
//  POSITION MONITOR
// ══════════════════════════════════════════════
async function checkPositions() {
  for (const [mint, pos] of Object.entries(STATE.positions)) {
    try {
      const dx = await getDexDetail(mint);
      let curMC = pos.mcAtBuy;
      if (dx?.marketCap) curMC = parseFloat(dx.marketCap);

      const pnlPct   = ((curMC - pos.mcAtBuy) / pos.mcAtBuy) * 100;
      const heldMins = (Date.now() - pos.buyTime) / 60000;

      let exit = null;
      if (pnlPct >= CFG.TAKE_PROFIT)       exit = { why: `🎯 Take Profit +${pnlPct.toFixed(1)}%`, win: true };
      else if (pnlPct <= -CFG.STOP_LOSS)   exit = { why: `🛡 Stop Loss ${pnlPct.toFixed(1)}%`,    win: false };
      else if (heldMins >= CFG.MAX_HOLD_MIN) exit = { why: `⏰ وقت (${Math.round(heldMins)}د)`,   win: pnlPct >= 0 };

      if (exit) {
        const res = await jupSell(mint, pos.tokenAmount);
        if (res.ok) {
          const realPnl    = res.solOut - pos.solSpent;
          const realPnlPct = (realPnl / pos.solSpent) * 100;
          STATE.stats.pnl += realPnl;
          STATE.stats.sold++;
          if (exit.win) STATE.stats.wins++; else STATE.stats.losses++;
          delete STATE.positions[mint];

          broadcast(`
${exit.win ? "✅" : "❌"} *صفقة مغلقة — ${pos.symbol}*
━━━━━━━━━━━━━━━━
${exit.why}
💰 دخل: \`${pos.solSpent} SOL\`
💵 خروج: \`${res.solOut.toFixed(4)} SOL\`
📊 P&L: \`${realPnlPct >= 0 ? "+" : ""}${realPnlPct.toFixed(1)}%\`
🔗 [TX](https://solscan.io/tx/${res.sig})
          `.trim());
        } else {
          broadcast(`⚠️ فشل بيع ${pos.symbol}: ${res.err}`);
        }
      }
    } catch(e) { log(`Monitor err: ${e.message}`); }
  }
}

// ══════════════════════════════════════════════
//  MAIN SCAN
// ══════════════════════════════════════════════
async function scan() {
  if (!STATE.active) return;
  STATE.stats.scans++;
  await updateSolPrice();

  if (Object.keys(STATE.positions).length >= CFG.MAX_POSITIONS) {
    log("Max positions reached, skip scan");
    return;
  }

  log(`🔍 Scan #${STATE.stats.scans} | SOL=$${STATE.solPrice}`);

  const [pNew, pTrend, dex] = await Promise.all([
    fetchPumpNew(), fetchPumpTrending(), fetchDexScreener()
  ]);

  const all = [...new Map(
    [...pNew, ...pTrend, ...dex]
      .filter(t => t.mint)
      .map(t => [t.mint, t])
  ).values()];

  log(`📦 ${all.length} tokens collected`);

  for (const token of all) {
    if (!STATE.active) break;
    if (STATE.seen.has(token.mint)) continue;
    STATE.seen.add(token.mint);
    if (STATE.seen.size > 3000) STATE.seen.clear();
    if (STATE.blacklist.has(token.mint)) continue;
    if (STATE.positions[token.mint]) continue;

    // Enrich with DexScreener data if from PumpFun
    if (!token.priceChange5m) {
      const dx = await getDexDetail(token.mint);
      if (dx) {
        token.priceChange5m = parseFloat(dx.priceChange?.m5 || 0);
        token.priceChange1h = parseFloat(dx.priceChange?.h1 || 0);
        token.volume5m      = parseFloat(dx.volume?.m5 || 0);
        token.buys5m        = dx.txns?.m5?.buys || 0;
        token.sells5m       = dx.txns?.m5?.sells || 0;
        token.pairUrl       = dx.url || token.pairUrl;
        if (dx.marketCap) token.usd_market_cap = parseFloat(dx.marketCap);
      }
    }

    // Technical Analysis
    const ta = technicalScore(token);
    log(`${ta.decision} | ${token.symbol} | score:${ta.score} | ${ta.signals.slice(0,2).join(", ")}`);

    if (ta.decision === "AVOID") continue;

    STATE.stats.passed++;

    // Build alert
    const mc  = Math.round(token.usd_market_cap || 0);
    const liq = Math.round((token.virtual_sol_reserves || 0) * STATE.solPrice);
    const age = Math.round((Date.now() - new Date(token.created_timestamp).getTime()) / 60000);

    const alertMsg = `
${ta.decision === "BUY" ? "🚀" : "👀"} *${token.name}* \`${token.symbol}\`
${token._src}
━━━━━━━━━━━━━━━━━━
📊 MC: \`$${mc.toLocaleString()}\`  💧 Liq: \`$${liq.toLocaleString()}\`
👥 \`${token.holder_count || 0}\` حامل  ⏱ \`${age}د\`
📈 5د: \`${ta.ch5 >= 0 ? "+" : ""}${ta.ch5}%\`  🛒 \`${token.buys5m || 0}/${token.sells5m || 0}\`
💹 حجم 5د: \`$${Math.round(ta.vol5m).toLocaleString()}\`

⚡ *التحليل التقني*
النقاط: \`${ta.score}/100\`
${ta.signals.map(s => `✅ ${s}`).join("\n")}
${ta.fails.map(f => `⚠️ ${f}`).join("\n")}

\`${token.mint}\`
[PumpFun](https://pump.fun/${token.mint}) | [DEX](${token.pairUrl || "https://dexscreener.com/solana/" + token.mint})
    `.trim();

    const kb = {
      inline_keyboard: [[
        { text: `✅ شراء ${CFG.BUY_SOL} SOL`, callback_data: `B_${token.mint}_${token.symbol}` },
        { text: "🚫 بلاك ليست",               callback_data: `BL_${token.mint}` },
      ]]
    };

    broadcast(alertMsg, kb);

    // Auto trade
    if (STATE.autoTrade && ta.decision === "BUY" && ta.score >= 70) {
      const bal = await getBalance();
      if (bal >= CFG.BUY_SOL + 0.015) {
        log(`💸 Auto buying ${token.symbol} score:${ta.score}`);
        const res = await jupBuy(token.mint, CFG.BUY_SOL);
        if (res.ok) {
          STATE.positions[token.mint] = {
            symbol:      token.symbol,
            buyTime:     Date.now(),
            solSpent:    CFG.BUY_SOL,
            tokenAmount: res.outAmount,
            mcAtBuy:     token.usd_market_cap || 0,
            pairUrl:     token.pairUrl,
            src:         token._src,
          };
          STATE.stats.bought++;
          broadcast(`
✅ *شراء تلقائي!*
━━━━━━━━━━━━━
🪙 *${token.name}* \`${token.symbol}\`
💰 \`${CFG.BUY_SOL} SOL\`
⚡ نقاط: \`${ta.score}/100\`
🎯 TP: \`+${CFG.TAKE_PROFIT}%\`  🛡 SL: \`-${CFG.STOP_LOSS}%\`
🔗 [TX](https://solscan.io/tx/${res.sig})
          `.trim());
        } else {
          broadcast(`⚠️ فشل شراء ${token.symbol}: ${res.err}`);
        }
      } else {
        broadcast(`⚠️ رصيد غير كافٍ (${bal.toFixed(3)} SOL)`);
      }
    }

    await sleep(1000);
  }
}

// ══════════════════════════════════════════════
//  TELEGRAM COMMANDS
// ══════════════════════════════════════════════
const isAdmin = id => CFG.ADMIN_IDS.includes(id);

function broadcast(text, kb) {
  for (const id of CFG.ADMIN_IDS) {
    bot.sendMessage(id, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...(kb ? { reply_markup: kb } : {})
    }).catch(() => {});
  }
}

bot.onText(/\/start$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id, `
🔥 *Ultimate Meme Bot — بدون AI*
⚡ تحليل تقني 100% مجاني
━━━━━━━━━━━━━━━━━
/on — تشغيل البوت
/off — إيقاف البوت
/auto — تداول تلقائي ON/OFF
/scan — فحص يدوي
/wallet — الرصيد
/pos — المراكز المفتوحة
/stats — الإحصائيات
/settings — الإعدادات
/sell SYMBOL — بيع يدوي
/buy 0.05 — تغيير مبلغ الشراء
/tp 100 — هدف الربح
/sl 30 — وقف الخسارة
  `, { parse_mode: "Markdown" });
});

bot.onText(/\/on$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  if (STATE.active) return bot.sendMessage(msg.chat.id, "⚠️ البوت شغّال بالفعل");
  STATE.active = true;
  STATE.scanTimer = setInterval(scan, CFG.SCAN_MS);
  STATE.posTimer  = setInterval(checkPositions, CFG.POS_CHECK_MS);
  bot.sendMessage(msg.chat.id, `
✅ *البوت شغّال!*
📡 يراقب PumpFun + DexScreener
⚡ تحليل تقني — بدون AI
🔄 كل ${CFG.SCAN_MS/1000} ثانية

أرسل /auto لتفعيل الشراء التلقائي
  `, { parse_mode: "Markdown" });
  scan();
});

bot.onText(/\/off$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  STATE.active = false;
  clearInterval(STATE.scanTimer);
  clearInterval(STATE.posTimer);
  bot.sendMessage(msg.chat.id, "⏹ *البوت موقوف*", { parse_mode: "Markdown" });bot.onText(/\/auto$/, msg => {
  if (!isAdmin(msg.chat.id)) return;
  STATE.autoTrade = !STATE.autoTrade;
  const txt = STATE.autoTrade
    ? "التداول التلقائي مفعل - يشتري عند 70 نقطة"
    : "التداول التلقائي موقوف - تنبيهات فقط";
  bot.sendMessage(msg.chat.id, txt);
});
