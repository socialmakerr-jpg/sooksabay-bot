// ============================================================
//  Sooksabay Messenger Bot
//  รับข้อความจาก Messenger -> ให้ Claude คิดคำตอบ -> ตอบกลับ
//  ตรวจจับเบอร์โทร -> บันทึกเป็น Lead ให้เซลล์โทรตาม
// ============================================================

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./systemPrompt");

const {
  PORT = 3000,
  VERIFY_TOKEN,                       // ตั้งเองอะไรก็ได้ ใช้ตอนเชื่อม webhook
  PAGE_TOKEN,                         // System User token (มี pages_messaging)
  PAGE_ID = "107690554516588",       // เพจสำรอง
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-opus-5",  // ฉลาดสุด. สาย cost เปลี่ยนเป็น claude-sonnet-5 หรือ claude-haiku-4-5
  GRAPH_VERSION = "v21.0",
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());

// ---- เก็บประวัติบทสนทนาต่อผู้ใช้ (in-memory; รีสตาร์ทแล้วหาย — เวอร์ชันหน้าค่อยต่อ DB) ----
const conversations = new Map();     // psid -> [{role, content}, ...]
const leads = [];                    // รายการเบอร์ที่เก็บได้
const HISTORY_LIMIT = 20;

const phoneRegex = /(0\d[\d\s-]{7,12}\d)/;   // เบอร์ไทยแบบหลวม ๆ

// ---------- หา Page Access Token จาก token ที่ให้มา ----------
let pageAccessToken = PAGE_TOKEN;
async function resolvePageToken() {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,access_token&access_token=${encodeURIComponent(PAGE_TOKEN)}`
    );
    const d = await r.json();
    const page = d.data?.find((p) => p.id === PAGE_ID);
    if (page?.access_token) {
      pageAccessToken = page.access_token;
      console.log("✓ ได้ Page Access Token ของเพจ", PAGE_ID);
    } else {
      console.log("! ใช้ token เดิม (ไม่พบ page ใน /me/accounts) — ปกติถ้าเป็น page token อยู่แล้ว");
    }
  } catch (e) {
    console.log("! resolvePageToken error, ใช้ token เดิม:", e.message);
  }
}

// ---------- Webhook verification (Facebook เรียกตอนเชื่อม) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✓ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- รับข้อความเข้า ----------
app.post("/webhook", (req, res) => {
  if (req.body.object !== "page") return res.sendStatus(404);
  res.sendStatus(200); // ตอบ Facebook ทันที แล้วค่อยประมวลผลเบื้องหลัง
  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message && event.message.text && !event.message.is_echo) {
        handleMessage(event.sender.id, event.message.text).catch((e) =>
          console.error("handleMessage error:", e)
        );
      }
    }
  }
});

// ---------- ประมวลผล 1 ข้อความ ----------
async function handleMessage(psid, text) {
  const history = conversations.get(psid) || [];
  history.push({ role: "user", content: text });

  // ตรวจจับเบอร์โทร -> บันทึก Lead
  const m = text.match(phoneRegex);
  if (m) {
    const phone = m[1].replace(/[\s-]/g, "");
    if (!leads.find((l) => l.psid === psid && l.phone === phone)) {
      leads.push({ psid, phone, time: new Date().toISOString() });
      console.log("📲 LEAD ใหม่:", phone, "(psid", psid + ")");
    }
  }

  // ให้ Claude คิดคำตอบ
  let reply = "ขอโทษค่ะ ระบบขัดข้องนิดนึง เดี๋ยวทีมงานติดต่อกลับนะคะ 🙏";
  try {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    reply = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim() || reply;
  } catch (e) {
    console.error("Claude error:", e.message);
  }

  history.push({ role: "assistant", content: reply });
  conversations.set(psid, history.slice(-HISTORY_LIMIT));

  await sendMessage(psid, reply);
}

// ---------- ส่งข้อความกลับผ่าน Send API ----------
async function sendMessage(psid, text) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: "RESPONSE",
          message: { text },
        }),
      }
    );
    const d = await r.json();
    if (d.error) console.error("Send API error:", d.error.message);
  } catch (e) {
    console.error("sendMessage error:", e.message);
  }
}

// ---------- หน้าเช็คสถานะ + ดูรายชื่อ Lead ----------
app.get("/", (_req, res) => res.send("Sooksabay bot กำลังทำงาน ✓"));
app.get("/leads", (_req, res) => res.json({ count: leads.length, leads }));

app.listen(PORT, async () => {
  console.log("🚀 Sooksabay bot ทำงานที่ port", PORT, "| model:", ANTHROPIC_MODEL);
  if (PAGE_TOKEN) await resolvePageToken();
});
