const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./database');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Enable CORS for cross-origin local testing (e.g. VS Code Live Server on port 5500)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Broadcast log message helper to connected WebSockets
function broadcastLog(username, level, message) {
    const logEntry = {
        username,
        level,
        message,
        timestamp: new Date().toISOString()
    };
    
    // Save log to SQLite db
    db.run(
        "INSERT INTO logs (username, level, message) VALUES (?, ?, ?)",
        [username, level, message],
        (err) => {
            if (err) console.error('Failed to log to DB:', err.message);
        }
    );

    // Send log to connected dashboard sockets
    const socketMsg = JSON.stringify({ type: 'log', data: logEntry });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(socketMsg);
        }
    });
}

// REST API endpoint: Check Queue Status
app.get('/api/check-queue', (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username is required' });
    }

    console.log(`[API] Checking queue for: ${username}`);
    
    // Query local database for account status and credentials
    db.get("SELECT * FROM accounts WHERE username = ?", [username], (err, account) => {
        if (err) {
            console.error(err.message);
            return res.status(500).json({ success: false, message: 'Database error' });
        }

        if (account) {
            // Log access check
            broadcastLog(username, 'info', `คิวถูกร้องขอตรวจสอบสถานะปัจจุบัน: คิวที่ #${account.queue_position} (${account.queue_status})`);
            
            // Asynchronously trigger target site updates (mock/actual scraping attempt)
            updateQueueFromTarget(account);

            return res.json({
                success: true,
                data: {
                    username: account.username,
                    queue_position: account.queue_position,
                    queue_status: account.queue_status,
                    last_updated: account.last_updated
                }
            });
        } else {
            // User not found in DB
            broadcastLog(username, 'warn', `ไม่พบบัญชีผู้ใช้ในการตรวจสอบคิวสไนเปอร์`);
            return res.status(404).json({ success: false, message: 'Account not found' });
        }
    });
});

// Scraping & Bot Automation Logic
async function updateQueueFromTarget(account) {
    const username = account.username;
    broadcastLog(username, 'info', `กำลังส่งสคริปต์บอทตรวจสอบเซสชันกับเว็บไซต์ต้นทาง (thewestern.rdcw.xyz)...`);

    try {
        // Mocking request-based scraping loop to pull order history
        // In real execution, this would use stored cookies or perform auto-login:
        // const loginRes = await axios.post('https://thewestern.rdcw.xyz/api/auth/callback/credentials', { username, password });
        // const orderRes = await axios.get('https://thewestern.rdcw.xyz/users/orders/histories', { headers: { Cookie: loginRes.headers['set-cookie'] } });
        
        // Simulating the request latency & auto-login retry sequence
        setTimeout(() => {
            // Success response path: Simulate updating the queue status from target
            const now = new Date().toISOString();
            
            // Just simulation of status progress: if Pending, shift to Processing; if Processing, shift to Completed
            let nextStatus = account.queue_status;
            let nextPos = account.queue_position;
            
            if (account.queue_status === 'Pending') {
                nextStatus = 'Processing';
                nextPos = Math.max(1, account.queue_position - 2);
            } else if (account.queue_status === 'Processing') {
                if (account.queue_position <= 2) {
                    nextStatus = 'Completed';
                    nextPos = 0;
                } else {
                    nextPos = account.queue_position - 1;
                }
            }

            db.run(
                "UPDATE accounts SET queue_status = ?, queue_position = ?, last_updated = ? WHERE username = ?",
                [nextStatus, nextPos, now, username],
                (err) => {
                    if (err) {
                        broadcastLog(username, 'error', `ไม่สามารถเซฟข้อมูลคิวอัปเดตลงฐานข้อมูลได้: ${err.message}`);
                    } else {
                        broadcastLog(username, 'success', `บอทอัปเดตคิวสำเร็จ: สถานะย้ายไปเป็น ${nextStatus} (คิวลำดับ #${nextPos})`);
                    }
                }
            );

        }, 3000); // 3 seconds simulation delay
        
    } catch (err) {
        broadcastLog(username, 'error', `บอทไม่สามารถเข้าสู่ระบบต้นทางได้: ${err.message}. กำลังพยายามทดสอบพร็อกซีสำรองเพื่อเชื่อมต่อใหม่...`);
    }
}

// Admin API endpoints for importing accounts
app.post('/api/admin/import-accounts', (req, res) => {
    const accountsList = req.body.accounts; // Array of {username, password}
    if (!Array.isArray(accountsList)) {
        return res.status(400).json({ success: false, message: 'Invalid data format' });
    }

    const stmt = db.prepare(`
        INSERT INTO accounts (username, password, status, queue_position, queue_status, last_updated)
        VALUES (?, ?, 'idle', ?, 'Pending', ?)
        ON CONFLICT(username) DO UPDATE SET password=excluded.password
    `);

    const now = new Date().toISOString();
    let imported = 0;

    accountsList.forEach(acc => {
        const initialQueue = Math.floor(Math.random() * 50) + 1; // Seed a random queue position for new accounts
        stmt.run(acc.username, acc.password, initialQueue, now);
        imported++;
        broadcastLog(acc.username, 'info', `นำเข้าบัญชีบอทใหม่เรียบร้อยแล้ว: รอคิวสไนเปอร์หลัก`);
    });

    stmt.finalize();
    res.json({ success: true, message: `Successfully imported ${imported} accounts` });
});

// WebSocket Server Logs connection
wss.on('connection', (ws) => {
    console.log('[WebSocket] Dashboard monitor client connected.');
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to CheckOrder Live Console logger.' }));
});

// Start Server
server.listen(PORT, () => {
    console.log(`[Server] CheckOrder active on http://localhost:${PORT}`);
});
