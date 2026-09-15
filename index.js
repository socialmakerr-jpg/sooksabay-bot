// ============================================================
//  สมอง Claude สำหรับ ManyChat (Hybrid)
//  ManyChat เรียก endpoint นี้ -> Claude คิดคำตอบ -> ส่งกลับ
//  ManyChat เป็นคนต่อ Messenger เอง (ไม่ต้องรอ App Review)
// ============================================================

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./systemPrompt");

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-opus-5",   // สาย cost เปลี่ยนเป็น claude-sonnet-5 หรือ claude-haiku-4-5
  SHARED_SECRET = "",                   // กันคนอื่นเรียก endpoint (ตั้งเองอะไรก็ได้)
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());

// เก็บประวัติบทสนทนาต่อผู้ใช้ (in-memory)
const conversations = new Map();
const HISTORY_LIMIT = 20;

// health check
app.get("/", (_req, res) => res.send("Claude brain พร้อมทำงาน ✓"));

// ---- endpoint หลัก: ManyChat จะยิง POST มาที่ /reply ----
// body ที่ ManyChat ส่งมา: { "user_id": "<subscriber id>", "text": "<ข้อความลูกค้า>" }
// ตอบกลับ: { "reply": "<คำตอบ>" }
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
      system: SYSTEM_PROMPT,
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

  history.push({ role: "assistant", content: reply });
  conversations.set(userId, history.slice(-HISTORY_LIMIT));

  res.json(mcReply(reply));
});

// รูปแบบที่ ManyChat "Dynamic block" เข้าใจ (ส่งข้อความให้ลูกค้าตรง ๆ ไม่ต้อง response mapping)
function mcReply(text) {
  return { version: "v2", content: { messages: [{ type: "text", text }] } };
}

app.listen(PORT, () =>
  console.log("🧠 Claude brain (hybrid) ทำงานที่ port", PORT, "| model:", ANTHROPIC_MODEL)
);
