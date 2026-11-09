// ============================================================
//  สมอง Claude — รองรับหลายช่องทาง (สมองเดียว ต่อได้หลายประตู)
//   • /reply        = ManyChat / UChat / SendPulse (external request)
//   • /line/webhook = LINE Official Account (Messaging API) ต่อตรง
//  ManyChat/LINE เป็นแค่ "ประตูหน้า" ต่อ Messenger/LINE
//  คำตอบทั้งหมดมาจาก Claude (สคริปต์เดียวกัน = บอทตอบเหมือนกันทุกช่องทาง)
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./systemPrompt");

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-opus-5",   // สาย cost เปลี่ยนเป็น claude-sonnet-5 หรือ claude-haiku-4-5
  SHARED_SECRET = "",                   // กันคนอื่นเรียก /reply
  PUBLIC_BASE_URL = "https://sooksabay-bot.onrender.com", // ใช้ทำลิงก์รูปผลงาน
  LINE_CHANNEL_ACCESS_TOKEN = "",       // จาก LINE Developers (Messaging API)
  LINE_CHANNEL_SECRET = "",             // จาก LINE Developers (ใช้ตรวจลายเซ็น)
  // ---- Facebook Messenger (ต่อตรง ไม่ผ่าน UChat) ----
  FB_PAGE_ACCESS_TOKEN = "",            // Page access token ของเพจ (ใช้ส่งข้อความ)
  FB_VERIFY_TOKEN = "sooksabay_verify", // ใช้ยืนยันตอนตั้ง webhook ในหน้า Developer
  FB_APP_SECRET = "",                   // App Secret (ตรวจลายเซ็น X-Hub-Signature-256)
  FB_API_VERSION = "v21.0",             // เวอร์ชัน Graph API
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
// เก็บ raw body ไว้ตรวจลายเซ็นของ LINE (HMAC-SHA256)
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public"))); // เสิร์ฟรูปผลงานจาก public/

// เก็บประวัติบทสนทนาต่อผู้ใช้ (in-memory)
const conversations = new Map();
const leads = [];                    // เบอร์ที่เก็บได้ (ไว้ให้เซลล์ดู /leads)
const HISTORY_LIMIT = 20;

// ---- คลังผลงาน (portfolio) ----
let PORTFOLIO = {};
function loadPortfolio() {
  try {
    PORTFOLIO = JSON.parse(
      fs.readFileSync(path.join(__dirname, "public/portfolio/manifest.json"), "utf8")
    );
  } catch {
    PORTFOLIO = {};
  }
}
loadPortfolio();

// health check + ดูรายชื่อ lead
app.get("/", (_req, res) => res.send("Claude brain พร้อมทำงาน ✓ (ManyChat + LINE + Facebook)"));
app.get("/leads", (_req, res) => res.json({ count: leads.length, leads }));

// ============================================================
//  สมองกลาง: ให้ Claude คิดคำตอบ (ใช้ร่วมกันทุกช่องทาง)
// ============================================================
// เรียก Claude พร้อม "ลองใหม่อัตโนมัติ" ถ้าสะดุด (กันลูกค้าเจอข้อความ error)
// - ลองสูงสุด 2 ครั้ง, แต่ละครั้งรอไม่เกิน 9 วิ (กันค้างจน UChat หมดเวลา ~14 วิ)
async function callClaudeText(messages) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await anthropic.messages.create(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: 500,
          system: SYSTEM_PROMPT + portfolioInstructions(),
          messages,
        },
        { timeout: 9000, maxRetries: 0 }
      );
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (text) return text;
      lastErr = new Error("empty reply");
    } catch (e) {
      lastErr = e;
      console.error(`Claude error (ครั้งที่ ${attempt}):`, e.message);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
  }
  throw lastErr;
}

