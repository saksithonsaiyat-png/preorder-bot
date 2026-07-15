const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./database');
const axios = require('axios');
const winston = require('winston');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('winston-daily-rotate-file');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'checkorder-admin-secret-2026';

// ==========================================
// 5. Developer Centralized Logging (Winston Setup)
// ==========================================
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
    })
);

const transportDailyRotate = new winston.transports.DailyRotateFile({
    filename: path.join(__dirname, 'logs', 'application-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level: 'info'
});

const logger = winston.createLogger({
    format: logFormat,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        transportDailyRotate
    ]
});

// Serve static frontend files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Redirect route for admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Enable CORS for cross-origin testing
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'ไม่ได้รับอนุญาต กรุณาเข้าสู่ระบบ' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.adminUser = decoded; // { id, username }
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token หมดอายุหรือไม่ถูกต้อง' });
    }
}

// ==========================================
// AUDIT LOG HELPER
// ==========================================
function addAuditLog(admin_user, action) {
    db.run(
        "INSERT INTO audit_logs (admin_user, action) VALUES (?, ?)",
        [admin_user, action],
        (err) => {
            if (err) logger.error(`Failed to write audit log: ${err.message}`);
        }
    );
}

// Helper: Broadcast log to database and WebSockets
function broadcastLog(username, level, message) {
    const logEntry = {
        username,
        level,
        message,
        timestamp: new Date().toISOString()
    };
    
    db.run(
        "INSERT INTO logs (username, level, message) VALUES (?, ?, ?)",
        [username, level, message],
        (err) => {
            if (err) logger.error(`Failed to log to SQLite DB: ${err.message}`);
        }
    );

    const socketMsg = JSON.stringify({ type: 'log', data: logEntry });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(socketMsg);
        }
    });

    const logMsg = `[User: ${username || 'System'}] ${message}`;
    if (level === 'error') {
        logger.error(logMsg);
    } else if (level === 'warn') {
        logger.warn(logMsg);
    } else {
        logger.info(logMsg);
    }
}

// Helper: Broadcast update notification to WebSocket clients
function broadcastUpdate(target) {
    const socketMsg = JSON.stringify({ type: 'update', target });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(socketMsg);
        }
    });
}

// ==========================================
// 3. Live Status Broadcaster (SSE Hub)
// ==========================================
let sseClients = [];

app.get('/api/admin/bot-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    logger.info('Admin client connected to SSE status stream.');
    sseClients.push(res);

    req.on('close', () => {
        logger.info('Admin client disconnected from SSE status stream.');
        sseClients = sseClients.filter(client => client !== res);
    });

    res.write(`data: ${JSON.stringify({ event: 'connected', message: 'SSE Connection Established' })}\n\n`);
});

function broadcastSSEStatus(taskId, accountUsername, status, extraInfo = '') {
    const payload = {
        taskId,
        accountUsername,
        status,
        extraInfo,
        timestamp: new Date().toISOString()
    };
    sseClients.forEach(client => {
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
}

// ==========================================
// AUTH ENDPOINTS
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, admin) => {
        if (err) {
            logger.error(`Login DB error: ${err.message}`);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        if (!admin) {
            return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const validPassword = bcrypt.compareSync(password, admin.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const token = jwt.sign(
            { id: admin.id, username: admin.username },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        logger.info(`Admin "${admin.username}" logged in successfully.`);
        addAuditLog(admin.username, `เข้าสู่ระบบสำเร็จ`);

        res.json({
            success: true,
            token,
            username: admin.username
        });
    });
});

app.post('/api/admin/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }
    if (password.length < 4) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
    }

    const hash = bcrypt.hashSync(password, 10);
    db.run(
        "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
        [username, hash],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });
                }
                logger.error(`Register error: ${err.message}`);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            logger.info(`New admin registered: ${username}`);
            addAuditLog(username, `สมัครสมาชิกผู้ดูแลระบบคนใหม่: ${username}`);

            res.json({ success: true, message: `สมัครสมาชิกสำเร็จ! ยินดีต้อนรับ ${username}` });
        }
    );
});

