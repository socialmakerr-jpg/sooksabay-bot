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
app.get("/", (_req, res) => res.send("Claude brain พร้อมทำงาน ✓ (ManyChat + LINE)"));
app.get("/leads", (_req, res) => res.json({ count: leads.length, leads }));

// ============================================================
//  สมองกลาง: ให้ Claude คิดคำตอบ (ใช้ร่วมกันทุกช่องทาง)
// ============================================================
async function generateReply(userId, text) {
  const history = conversations.get(userId) || [];
  history.push({ role: "user", content: text });

  let reply = "ขอโทษค่ะ ระบบขัดข้องนิดนึง เดี๋ยวทีมงานติดต่อกลับนะคะ 🙏";
  try {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT + portfolioInstructions(),
      messages: history,
    });
    reply =
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim() || reply;
  } catch (e) {
    console.error("Claude error:", e.message);
  }

  history.push({ role: "assistant", content: stripMarkers(reply) });
  conversations.set(userId, history.slice(-HISTORY_LIMIT));
  return reply; // ยังมีโค้ด [[PORTFOLIO:..]] อยู่ ให้ตัวสร้างข้อความของแต่ละช่องทางจัดการ
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
  res.json({ version: "v2", content });
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
  console.log("🧠 Claude brain ทำงานที่ port", PORT, "| model:", ANTHROPIC_MODEL, "| LINE:", LINE_CHANNEL_ACCESS_TOKEN ? "พร้อม" : "รอ token")
);
