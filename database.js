const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'checkorder.db');
let db;

try {
    const { DatabaseSync } = require('node:sqlite');
    console.log('[Database] Using Node.js built-in node:sqlite (Zero C++ dependency)');
    const nativeDb = new DatabaseSync(dbPath);

    db = {
        serialize(cb) {
            if (cb) cb();
        },
        run(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            try {
                const stmt = nativeDb.prepare(sql);
                const res = stmt.run(...params);
                if (cb) cb.call({ lastID: Number(res.lastInsertRowid || 0), changes: res.changes || 0 }, null);
            } catch (err) {
                console.error('[DB Error] run failed:', err.message, '| SQL:', sql);
                if (cb) cb(err);
            }
        },
        get(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            try {
                const stmt = nativeDb.prepare(sql);
                const row = stmt.get(...params);
                if (cb) cb(null, row || undefined);
            } catch (err) {
                console.error('[DB Error] get failed:', err.message, '| SQL:', sql);
                if (cb) cb(err, null);
            }
        },
        all(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            try {
                const stmt = nativeDb.prepare(sql);
                const rows = stmt.all(...params);
                if (cb) cb(null, rows || []);
            } catch (err) {
                console.error('[DB Error] all failed:', err.message, '| SQL:', sql);
                if (cb) cb(err, []);
            }
        },
        prepare(sql) {
            try {
                const stmt = nativeDb.prepare(sql);
                return {
                    run(...args) {
                        let cb = null;
                        if (args.length > 0 && typeof args[args.length - 1] === 'function') {
                            cb = args.pop();
                        }
                        try {
                            const res = stmt.run(...args);
                            if (cb) cb.call({ lastID: Number(res.lastInsertRowid || 0), changes: res.changes || 0 }, null);
                        } catch (err) {
                            console.error('[DB Error] stmt.run failed:', err.message, '| SQL:', sql);
                            if (cb) cb(err);
                        }
                    },
                    finalize(cb) {
                        if (cb) cb();
                    }
                };
            } catch (err) {
                console.error('[DB Error] prepare failed:', err.message, '| SQL:', sql);
                return {
                    run(...args) {
                        let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
                        if (cb) cb(err);
                    },
                    finalize(cb) { if (cb) cb(); }
                };
            }
        }
    };
} catch (e) {
    console.log('[Database] node:sqlite unavailable, falling back to sqlite3 package...');
    const sqlite3 = require('sqlite3').verbose();
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Error opening database:', err.message);
        } else {
            console.log('Connected to the SQLite database.');
        }
    });
}

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
                status TEXT DEFAULT 'idle',
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
                level TEXT,
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
                status TEXT DEFAULT 'pending'
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
                queue_status TEXT DEFAULT 'Pending',
                estimated_wait_time TEXT,
                notes TEXT,
                buyer_notes TEXT DEFAULT '',
                purchase_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                wait_time_target DATETIME,
                last_updated DATETIME
            )
        `);

        // Admin users table: authentication for admin panel
        db.run(`
            CREATE TABLE IF NOT EXISTS admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // System settings table: key-value store for app configuration
        db.run(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);

        // Audit logs table: tracks all admin actions
        db.run(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_user TEXT NOT NULL,
                action TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('Database tables verified/created successfully.');
        seedInitialData();
    });
}

function seedInitialData() {
    // Seed default admin account
    db.get("SELECT COUNT(*) as count FROM admins", [], async (err, row) => {
        if (err) return console.error(err.message);
        if (row.count === 0) {
            console.log('Seeding default admin account (admin / admin123)...');
            const hash = bcrypt.hashSync('admin123', 10);
            db.run(
                "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
                ['admin', hash]
            );
        }
    });

    // Seed default system settings
    db.get("SELECT COUNT(*) as count FROM system_settings", [], (err, row) => {
        if (err) return console.error(err.message);
        if (row.count === 0) {
            console.log('Seeding default system settings...');
            const stmt = db.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?)");
            stmt.run('is_queue_active', '1');
            stmt.run('closed_message', 'ระบบปิดปรับปรุงชั่วคราว กรุณากลับมาใหม่ภายหลัง');
            stmt.finalize();
        }
    });

    // Seed customer accounts
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

    // Seed orders with new fields (purchase_time, wait_time_target, buyer_notes)
    db.get("SELECT COUNT(*) as count FROM orders", [], (err, row) => {
        if (err) return console.error(err.message);
        if (row.count === 0) {
            console.log('Seeding initial test orders...');
            const stmt = db.prepare(`
                INSERT INTO orders (username, product_name, product_image, queue_position, queue_status, estimated_wait_time, notes, buyer_notes, purchase_time, wait_time_target, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const now = new Date().toISOString();
            // 90 minutes from now for active orders
            const waitTarget90 = new Date(Date.now() + 90 * 60 * 1000).toISOString();
            // 45 minutes from now (simulating halfway through)
            const waitTarget45 = new Date(Date.now() + 45 * 60 * 1000).toISOString();

            // customer_test_1@example.com orders
            stmt.run(
                'customer_test_1@example.com',
                'iPhone 15 Pro Max 256GB Titanium',
                'https://images.unsplash.com/photo-1695048133142-1a20484d2569?auto=format&fit=crop&w=300&q=80',
                5,
                'Processing',
                'ประมาณ 10 นาที',
                'บอทกำลังรันสคริปต์ทำคำสั่งซื้อกับระบบหลังบ้านจำลองเพื่อล็อกสินค้า...',
                'ต้องการรุ่น Titanium สีน้ำเงินเข้ม',
                new Date(Date.now() - 30 * 60 * 1000).toISOString(), // purchased 30 min ago
                waitTarget45,
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
                '',
                new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // purchased 2 hours ago
                null,
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
                'ต้องการรุ่น 512GB',
                new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // purchased 1 hour ago
                null,
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
                'สีนีออนแดง/น้ำเงิน',
                new Date(Date.now() - 10 * 60 * 1000).toISOString(), // purchased 10 min ago
                waitTarget90,
                now
            );
            stmt.run(
                'customer_test_2@example.com',
                'NVIDIA GeForce RTX 4090 Founders Edition',
                'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=300&q=80',
                0,
                'Failed',
                '-',
                'การพรีออเดอร์ล้มเหลวเนื่องจากยอมสิทธิ์สั่งซื้อของเซสชันนี้หมดลงก่อนถึงคิว',
                '',
                new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // purchased 3 hours ago
                null,
                now
            );

            stmt.finalize();
        }
    });
}

module.exports = db;