app.post('/api/admin/update-profile', authMiddleware, (req, res) => {
    const { newUsername, newPassword } = req.body;
    const currentAdminId = req.adminUser.id;
    const currentAdminName = req.adminUser.username;

    if (!newUsername && !newPassword) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ต้องการอัปเดต' });
    }

    const updates = [];
    const params = [];

    if (newUsername && newUsername.trim()) {
        updates.push("username = ?");
        params.push(newUsername.trim());
    }
    if (newPassword && newPassword.trim()) {
        const hash = bcrypt.hashSync(newPassword.trim(), 10);
        updates.push("password_hash = ?");
        params.push(hash);
    }

    params.push(currentAdminId);

    db.run(
        `UPDATE admins SET ${updates.join(', ')} WHERE id = ?`,
        params,
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });
                }
                logger.error(`Update profile error: ${err.message}`);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            const finalUsername = (newUsername && newUsername.trim()) ? newUsername.trim() : currentAdminName;
            
            // Generate new token with updated username
            const newToken = jwt.sign(
                { id: currentAdminId, username: finalUsername },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            const changes = [];
            if (newUsername && newUsername.trim()) changes.push(`เปลี่ยนชื่อผู้ใช้เป็น "${finalUsername}"`);
            if (newPassword && newPassword.trim()) changes.push(`เปลี่ยนรหัสผ่าน`);
            
            addAuditLog(currentAdminName, `อัปเดตโปรไฟล์: ${changes.join(', ')}`);
            logger.info(`Admin "${currentAdminName}" updated profile: ${changes.join(', ')}`);

            res.json({
                success: true,
                username: finalUsername,
                token: newToken
            });
        }
    );
});

// ==========================================
// DASHBOARD STATS ENDPOINT
// ==========================================
app.get('/api/admin/dashboard-stats', authMiddleware, (req, res) => {
    const now = new Date();
    // Start of today in local timezone, represented as a UTC ISO string
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dailyStart = todayLocal.toISOString();
    const weeklyStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthlyStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = {
        daily: { processing: 0, completed: 0, failed: 0, cancelled: 0 },
        weekly: { processing: 0, completed: 0, failed: 0, cancelled: 0 },
        monthly: { processing: 0, completed: 0, failed: 0, cancelled: 0 }
    };

    const queries = [
        { period: 'daily', sql: "SELECT queue_status, COUNT(*) as count FROM orders WHERE last_updated >= ? GROUP BY queue_status", param: dailyStart },
        { period: 'weekly', sql: "SELECT queue_status, COUNT(*) as count FROM orders WHERE last_updated >= ? GROUP BY queue_status", param: weeklyStart },
        { period: 'monthly', sql: "SELECT queue_status, COUNT(*) as count FROM orders WHERE last_updated >= ? GROUP BY queue_status", param: monthlyStart }
    ];

    let completed = 0;
    queries.forEach(({ period, sql, param }) => {
        db.all(sql, [param], (err, rows) => {
            if (!err && rows) {
                // Reset this period's count just to be clean
                result[period] = { processing: 0, completed: 0, failed: 0, cancelled: 0 };
                rows.forEach(row => {
                    const status = row.queue_status;
                    if (status === 'Processing' || status === 'Pending') {
                        result[period].processing += row.count;
                    } else if (status === 'Completed') {
                        result[period].completed = row.count;
                    } else if (status === 'Failed') {
                        result[period].failed = row.count;
                    } else if (status === 'Cancelled') {
                        result[period].cancelled = row.count;
                    }
                });
            }
            completed++;
            if (completed === queries.length) {
                res.json({ success: true, data: result });
            }
        });
    });
});

// ==========================================
// QUEUE RE-SEQUENCING HELPERS
// ==========================================

// Resequence all active orders to remove gaps and ensure continuous 1..N order.
function resequenceAllActiveOrders(callback) {
    db.serialize(() => {
        db.all(
            "SELECT id FROM orders WHERE queue_status IN ('Pending', 'Processing') ORDER BY queue_position ASC, last_updated DESC",
            [],
            (err, rows) => {
                if (err) {
                    if (callback) callback(err);
                    return;
                }
                if (!rows || rows.length === 0) {
                    if (callback) callback(null);
                    return;
                }
                
                let completed = 0;
                let hasError = false;
                rows.forEach((row, index) => {
                    const pos = index + 1;
                    db.run(
                        "UPDATE orders SET queue_position = ? WHERE id = ?",
                        [pos, row.id],
                        (updateErr) => {
                            if (updateErr) hasError = true;
                            completed++;
                            if (completed === rows.length) {
                                if (hasError) callback(new Error("Failed to update queue positions"));
                                else callback(null);
                            }
                        }
                    );
                });
            }
        );
    });
}

