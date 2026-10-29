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
    // Seed or update default admin account password to 1234
    db.get("SELECT * FROM admins WHERE username = 'admin'", [], (err, row) => {
        if (err) return console.error(err.message);
        const hash = bcrypt.hashSync('1234', 10);
        if (!row) {
            console.log('Seeding default admin account (admin / 1234)...');
            db.run(
                "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
                ['admin', hash]
            );
        } else {
            console.log('Updating admin password to 1234...');
            db.run(
                "UPDATE admins SET password_hash = ? WHERE username = 'admin'",
                [hash]
            );
        }
    });

    // Seed default system settings
    db.serialize(() => {
        const defaultSettings = [
            ['is_queue_active', '1'],
            ['closed_message', 'ระบบปิดปรับปรุงชั่วคราว กรุณากลับมาใหม่ภายหลัง'],
            ['shop_name', 'Checkorder'],
            ['hero_title', 'ตรวจสอบคิวจองสินค้าพรีออเดอร์'],
            ['hero_subtitle', 'กรอกชื่อบัญชีที่ลงทะเบียนไว้กับเว็บต้นทาง (thewestern.rdcw.xyz) เพื่อให้บอทเข้าไปสแกนดึงออเดอร์มาแสดงผล'],
            ['color_shop_name', '#4A7BF8'],
            ['color_hero_title', '#4A7BF8'],
            ['color_border', '#4A7BF8'],
            ['color_accent', '#4A7BF8'],
            ['announcement_text', ''],
            ['warning_note', 'ระยะเวลาเป็นการประมาณการโดยระบบอัตโนมัติ อาจคลาดเคลื่อนจากเวลาจริง']
        ];
        
        defaultSettings.forEach(([key, val]) => {
            db.run("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)", [key, val]);
        });
    });

    // Seed customer accounts
    // No dummy test accounts seeding - accounts auto-discovered from thewestern.rdcw.xyz
}

module.exports = db;
