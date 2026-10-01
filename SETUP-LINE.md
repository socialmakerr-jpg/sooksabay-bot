# ตั้งค่า LINE ให้บอทตอบ (เช็คลิสต์)

สมอง Claude ต่อ LINE พร้อมแล้ว — Webhook URL: **https://sooksabay-bot.onrender.com/line/webhook**
เหลือแค่ขั้นตอนฝั่ง LINE (ทำครั้งเดียว) แล้วส่ง token ให้ Claude เสียบ env

## 1) มี LINE Official Account (OA)
- ยังไม่มี → สร้างฟรีที่ https://manager.line.biz (Create / สร้างบัญชี)
- มีแล้ว → ใช้ตัวเดิมได้เลย

## 2) เปิด Messaging API ให้ OA
- เข้า **LINE OA Manager** → **Settings (ตั้งค่า)** → **Messaging API**
- กด **Enable / Use Messaging API** → เลือก/สร้าง Provider (ชื่ออะไรก็ได้ เช่น Sooksabay)

## 3) เอา credential 2 ตัว (จาก LINE Developers Console → https://developers.line.biz)
เปิด channel ของ OA นี้:
- **Channel secret** — แท็บ *Basic settings*
- **Channel access token (long-lived)** — แท็บ *Messaging API* → กด **Issue**

## 4) ตั้ง Webhook (แท็บ Messaging API)
- **Webhook URL:** `https://sooksabay-bot.onrender.com/line/webhook`
- เปิด **Use webhook = ON**
- กด **Verify** (ต้องขึ้น Success — เพราะ endpoint เรา live แล้ว)

## 5) ปิดออโต้ตอบเดิมของ LINE (กันตอบชนบอท)
- LINE OA Manager → **Settings → Response settings**
- **Response mode = Bot** (หรือเปิด Webhook)
- **Auto-response messages = OFF**, **Greeting message** ปิดหรือปรับตามต้องการ

## 6) ส่ง credential ให้ Claude
ส่ง **Channel secret** + **Channel access token** ให้ Claude
→ Claude จะตั้งเป็น env (LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN) บน Render + redeploy
→ ทดสอบทักเข้า LINE OA → บอทตอบเลย 🎉

---
### หมายเหตุ
- ตอบลูกค้าที่ทักเข้ามา (reply) = ฟรีไม่จำกัด / ข้อความ push (ทักก่อน/บรอดแคสต์) มีโควตาฟรีรายเดือนแล้วค่อยเสียเงิน
- รันคู่กับ Messenger ได้ สมองตัวเดียวตอบทั้งสองช่องทาง
- ดูรายชื่อเบอร์ที่บอทเก็บได้: https://sooksabay-bot.onrender.com/leads