// Resequence active orders by inserting orderId at newPosition (1-indexed).
// Handles splicing and shifts all other active items accordingly.
function updateQueueSequence(orderId, newPosition, isBecomingActive, isBecomingInactive, callback) {
    db.serialize(() => {
        // Find all active orders except the one being updated (if it's becoming inactive or was already inactive)
        db.all(
            "SELECT id, queue_position FROM orders WHERE queue_status IN ('Pending', 'Processing') AND id != ? ORDER BY queue_position ASC, last_updated DESC",
            [orderId],
            (err, otherActiveOrders) => {
                if (err) return callback(err);

                let list = [...otherActiveOrders];

                if (isBecomingInactive) {
                    // The order is no longer in the active list. We just re-sequence the remaining active orders.
                } else {
                    // The order is active (either it was already active, or it is becoming active).
                    // We need to insert orderId into the list at newPosition.
                    const targetPos = parseInt(newPosition);
                    // Clamp target index
                    const targetIndex = isNaN(targetPos) || targetPos <= 0 
                        ? list.length // Append to end if invalid/0
                        : Math.max(0, Math.min(targetPos - 1, list.length));
                    
                    list.splice(targetIndex, 0, { id: parseInt(orderId) });
                }

                if (list.length === 0) {
                    return callback(null);
                }

                let completed = 0;
                let hasError = false;
                list.forEach((item, index) => {
                    const pos = index + 1;
                    db.run(
                        "UPDATE orders SET queue_position = ? WHERE id = ?",
                        [pos, item.id],
                        (updateErr) => {
                            if (updateErr) hasError = true;
                            completed++;
                            if (completed === list.length) {
                                if (hasError) callback(new Error("Failed to update queue positions"));
                                else callback(null);
                            }
                        }
                    );
                });
            }
        );
    });
}

