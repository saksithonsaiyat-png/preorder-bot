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

        console.log('Database tables verified/created successfully.');
        seedInitialData();
    });
}

function seedInitialData() {
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
}

module.exports = db;