async function generateReply(userId, text) {
  const history = conversations.get(userId) || [];
  history.push({ role: "user", content: text });

  // ถ้าสะดุดจริง ๆ ให้พูดแบบธรรมชาติชวนคุยต่อ — ห้ามบอกลูกค้าว่า "ระบบขัดข้อง" เด็ดขาด
  let reply =
    "สวัสดีค่ะลูกค้า 😊 ขอบคุณที่ทักเข้ามานะคะ รบกวนเล่าให้ฟังหน่อยได้ไหมคะว่าลูกค้าสนใจเรื่องไหน เดี๋ยวช่วยดูให้ค่ะ";
  try {
    reply = await callClaudeText(history);
  } catch (e) {
    console.error("Claude error (ใช้ข้อความสำรองแบบเนียน):", e.message);
  }

  history.push({ role: "assistant", content: stripMarkers(reply) });
  conversations.set(userId, history.slice(-HISTORY_LIMIT));
  return reply; // ยังมีโค้ด [[PORTFOLIO:..]] อยู่ ให้ตัวสร้างข้อความของแต่ละช่องทางจัดการ
}

// ให้ Claude คิด "ประโยคทักกลับ" เองตามบริบท (ตอนลูกค้าเงียบ)
async function generateFollowup(userId) {
  const history = conversations.get(userId) || [];
  const nudge = {
    role: "user",
    content:
      "(ข้อความระบบภายใน ไม่ใช่จากลูกค้า: ลูกค้าเงียบหายไปพักหนึ่งแล้ว ช่วยทักกลับไปหาลูกค้าสั้น ๆ สุภาพ 1-2 ประโยคตามบริบทที่คุยกันมา เพื่อชวนคุยต่อและขอเบอร์อย่างสุภาพ ห้ามทักซ้ำซาก/ใช้ประโยคเดิม)",
  };
  let reply = "ลูกค้าคะ 🙏 รบกวนขอเบอร์ติดต่อกลับได้ไหมคะ เดี๋ยวทีมงานโทรไปให้ข้อมูลและเล่ารายละเอียดให้ฟังค่ะ";
  try {
    reply = await callClaudeText([...history, nudge]);
  } catch (e) {
    console.error("Followup error (ใช้ข้อความสำรอง):", e.message);
  }
  history.push({ role: "assistant", content: stripMarkers(reply) });
  conversations.set(userId, history.slice(-HISTORY_LIMIT));
  return reply;
}

// ============================================================
//  ช่องทาง 1: ManyChat / UChat / SendPulse  (POST /reply)
// ============================================================
app.post("/reply", async (req, res) => {
  console.log("📩 /reply hit | body:", JSON.stringify(req.body).slice(0, 200), "| x-secret ok:", req.headers["x-secret"] === SHARED_SECRET);
  if (SHARED_SECRET && req.headers["x-secret"] !== SHARED_SECRET) {
    console.log("⚠️ secret ไม่ตรง — ปฏิเสธ");
    return res.status(401).json({ reply: "unauthorized" });
  }

  const userId = String(req.body.user_id || "anon");
  const text = String(req.body.text || "").trim();
  if (!text) return res.json(mcReply("สวัสดีค่ะ 🙏 มีอะไรให้ช่วยไหมคะ"));

  // โหมด follow-up: ลูกค้าเงียบไป -> ให้ Claude คิดประโยคทักกลับเองตามบริบท
  if (text === "__FOLLOWUP__") {
    const fr = await generateFollowup(userId);
    const fb = buildMessages(fr);
    return res.json({ version: "v2", reply: fb.text || stripMarkers(fr), content: { messages: fb.messages } });
  }

  const reply = await generateReply(userId, text);
  const built = buildMessages(reply);

  const phone = extractPhone(text);
  if (phone) {
    console.log("📞 เจอเบอร์:", phone, "| ติดแท็ก ได้เบอร์แล้ว");
    if (!leads.find((l) => l.userId === userId && l.phone === phone))
      leads.push({ channel: "manychat", userId, phone, time: new Date().toISOString() });
  }

  const content = { messages: built.messages };
  if (phone) content.actions = [{ action: "add_tag", tag_name: "ได้เบอร์แล้ว" }];
  // version/content = ManyChat อ่าน | reply = UChat/SendPulse เอาไป map เป็นข้อความง่าย ๆ
  res.json({ version: "v2", reply: built.text || stripMarkers(reply), content });
});

