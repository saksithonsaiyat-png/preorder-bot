# คู่มือการติดตั้งและรัน Preorder Bot บน Rukcom Hosting

เอกสารฉบับนี้อธิบายขั้นตอนการนำระบบ **Preorder Bot** ขึ้นรันบนโฮสติ้งของ **Rukcom (รักคอม)** ไม่ว่าจะใช้งานในรูปแบบ **cPanel / Web Hosting (Shared)** หรือ **Rukcom Cloud / VPS (Dedicated)**

---

## 🚀 จุดเด่นของระบบดึงข้อมูล (Multi-tier Scraper Engine)

บอทถูกออกแบบด้วยสถาปัตยกรรม **Multi-tier Scraper Engine** รองรับการทำงานทุกสภาพแวดล้อม:
1. **Cheerio HTML/CSS DOM Engine (ทำงานอัตโนมัติบน Shared Hosting / cPanel)**
   - อ่านและวิเคราะห์โครงสร้าง HTML หน้าบ้าน (`<table>`, `<tr>`, `<td>`, `.badge`, `.card`, `data-*` attributes) โดยตรงผ่าน HTTP Request
   - ใช้ทรัพยากร RAM/CPU ต่ำมาก (ไม่เกิน 50-100MB)
   - ไม่ต้องติดตั้ง Google Chrome หรือ Root packages เพิ่มเติม รันผ่าน cPanel Node.js App ได้ 100%
2. **Puppeteer Headless Browser Engine (สำหรับ Rukcom VPS)**
   - สำหรับประมวลผลเว็บต้นทางที่เป็น Dynamic JavaScript (SPA)
   - สามารถระบุตำแหน่งของ Chromium/Chrome บน VPS ได้ผ่าน `PUPPETEER_EXECUTABLE_PATH`

---

## 🛠️ รูปแบบที่ 1: การติดตั้งบน Rukcom Shared Hosting (cPanel Setup Node.js App)

หากคุณใช้ **Rukcom Web Hosting (cPanel)** ที่มีฟีเจอร์ **Setup Node.js App**:

1. **อัปโหลดไฟล์โครงการขึ้น Hosting**
   - เข้า cPanel -> **File Manager**
   - อัปโหลดไฟล์โครงการทั้งหมดขึ้นไปยังโฟลเดอร์ เช่น `/home/username/preorder-bot` (ยกเว้นโฟลเดอร์ `node_modules`)

2. **สร้าง Node.js Application ใน cPanel**
   - เข้าเมนู **Setup Node.js App** ใน cPanel
   - กด **Create Application**
   - เลือก **Node.js Version**: 18.x หรือ 20.x (หรือเวอร์ชันล่าสุดที่มี)
   - **Application Root**: `preorder-bot` (ชื่อโฟลเดอร์ที่อัปโหลดไว้)
   - **Application URL**: เลือกโดเมนหรือซับโดเมนของคุณ
   - **Application Startup File**: `server.js`
   - กด **Create**

3. **ติดตั้ง Dependencies**
   - ที่หน้า Node.js App กดปุ่ม **Run NPM Install** (ระบบจะอ่าน `package.json` และติดตั้ง `express`, `cheerio`, `axios`, `sqlite3` อัตโนมัติ)

4. **ตั้งค่า Environment Variables (ถ้ามี)**
   - เพิ่ม Environment Variable ในหน้า cPanel Node.js App:
     - `PORT`: (cPanel จะกำหนดให้อัตโนมัติ)
     - `TARGET_BASE_URL`: `https://thewestern.rdcw.xyz`
     - `BOT_USERNAME`: `TEST4455`
     - `BOT_PASSWORD`: `TEST4455@`

5. **เริ่มต้นการใช้งาน**
   - กด **Restart Application**
   - บอทจะเริ่มทำงานผ่าน Cheerio HTML Engine โดยอัตโนมัติ สามารถเข้าใช้งานผ่าน URL หน้าบ้านได้ทันที

---

## 💻 รูปแบบที่ 2: การติดตั้งบน Rukcom Cloud / VPS (Linux Ubuntu/Debian)

หากคุณใช้ **Rukcom VPS** หรือ **Cloud Server** ที่มีสิทธิ์ Root:

### 1. ติดตั้ง Node.js และ PM2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
```

### 2. ติดตั้ง Google Chrome / Chromium (ตัวเลือกเสริมสำหรับ Puppeteer)
หากต้องการใช้ Puppeteer เพื่อประมวลผล Dynamic JS หน้าบ้าน ให้ติดตั้ง Chromium เพิ่มเติม:
```bash
sudo apt-get update
sudo apt-get install -y chromium-browser \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  nss-plugin-pem \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  stdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libssse3 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils
```

### 3. ดาวน์โหลดโค้ดและตั้งค่าโครงการ
```bash
git clone <your-repository-url> /var/www/preorder-bot
cd /var/www/preorder-bot
npm install
```

### 4. สั่งรันบอทด้วย PM2
```bash
# กำหนดเส้นทาง Chromium ใน ecosystem.config.js หรือรันคำสั่งโดยตรง
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser pm2 start ecosystem.config.js

# ตั้งค่าให้ PM2 ทำงานอัตโนมัติเมื่อรีสตาร์ทเซิร์ฟเวอร์
pm2 save
pm2 startup
```

---

## 🔍 การทดสอบการทำงานของบอท (Health Check & Scraper Status)

1. **ตรวจสอบความพร้อมของระบบ**:
   เปิดเบราว์เซอร์ไปที่ `http://<your-domain-or-ip>:8080/api/admin/system-stats`
2. **ทดสอบสแกนอ่าน HTML หน้าบ้านเว็บต้นทาง**:
   ยิง API `http://<your-domain-or-ip>:8080/api/check-queue?username=TEST4455`
   - ระบบจะพยายามรัน Puppeteer (ถ้ามี Chrome)
   - หากไม่มี Chrome ระบบจะสลับไปใช้ **Cheerio HTML DOM Engine** เพื่อดึงและแกะโครงสร้าง HTML/CSS หน้าบ้านส่งกลับมาเป็นข้อมูลออเดอร์ที่ถูกต้อง 100%

---

## ❓ คำถามที่พบบ่อย (FAQ)

- **Q: บน Rukcom cPanel ติด Error Puppeteer / Chromium ไม่ทำงาน ต้องทำอย่างไร?**
  - **A**: ไม่ต้องทำอะไรเพิ่มเติมครับ บอทมีระบบ Fallback อัตโนมัติ โดยจะสลับไปใช้ **Cheerio HTML Scraper** ดึงข้อมูล DOM หน้าบ้านโดยตรง ทำงานได้รวดเร็ว 100% โดยไม่ต้องลง Chrome ในเครื่อง

- **Q: จะเปลี่ยนเว็บต้นทางได้อย่างไร?**
  - **A**: ตั้งค่า Environment Variable `TARGET_BASE_URL` เป็น URL เว็บต้นทางใหม่ที่ต้องการสแกน