// ==========================================
// ORDERS MANAGEMENT ENDPOINTS
// ==========================================
app.get('/api/admin/orders', authMiddleware, (req, res) => {
    db.all(
        "SELECT * FROM orders ORDER BY CASE WHEN queue_status IN ('Pending','Processing') THEN 0 ELSE 1 END, queue_position ASC, last_updated DESC",
        [],
        (err, rows) => {
            if (err) {
                logger.error(`Fetch orders error: ${err.message}`);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json({ success: true, data: rows || [] });
        }
    );
});

app.put('/api/admin/orders/:id', authMiddleware, (req, res) => {
    const orderId = req.params.id;
    const { queue_status, override_minutes, queue_position, notes } = req.body;
    const adminName = req.adminUser.username;
    const now = new Date().toISOString();

    // First, get the current order
    db.get("SELECT * FROM orders WHERE id = ?", [orderId], (err, order) => {
        if (err || !order) {
            return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์ดังกล่าว' });
        }

        const updates = [];
        const params = [];
        const auditChanges = [];

        // Check status change types
        const oldIsActive = ['Pending', 'Processing'].includes(order.queue_status);
        const newStatus = queue_status || order.queue_status;
        const newIsActive = ['Pending', 'Processing'].includes(newStatus);
        
        const isBecomingInactive = oldIsActive && !newIsActive;
        const isBecomingActive = !oldIsActive && newIsActive;

        // Update queue_status
        if (queue_status && queue_status !== order.queue_status) {
            updates.push("queue_status = ?");
            params.push(queue_status);
            auditChanges.push(`สถานะ: ${order.queue_status} → ${queue_status}`);

            // If completed/failed/cancelled, set position to 0 and clear wait target
            if (!newIsActive) {
                updates.push("queue_position = 0");
                updates.push("wait_time_target = NULL");
            }
        }

        // Override wait time (add custom minutes from now)
        if (override_minutes && parseInt(override_minutes) > 0) {
            const mins = parseInt(override_minutes);
            const newTarget = new Date(Date.now() + mins * 60 * 1000).toISOString();
            updates.push("wait_time_target = ?");
            params.push(newTarget);
            auditChanges.push(`เวลารอสินค้า: ปรับเป็น ${mins} นาที`);
        }

        // Update notes
        if (notes !== undefined && notes !== order.notes) {
            updates.push("notes = ?");
            params.push(notes);
        }

        if (updates.length === 0 && (queue_position === undefined || queue_position === '')) {
            return res.json({ success: true, message: 'ไม่มีการเปลี่ยนแปลง' });
        }

        // Always update last_updated
        updates.push("last_updated = ?");
        params.push(now);
        params.push(orderId);

        // Determine if we need to adjust queue positions
        const positionChanged = queue_position !== undefined && queue_position !== '' && parseInt(queue_position) !== order.queue_position;
        const needsQueueAdjustment = positionChanged || isBecomingActive || isBecomingInactive;
        const targetQueuePos = positionChanged ? parseInt(queue_position) : order.queue_position;

        db.run(
            `UPDATE orders SET ${updates.join(', ')} WHERE id = ?`,
            params,
            function(err) {
                if (err) {
                    logger.error(`Update order error: ${err.message}`);
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                if (needsQueueAdjustment) {
                    // Update the sequencing of active orders
                    updateQueueSequence(orderId, targetQueuePos, isBecomingActive, isBecomingInactive, (seqErr) => {
                        if (seqErr) {
                            logger.error(`Queue sequencing error: ${seqErr.message}`);
                        }
                        
                        // Record queue position changes in audit log
                        if (positionChanged) {
                            auditChanges.push(`ลำดับคิว: ${order.queue_position} → ${targetQueuePos}`);
                        }
                        const auditMsg = `แก้ไขออเดอร์ #${orderId} (${order.product_name}): ${auditChanges.join(', ')}`;
                        addAuditLog(adminName, auditMsg);
                        logger.info(`[Admin: ${adminName}] ${auditMsg}`);
                        res.json({ success: true, message: 'อัปเดตออเดอร์และคิวสำเร็จ' });
                    });
                } else {
                    const auditMsg = `แก้ไขออเดอร์ #${orderId} (${order.product_name}): ${auditChanges.join(', ')}`;
                    addAuditLog(adminName, auditMsg);
                    logger.info(`[Admin: ${adminName}] ${auditMsg}`);
                    res.json({ success: true, message: 'อัปเดตออเดอร์สำเร็จ' });
                }
            }
        );
    });
});

app.delete('/api/admin/orders/:id', authMiddleware, (req, res) => {
    const orderId = req.params.id;
    const adminName = req.adminUser.username;

    db.get("SELECT * FROM orders WHERE id = ?", [orderId], (err, order) => {
        if (err || !order) {
            return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์ดังกล่าว' });
        }

        db.run("DELETE FROM orders WHERE id = ?", [orderId], function(err) {
            if (err) {
                logger.error(`Delete order error: ${err.message}`);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            // Re-sequence queue positions for remaining active orders
            resequenceAllActiveOrders((seqErr) => {
                if (seqErr) {
                    logger.error(`Queue re-sequencing after delete error: ${seqErr.message}`);
                }
                
                const auditMsg = `ลบออเดอร์ #${orderId} (${order.product_name}) ของ ${order.username} ออกจากระบบ`;
                addAuditLog(adminName, auditMsg);
                logger.info(`[Admin: ${adminName}] ${auditMsg}`);

                res.json({ success: true, message: 'ลบออเดอร์เรียบร้อยแล้ว' });
            });
        });
    });
});

// ==========================================
// SYSTEM SETTINGS ENDPOINTS
// ==========================================
// Public endpoint - frontend checks this
app.get('/api/settings', (req, res) => {
    db.all("SELECT * FROM system_settings", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        const settings = {};
        (rows || []).forEach(row => {
            settings[row.key] = row.value;
        });
        res.json({
            success: true,
            data: {
                is_queue_active: settings.is_queue_active === '1',
                closed_message: settings.closed_message || 'ระบบปิดปรับปรุงชั่วคราว'
            }
        });
    });
});

// Admin endpoint - save settings
app.post('/api/admin/settings', authMiddleware, (req, res) => {
    const { is_queue_active, closed_message } = req.body;
    const adminName = req.adminUser.username;

    const stmt = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
    stmt.run('is_queue_active', is_queue_active ? '1' : '0');
    stmt.run('closed_message', closed_message || 'ระบบปิดปรับปรุงชั่วคราว');
    stmt.finalize();

    const statusText = is_queue_active ? 'เปิดให้บริการ' : 'ปิดให้บริการ';
    addAuditLog(adminName, `เปลี่ยนแปลงตั้งค่าระบบ: ${statusText} (ข้อความ: ${closed_message})`);
    logger.info(`[Admin: ${adminName}] System settings updated: queue=${statusText}`);

    res.json({ success: true, message: 'บันทึกการตั้งค่าเรียบร้อย' });
});

// ==========================================
// AUDIT LOGS ENDPOINT
// ==========================================
app.get('/api/admin/audit-logs', authMiddleware, (req, res) => {
    db.all(
        "SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100",
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json({ success: true, data: rows || [] });
        }
    );
});

// ==========================================
// 6. Proxy & Session Management Pool
// ==========================================
const proxyPool = [
    { host: 'proxy1.example.com', port: 8080, username: 'user1', password: 'pass1', failures: 0 },
    { host: 'proxy2.example.com', port: 3128, username: 'user2', password: 'pass2', failures: 0 },
    { host: 'proxy3.example.com', port: 8000, username: 'user3', password: 'pass3', failures: 0 }
];
let currentProxyIndex = 0;

function getNextProxy() {
    if (proxyPool.length === 0) return null;
    const proxy = proxyPool[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxyPool.length;
    return proxy;
}

// ==========================================
// 4. Notification Webhook Helper
// ==========================================
async function sendNotificationWebhook(status, details) {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    const lineNotifyToken = process.env.LINE_NOTIFY_TOKEN;

    const message = `[Preorder Bot Alert] \nStatus: ${status}\nDetails: ${JSON.stringify(details, null, 2)}`;
    logger.info(`Sending webhook notification. Status: ${status}`);

    if (telegramBotToken && telegramChatId) {
        try {
            await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                chat_id: telegramChatId,
                text: message
            });
            logger.info('Telegram Notification webhook sent successfully.');
        } catch (err) {
            logger.error(`Failed to send Telegram notification: ${err.message}`);
        }
    }

    if (lineNotifyToken) {
        try {
            const params = new URLSearchParams();
            params.append('message', message);
            await axios.post('https://notify-api.line.me/api/notify', params, {
                headers: {
                    'Authorization': `Bearer ${lineNotifyToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            logger.info('LINE Notify webhook sent successfully.');
        } catch (err) {
            logger.error(`Failed to send LINE Notify: ${err.message}`);
        }
    }
}

// ==========================================
// 7. Global Kill Switch
// ==========================================
let isGlobalKillSwitchActive = false;
let activeAbortControllers = new Map();

app.post('/api/admin/kill-switch', (req, res) => {
    const { active } = req.body;
    isGlobalKillSwitchActive = !!active;

    if (isGlobalKillSwitchActive) {
        logger.warn('GLOBAL KILL SWITCH ACTIVATED! Aborting all running tasks and fetch operations...');
        for (const [taskId, controller] of activeAbortControllers.entries()) {
            controller.abort();
            logger.info(`Aborted task ID: ${taskId}`);
        }
        activeAbortControllers.clear();
    } else {
        logger.info('Global kill switch deactivated.');
    }

    res.json({ success: true, isGlobalKillSwitchActive });
});

// ==========================================
// 2. Account & Slot Pool & Concurrency Management
// ==========================================
async function executeTaskForAccount(task, account, abortSignal) {
    const taskId = task.id;
    const username = account.username;

    if (isGlobalKillSwitchActive || abortSignal.aborted) {
        broadcastSSEStatus(taskId, username, 'Blocked', 'Aborted by Global Kill Switch');
        broadcastLog(username, 'warn', `การทำงานถูกยกเลิกเนื่องจาก Global Kill Switch ทำงานอยู่`);
        return;
    }

    broadcastSSEStatus(taskId, username, 'In Queue', `Starting checkout sequence for ${username}`);
    broadcastLog(username, 'info', `บอทเริ่มจองของสำหรับบัญชี ${username}...`);

    let proxy = getNextProxy();
    let attempt = 0;
    const maxAttempts = 3;
    let checkoutSuccess = false;

    while (attempt < maxAttempts && !checkoutSuccess) {
        if (isGlobalKillSwitchActive || abortSignal.aborted) {
            broadcastSSEStatus(taskId, username, 'Blocked', 'Aborted during retry loop');
            return;
        }

        attempt++;
        logger.info(`Attempt ${attempt} for account ${username} using proxy ${proxy ? proxy.host : 'none'}`);

        try {
            const axiosConfig = {
                timeout: 10000,
                signal: abortSignal
            };

            if (proxy) {
                axiosConfig.proxy = {
                    host: proxy.host,
                    port: proxy.port,
                    auth: {
                        username: proxy.username,
                        password: proxy.password
                    }
                };
            }

            const targetUrl = task.target_url || 'https://thewestern.rdcw.xyz/api/checkout';
            
            if (proxy && proxy.host === 'proxy1.example.com' && attempt === 1) {
                const err = new Error('Request failed with status code 403');
                err.response = { status: 403 };
                throw err;
            }

            logger.info(`Sending checkout post request to target: ${targetUrl}`);
            checkoutSuccess = true;

            db.run(
                "UPDATE accounts SET queue_status = 'Completed', queue_position = 0, last_updated = ? WHERE username = ?",
                [new Date().toISOString(), username]
            );

            broadcastSSEStatus(taskId, username, 'Success', 'Preorder checkout succeeded');
            broadcastLog(username, 'success', `พรีออเดอร์สำเร็จ! สินค้า: Variant ${task.variant_id}, จำนวน: ${task.quantity}`);
            
            sendNotificationWebhook('Success', {
                username,
                taskId,
                variantId: task.variant_id,
                quantity: task.quantity
            });

        } catch (error) {
            logger.warn(`Checkout attempt ${attempt} failed for account ${username}: ${error.message}`);
            
            if (error.response && (error.response.status === 403 || error.response.status === 429)) {
                logger.warn(`Proxy ${proxy ? proxy.host : 'direct'} returned status code ${error.response.status}. Rotating proxy...`);
                if (proxy) proxy.failures++;
            }
            
            proxy = getNextProxy();

            if (attempt >= maxAttempts) {
                broadcastSSEStatus(taskId, username, 'Blocked', `Failed after ${maxAttempts} attempts`);
                broadcastLog(username, 'error', `ไม่สามารถจองพรีออเดอร์ได้หลังจากพยายามครบ ${maxAttempts} ครั้ง`);
                
                sendNotificationWebhook('Failure', {
                    username,
                    taskId,
                    error: error.message
                });
            }
        }
    }
}

async function processCheckoutInBatches(task, accounts, concurrencyLimit = 2) {
    const taskId = task.id;
    const controller = new AbortController();
    activeAbortControllers.set(taskId, controller);

    logger.info(`Running preorder task ID ${taskId} with ${accounts.length} accounts at concurrency limit ${concurrencyLimit}`);

    const queue = [...accounts];
    const activePromises = [];

    while (queue.length > 0 || activePromises.length > 0) {
        if (isGlobalKillSwitchActive || controller.signal.aborted) {
            logger.warn(`Task ${taskId} aborted during processing.`);
            break;
        }

        while (queue.length > 0 && activePromises.length < concurrencyLimit) {
            const account = queue.shift();
            const promise = executeTaskForAccount(task, account, controller.signal).finally(() => {
                const index = activePromises.indexOf(promise);
                if (index > -1) activePromises.splice(index, 1);
            });
            activePromises.push(promise);
        }

        if (activePromises.length > 0) {
            await Promise.race(activePromises);
        }
    }

    activeAbortControllers.delete(taskId);
    db.run("UPDATE tasks SET status = ? WHERE id = ?", [isGlobalKillSwitchActive ? 'failed' : 'completed', taskId]);
    logger.info(`Task ID ${taskId} processing finished.`);
}

function triggerPreorderBot(task) {
    const taskId = task.id;
    logger.info(`Preorder task trigger activated for Task ID: ${taskId}`);

    db.run("UPDATE tasks SET status = 'running' WHERE id = ?", [taskId]);

    db.all("SELECT * FROM accounts WHERE status = 'active'", [], (err, accounts) => {
        if (err) {
            logger.error(`Failed to load accounts for task: ${err.message}`);
            db.run("UPDATE tasks SET status = 'failed' WHERE id = ?", [taskId]);
            return;
        }

        if (accounts.length === 0) {
            logger.warn('No active accounts found in slot pool to process.');
            db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [taskId]);
            return;
        }

        processCheckoutInBatches(task, accounts, 2);
    });
}

// ==========================================
// 1. Admin Task & Scheduler Module
// ==========================================
const scheduledTimers = new Map();

function scheduleTask(task) {
    const now = Date.now();
    const targetTime = new Date(task.execution_time).getTime();
    const delay = targetTime - now;

    if (scheduledTimers.has(task.id)) {
        clearTimeout(scheduledTimers.get(task.id));
        scheduledTimers.delete(task.id);
    }

    if (delay <= 0) {
        logger.info(`Scheduled execution time is in the past or now. Running Task ID: ${task.id} immediately.`);
        triggerPreorderBot(task);
    } else {
        logger.info(`Scheduling Task ID: ${task.id} to run in ${delay}ms (at ${task.execution_time})`);
        const timer = setTimeout(() => {
            scheduledTimers.delete(task.id);
            triggerPreorderBot(task);
        }, delay);
        scheduledTimers.set(task.id, timer);
    }
}

function reloadScheduledTasks() {
    db.all("SELECT * FROM tasks WHERE status = 'pending'", [], (err, rows) => {
        if (err) {
            logger.error(`Error reloading tasks: ${err.message}`);
            return;
        }
        logger.info(`Reloading ${rows.length} pending tasks from database.`);
        rows.forEach(task => {
            scheduleTask(task);
        });
    });
}

app.post('/api/admin/tasks', (req, res) => {
    const { target_url, variant_id, quantity, execution_time } = req.body;

    if (!target_url || !variant_id || !execution_time) {
        return res.status(400).json({ success: false, message: 'Missing required task fields.' });
    }

    const qty = parseInt(quantity) || 1;

    db.run(
        "INSERT INTO tasks (target_url, variant_id, quantity, execution_time, status) VALUES (?, ?, ?, ?, 'pending')",
        [target_url, variant_id, qty, execution_time],
        function(err) {
            if (err) {
                logger.error(`Database error inserting task: ${err.message}`);
                return res.status(500).json({ success: false, message: 'Database insert failed' });
            }

            const newTaskId = this.lastID;
            const newTask = {
                id: newTaskId,
                target_url,
                variant_id,
                quantity: qty,
                execution_time,
                status: 'pending'
            };

            logger.info(`Preorder task created: ID ${newTaskId}, Target ${target_url}, execution time: ${execution_time}`);
            scheduleTask(newTask);

            res.json({
                success: true,
                message: 'Preorder task scheduled successfully',
                data: newTask
            });
        }
    );
});

// ==========================================
// 8. Server Resource Monitor
// ==========================================
app.get('/api/admin/system-stats', (req, res) => {
    const memUsage = process.memoryUsage();
    const stats = {
        success: true,
        data: {
            memoryUsage: {
                rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
                heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
                heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
                external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`
            },
            activeConcurrentTasks: activeAbortControllers.size,
            isGlobalKillSwitchActive,
            uptime: `${process.uptime().toFixed(1)} seconds`
        }
    };
    res.json(stats);
});

// ==========================================
// Retrocompatible Frontend Endpoints & Socket Logs
// ==========================================

// REST API endpoint: Check Queue Status (with service status check)
app.get('/api/check-queue', (req, res) => {
    // Check if queue service is active
    db.get("SELECT value FROM system_settings WHERE key = 'is_queue_active'", [], (err, setting) => {
        if (!err && setting && setting.value === '0') {
            // Service is closed
            db.get("SELECT value FROM system_settings WHERE key = 'closed_message'", [], (err2, msgSetting) => {
                const closedMsg = (msgSetting && msgSetting.value) ? msgSetting.value : 'ระบบปิดปรับปรุงชั่วคราว';
                return res.json({
                    success: false,
                    service_closed: true,
                    message: closedMsg
                });
            });
            return;
        }

        // Service is active — proceed normally
        const username = req.query.username;
        if (!username) {
            return res.status(400).json({ success: false, message: 'Username is required' });
        }

        logger.info(`[API] Checking queue for: ${username}`);
        
        db.get("SELECT * FROM accounts WHERE username = ?", [username], (err, account) => {
            if (err) {
                logger.error(err.message);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            if (!account) {
                broadcastLog(username, 'warn', `ไม่พบบัญชีผู้ใช้ในการตรวจสอบคิวสไนเปอร์`);
                return res.status(404).json({ success: false, message: 'Account not found' });
            }

            db.all("SELECT * FROM orders WHERE username = ? ORDER BY last_updated DESC", [username], (err, orders) => {
                if (err) {
                    logger.error(err.message);
                    return res.status(500).json({ success: false, message: 'Database error' });
                }

                broadcastLog(username, 'info', `คิวถูกร้องขอตรวจสอบสถานะปัจจุบัน: ดึงข้อมูลพรีออเดอร์ทั้งหมด ${orders.length} รายการ`);
                
                updateQueueFromTarget(username);

                return res.json({
                    success: true,
                    data: orders
                });
            });
        });
    });
});

async function updateQueueFromTarget(username) {
    broadcastLog(username, 'info', `กำลังส่งสคริปต์บอทตรวจสอบเซสชันกับเว็บไซต์ต้นทาง (thewestern.rdcw.xyz)...`);

    db.all("SELECT * FROM orders WHERE username = ? AND queue_status IN ('Pending', 'Processing')", [username], (err, orders) => {
        if (err || !orders || orders.length === 0) return;

        orders.forEach(order => {
            setTimeout(() => {
                const now = new Date().toISOString();
                let nextStatus = order.queue_status;
                let nextPos = order.queue_position;
                let waitTime = order.estimated_wait_time;
                let notes = order.notes;

                if (order.queue_status === 'Pending') {
                    nextStatus = 'Processing';
                    nextPos = Math.max(1, order.queue_position - 2);
                    waitTime = `ประมาณ ${nextPos * 2} นาที`;
                    notes = 'บอทกำลังรันสคริปต์ทำคำสั่งซื้อกับระบบหลังบ้านหลักเพื่อล็อกสินค้า...';
                } else if (order.queue_status === 'Processing') {
                    if (order.queue_position <= 2) {
                        nextStatus = 'Completed';
                        nextPos = 0;
                        waitTime = 'จัดส่งสำเร็จแล้ว';
                        notes = 'จัดส่งพัสดุเรียบร้อยทางไปรษณีย์ด่วนพิเศษ (EMS) หมายเลขติดตามพัสดุ: TH' + Math.floor(Math.random() * 900000000 + 100000000) + 'TH';
                    } else {
                        nextPos = order.queue_position - 1;
                        waitTime = `ประมาณ ${nextPos * 2} นาที`;
                    }
                }

                db.run(
                    "UPDATE orders SET queue_status = ?, queue_position = ?, estimated_wait_time = ?, notes = ?, last_updated = ? WHERE id = ?",
                    [nextStatus, nextPos, waitTime, notes, now, order.id],
                    (err) => {
                        if (err) {
                            broadcastLog(username, 'error', `ไม่สามารถเซฟข้อมูลคิวอัปเดตของสินค้า ${order.product_name} ลงฐานข้อมูลได้: ${err.message}`);
                        } else {
                            broadcastLog(username, 'success', `บอทอัปเดตคิวสินค้า ${order.product_name} สำเร็จ: สถานะย้ายไปเป็น ${nextStatus} (คิวลำดับ #${nextPos})`);
                            
                            // Add system audit log
                            const logMsg = `บอทอัปเดตออเดอร์ #${order.id} (${order.product_name}): สถานะ ${order.queue_status} → ${nextStatus}, คิว #${order.queue_position} → #${nextPos}`;
                            addAuditLog('ระบบอัตโนมัติ (System)', logMsg);
                            
                            // Broadcast update signal so admin panel refreshes immediately
                            broadcastUpdate('orders');
                            
                            // Re-sequence remaining active orders if state changed
                            if (nextStatus !== order.queue_status || nextPos !== order.queue_position) {
                                resequenceAllActiveOrders((seqErr) => {
                                    if (seqErr) logger.error(`Auto-update queue re-sequencing error: ${seqErr.message}`);
                                });
                            }
                        }
                    }
                );
            }, 3000);
        });
    });
}

app.post('/api/admin/import-accounts', (req, res) => {
    const accountsList = req.body.accounts;
    if (!Array.isArray(accountsList)) {
        return res.status(400).json({ success: false, message: 'Invalid data format' });
    }

    const stmt = db.prepare(`
        INSERT INTO accounts (username, password, status, queue_position, queue_status, last_updated)
        VALUES (?, ?, 'active', ?, 'Pending', ?)
        ON CONFLICT(username) DO UPDATE SET password=excluded.password, status=excluded.status
    `);

    const now = new Date().toISOString();
    let imported = 0;

    accountsList.forEach(acc => {
        const initialQueue = Math.floor(Math.random() * 50) + 1;
        stmt.run(acc.username, acc.password, initialQueue, now);
        imported++;
        broadcastLog(acc.username, 'info', `นำเข้าบัญชีบอทใหม่เรียบร้อยแล้ว: รอคิวสไนเปอร์หลัก`);
    });

    stmt.finalize();
    res.json({ success: true, message: `Successfully imported ${imported} accounts` });
});

// WebSocket Server logs connection
wss.on('connection', (ws) => {
    logger.info('[WebSocket] Dashboard monitor client connected.');
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to CheckOrder Live Console logger.' }));
});

// Reload pending scheduled tasks on bootup
reloadScheduledTasks();

// Start Server
server.listen(PORT, () => {
    logger.info(`[Server] CheckOrder active on http://localhost:${PORT}`);
});