// ============================================================
//  ช่องทาง 2: LINE Official Account  (POST /line/webhook)
// ============================================================
app.post("/line/webhook", (req, res) => {
  // ตรวจลายเซ็นจาก LINE (กันคนปลอมยิงเข้ามา)
  if (LINE_CHANNEL_SECRET) {
    const sig = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("base64");
    if (sig !== req.headers["x-line-signature"]) {
      console.log("⚠️ LINE signature ไม่ตรง — ปฏิเสธ");
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // ตอบ LINE ทันที แล้วค่อยประมวลผลเบื้องหลัง

  for (const ev of req.body.events || []) {
    if (ev.type === "message" && ev.message?.type === "text") {
      handleLine(ev).catch((e) => console.error("LINE handle error:", e.message));
    }
  }
});

async function handleLine(ev) {
  const userId = "line:" + (ev.source?.userId || "anon");
  const text = String(ev.message.text || "").trim();
  console.log("💚 LINE | msg:", text.slice(0, 80));
  if (!text) return;

  const reply = await generateReply(userId, text);

  const phone = extractPhone(text);
  if (phone) {
    console.log("📞 LINE เจอเบอร์:", phone);
    if (!leads.find((l) => l.userId === userId && l.phone === phone))
      leads.push({ channel: "line", userId, phone, time: new Date().toISOString() });
  }

  const messages = buildLineMessages(reply);
  await lineReply(ev.replyToken, messages);
}

// ตอบกลับผ่าน LINE Reply API (ฟรี ภายในกรอบ replyToken)
async function lineReply(replyToken, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("! ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN — ข้ามการตอบ (รอเสียบ token)");
    return;
  }
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }), // LINE ตอบได้สูงสุด 5 ข้อความ/ครั้ง
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("LINE reply error:", r.status, t.slice(0, 200));
    }
  } catch (e) {
    console.error("lineReply error:", e.message);
  }
}

// ============================================================
//  ช่องทาง 3: Facebook Messenger  (GET/POST /fb/webhook)  — ต่อตรง ไม่ผ่าน UChat
// ============================================================

// 3.1 ยืนยัน webhook ตอนตั้งค่าในหน้า Facebook Developer
app.get("/fb/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("✅ FB webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("⚠️ FB webhook verify ไม่ผ่าน (verify token ไม่ตรง)");
  return res.sendStatus(403);
});

// 3.2 รับข้อความ/ปุ่มกด จากลูกค้า
app.post("/fb/webhook", (req, res) => {
  // ตรวจลายเซ็นจาก Facebook (กันคนปลอมยิงเข้ามา) — ต้องตั้ง FB_APP_SECRET ก่อน
  if (FB_APP_SECRET) {
    const sig = req.headers["x-hub-signature-256"] || "";
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", FB_APP_SECRET).update(req.rawBody || Buffer.from("")).digest("hex");
    if (!safeEqual(sig, expected)) {
      console.log("⚠️ FB signature ไม่ตรง — ปฏิเสธ");
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // ตอบ Facebook ทันที แล้วค่อยคิดคำตอบเบื้องหลัง (ไม่มี timeout 14 วิแล้ว)

  if (req.body.object !== "page") return;
  for (const entry of req.body.entry || []) {
    for (const ev of entry.messaging || []) {
      handleFacebook(ev).catch((e) => console.error("FB handle error:", e.message));
    }
  }
});

async function handleFacebook(ev) {
  const senderId = ev.sender?.id;
  if (!senderId) return;
  // ข้าม echo (ข้อความที่เพจส่งเอง), delivery/read receipts
  if (ev.message?.is_echo || ev.delivery || ev.read) return;

  let text = "";
  if (ev.message?.text) text = String(ev.message.text).trim();
  else if (ev.postback) text = String(ev.postback.payload || ev.postback.title || "").trim(); // ลูกค้ากดปุ่มจากแอด
  const userId = "fb:" + senderId;
  if (!text) text = "(ลูกค้าส่งรูป/สติกเกอร์เข้ามาโดยไม่มีข้อความ)";
  console.log("📘 FB | msg:", text.slice(0, 80));

  clearFollowup(userId);                 // ลูกค้าตอบแล้ว ยกเลิกตัวทักกลับเดิม
  fbSenderAction(senderId, "mark_seen"); // อ่านแล้ว + กำลังพิมพ์ (ดูเป็นคนจริง)
  fbSenderAction(senderId, "typing_on");

  const reply = await generateReply(userId, text);

  const phone = extractPhone(text);
  if (phone) {
    console.log("📞 FB เจอเบอร์:", phone);
    if (!leads.find((l) => l.userId === userId && l.phone === phone))
      leads.push({ channel: "facebook", userId, phone, time: new Date().toISOString() });
  }

  const messages = buildFbMessages(reply);
  for (const m of messages) await fbSend(senderId, m);

  // ยังไม่ได้เบอร์ -> ตั้งเวลา 5 นาที ถ้าลูกค้าเงียบ บอทจะทักกลับเอง (เซิร์ฟเวอร์จับเวลาเอง)
  if (!phone) scheduleFollowup(userId, senderId);
}

// ส่งข้อความผ่าน Messenger Send API (ใช้ Page access token)
async function fbSend(recipientId, message) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.log("! ยังไม่ได้ตั้ง FB_PAGE_ACCESS_TOKEN — ข้ามการส่ง (รอเสียบ token)");
    return;
  }
  try {
    const r = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}` },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("FB send error:", r.status, t.slice(0, 300));
    }
  } catch (e) {
    console.error("fbSend error:", e.message);
  }
}

// แสดง "อ่านแล้ว" / "กำลังพิมพ์" (ไม่สำคัญถ้าพลาดก็ข้าม)
async function fbSenderAction(recipientId, action) {
  if (!FB_PAGE_ACCESS_TOKEN) return;
  try {
    await fetch(`https://graph.facebook.com/${FB_API_VERSION}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}` },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
    });
  } catch {}
}

