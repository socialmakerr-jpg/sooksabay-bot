# ตั้งค่า UChat แทน ManyChat (Facebook Messenger)

สมอง Claude เดิมใช้ได้เลย — endpoint: **https://sooksabay-bot.onrender.com/reply**
UChat เป็นแค่ประตูหน้าต่อ Messenger (ไม่ต้องรอ App Review)

## 1) สมัคร UChat + ต่อเพจ
- สมัครที่ https://uchat.com.au (มีแพ็กฟรี / เริ่ม ~$15/เดือน)
- **Add Bot → Facebook Messenger** → ล็อกอิน Facebook → เลือก **เพจสำรอง (107690554516588)** → อนุญาตสิทธิ์

## 2) สร้าง Flow ตอบอัตโนมัติ
- ไปที่ **Automation → Default Reply** (หรือ Main Menu / Welcome ตามต้องการ)
- เพิ่ม **Action step → Advance Actions → External Request**

## 3) ตั้งค่า External Request (เรียกสมอง Claude)
- **Method:** POST
- **URL:** `https://sooksabay-bot.onrender.com/reply`
- **Headers:**
  - `x-secret` = `sooksabay-2ae637efe8321a88003d0f2f`
  - `Content-Type` = `application/json`
- **Body (JSON):**
  ```json
  { "user_id": "{{user id}}", "text": "{{last text input}}" }
  ```
  (เลือกตัวแปร subscriber id กับข้อความล่าสุดจากเมนู UChat)

## 4) เอาคำตอบมาแสดง (Response Mapping)
- ในส่วน **Response Mapping** ของ External Request:
  - map field **`reply`** → เก็บลง custom field เช่น `bot_reply`
- เพิ่ม **Send Message step** ต่อจากนั้น → พิมพ์ `{{bot_reply}}` → บอทจะพูดคำตอบจาก Claude

## 5) เปิดใช้งาน
- ตั้ง trigger **"User sends a message"** → **every time** (สำคัญ! ไม่งั้นตอบครั้งเดียว)
- **Publish / Set Live**
- ปิดออโต้ตอบเดิมของ Meta (Instant reply / keyword) กันตอบชน

## 6) ทดสอบ
- ทักเข้าเพจ → บอทควรตอบจาก Claude
- ไม่ตอบ → บอก Claude เดี๋ยวเช็ก log ให้ (https://sooksabay-bot.onrender.com/leads ดูเบอร์ที่เก็บได้)

---
### หมายเหตุ
- endpoint คืนทั้ง `reply` (ข้อความล้วน — UChat/SendPulse ใช้) และ `content` v2 (ManyChat ใช้) → ใช้ได้ทุกเจ้า
- รูปผลงาน (portfolio) ตอนนี้เทผ่าน ManyChat/LINE ได้เต็ม; บน UChat เริ่มที่ข้อความก่อน รูปค่อยเสริมภายหลัง
- UChat มี Claude ในตัวด้วย แต่เราใช้สมองเราเองดีกว่า (คุมสคริปต์+จับเบอร์+ประวัติได้)
