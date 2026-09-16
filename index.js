// ============================================================
//  สมอง Claude สำหรับ ManyChat (Hybrid)
//  ManyChat เรียก endpoint นี้ -> Claude คิดคำตอบ -> ส่งกลับ
//  ManyChat เป็นคนต่อ Messenger เอง (ไม่ต้องรอ App Review)
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./systemPrompt");

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-opus-5",   // สาย cost เปลี่ยนเป็น claude-sonnet-5 หรือ claude-haiku-4-5
  SHARED_SECRET = "",                   // กันคนอื่นเรียก endpoint (ตั้งเองอะไรก็ได้)
  PUBLIC_BASE_URL = "https://sooksabay-bot.onrender.com", // URL หน้าบ้าน (ใช้ทำลิงก์รูปผลงาน)
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // เสิร์ฟรูปผลงานจากโฟลเดอร์ public/

// เก็บประวัติบทสนทนาต่อผู้ใช้ (in-memory)
const conversations = new Map();
const HISTORY_LIMIT = 20;

// ---- คลังผลงาน (portfolio) ----
// อ่านจาก public/portfolio/manifest.json — เพิ่มรูป = แก้ไฟล์นี้ ไม่ต้องแก้โค้ด
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

// health check
app.get("/", (_req, res) => res.send("Claude brain พร้อมทำงาน ✓"));

// ---- endpoint หลัก: ManyChat จะยิง POST มาที่ /reply ----
// body ที่ ManyChat ส่งมา: { "user_id": "<subscriber id>", "text": "<ข้อความลูกค้า>" }
app.post("/reply", async (req, res) => {
  console.log("📩 /reply hit | body:", JSON.stringify(req.body).slice(0, 200), "| x-secret ok:", req.headers["x-secret"] === SHARED_SECRET);
  // กันคนอื่นเรียก
  if (SHARED_SECRET && req.headers["x-secret"] !== SHARED_SECRET) {
    console.log("⚠️ secret ไม่ตรง — ปฏิเสธ");
    return res.status(401).json({ reply: "unauthorized" });
  }

  const userId = String(req.body.user_id || "anon");
  const text = String(req.body.text || "").trim();
  if (!text) return res.json(mcReply("สวัสดีค่ะ 🙏 มีอะไรให้ช่วยไหมคะ"));

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

  // แปลงคำตอบ -> ข้อความ (+รูปผลงานถ้ามีโค้ด [[PORTFOLIO:xxx]])
  const built = buildMessages(reply);

  history.push({ role: "assistant", content: built.text || reply });
  conversations.set(userId, history.slice(-HISTORY_LIMIT));

  // ถ้าลูกค้าพิมพ์เบอร์มา -> ติดแท็ก "ได้เบอร์แล้ว" ให้ ManyChat หยุดตาม (follow-up)
  const phone = extractPhone(text);
  if (phone) console.log("📞 เจอเบอร์:", phone, "| ติดแท็ก ได้เบอร์แล้ว");

  const content = { messages: built.messages };
  if (phone) content.actions = [{ action: "add_tag", tag_name: "ได้เบอร์แล้ว" }];
  res.json({ version: "v2", content });
});

// สร้างรายการข้อความสำหรับ ManyChat — แทนโค้ด [[PORTFOLIO:หมวด]] ด้วยรูปผลงานจริง
function buildMessages(reply) {
  const imageMsgs = [];
  const sent = new Set();
  const text = String(reply)
    .replace(/\[\[PORTFOLIO:([a-zA-Z0-9_-]+)\]\]/g, (_m, cat) => {
      const c = PORTFOLIO[cat];
      if (c && Array.isArray(c.items) && c.items.length && !sent.has(cat)) {
        sent.add(cat);
        for (const it of c.items) {
          const url = /^https?:\/\//.test(it.url) ? it.url : PUBLIC_BASE_URL + it.url;
          imageMsgs.push({ type: "image", url });
          if (it.caption) imageMsgs.push({ type: "text", text: it.caption });
        }
      }
      return ""; // ลบโค้ดออก ลูกค้าจะไม่เห็น
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ type: "text", text });
  messages.push(...imageMsgs);
  return {
    messages: messages.length ? messages : [{ type: "text", text: String(reply) }],
    text,
  };
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

// ดึงเบอร์โทรไทยจากข้อความ (มือถือ 10 หลัก / บ้าน 9 หลัก, มี - หรือเว้นวรรคได้)
function extractPhone(text) {
  const cleaned = String(text).replace(/[\s\-().]/g, "");
  const m = cleaned.match(/0\d{8,9}(?!\d)/);
  return m ? m[0] : null;
}

// รูปแบบที่ ManyChat "Dynamic block" เข้าใจ (ส่งข้อความให้ลูกค้าตรง ๆ ไม่ต้อง response mapping)
// actions = สั่งงาน ManyChat เพิ่ม เช่น ติดแท็ก (ถ้าไม่ส่งก็ไม่ใส่ = ปลอดภัยกับข้อความปกติ)
function mcReply(text, actions) {
  const content = { messages: [{ type: "text", text }] };
  if (actions && actions.length) content.actions = actions;
  return { version: "v2", content };
}

app.listen(PORT, () =>
  console.log("🧠 Claude brain (hybrid) ทำงานที่ port", PORT, "| model:", ANTHROPIC_MODEL)
);