// ---- สร้างข้อความสำหรับ Facebook Messenger (ข้อความ + รูปผลงาน) ----
function buildFbMessages(reply) {
  const media = [];
  const sent = new Set();
  const text = String(reply)
    .replace(/\[\[PORTFOLIO:([a-zA-Z0-9_-]+)\]\]/g, (_m, cat) => {
      const c = PORTFOLIO[cat];
      if (c && Array.isArray(c.items) && c.items.length && !sent.has(cat)) {
        sent.add(cat);
        for (const it of c.items) {
          if (it.caption) media.push({ text: it.caption });
          if (it.url) {
            const url = /^https?:\/\//.test(it.url) ? it.url : PUBLIC_BASE_URL + it.url;
            media.push({ attachment: { type: "image", payload: { url, is_reusable: true } } });
          }
          if (it.video) media.push({ text: it.video });
        }
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ text });
  messages.push(...media);
  return messages.length ? messages : [{ text: String(reply) }];
}

// ---- ตัวจับเวลา "ทักกลับเมื่อลูกค้าเงียบ 5 นาที" (เซิร์ฟเวอร์ทำเอง ไม่พึ่ง UChat) ----
const followupTimers = new Map();
const FOLLOWUP_DELAY_MS = 5 * 60 * 1000;
function clearFollowup(userId) {
  const t = followupTimers.get(userId);
  if (t) { clearTimeout(t); followupTimers.delete(userId); }
}
function scheduleFollowup(userId, senderId) {
  clearFollowup(userId);
  const t = setTimeout(async () => {
    followupTimers.delete(userId);
    try {
      const reply = await generateFollowup(userId);
      const messages = buildFbMessages(reply);
      for (const m of messages) await fbSend(senderId, m);
      console.log("⏰ FB followup ส่งแล้ว:", userId);
    } catch (e) {
      console.error("FB followup error:", e.message);
    }
  }, FOLLOWUP_DELAY_MS);
  if (t.unref) t.unref();
  followupTimers.set(userId, t);
}

// เทียบสตริงแบบกันจับเวลา (ใช้ตรวจลายเซ็น)
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ============================================================
//  ตัวช่วย
// ============================================================

// ตัดโค้ด [[PORTFOLIO:..]] ออก (ใช้เก็บลงประวัติให้สะอาด)
function stripMarkers(reply) {
  return String(reply)
    .replace(/\[\[PORTFOLIO:[a-zA-Z0-9_-]+\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- สร้างข้อความสำหรับ ManyChat (v2) ----
function buildMessages(reply) {
  const mediaMsgs = [];
  const sent = new Set();
  const text = String(reply)
    .replace(/\[\[PORTFOLIO:([a-zA-Z0-9_-]+)\]\]/g, (_m, cat) => {
      const c = PORTFOLIO[cat];
      if (c && Array.isArray(c.items) && c.items.length && !sent.has(cat)) {
        sent.add(cat);
        for (const it of c.items) {
          if (it.caption) mediaMsgs.push({ type: "text", text: it.caption });
          if (it.url) {
            const url = /^https?:\/\//.test(it.url) ? it.url : PUBLIC_BASE_URL + it.url;
            mediaMsgs.push({ type: "image", url });
          }
          if (it.video) mediaMsgs.push({ type: "text", text: it.video });
        }
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ type: "text", text });
  messages.push(...mediaMsgs);
  return {
    messages: messages.length ? messages : [{ type: "text", text: String(reply) }],
    text,
  };
}

// ---- สร้างข้อความสำหรับ LINE ----
function buildLineMessages(reply) {
  const media = [];
  const sent = new Set();
  const text = String(reply)
    .replace(/\[\[PORTFOLIO:([a-zA-Z0-9_-]+)\]\]/g, (_m, cat) => {
      const c = PORTFOLIO[cat];
      if (c && Array.isArray(c.items) && c.items.length && !sent.has(cat)) {
        sent.add(cat);
        for (const it of c.items) {
          if (it.caption) media.push({ type: "text", text: it.caption });
          if (it.url) {
            const url = /^https?:\/\//.test(it.url) ? it.url : PUBLIC_BASE_URL + it.url;
            media.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
          }
          if (it.video) media.push({ type: "text", text: it.video });
        }
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ type: "text", text });
  messages.push(...media);
  return messages.length ? messages : [{ type: "text", text: String(reply) }];
}

// บอก Claude ว่ามีคลังผลงานหมวดไหนบ้าง (เฉพาะหมวดที่มีรูปจริงแล้ว)
function portfolioInstructions() {
  const cats = Object.entries(PORTFOLIO).filter(
    ([, v]) => Array.isArray(v.items) && v.items.length
  );
  if (!cats.length) return "";
  const list = cats.map(([k, v]) => `- ${v.label} → ใส่ [[PORTFOLIO:${k}]]`).join("\n");
  return `

# คลังผลงาน (ส่งรูปให้ลูกค้าได้จริง)
ถ้าลูกค้าขอ "ดูผลงาน / ตัวอย่างงาน / แบนเนอร์" ให้ใส่โค้ดพิเศษนี้ในคำตอบ ระบบจะแนบรูปให้อัตโนมัติ:
${list}
- ใส่โค้ดต่อท้ายประโยคได้เลย เช่น "ได้เลยค่ะ นี่ตัวอย่างผลงานของเรานะคะ [[PORTFOLIO:car]]"
- ลูกค้าจะไม่เห็นโค้ด เห็นแค่รูป — ส่งเฉพาะหมวดที่ลูกค้าขอเท่านั้น
- ถ้าลูกค้าขอหมวดที่ยังไม่มีในคลัง อย่าแต่งโค้ดมั่ว ให้บอกว่าเดี๋ยวทีมงานส่งตัวอย่างให้ทางโทร แล้วขอเบอร์
- หลังส่งผลงานแล้ว พาต่อไปที่ขอเบอร์เสมอ`;
}

// ดึงเบอร์โทรไทยจากข้อความ
function extractPhone(text) {
  const cleaned = String(text).replace(/[\s\-().]/g, "");
  const m = cleaned.match(/0\d{8,9}(?!\d)/);
  return m ? m[0] : null;
}

// รูปแบบข้อความ ManyChat v2 (ข้อความเดียว)
function mcReply(text, actions) {
  const content = { messages: [{ type: "text", text }] };
  if (actions && actions.length) content.actions = actions;
  return { version: "v2", content };
}

app.listen(PORT, () =>
  console.log(
    "🧠 Claude brain ทำงานที่ port", PORT,
    "| model:", ANTHROPIC_MODEL,
    "| LINE:", LINE_CHANNEL_ACCESS_TOKEN ? "พร้อม" : "รอ token",
    "| Facebook:", FB_PAGE_ACCESS_TOKEN ? "พร้อม" : "รอ token"
  )
);
