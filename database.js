const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'checkorder.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

initializeDatabase();

function initializeDatabase() {
    db.serialize(() => {
        // Accounts table: holds imported customer accounts, passwords, and active session cookies
        db.run(`
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                cookies TEXT,
                status TEXT DEFAULT 'idle', -- idle, logging_in, active, error
                queue_position INTEGER DEFAULT 0,
                queue_status TEXT DEFAULT 'Pending',
                last_updated DATETIME
            )
        `);

        // Logs table: audit log for bot actions
        db.run(`
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT,
                level TEXT, -- info, warn, error, success
                message TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tasks table: holds preorder scheduler tasks
        db.run(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_url TEXT NOT NULL,
                variant_id TEXT NOT NULL,
                quantity INTEGER DEFAULT 1,
                execution_time DATETIME NOT NULL,
                status TEXT DEFAULT 'pending' -- pending, running, completed, failed
            )
        `);

        // Orders table: holds detailed preorder queue items
        db.run(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                product_name TEXT NOT NULL,
                product_image TEXT,
                queue_position INTEGER DEFAULT 0,
                queue_status TEXT DEFAULT 'Pending', -- Pending, Processing, Completed, Failed, Cancelled
                estimated_wait_time TEXT,
                notes TEXT,
                last_updated DATETIME
            )
        `);

        console.log('Database tables verified/created successfully.');
        seedInitialData();
    });
}

function seedInitialData() {
    // Seed accounts
    db.get("SELECT COUNT(*) as count FROM accounts", [], (err, row) => {
        if (err) return console.error(err.message);
        if (row.count === 0) {
            console.log('Seeding initial test accounts...');
            const stmt = db.prepare(`
                INSERT INTO accounts (username, password, status, queue_position, queue_status, last_updated)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const now = new Date().toISOString();
            stmt.run('customer_test_1@example.com', 'securepass123', 'active', 5, 'Processing', now);
            stmt.run('customer_test_2@example.com', 'mypassword789', 'active', 12, 'Pending', now);
            stmt.run('customer_test_completed@example.com', 'pass1111', 'active', 0, 'Completed', now);
            stmt.finalize();
        }
    });

    // Seed orders
    db.get("SELECT COUNT(*) as count FROM orders", [], (err, row) => {
        if (err) return console.error(err.message);
        if (row.count === 0) {
            console.log('Seeding initial test orders...');
            const stmt = db.prepare(`
                INSERT INTO orders (username, product_name, product_image, queue_position, queue_status, estimated_wait_time, notes, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const now = new Date().toISOString();
            
            // customer_test_1@example.com orders
            stmt.run(
                'customer_test_1@example.com', 
                'iPhone 15 Pro Max 256GB Titanium',
                'https://images.unsplash.com/photo-1695048133142-1a20484d2569?auto=format&fit=crop&w=300&q=80',
                5,
                'Processing',
                'ประมาณ 10 นาที',
                'บอทกำลังรันสคริปต์ทำคำสั่งซื้อกับระบบหลังบ้านหลักเพื่อล็อกสินค้า...',
                now
            );
            stmt.run(
                'customer_test_1@example.com', 
                'PlayStation 5 Slim Disc Edition',
                'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?auto=format&fit=crop&w=300&q=80',
                0,
                'Completed',
                'จัดส่งสำเร็จแล้ว',
                'จัดส่งพัสดุเรียบร้อยทางไปรษณีย์ด่วนพิเศษ (EMS) หมายเลขติดตามพัสดุ: TH8394019283TH',
                now
            );
            stmt.run(
                'customer_test_1@example.com', 
                'MacBook Pro 14" M3 Space Grey',
                'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=300&q=80',
                0,
                'Cancelled',
                '-',
                'คำสั่งซื้อถูกยกเลิกเนื่องจากโควต้าสินค้าเต็มกรุณาติดต่อทีมงาน',
                now
            );

            // customer_test_2@example.com orders
            stmt.run(
                'customer_test_2@example.com', 
                'Nintendo Switch OLED Model Neon',
                'https://images.unsplash.com/photo-1578301978693-85fa9c0320b9?auto=format&fit=crop&w=300&q=80',
                12,
                'Pending',
                'ประมาณ 24 นาที',
                'อยู่ในคิวรอเริ่มการรันบอทสไนเปอร์ตามกำหนดเวลาพรีออเดอร์',
                now
            );
            stmt.run(
                'customer_test_2@example.com', 
                'NVIDIA GeForce RTX 4090 Founders Edition',
                'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=300&q=80',
                0,
                'Failed',
                '-',
                'การพรีออเดอร์ล้มเหลวเนื่องจากยอดสิทธิ์สั่งซื้อของเซสชันนี้หมดลงก่อนถึงคิว',
                now
            );

            stmt.finalize();
        }
    });
}

module.exports = db;
