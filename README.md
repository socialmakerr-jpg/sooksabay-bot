# Sooksabay Messenger Bot 🤖

บอทตอบแชต Messenger ของเพจ Sooksabay Online — คุยเป็นธรรมชาติเหมือนคนจริง
เก็บเบอร์ลูกค้า ส่งให้ทีมเซลล์โทรปิดการขาย

---

## 📁 มีอะไรบ้าง
- `server.js` — ตัวบอท (รับข้อความ → ให้ Claude คิดคำตอบ → ตอบกลับ → เก็บเบอร์)
- `systemPrompt.js` — **บทคุย/บุคลิกของบอท** (แก้ในนี้ = เปลี่ยนวิธีคุยได้ทันที)
- `.env.example` — รายการค่าที่ต้องตั้ง
- `render.yaml` — ตั้งค่า deploy บน Render
- `privacy-policy.html` — หน้านโยบายความเป็นส่วนตัว (Meta บังคับตอนส่ง App Review)

---

## 🚀 ขั้นตอนเปิดใช้งาน (ทำครั้งเดียว)

### 1) เตรียมค่า
- **ANTHROPIC_API_KEY**: console.anthropic.com → API Keys → Create (ขึ้นต้น `sk-ant-...`)
- **PAGE_TOKEN**: System User token ที่สร้างไว้ (มี pages_messaging)
- **VERIFY_TOKEN**: ตั้งเองอะไรก็ได้ เช่น `sooksabay_verify_123`

### 2) Deploy บน Render
1. เอาโค้ดขึ้น GitHub (repo ใหม่)
2. Render → New → Web Service → เลือก repo
3. ใส่ Environment Variables ตาม `.env.example`
4. Deploy → จะได้ลิงก์ เช่น `https://sooksabay-bot.onrender.com`

### 3) เชื่อม Webhook กับ Facebook App "ตอบแชท"
1. developers.facebook.com → แอป "ตอบแชท" → Messenger → Settings
2. Webhooks → Add Callback URL:
   - Callback URL: `https://<ลิงก์ Render>/webhook`
   - Verify Token: (ค่า VERIFY_TOKEN ที่ตั้ง)
3. Subscribe fields: `messages`, `messaging_postbacks`
4. เลือกเพจ "Sooksabay Online ดูแลการตลาด…" → Subscribe

### 4) เทสต์ (โหมดพัฒนา — ได้เฉพาะแอดมิน/ทีมทดสอบ)
ทักเพจจากบัญชีแอดมิน → บอทควรตอบ ✓
ดูรายชื่อเบอร์ที่เก็บได้: `https://<ลิงก์ Render>/leads`

---

## 📋 ส่ง App Review (เพื่อให้ตอบลูกค้าจริง)
1. เอา `privacy-policy.html` ขึ้นเว็บ (เช่นเสิร์ฟจากบอทเอง หรือเว็บบริษัท) → ได้ URL
2. developers.facebook.com → แอป "ตอบแชท" → App Review → Permissions
3. ขอสิทธิ์ `pages_messaging` → ใส่คำอธิบาย + วิดีโอสาธิต + Privacy Policy URL
4. ยืนยันธุรกิจ (Business Verification) ของ MacaLive ถ้ายังไม่เคยทำ
5. Submit → รอ Meta 2-7 วัน → อนุมัติ → เปิดแอปเป็น **Live** → บอทตอบลูกค้าจริง 24 ชม. 🎉

---

## ✏️ แก้บทคุยของบอท
เปิด `systemPrompt.js` แล้วแก้ข้อความ → deploy ใหม่ → บอทเปลี่ยนวิธีคุยทันที

## ⚙️ เปลี่ยนโมเดล (คุมค่าใช้จ่าย)
ตั้ง `ANTHROPIC_MODEL`:
- `claude-opus-5` — ฉลาดสุด (แพงสุด)
- `claude-sonnet-5` — สมดุล
- `claude-haiku-4-5` — ถูก+เร็ว (เหมาะกับแชตทั่วไป)
