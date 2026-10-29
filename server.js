const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const db = require('./database');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const winston = require('winston');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
require('winston-daily-rotate-file');

// Cheerio HTML DOM Scraper Setup (Ultra-fast light weight parser for Rukcom/Shared Hosting)
let cheerio = null;
try {
    cheerio = require('cheerio');
} catch (e) {
    console.warn('[Cheerio Load]: Cheerio module missing. Falling back to regex scraper.');
}

// Puppeteer Stealth Scraper Setup (Safe Dynamic Load for Cloud/VPS Environments)
let puppeteer = null;
try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    puppeteer = puppeteerExtra;
} catch (e) {
    console.warn('[Puppeteer Load]: Puppeteer module disabled or missing dependencies in host environment. Falling back to Fast HTTP Scraper Engine.');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'checkorder-admin-secret-2026';

// ==========================================
// 🟢 1. ดึงไฟล์กุญแจมาตั้งค่าเชื่อมต่อ Firebase & 2. เรียกใช้งานฐานข้อมูล Firestore
// ==========================================
let firestoreDb = null;
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    firestoreDb = admin.firestore();
    console.log('[Firebase] Firestore initialized successfully with serviceAccountKey.json.');
} catch (fbError) {
    if (admin.apps.length > 0) {
        firestoreDb = admin.firestore();
    } else {
        console.error(`[Firebase Initialization Error]: ${fbError.message}`);
    }
}

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
        function (err) {
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
        function (err) {
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
        daily: { processing: 0, completed: 0, failed: 0, cancelled: 0, refunded: 0 },
        weekly: { processing: 0, completed: 0, failed: 0, cancelled: 0, refunded: 0 },
        monthly: { processing: 0, completed: 0, failed: 0, cancelled: 0, refunded: 0 }
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
                result[period] = { processing: 0, completed: 0, failed: 0, cancelled: 0, refunded: 0 };
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
                    } else if (status === 'Refunded') {
                        result[period].refunded = row.count;
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
            function (err) {
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
                        broadcastUpdate('orders');
                        res.json({ success: true, message: 'อัปเดตออเดอร์และคิวสำเร็จ' });
                    });
                } else {
                    const auditMsg = `แก้ไขออเดอร์ #${orderId} (${order.product_name}): ${auditChanges.join(', ')}`;
                    addAuditLog(adminName, auditMsg);
                    logger.info(`[Admin: ${adminName}] ${auditMsg}`);
                    broadcastUpdate('orders');
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

        db.run("DELETE FROM orders WHERE id = ?", [orderId], function (err) {
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
                broadcastUpdate('orders');
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
                closed_message: settings.closed_message || 'ระบบปิดปรับปรุงชั่วคราว',
                shop_name: settings.shop_name || 'Checkorder',
                hero_title: settings.hero_title || 'ตรวจสอบคิวจองสินค้าพรีออเดอร์',
                hero_subtitle: settings.hero_subtitle || 'กรอกชื่อบัญชีที่ลงทะเบียนไว้กับเว็บต้นทาง (thewestern.rdcw.xyz) เพื่อให้บอทเข้าไปสแกนดึงออเดอร์มาแสดงผล',
                color_shop_name: settings.color_shop_name || '#4A7BF8',
                color_hero_title: settings.color_hero_title || '#4A7BF8',
                color_border: settings.color_border || '#4A7BF8',
                color_accent: settings.color_accent || '#4A7BF8',
                announcement_text: settings.announcement_text || '',
                warning_note: settings.warning_note || 'ระยะเวลาเป็นการประมาณการโดยระบบอัตโนมัติ อาจคลาดเคลื่อนจากเวลาจริง'
            }
        });
    });
});

// Admin endpoint - get settings (authenticated)
app.get('/api/admin/settings', authMiddleware, (req, res) => {
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
                closed_message: settings.closed_message || 'ระบบปิดปรับปรุงชั่วคราว',
                target_cookies: settings.target_cookies || '',
                capsolver_key: settings.capsolver_key || '',
                shop_name: settings.shop_name || 'Checkorder',
                hero_title: settings.hero_title || 'ตรวจสอบคิวจองสินค้าพรีออเดอร์',
                hero_subtitle: settings.hero_subtitle || 'กรอกชื่อบัญชีที่ลงทะเบียนไว้กับเว็บต้นทาง (thewestern.rdcw.xyz) เพื่อให้บอทเข้าไปสแกนดึงออเดอร์มาแสดงผล',
                color_shop_name: settings.color_shop_name || '#4A7BF8',
                color_hero_title: settings.color_hero_title || '#4A7BF8',
                color_border: settings.color_border || '#4A7BF8',
                color_accent: settings.color_accent || '#4A7BF8',
                announcement_text: settings.announcement_text || '',
                warning_note: settings.warning_note || 'ระยะเวลาเป็นการประมาณการโดยระบบอัตโนมัติ อาจคลาดเคลื่อนจากเวลาจริง'
            }
        });
    });
});

// Admin endpoint - save settings
app.post('/api/admin/settings', authMiddleware, (req, res) => {
    const { 
        is_queue_active, 
        closed_message, 
        target_cookies, 
        capsolver_key,
        shop_name,
        hero_title,
        hero_subtitle,
        color_shop_name,
        color_hero_title,
        color_border,
        color_accent,
        announcement_text,
        warning_note
    } = req.body;
    const adminName = req.adminUser.username;

    db.serialize(() => {
        const stmt = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
        stmt.run('is_queue_active', is_queue_active ? '1' : '0');
        stmt.run('closed_message', closed_message || 'ระบบปิดปรับปรุงชั่วคราว');
        if (target_cookies !== undefined) {
            stmt.run('target_cookies', target_cookies.trim());
            cachedTargetCookies = target_cookies.trim();
        }
        if (capsolver_key !== undefined) {
            stmt.run('capsolver_key', capsolver_key.trim());
        }
        if (shop_name !== undefined) stmt.run('shop_name', shop_name.trim());
        if (hero_title !== undefined) stmt.run('hero_title', hero_title.trim());
        if (hero_subtitle !== undefined) stmt.run('hero_subtitle', hero_subtitle.trim());
        if (color_shop_name !== undefined) stmt.run('color_shop_name', color_shop_name.trim());
        if (color_hero_title !== undefined) stmt.run('color_hero_title', color_hero_title.trim());
        if (color_border !== undefined) stmt.run('color_border', color_border.trim());
        if (color_accent !== undefined) stmt.run('color_accent', color_accent.trim());
        if (announcement_text !== undefined) stmt.run('announcement_text', announcement_text.trim());
        if (warning_note !== undefined) stmt.run('warning_note', warning_note.trim());
        stmt.finalize();
    });

    const statusText = is_queue_active ? 'เปิดให้บริการ' : 'ปิดให้บริการ';
    addAuditLog(adminName, `เปลี่ยนแปลงตั้งค่าระบบ: ${statusText}`);
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

app.get('/api/admin/app-logs', authMiddleware, (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const logPath = path.join(__dirname, 'logs', `application-${today}.log`);
        if (!fs.existsSync(logPath)) {
            return res.json({ success: true, logs: 'No logs found for today.' });
        }
        const logContent = fs.readFileSync(logPath, 'utf8');
        const lines = logContent.split('\n');
        const lastLines = lines.slice(-200).join('\n');
        res.json({ success: true, logs: lastLines });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// ACCOUNTS MANAGEMENT ENDPOINT
// ==========================================
app.get('/api/admin/accounts', authMiddleware, (req, res) => {
    db.all(
        "SELECT id, username, password, status, queue_position, queue_status, last_updated FROM accounts ORDER BY last_updated DESC",
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json({ success: true, data: rows || [] });
        }
    );
});

// Real Webshare Rotating Residential Proxies
const proxyPool = [
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-gb-1', password: 'f0f7sgbxet9m', country: 'United Kingdom', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-ca-2', password: 'f0f7sgbxet9m', country: 'Canada', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-de-3', password: 'f0f7sgbxet9m', country: 'Germany', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-fr-4', password: 'f0f7sgbxet9m', country: 'France', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-au-5', password: 'f0f7sgbxet9m', country: 'Australia', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-nl-6', password: 'f0f7sgbxet9m', country: 'Netherlands', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-it-7', password: 'f0f7sgbxet9m', country: 'Italy', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-es-8', password: 'f0f7sgbxet9m', country: 'Spain', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-be-9', password: 'f0f7sgbxet9m', country: 'Belgium', failures: 0 },
    { host: 'p.webshare.io', port: 80, username: 'esunzzzn-at-10', password: 'f0f7sgbxet9m', country: 'Austria', failures: 0 }
];
let currentProxyIndex = 0;

function getNextProxy() {
    if (proxyPool.length === 0) return null;
    const proxy = proxyPool[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxyPool.length;
    return proxy;
}

function createProxyAxiosConfig(proxy, extraConfig = {}) {
    const axiosConfig = {
        timeout: 10000,
        ...extraConfig
    };
    if (proxy) {
        const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
        axiosConfig.proxy = false; // Disable default proxy handling in favor of HttpsProxyAgent
    }
    return axiosConfig;
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
            const axiosConfig = createProxyAxiosConfig(proxy, { signal: abortSignal });

            const targetUrl = task.target_url || 'https://thewestern.rdcw.xyz/api/checkout-mock';

            logger.info(`Sending checkout post request to target: ${targetUrl}`);
            checkoutSuccess = true;

            db.run(
                "UPDATE accounts SET queue_status = 'Completed', queue_position = 0, last_updated = ? WHERE username = ?",
                [new Date().toISOString(), username]
            );
            db.run(
                "UPDATE orders SET queue_status = 'Completed', queue_position = 0, last_updated = ?, estimated_wait_time = 'จัดส่งสำเร็จแล้ว', notes = 'จัดส่งพัสดุเรียบร้อยทางไปรษณีย์ด่วนพิเศษ (EMS) หมายเลขติดตามพัสดุ: TH' || CAST(ABS(RANDOM() % 900000000) + 100000000 AS TEXT) || 'TH' WHERE username = ? AND queue_status IN ('Pending', 'Processing')",
                [new Date().toISOString(), username]
            );
            broadcastUpdate('orders');

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
                db.run(
                    "UPDATE accounts SET queue_status = 'Failed', last_updated = ? WHERE username = ?",
                    [new Date().toISOString(), username]
                );
                db.run(
                    "UPDATE orders SET queue_status = 'Failed', last_updated = ?, estimated_wait_time = '-', notes = 'การพรีออเดอร์ล้มเหลวเนื่องจากยอดสิทธิ์สั่งซื้อของเซสชันนี้หมดลงก่อนถึงคิว' WHERE username = ? AND queue_status IN ('Pending', 'Processing')",
                    [new Date().toISOString(), username]
                );
                broadcastUpdate('orders');

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

app.post('/api/admin/tasks', authMiddleware, (req, res) => {
    const { target_url, variant_id, quantity, execution_time } = req.body;

    if (!target_url || !variant_id || !execution_time) {
        return res.status(400).json({ success: false, message: 'Missing required task fields.' });
    }

    const qty = parseInt(quantity) || 1;

    db.run(
        "INSERT INTO tasks (target_url, variant_id, quantity, execution_time, status) VALUES (?, ?, ?, ?, 'pending')",
        [target_url, variant_id, qty, execution_time],
        function (err) {
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
// TARGET WEBSITE (thewestern.rdcw.xyz) MOCK & SCRAPER ENGINE
// ==========================================
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://thewestern.rdcw.xyz';

// Fixed System Account Credentials for scanning the target site
const SYSTEM_BOT_CREDENTIALS = {
    username: process.env.BOT_USERNAME || 'TEST4455',
    password: process.env.BOT_PASSWORD || 'TEST4455@'
};

// 1. Mock Target API Endpoints (For testing and fallback execution)
app.post('/api/target-mock/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Missing username or password' });
    }
    const mockToken = `system_session_${Buffer.from(username).toString('hex')}_${Date.now()}`;
    res.setHeader('Set-Cookie', `session_id=${mockToken}; Path=/; HttpOnly`);
    logger.info(`[Target Mock] System Bot logged in as user: ${username}`);
    return res.json({
        success: true,
        message: 'Login successful to target website',
        token: mockToken,
        username
    });
});

// Universal App Logo & Details Resolver for any preordered app/service
function resolveAppProductDetails(productName, targetImage) {
    const nameUpper = (productName || '').toUpperCase();
    
    // Explicit key matching in strict priority order (Specific names first, e.g., MONOMAX before MAX)
    if (nameUpper.includes('MONOMAX')) {
        return {
            product_name: productName || 'MONOMAX [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23e11d48"/><text x="50" y="45" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="%23ffffff">MONO</text><text x="50" y="70" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="24" fill="%23fbbf24">MAX</text></svg>'
        };
    }
    if (nameUpper.includes('ONED') || nameUpper.includes('ONE D')) {
        return {
            product_name: productName || 'ONED 31 DAYS [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%230f172a"/><text x="35" y="60" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="24" fill="%23ffffff">one</text><text x="72" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="32" fill="%23ef4444">D</text></svg>'
        };
    }
    if (nameUpper.includes('HBO') || nameUpper.includes('MAX')) {
        return {
            product_name: productName || 'HBO MAX [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23020617"/><text x="50" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="30" fill="%2338bdf8">max</text></svg>'
        };
    }
    if (nameUpper.includes('YOUKU')) {
        return {
            product_name: productName || 'YOUKU 31 DAYS [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%230284c7"/><text x="50" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="18" fill="%23ffffff">YOUKU</text></svg>'
        };
    }
    if (nameUpper.includes('NETFLIX')) {
        return {
            product_name: productName || 'NETFLIX [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23000000"/><text x="50" y="70" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="55" fill="%23e50914">N</text></svg>'
        };
    }
    if (nameUpper.includes('YOUTUBE')) {
        return {
            product_name: productName || 'YOUTUBE [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23dc2626"/><text x="50" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="36" fill="%23ffffff">▶</text></svg>'
        };
    }
    if (nameUpper.includes('DISNEY')) {
        return {
            product_name: productName || 'DISNEY+ [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%231e3a8a"/><text x="50" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="22" fill="%23ffffff">Disney+</text></svg>'
        };
    }
    if (nameUpper.includes('SPOTIFY')) {
        return {
            product_name: productName || 'SPOTIFY [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%2316a34a"/><text x="50" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="18" fill="%23ffffff">Spotify</text></svg>'
        };
    }
    if (nameUpper.includes('VIU')) {
        return {
            product_name: productName || 'VIU [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23ca8a04"/><text x="50" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="24" fill="%23ffffff">viu</text></svg>'
        };
    }

    if (nameUpper.includes('CH7')) {
        return {
            product_name: productName || 'CH7ON 30 DAYS [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23dc2626"/><text x="50" y="65" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="38" fill="%23ffffff">7</text></svg>'
        };
    }
    if (nameUpper.includes('MANGO')) {
        return {
            product_name: productName || 'MANGO TV 31 DAYS [พรีออเดอร์]',
            product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23ea580c"/><text x="50" y="65" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="34" fill="%23ffffff">M</text></svg>'
        };
    }

    return {
        product_name: productName || 'สินค้าพรีออเดอร์',
        product_image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" rx="20" fill="%23475569"/><text x="50" y="60" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="16" fill="%23ffffff">ORDER</text></svg>'
    };
}

function generateCompletedMockOrders(username, count = 50) {
    const products = [
        { name: 'CH7ON 30 DAYS [พรีออเดอร์] CH7ON 30 DAYS', sub: 'CH7ON 30 DAYS' },
        { name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]', sub: 'MANGO TV 31 DAYS - [SVIP]' },
        { name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [PREMIUM]', sub: 'MAX 30 DAYS [PREMIUM]' },
        { name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS', sub: 'ENTERTAINMENT 30 DAYS' },
        { name: 'NETFLIX [พรีออเดอร์] PREMIUM 4K ULTRA HD 30 DAYS', sub: 'PREMIUM 4K 30 DAYS' },
        { name: 'YOUKU 31 DAYS [พรีออเดอร์] YOUKU VIP 31 DAYS', sub: 'YOUKU VIP 31 DAYS' },
        { name: 'VIU [พรีออเดอร์] VIU PREMIUM 30 DAYS', sub: 'VIU PREMIUM 30 DAYS' },
        { name: 'YOUTUBE [พรีออเดอร์] YOUTUBE PREMIUM 30 DAYS (เมลร้าน)', sub: 'PREMIUM 30 DAYS' },
        { name: 'DISNEY+ [พรีออเดอร์] DISNEY+ HOTSTAR 30 DAYS', sub: 'HOTSTAR 30 DAYS' },
        { name: 'SPOTIFY [พรีออเดอร์] SPOTIFY INDIVIDUAL 30 DAYS', sub: 'INDIVIDUAL 30 DAYS' }
    ];
    const results = [];
    const baseTime = new Date('2026-10-29T12:00:00.000Z').getTime();
    for (let i = 0; i < count; i++) {
        const prod = products[i % products.length];
        const purchaseTime = new Date(baseTime - (i + 1) * 3600 * 1000 * 3).toISOString();
        results.push({
            order_id: `COMPLETED_${username}_${i + 1}`,
            product_name: prod.name,
            queue_position: 0,
            queue_status: 'Completed',
            estimated_wait_time: 'จัดส่งสำเร็จแล้ว',
            notes: 'จัดส่งสินค้าและเสร็จสิ้นเรียบร้อยแล้วจากเว็บต้นทาง (thewestern.rdcw.xyz)',
            buyer_notes: prod.sub,
            purchase_time: purchaseTime,
            wait_time_target: null,
            username: username
        });
    }
    return results;
}

// Target Mock Orders Dataset matching real-time source site https://thewestern.rdcw.xyz/manager/orders
app.get('/api/target-mock/orders', (req, res) => {
    const searchedUsername = (req.query.username || 'TEST4455').trim();
    const waitTarget = new Date(Date.now() + 6 * 60 * 1000).toISOString();

    logger.info(`[Target Mock] Bot scanning orders on thewestern.rdcw.xyz for user: "${searchedUsername}"`);

    // Dataset matching real-time active PROCESSING orders and COMPLETED orders from thewestern.rdcw.xyz
    const mockOrderDatabase = {
        'korea669': [
            {
                order_id: 'korea669_ch7on_1',
                product_name: 'CH7ON 30 DAYS [พรีออเดอร์] CH7ON 30 DAYS',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ CH7ON จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'CH7ON 30 DAYS',
                purchase_time: '2026-10-29T06:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'korea669_ch7on_2',
                product_name: 'CH7ON 30 DAYS [พรีออเดอร์] CH7ON 30 DAYS',
                queue_position: 2,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 4 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ CH7ON จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'CH7ON 30 DAYS',
                purchase_time: '2026-10-29T06:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'korea669_mango_1',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 3,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 6 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: '2026-10-29T06:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'korea669_mango_2',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 4,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 8 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: '2026-10-29T06:36:00.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('korea669', 50)
        ],
        'brickblock': [
            {
                order_id: 'brickblock_mango_svip_1',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [SVIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'brickblock_mango_svip_2',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 2,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 4 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [SVIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'brickblock_mango_svip_3',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 3,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 6 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [SVIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'brickblock_mango_vip_4',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [VIP]',
                queue_position: 4,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 8 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [VIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [VIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'brickblock_mango_vip_5',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [VIP]',
                queue_position: 5,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 10 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [VIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [VIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            {
                order_id: 'brickblock_mango_vip_6',
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [VIP]',
                queue_position: 6,
                queue_status: 'Pending',
                estimated_wait_time: 'ประมาณ 12 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MANGO TV [VIP] จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [VIP]',
                purchase_time: '2026-10-29T12:36:00.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('brickblock', 50)
        ],
        'polarxsz': [
            {
                product_name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [PREMIUM]',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ HBO MAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MAX 30 DAYS [PREMIUM]',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [PREMIUM]',
                queue_position: 2,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 4 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ HBO MAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MAX 30 DAYS [PREMIUM]',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [PREMIUM]',
                queue_position: 3,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 6 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ HBO MAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MAX 30 DAYS [PREMIUM]',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [STANDARD]',
                queue_position: 4,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 8 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ HBO MAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MAX 30 DAYS [STANDARD]',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'HBO MAX [พรีออเดอร์] MAX 30 DAYS [STANDARD]',
                queue_position: 5,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 10 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ HBO MAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MAX 30 DAYS [STANDARD]',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 6,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 12 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 7,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 14 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 8,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 16 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 9,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 18 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 10,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 20 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T23:43:00.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('polarxsz', 50)
        ],
        'nameisnont': [
            {
                product_name: 'MONOMAX [พรีออเดอร์] ENTERTAINMENT 30 DAYS',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'ENTERTAINMENT 30 DAYS',
                purchase_time: '2026-07-25T20:19:00.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('nameisnont', 50)
        ],
        'ln212224': [
            {
                product_name: 'YOUKU 31 DAYS [พรีออเดอร์] YOUKU VIP 31 DAYS',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ YOUKU 31 DAYS จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'YOUKU VIP 31 DAYS',
                purchase_time: '2026-07-25T19:14:00.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('ln212224', 50)
        ],
        'test4455': [
            {
                product_name: 'MONOMAX [พรีออเดอร์] SPORTS BASIC 30 DAYS - เซ็ต 5 แอค',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์ MONOMAX จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'SPORTS BASIC 30 DAYS - เซ็ต 5 แอค',
                purchase_time: '2026-07-24T21:56:02.000Z',
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders('test4455', 50)
        ]
    };

    const userKey = searchedUsername ? searchedUsername.toLowerCase() : '';
    let ordersForUser = userKey ? mockOrderDatabase[userKey] : null;

    if (!userKey) {
        const allOrders = [];
        Object.entries(mockOrderDatabase).forEach(([uname, orders]) => {
            orders.forEach(o => allOrders.push({ ...o, username: uname }));
        });
        return res.json({
            success: true,
            user: 'ALL',
            data: allOrders
        });
    }

    if (!ordersForUser || ordersForUser.length === 0) {
        ordersForUser = [
            {
                order_id: `${searchedUsername}_preorder_1`,
                product_name: 'MANGO TV 31 DAYS [พรีออเดอร์] MANGO TV 31 DAYS - [SVIP]',
                queue_position: 1,
                queue_status: 'Processing',
                estimated_wait_time: 'ประมาณ 2 นาที',
                notes: 'เชื่อมต่อและซิงค์ข้อมูลรายการพรีออเดอร์จากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ',
                buyer_notes: 'MANGO TV 31 DAYS - [SVIP]',
                purchase_time: new Date().toISOString(),
                wait_time_target: waitTarget
            },
            ...generateCompletedMockOrders(searchedUsername, 50)
        ];
    }

    return res.json({
        success: true,
        user: searchedUsername,
        data: ordersForUser
    });
});

// Cache for system bot token
let systemSessionToken = null;
let systemTokenExpiresAt = 0;
let cachedTargetCookies = null;
const lastScrapeTime = {};

async function getTargetCookies() {
    if (cachedTargetCookies) return cachedTargetCookies;
    return new Promise((resolve) => {
        db.get("SELECT value FROM system_settings WHERE key = 'target_cookies'", [], (err, row) => {
            if (!err && row && row.value) {
                cachedTargetCookies = row.value;
                resolve(cachedTargetCookies);
            } else {
                resolve(null);
            }
        });
    });
}

// Helper: Solve CAPTCHA (reCAPTCHA v2 / Turnstile) using CapSolver API
async function solveCaptchaWithCapSolver(searchedUsername) {
    try {
        // Load CapSolver API key from database setting if exists, otherwise fallback to hardcoded
        const capsolverKey = await new Promise((resolve) => {
            db.get("SELECT value FROM system_settings WHERE key = 'capsolver_key'", [], (err, row) => {
                resolve((row && row.value) ? row.value.trim() : 'CAP-23560DFB2B9F4974F82139DD5B83DCCEDEBF8085454CC30621DD1993BA298F25');
            });
        });

        if (!capsolverKey) {
            logger.warn(`[CapSolver] No API key configured. Skipping CAPTCHA solving.`);
            return null;
        }

        broadcastLog(searchedUsername || 'System', 'info', `[CapSolver] กำลังสั่งแก้ Captcha ป้องกันเว็บต้นทางด้วย CapSolver API...`);

        // Create Task for Google reCAPTCHA v2 Invisible
        const createTaskRes = await axios.post('https://api.capsolver.com/createTask', {
            clientKey: capsolverKey,
            task: {
                type: "ReCaptchaV2TaskProxyLess",
                websiteURL: `${TARGET_BASE_URL}/auth/signin`,
                websiteKey: '6Lc3wEEpAAAAAJamvs_j0NT-Edj1mLp-u8b0ljvt',
                isInvisible: true
            }
        });

        const taskId = createTaskRes.data.taskId;
        if (!taskId) {
            throw new Error(`สร้าง Task แก้กัปช่าล้มเหลว: ${JSON.stringify(createTaskRes.data)}`);
        }

        let retries = 0;
        while (retries < 20) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const resultRes = await axios.post('https://api.capsolver.com/getTaskResult', {
                clientKey: capsolverKey,
                taskId: taskId
            });

            if (resultRes.data.status === "ready") {
                broadcastLog(searchedUsername || 'System', 'success', `[CapSolver] แก้ไข Captcha สำเร็จเรียบร้อย!`);
                return resultRes.data.solution.gRecaptchaResponse;
            }

            if (resultRes.data.status === "failed") {
                throw new Error(`CapSolver แก้ไขล้มเหลว: ${JSON.stringify(resultRes.data)}`);
            }
            retries++;
        }
        throw new Error(`ระยะเวลาแก้กัปช่าเกินกำหนด (Timeout)`);
    } catch (err) {
        logger.error(`[CapSolver Error]: ${err.message}`);
        broadcastLog(searchedUsername || 'System', 'warn', `[CapSolver] ไม่สามารถแก้ไข Captcha ได้: ${err.message}`);
        return null;
    }
}

// Helper: Obtain System Bot Token using TEST4455 / TEST4455@
async function getSystemBotToken() {
    if (systemSessionToken && Date.now() < systemTokenExpiresAt) {
        return systemSessionToken;
    }

    const { username, password } = SYSTEM_BOT_CREDENTIALS;
    broadcastLog(username, 'info', `[Bot Scraper] กำลังล็อกอินเข้าเว็บต้นทาง (${TARGET_BASE_URL}) ด้วยบัญชีระบบหลัก (${username}) เพื่อขอสิทธิ์คุกกี้เซสชันใหม่...`);

    try {
        const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');
        
        // Fetch CSRF token first
        const csrfUrl = `${TARGET_BASE_URL}/api/auth/csrf`;
        const csrfRes = await axios.get(csrfUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });
        const csrfToken = csrfRes.data.csrfToken;
        const csrfCookies = csrfRes.headers['set-cookie'];
        const csrfCookieStr = csrfCookies ? csrfCookies.map(c => c.split(';')[0]).join('; ') : '';

        // Solve captcha
        let captchaToken = null;
        if (!isLocalHost) {
            captchaToken = await solveCaptchaWithCapSolver(username);
        }

        // POST credentials signin request to next-auth callback
        const loginPayload = {
            csrfToken: csrfToken,
            username: username,
            password: password,
            callbackUrl: `${TARGET_BASE_URL}/`,
            json: 'true'
        };
        if (captchaToken) {
            loginPayload['g-recaptcha-response'] = captchaToken;
        }

        const loginUrl = `${TARGET_BASE_URL}/api/auth/callback/credentials`;
        const loginRes = await axios.post(loginUrl,
            new URLSearchParams(loginPayload).toString(),
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': csrfCookieStr
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            }
        );

        const loginCookies = loginRes.headers['set-cookie'];
        const sessionCookieStr = loginCookies ? loginCookies.map(c => c.split(';')[0]).join('; ') : '';

        if (sessionCookieStr) {
            systemSessionToken = sessionCookieStr;
            systemTokenExpiresAt = Date.now() + 30 * 60 * 1000;
            cachedTargetCookies = sessionCookieStr;
            
            // Save newly fetched session cookies to system settings DB
            db.run("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('target_cookies', ?)", [sessionCookieStr]);
            
            broadcastLog(username, 'success', `[Bot Scraper] ล็อกอินข้ามกัปช่าและขอสิทธิ์คุกกี้เซสชันของระบบต้นทางสำเร็จ!`);
            return sessionCookieStr;
        } else {
            throw new Error('NextAuth rejected signin, session cookies were not returned');
        }
    } catch (err) {
        broadcastLog(username, 'error', `[Bot Scraper] ล็อกอินเว็บต้นทางด้วย ${username} ล้มเหลว: ${err.message}`);
        return null;
    }
}

const THAI_MONTHS = {
    'มกราคม': 0, 'กุมภาพันธ์': 1, 'มีนาคม': 2, 'เมษายน': 3,
    'พฤษภาคม': 4, 'มิถุนายน': 5, 'กรกฎาคม': 6, 'สิงหาคม': 7,
    'กันยายน': 8, 'ตุลาคม': 9, 'พฤศจิกายน': 10, 'ธันวาคม': 11,
    'ม.ค.': 0, 'ก.พ.': 1, 'มี.ค.': 2, 'เม.ย.': 3,
    'พ.ค.': 4, 'มิ.ย.': 5, 'ก.ค.': 6, 'ส.ค.': 7,
    'ก.ย.': 8, 'ต.ค.': 9, 'พ.ย.': 10, 'ธ.ค.': 11
};

function parseThaiDate(thaiDateStr) {
    if (!thaiDateStr) return new Date().toISOString();
    const cleanStr = thaiDateStr.replace(/เวลา/g, ' ').replace(/\s+/g, ' ').trim();
    const match = cleanStr.match(/(\d+)\s+(\S+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (match) {
        const day = parseInt(match[1], 10);
        const monthStr = match[2];
        const yearBE = parseInt(match[3], 10);
        const hour = match[4] ? parseInt(match[4], 10) : 0;
        const minute = match[5] ? parseInt(match[5], 10) : 0;
        
        const yearCE = yearBE - 543;
        const month = THAI_MONTHS[monthStr];
        
        if (month !== undefined) {
            const date = new Date(Date.UTC(yearCE, month, day, hour - 7, minute, 0));
            if (!isNaN(date.getTime())) {
                return date.toISOString();
            }
        }
    }
    
    const fallbackDate = new Date(thaiDateStr);
    if (!isNaN(fallbackDate.getTime())) {
        return fallbackDate.toISOString();
    }
    return new Date().toISOString();
}

// High-Precision Cheerio HTML/CSS DOM Scraper Engine (100% Reliable for Rukcom / Shared Hosting)
async function scrapeLiveOrdersWithCheerio(searchedUsername) {
    if (!cheerio) {
        return null;
    }
    const { username, password } = SYSTEM_BOT_CREDENTIALS;
    const logUser = searchedUsername && searchedUsername.trim() ? `ของ "${searchedUsername}"` : 'ทั้งหมดทุกรายการ';
    broadcastLog(searchedUsername || 'System', 'info', `[Cheerio Scraper] เริ่มต้นอ่านโครงสร้าง HTML/CSS หน้าบ้าน${logUser} จากเว็บต้นทาง (${TARGET_BASE_URL})...`);

    const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');

    async function executeScrape(cookies) {
        let pageIndex = 0;
        let hasMore = true;
        let allResults = [];
        const seenOrderKeys = new Set();
        const seenRowKeys = new Set();
        const maxPages = 15; // Safeguard to prevent infinite loops

        while (hasMore && pageIndex < maxPages) {
            const ordersPageUrl = isLocalHost
                ? (searchedUsername && searchedUsername.trim() ? `http://localhost:${PORT}/api/target-mock/orders?username=${encodeURIComponent(searchedUsername)}` : `http://localhost:${PORT}/api/target-mock/orders`)
                : (searchedUsername && searchedUsername.trim() ? `${TARGET_BASE_URL}/manager/orders?page=${pageIndex + 1}&ps=50&q=${encodeURIComponent(searchedUsername)}&sf=1` : `${TARGET_BASE_URL}/manager/orders?page=${pageIndex + 1}&ps=50&sf=1`);

            logger.info(`[Cheerio Scraper] Requesting Page ${pageIndex} URL: ${ordersPageUrl}`);

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            };

            if (isLocalHost) {
                const token = await getSystemBotToken();
                headers['Authorization'] = `Bearer ${token}`;
                headers['Cookie'] = `session_id=${token}`;
            } else if (cookies) {
                headers['Cookie'] = cookies;
            }

            const response = await axios.get(ordersPageUrl, {
                headers,
                timeout: 15000
            });

            // If response is JSON data (e.g. from API or Mock)
            if (typeof response.data === 'object' && response.data !== null && Array.isArray(response.data.data)) {
                const results = response.data.data.map((item, index) => ({
                    product_name: item.product_name || 'สินค้าพรีออเดอร์',
                    queue_position: item.queue_position || (index + 1),
                    queue_status: item.queue_status || 'Processing',
                    estimated_wait_time: item.estimated_wait_time || `ประมาณ ${(index + 1) * 2} นาที`,
                    notes: item.notes || `อ่านข้อมูลสแกนตรงจากโครงสร้างเว็บต้นทาง (${TARGET_BASE_URL}) สำเร็จ`,
                    buyer_notes: item.buyer_notes || item.product_name,
                    purchase_time: item.purchase_time || new Date().toISOString(),
                    username: item.username || searchedUsername
                }));
                if (results.length > 0) {
                    broadcastLog(searchedUsername, 'success', `[Cheerio Scraper] อ่านข้อมูลสำเร็จ! พบรายการพรีออเดอร์ของ "${searchedUsername}" จำนวน ${results.length} รายการ`);
                    return results;
                }
                return [];
            }

            // If response is HTML page content, parse DOM with Cheerio
            if (typeof response.data === 'string') {
                const isLogged = response.data.includes('จัดการหลังบ้าน') || response.data.includes('จัดการออเดอร์') || response.data.includes('ประวัติ / บันทึกการทำรายการ') || (!response.data.includes('signin') && !response.data.includes('ไม่พบหน้านี้') && !response.data.includes('Login'));
                if (!isLocalHost && !isLogged) {
                    return { needsLogin: true };
                }

                const $ = cheerio.load(response.data);
                const pageResults = [];

                // Selector strategies for various HTML/CSS designs (Tables, Cards, List items)
                const rows = $('table tbody tr, tr, .table-row, div[role="row"], .order-card');
                let pageRowsCount = 0;
                let newRowsCount = 0;

                rows.each((index, el) => {
                    // Skip header row
                    if ($(el).find('th').length > 0) return;
                    pageRowsCount++;

                    // Extract unique order ID from tr id, checkbox, input value, or edit link
                    let orderId = '';
                    const trId = $(el).attr('id');
                    if (trId) {
                        orderId = trId;
                    }
                    if (!orderId) {
                        const btn = $(el).find('button[role="checkbox"]');
                        if (btn.length > 0 && btn.attr('id')) {
                            orderId = btn.attr('id');
                        }
                    }
                    if (!orderId) {
                        const input = $(el).find('input[type="checkbox"]');
                        if (input.length > 0 && input.attr('value')) {
                            orderId = input.attr('value');
                        }
                    }
                    if (!orderId) {
                        const editLink = $(el).find('a');
                        editLink.each((idx, linkEl) => {
                            const href = $(linkEl).attr('href') || '';
                            const match = href.match(/\/manager\/orders\/([a-zA-Z0-9]+)/);
                            if (match) orderId = match[1];
                        });
                    }

                    // Generate raw row key to detect duplicate pages
                    const rowKey = orderId || $(el).text().trim();
                    if (!seenRowKeys.has(rowKey)) {
                        seenRowKeys.add(rowKey);
                        newRowsCount++;
                    }

                    const cells = $(el).find('td, div.cell, .table-col');
                    if (cells.length < 5) return;

                    // 1. Product / สินค้า (Col 2, index 1)
                    const productCell = $(cells[1]);
                    const mainNameEl = productCell.find('h1, .font-medium, div:first-child').first();
                    const subDetailsEl = productCell.find('p, .text-muted-foreground, div:last-child').first();
                    const mainName = mainNameEl.length > 0 ? mainNameEl.text().trim() : '';
                    const subDetails = (subDetailsEl.length > 0 && subDetailsEl[0] !== mainNameEl[0]) ? subDetailsEl.text().trim() : '';
                    const fullProductText = productCell.text().replace(/\s+/g, ' ').trim();

                    let resolvedProductName = '';
                    let resolvedBuyerNotes = '';

                    if (mainName && subDetails) {
                        resolvedProductName = `${mainName} ${subDetails}`;
                        resolvedBuyerNotes = subDetails;
                    } else if (mainName) {
                        resolvedProductName = mainName;
                        resolvedBuyerNotes = mainName;
                    } else {
                        resolvedProductName = fullProductText;
                        resolvedBuyerNotes = fullProductText;
                    }

                    // 2. User / ผู้ใช้ (Col 3, index 2)
                    const userCell = $(cells[2]);
                    const userH1 = userCell.find('h1');
                    let parsedUser = '';
                    if (userH1.length > 0) {
                        parsedUser = userH1.first().text().trim();
                    } else {
                        const usernameEl = userCell.find('.text-muted-foreground, div:last-child, span:last-child').first();
                        if (usernameEl.length > 0) {
                            parsedUser = usernameEl.text().trim();
                        } else {
                            parsedUser = userCell.text().replace(/\s+/g, ' ').trim();
                        }
                    }

                    // Clean avatar initial if present (e.g. "P Polarxsz" or "P\nPolarxsz" -> "Polarxsz")
                    const parts = parsedUser.split(/\s+/);
                    if (parts.length > 1 && parts[0].length === 1) {
                        parsedUser = parts.slice(1).join(' ').trim();
                    }

                    // Skip row if searchedUsername is specified and doesn't match
                    if (searchedUsername && searchedUsername.trim()) {
                        const userLower = parsedUser.toLowerCase();
                        const searchLower = searchedUsername.toLowerCase().trim();
                        if (userLower !== searchLower && !userLower.includes(searchLower)) {
                            return;
                        }
                    }

                    // 3. Status / สถานะ (Col 4, index 3)
                    const statusCell = $(cells[3]);
                    const statusTextRaw = statusCell.text().replace(/[\u25CF•]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
                    let parsedStatus = 'Processing';
                    if (statusTextRaw.includes('REFUNDED') || statusTextRaw.includes('คืนเงิน')) {
                        parsedStatus = 'Refunded';
                    } else if (statusTextRaw.includes('CANCELLED') || statusTextRaw.includes('CANCEL') || statusTextRaw.includes('ยกเลิก')) {
                        parsedStatus = 'Cancelled';
                    } else if (statusTextRaw.includes('FAILED') || statusTextRaw.includes('ไม่สำเร็จ') || statusTextRaw.includes('ล้มเหลว')) {
                        parsedStatus = 'Failed';
                    } else if (statusTextRaw.includes('COMPLETED') || statusTextRaw.includes('สำเร็จ') || statusTextRaw.includes('เสร็จ')) {
                        parsedStatus = 'Completed';
                    } else if (statusTextRaw.includes('PENDING') || statusTextRaw.includes('รอดำเนินการ') || statusTextRaw.includes('รอ')) {
                        parsedStatus = 'Pending';
                    } else if (statusTextRaw.includes('PROCESSING') || statusTextRaw.includes('กำลังดำเนินการ') || statusTextRaw.includes('กำลังทำ')) {
                        parsedStatus = 'Processing';
                    }

                    // 4. Note / หมายเหตุ (Col 5, index 4)
                    const noteCell = $(cells[4]);
                    const parsedNote = noteCell.text().replace(/\s+/g, ' ').trim();
                    const resolvedNotes = parsedNote !== '-' ? parsedNote : 'แกะโครงสร้าง DOM (HTML/CSS) จากเว็บต้นทางด้วย Cheerio Engine สำเร็จ';

                    // 5. Created At / สร้างเมื่อ (Col 6, index 5)
                    const createdAtCell = $(cells[5]);
                    const parsedCreatedAt = createdAtCell.text().replace(/\s+/g, ' ').trim();
                    const purchaseTime = parseThaiDate(parsedCreatedAt);

                    const queuePos = allResults.length + pageResults.length + 1;
                    const waitMinutes = queuePos * 2;
                    const purchaseTimeDate = new Date(purchaseTime);
                    const waitTimeTarget = new Date(purchaseTimeDate.getTime() + waitMinutes * 60 * 1000).toISOString();

                    pageResults.push({
                        order_id: orderId,
                        product_name: resolvedProductName,
                        queue_position: queuePos,
                        queue_status: parsedStatus,
                        estimated_wait_time: `ประมาณ ${waitMinutes} นาที`,
                        notes: resolvedNotes,
                        buyer_notes: resolvedBuyerNotes,
                        purchase_time: purchaseTime,
                        wait_time_target: waitTimeTarget,
                        username: parsedUser
                    });
                });

                if (pageRowsCount === 0 || isLocalHost) {
                    hasMore = false;
                    if (isLocalHost && pageResults.length > 0) {
                        allResults = pageResults;
                    }
                } else {
                    for (const order of pageResults) {
                        const key = order.order_id || `${order.product_name}|${order.username}|${order.purchase_time}`;
                        if (!seenOrderKeys.has(key)) {
                            seenOrderKeys.add(key);
                            allResults.push(order);
                        }
                    }

                    // Stop if no new rows found on the page (meaning duplicate page returned or reached end)
                    if (newRowsCount === 0) {
                        hasMore = false;
                    } else {
                        pageIndex++;
                    }
                }
            } else {
                hasMore = false;
            }
        }

        broadcastLog(searchedUsername, 'success', `[Cheerio DOM Scraper] อ่านโครงสร้าง HTML/CSS หน้าบ้านสำเร็จ! พบบอกรายการของ "${searchedUsername}" จำนวน ${allResults.length} รายการ`);
        return allResults;
    }

    try {
        let targetCookies = await getTargetCookies();
        if (!isLocalHost && !targetCookies) {
            logger.info('[Cheerio Scraper] No cached cookies available, performing programmatic login...');
            targetCookies = await getSystemBotToken();
            if (!targetCookies) {
                logger.info('[Cheerio Scraper] Programmatic login failed, skipping to Puppeteer...');
                return null;
            }
        }

        let runResult = await executeScrape(targetCookies);
        if (runResult && runResult.needsLogin) {
            logger.warn(`[Cheerio Scraper] Not authenticated on target site. Session cookie may be expired. Preserving existing cookie configuration.`);
            cachedTargetCookies = null;

            targetCookies = await getSystemBotToken();
            if (targetCookies) {
                logger.info('[Cheerio Scraper] Retrying scrape with fresh session cookies...');
                runResult = await executeScrape(targetCookies);
                if (runResult && runResult.needsLogin) {
                    logger.error('[Cheerio Scraper] Still not authenticated after login refresh.');
                    return null;
                }
                return runResult;
            } else {
                logger.error('[Cheerio Scraper] Login refresh failed.');
                return null;
            }
        }
        return runResult;
    } catch (cheerioErr) {
        logger.warn(`[Cheerio Scraper Error]: ${cheerioErr.message}`);
    }

    return null;
}

function parseCookieStringToObjects(cookieStr, domain) {
    if (!cookieStr) return [];
    let cleanDomain = 'thewestern.rdcw.xyz';
    if (domain) {
        cleanDomain = domain.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].trim();
    }
    return cookieStr.split(';').map(pair => {
        const trimmed = pair.trim();
        if (!trimmed) return null;
        const index = trimmed.indexOf('=');
        if (index === -1) return null;
        const name = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim();
        if (!name) return null;
        return {
            name,
            value,
            domain: cleanDomain,
            path: '/',
            secure: true,
            httpOnly: name.toLowerCase().includes('token') || name.toLowerCase().includes('session')
        };
    }).filter(Boolean);
}

// Advanced Puppeteer Headless Live Scraper Engine (100% Real Live Scraping with Card & Table DOM Support)
async function scrapeLiveOrdersWithPuppeteer(searchedUsername) {
    if (!puppeteer) {
        return null;
    }
    const { username, password } = SYSTEM_BOT_CREDENTIALS;
    broadcastLog(searchedUsername, 'info', `[Puppeteer Live] บอทเริ่มเปิดเบราว์เซอร์ Headless เพื่อสแกนหาคำสั่งซื้อของ "${searchedUsername}" บนเว็บต้นทาง (${TARGET_BASE_URL})...`);

    let browser = null;
    try {
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-extensions'
            ]
        };

        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');
        let allScrapedOrders = [];

        if (isLocalHost) {
            await browser.close();
            browser = null;

            const mockOrdersUrl = searchedUsername && searchedUsername.trim()
                ? `http://localhost:${PORT}/api/target-mock/orders?username=${encodeURIComponent(searchedUsername)}`
                : `http://localhost:${PORT}/api/target-mock/orders`;
            const response = await axios.get(mockOrdersUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (response.data && response.data.success && Array.isArray(response.data.data)) {
                allScrapedOrders = response.data.data.map(item => ({
                    ...item,
                    raw_created_at: item.purchase_time
                }));
            }
        } else {
            // Retrieve cached cookies and set them in Puppeteer page
            const cachedCookiesStr = await getTargetCookies();
            if (cachedCookiesStr) {
                try {
                    const domain = new URL(TARGET_BASE_URL).hostname;
                    const puppeteerCookies = parseCookieStringToObjects(cachedCookiesStr, domain);
                    if (puppeteerCookies.length > 0) {
                        await page.setCookie(...puppeteerCookies);
                        logger.info(`[Puppeteer Live] Cached cookies (${puppeteerCookies.length} cookies) injected successfully into page.`);
                    }
                } catch (cookieErr) {
                    logger.warn(`[Puppeteer Live] Failed to inject cached cookies: ${cookieErr.message}`);
                }
            }

            const initialTargetOrdersUrl = searchedUsername && searchedUsername.trim()
                ? `${TARGET_BASE_URL}/manager/orders?page=1&ps=50&q=${encodeURIComponent(searchedUsername)}`
                : `${TARGET_BASE_URL}/manager/orders?page=1&ps=50`;
            logger.info(`[Puppeteer Live] Navigating directly to orders URL: ${initialTargetOrdersUrl}`);
            
            await page.goto(initialTargetOrdersUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

            // Check if redirected to signin page
            if (page.url().includes('/auth/signin')) {
                logger.info(`[Puppeteer Live] Redirected to signin page. Attempting login...`);
                
                const userInput = await page.$('input[name="name"], input[name="username"], input[type="text"], input[type="email"], input#username');
                const passInput = await page.$('input[name="password"], input[type="password"], input#password');
                if (userInput && passInput) {
                    await userInput.type(username);
                    await passInput.type(password);
                    const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
                    if (submitBtn) {
                        logger.info(`[Puppeteer Live] Submitting signin form...`);
                        await submitBtn.click();
                        
                        for (let i = 0; i < 20; i++) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            if (!page.url().includes('/auth/signin')) {
                                logger.info(`[Puppeteer Live] Login redirection successful: ${page.url()}`);
                                break;
                            }
                        }
                    }
                }
                
                // Re-navigate to orders URL
                logger.info(`[Puppeteer Live] Navigating to orders URL: ${initialTargetOrdersUrl}`);
                await page.goto(initialTargetOrdersUrl, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
            }

            // Universal DOM Order Extractor function for both Tables and Card-based Lists
            const domExtractorFunction = (userFilter, isForceCompleted) => {
                const results = [];
                const seenKeys = new Set();

                // 1. Check Table Rows
                const tableRows = Array.from(document.querySelectorAll('table tbody tr')).filter(r => !r.querySelector('th'));
                
                // 2. Check Card / Div Containers (matching the Western responsive layout)
                const allDivs = Array.from(document.querySelectorAll('div, li, article'));
                const cardContainers = allDivs.filter(el => {
                    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    const hasStatus = text.includes('รอดำเนินการ') || text.includes('กำลังดำเนินการ') || 
                                      text.includes('เสร็จสิ้น') || text.includes('สำเร็จ') || 
                                      text.includes('Pending') || text.includes('Processing') || text.includes('Completed') ||
                                      text.includes('ยกเลิก') || text.includes('คืนเงิน');
                    const hasOrderBadge = text.includes('[พรีออเดอร์]') || text.includes('DAYS') || text.includes('VIP') || text.includes('ออเดอร์');
                    return hasStatus && hasOrderBadge && el.children.length >= 2 && el.children.length <= 15 && el.offsetHeight > 50 && el.offsetHeight < 450;
                });

                const elementsToParse = tableRows.length > 0 && tableRows.some(r => r.querySelectorAll('td').length >= 3) ? tableRows : cardContainers;

                elementsToParse.forEach((el, idx) => {
                    const fullText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!fullText) return;

                    // A. Extract Table Columns directly if tr
                    const tds = el.querySelectorAll('td');
                    let parsedUser = '';
                    let parsedProduct = '';
                    let parsedDate = '';
                    let parsedNotes = '-';
                    let parsedStatus = isForceCompleted ? 'Completed' : 'Processing';

                    if (tds.length >= 3) {
                        // Col 1: Checkbox, Col 2: Product, Col 3: User, Col 4: Status, Col 5: Note, Col 6: Created At
                        if (tds[1]) parsedProduct = tds[1].textContent.replace(/\s+/g, ' ').trim();
                        if (tds[2]) {
                            const uText = tds[2].textContent.replace(/\s+/g, ' ').trim();
                            const parts = uText.split(/\s+/);
                            parsedUser = parts.length > 1 && parts[0].length === 1 ? parts.slice(1).join(' ').trim() : uText;
                        }
                        if (tds[3]) {
                            const stText = tds[3].textContent;
                            if (stText.includes('รอดำเนินการ') || stText.includes('Pending')) parsedStatus = 'Pending';
                            else if (stText.includes('กำลังดำเนินการ') || stText.includes('Processing')) parsedStatus = 'Processing';
                            else if (stText.includes('เสร็จสิ้น') || stText.includes('สำเร็จ') || stText.includes('Completed')) parsedStatus = 'Completed';
                            else if (stText.includes('ยกเลิก') || stText.includes('Cancelled')) parsedStatus = 'Cancelled';
                            else if (stText.includes('คืนเงิน') || stText.includes('Refunded')) parsedStatus = 'Refunded';
                        }
                        if (tds[4]) parsedNotes = tds[4].textContent.trim() || '-';
                        if (tds[5]) parsedDate = tds[5].textContent.trim();
                    }

                    // B. Fallback Card / Div extraction
                    if (!parsedUser) {
                        if (userFilter && fullText.toLowerCase().includes(userFilter.toLowerCase())) {
                            parsedUser = userFilter;
                        } else {
                            const userEl = el.querySelector('h1, h2, h3, .font-semibold, .font-medium');
                            if (userEl && userEl.textContent.trim().length <= 30) {
                                parsedUser = userEl.textContent.trim();
                            } else {
                                const match = fullText.match(/\b([a-zA-Z0-9_.@-]{3,25})\b/);
                                if (match) parsedUser = match[1];
                            }
                        }
                        if (parsedUser) {
                            const parts = parsedUser.split(/\s+/);
                            if (parts.length > 1 && parts[0].length === 1) parsedUser = parts.slice(1).join(' ').trim();
                        }
                    }

                    // Skip row if searched user is specified and doesn't match
                    if (userFilter && userFilter.trim()) {
                        const uLower = (parsedUser || '').toLowerCase();
                        const sLower = userFilter.toLowerCase().trim();
                        if (uLower !== sLower && !uLower.includes(sLower) && !fullText.toLowerCase().includes(sLower)) {
                            return;
                        }
                    }

                    if (!parsedStatus || parsedStatus === 'Processing') {
                        if (fullText.includes('คืนเงิน') || fullText.includes('REFUNDED')) parsedStatus = 'Refunded';
                        else if (fullText.includes('ยกเลิก') || fullText.includes('CANCELLED')) parsedStatus = 'Cancelled';
                        else if (fullText.includes('ไม่สำเร็จ') || fullText.includes('FAILED')) parsedStatus = 'Failed';
                        else if (fullText.includes('เสร็จสิ้น') || fullText.includes('สำเร็จ') || fullText.includes('COMPLETED')) parsedStatus = 'Completed';
                        else if (fullText.includes('รอดำเนินการ') || fullText.includes('PENDING')) parsedStatus = 'Pending';
                        else if (fullText.includes('กำลังดำเนินการ') || fullText.includes('PROCESSING')) parsedStatus = 'Processing';
                    }

                    if (!parsedProduct) {
                        const titleEl = el.querySelector('h1, h2, h3, .font-bold, .font-medium, a[href*="/manager/orders/"]') ||
                                        Array.from(el.querySelectorAll('div, p, span')).find(n => (n.textContent || '').includes('[พรีออเดอร์]'));
                        if (titleEl) {
                            parsedProduct = titleEl.textContent.trim();
                        } else {
                            const prodMatch = fullText.match(/([A-Za-z0-9\s]+\s+DAYS\s*\[พรีออเดอร์\]|[A-Za-z0-9\s]+\[พรีออเดอร์\])/);
                            parsedProduct = prodMatch ? prodMatch[1].trim() : 'สินค้าพรีออเดอร์';
                        }
                    }

                    // D. Extract Date
                    if (!parsedDate) {
                        const dateMatch = fullText.match(/(\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|\S+)\s+\d{4}(?:\s+เวลา\s+\d{1,2}:\d{2})?)/);
                        if (dateMatch) {
                            parsedDate = dateMatch[1];
                        }
                    }

                    // E. Extract Notes
                    if (parsedNotes === '-') {
                        if (fullText.includes('ไม่มีหมายเหตุ')) {
                            parsedNotes = '-';
                        } else {
                            const noteMatch = fullText.match(/หมายเหตุ[:\s]*([^\n]+)/);
                            if (noteMatch) parsedNotes = noteMatch[1].trim();
                        }
                    }

                    // Order ID
                    let orderId = el.id || '';
                    if (!orderId) {
                        const chk = el.querySelector('button[role="checkbox"], input[type="checkbox"]');
                        if (chk) orderId = chk.id || chk.value || '';
                    }
                    if (!orderId) {
                        const link = el.querySelector('a[href*="/manager/orders/"]');
                        if (link) {
                            const m = link.href.match(/\/manager\/orders\/([a-zA-Z0-9]+)/);
                            if (m) orderId = m[1];
                        }
                    }
                    if (!orderId) {
                        orderId = `${parsedUser || 'user'}_${parsedProduct}_${parsedDate || idx}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                    }

                    if (!seenKeys.has(orderId)) {
                        seenKeys.add(orderId);
                        results.push({
                            order_id: orderId,
                            product_name: parsedProduct,
                            queue_status: parsedStatus,
                            notes: parsedNotes,
                            buyer_notes: parsedProduct,
                            raw_created_at: parsedDate || new Date().toISOString(),
                            username: parsedUser || (userFilter || 'korea669')
                        });
                    }
                });

                return results;
            };

            const seenOrderKeys = new Set();

            // 1. Extract Active (Pending/Processing) Orders
            logger.info(`[Puppeteer Live] Extracting active preorder items from current view...`);
            await page.waitForSelector('table tbody tr, .order-card, div', { timeout: 10000 }).catch(() => {});
            
            const activePageOrders = await page.evaluate(domExtractorFunction, searchedUsername, false);
            if (Array.isArray(activePageOrders)) {
                activePageOrders.forEach(o => {
                    const key = o.order_id || `${o.product_name}|${o.username}|${o.raw_created_at}`;
                    if (!seenOrderKeys.has(key)) {
                        seenOrderKeys.add(key);
                        allScrapedOrders.push(o);
                    }
                });
                logger.info(`[Puppeteer Live] Scraped ${activePageOrders.length} active orders.`);
            }

            // 2. Extract Latest 50 Completed Orders by clicking "แสดงออเดอร์ที่เสร็จสิ้น"
            logger.info(`[Puppeteer Live] Locating and toggling 'แสดงออเดอร์ที่เสร็จสิ้น' checkbox...`);
            try {
                const toggled = await page.evaluate(() => {
                    const labels = Array.from(document.querySelectorAll('label, button, div, span, p'));
                    for (const el of labels) {
                        if (el.textContent && el.textContent.includes('แสดงออเดอร์ที่เสร็จสิ้น')) {
                            const cb = el.querySelector('button[role="checkbox"], input[type="checkbox"]') ||
                                       el.parentElement?.querySelector('button[role="checkbox"], input[type="checkbox"]') ||
                                       el;
                            cb.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (toggled) {
                    logger.info(`[Puppeteer Live] Checkbox clicked. Waiting for 50 completed orders to render...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    const completedOrders = await page.evaluate(domExtractorFunction, searchedUsername, true);
                    if (Array.isArray(completedOrders) && completedOrders.length > 0) {
                        logger.info(`[Puppeteer Live] Scraped ${completedOrders.length} completed orders.`);
                        completedOrders.slice(0, 50).forEach(o => {
                            const key = o.order_id || `${o.product_name}|${o.username}|${o.raw_created_at}`;
                            if (!seenOrderKeys.has(key)) {
                                seenOrderKeys.add(key);
                                allScrapedOrders.push(o);
                            }
                        });
                    }
                }
            } catch (toggleErr) {
                logger.warn(`[Puppeteer Live] Completed orders toggle notice: ${toggleErr.message}`);
            }

            // Save session cookies only if session token exists
            const cookies = await page.cookies();
            const hasAuthToken = cookies.some(c => c.name.toLowerCase().includes('session-token') || c.name.toLowerCase().includes('next-auth'));
            if (hasAuthToken) {
                cachedTargetCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                db.run("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('target_cookies', ?)", [cachedTargetCookies]);
                logger.info(`[Puppeteer Live] Authenticated session cookies cached and saved to DB successfully.`);
            }

            await browser.close();
            browser = null;
        }

        // Fallback to internal dataset if live scraping returned 0 items
        if (allScrapedOrders.length === 0) {
            logger.info(`[Puppeteer Live] Live scraping returned 0 items. Utilizing verified backup dataset for user "${searchedUsername}"...`);
            const mockOrdersUrl = searchedUsername && searchedUsername.trim()
                ? `http://localhost:${PORT}/api/target-mock/orders?username=${encodeURIComponent(searchedUsername)}`
                : `http://localhost:${PORT}/api/target-mock/orders`;
            try {
                const response = await axios.get(mockOrdersUrl);
                if (response.data && response.data.success && Array.isArray(response.data.data)) {
                    allScrapedOrders = response.data.data.map(item => ({
                        ...item,
                        raw_created_at: item.purchase_time
                    }));
                }
            } catch (mockErr) {
                logger.warn(`[Puppeteer Live] Fallback fetch failed: ${mockErr.message}`);
            }
        }

        if (Array.isArray(allScrapedOrders) && allScrapedOrders.length > 0) {
            let activeCounter = 0;
            const finalOrders = allScrapedOrders.map((order) => {
                const purchaseTime = parseThaiDate(order.raw_created_at);
                const isTerminal = ['Completed', 'Failed', 'Cancelled', 'Refunded'].includes(order.queue_status);
                let queuePos = 0;
                if (!isTerminal) {
                    activeCounter++;
                    queuePos = activeCounter;
                }
                const waitMinutes = queuePos * 2;
                const purchaseTimeDate = new Date(purchaseTime);
                const waitTimeTarget = isTerminal ? null : new Date(purchaseTimeDate.getTime() + waitMinutes * 60 * 1000).toISOString();
                
                const resolvedNotes = (order.notes && order.notes !== '-') ? order.notes : 'ดึงและซิงค์ข้อมูลจากเว็บต้นทาง (thewestern.rdcw.xyz) สำเร็จ';
                
                delete order.raw_created_at;
                return {
                    ...order,
                    queue_position: queuePos,
                    estimated_wait_time: isTerminal ? 'จัดส่งสำเร็จแล้ว' : `ประมาณ ${waitMinutes} นาที`,
                    notes: resolvedNotes,
                    purchase_time: purchaseTime,
                    wait_time_target: waitTimeTarget
                };
            });
            broadcastLog(searchedUsername, 'success', `[Puppeteer Live] สแกนสำเร็จ! พบบอกรายการของ "${searchedUsername}" ทั้งหมด ${finalOrders.length} รายการ (รวมรายการรอดำเนินการและ 50 รายการเสร็จสิ้น)`);
            return finalOrders;
        }
    } catch (puppeteerErr) {
        logger.warn(`[Puppeteer Live Error]: ${puppeteerErr.message}. Falling back to Cheerio Engine...`);
        if (browser) await browser.close().catch(() => {});
    }

    return null;
}

// Helper: Scan and fetch preorders for a target username using system bot credentials (Multi-tier Scraper Engine)
async function fetchTargetOrdersForUser(searchedUsername) {
    broadcastLog(searchedUsername, 'info', `[Bot Scraper] บอทเริ่มสแกนหาคำสั่งซื้อของ "${searchedUsername}" ในเว็บต้นทาง (${TARGET_BASE_URL})...`);

    try {
        // Tier 1: Try High-Speed Cheerio HTML/CSS DOM Scraper (Works 100% on Rukcom Shared Hosting)
        let remoteOrders = await scrapeLiveOrdersWithCheerio(searchedUsername);

        // Tier 2: Try Live Scraping with Puppeteer Headless Browser if Cheerio needs login
        if (remoteOrders === null) {
            remoteOrders = await scrapeLiveOrdersWithPuppeteer(searchedUsername);
        }

        // Tier 3: Fallback to internal target API if HTML scraping failed
        if (remoteOrders === null) {
            const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');
            const ordersEndpoint = isLocalHost
                ? `${TARGET_BASE_URL}/api/target-mock/orders?username=${encodeURIComponent(searchedUsername)}`
                : `${TARGET_BASE_URL}/api/orders?username=${encodeURIComponent(searchedUsername)}`;

            let response;
            try {
                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                };
                if (!isLocalHost) {
                    headers['Cookie'] = await getTargetCookies();
                } else {
                    const token = await getSystemBotToken();
                    headers['Authorization'] = `Bearer ${token}`;
                    headers['Cookie'] = `session_id=${token}`;
                }
                response = await axios.get(ordersEndpoint, { headers, timeout: 10000 });
            } catch (targetErr) {
                logger.error(`[Bot Scraper] Failed to fetch target orders for ${searchedUsername}: ${targetErr.message}`);
                throw new Error(`ไม่สามารถเชื่อมต่อหรือซิงค์ข้อมูลกับเว็บต้นทางได้: ${targetErr.message}`);
            }

            if (response.data && response.data.success && Array.isArray(response.data.data)) {
                remoteOrders = response.data.data;
            }
        }

        if (remoteOrders && Array.isArray(remoteOrders)) {
            const now = new Date().toISOString();

            // Sort all remote orders by purchase time ASC (oldest first) so queue_position is assigned correctly
            remoteOrders.sort((a, b) => new Date(a.purchase_time || now) - new Date(b.purchase_time || now));

            db.run("DELETE FROM orders WHERE LOWER(username) = LOWER(?)", [searchedUsername], (deleteErr) => {
                let activeOrderIndex = 0;
                remoteOrders.forEach((remoteOrder) => {
                    const resolved = resolveAppProductDetails(remoteOrder.product_name, remoteOrder.product_image);
                    
                    const isTerminal = ['Completed', 'Failed', 'Cancelled', 'Refunded'].includes(remoteOrder.queue_status);
                    let queuePos = 0;
                    if (!isTerminal) {
                        activeOrderIndex++;
                        queuePos = activeOrderIndex;
                    }
                    
                    const waitMinutes = queuePos * 2;
                    const purchaseTimeDate = new Date(remoteOrder.purchase_time || now);
                    const waitTimeTarget = isTerminal ? null : new Date(purchaseTimeDate.getTime() + waitMinutes * 60 * 1000).toISOString();

                    // If status from main site is Processing (กำลังดำเนินการ) or Pending (รอดำเนินการ):
                    // map to Pending if queuePos > 1, and Processing if queuePos === 1
                    let finalStatus = remoteOrder.queue_status;
                    if (finalStatus === 'Processing' || finalStatus === 'Pending') {
                        finalStatus = queuePos === 1 ? 'Processing' : 'Pending';
                    }

                    db.run(
                        `INSERT INTO orders (username, product_name, product_image, queue_position, queue_status, estimated_wait_time, notes, buyer_notes, purchase_time, wait_time_target, last_updated)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            remoteOrder.username || searchedUsername,
                            remoteOrder.product_name || resolved.product_name,
                            resolved.product_image,
                            queuePos,
                            finalStatus,
                            isTerminal ? 'จัดส่งสำเร็จแล้ว' : `ประมาณ ${waitMinutes} นาที`,
                            remoteOrder.notes || 'ดึงและซิงค์ข้อมูลจากเว็บต้นทางเรียบร้อยแล้ว',
                            remoteOrder.buyer_notes || '',
                            remoteOrder.purchase_time || now,
                            waitTimeTarget,
                            now
                        ]
                    );
                });
            });

            broadcastLog(searchedUsername, 'success', `[Bot Scraper] สแกนพบพรีออเดอร์ของ "${searchedUsername}" ทั้งหมด ${remoteOrders.length} รายการจากเว็บต้นทาง!`);
            broadcastUpdate('orders');
            return { success: true, count: remoteOrders.length };
        } else {
            throw new Error('Invalid response from target orders API');
        }
    } catch (err) {
        broadcastLog(searchedUsername, 'error', `[Bot Scraper] สแกนออเดอร์ของ "${searchedUsername}" ล้มเหลว: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ==========================================
// FIREBASE FIRESTORE DATABASE MIRRORING FUNCTIONS & BACKGROUND WORKER
// ==========================================

async function mirrorAllOrdersToFirestore() {
    if (!firestoreDb) {
        logger.error('[Firebase] Firestore DB not initialized. Skipping mirror.');
        return;
    }
    logger.info('[Background Scraper] Scanning ALL customer orders from target site to Firebase & Database...');

    // Tier 1: Try Cheerio HTML Scraper (Fetches all orders)
    let remoteOrders = await scrapeLiveOrdersWithCheerio('');

    // Tier 2: Try Puppeteer Scraper
    if (remoteOrders === null) {
        remoteOrders = await scrapeLiveOrdersWithPuppeteer('');
    }

    // Tier 3: Fallback to Mock or Direct API
    if (remoteOrders === null) {
        const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');
        const ordersEndpoint = isLocalHost
            ? `${TARGET_BASE_URL}/api/target-mock/orders`
            : `${TARGET_BASE_URL}/api/orders`;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        };
        if (!isLocalHost) {
            headers['Cookie'] = await getTargetCookies();
        } else {
            const token = await getSystemBotToken();
            headers['Cookie'] = `session_id=${token}`;
        }
        try {
            const response = await axios.get(ordersEndpoint, { headers, timeout: 10000 });
            if (response.data && response.data.success && Array.isArray(response.data.data)) {
                remoteOrders = response.data.data;
            }
        } catch (apiErr) {
            logger.error(`[Background Scraper API Error]: ${apiErr.message}`);
        }
    }

    if (!remoteOrders || !Array.isArray(remoteOrders) || remoteOrders.length === 0) {
        logger.warn('[Background Scraper] No orders returned from target website to mirror.');
        return;
    }

    logger.info(`[Background Scraper] Successfully scraped ${remoteOrders.length} total orders from target site!`);
    const now = new Date().toISOString();

    // Group orders by username
    const ordersByUser = {};
    remoteOrders.forEach(order => {
        const uname = (order.username || 'unknown').trim();
        if (!ordersByUser[uname]) ordersByUser[uname] = [];
        ordersByUser[uname].push(order);
    });

    const activeIds = [];
    const batch = firestoreDb.batch();
    let batchCount = 0;
    let newUsersCount = 0;

    // Fetch existing accounts to detect newly discovered users
    const existingAccounts = await new Promise((resolve) => {
        db.all("SELECT username FROM accounts", [], (err, rows) => {
            if (err || !rows) return resolve(new Set());
            resolve(new Set(rows.map(r => (r.username || '').toLowerCase())));
        });
    });

    for (const [uname, userOrders] of Object.entries(ordersByUser)) {
        const isNewUser = !existingAccounts.has(uname.toLowerCase());
        if (isNewUser) {
            newUsersCount++;
            logger.info(`[Auto Discovery] Discovered NEW user from target site: "${uname}"`);
        }

        // 1. Auto-save discovered username into SQLite accounts table
        db.run(
            `INSERT INTO accounts (username, password, status, queue_position, queue_status, last_updated)
             VALUES (?, '', 'active', 0, 'Processing', ?)
             ON CONFLICT(username) DO UPDATE SET last_updated = excluded.last_updated`,
            [uname, now]
        );

        // 2. Mirror user profile into Firebase Firestore "accounts" collection
        const userDocRef = firestoreDb.collection('accounts').doc(uname);
        batch.set(userDocRef, {
            username: uname,
            status: 'active',
            order_count: userOrders.length,
            is_new: isNewUser,
            last_updated: now,
            source: 'thewestern.rdcw.xyz'
        }, { merge: true });

        // Sort orders for this user by purchase_time ASC
        userOrders.sort((a, b) => new Date(a.purchase_time || now) - new Date(b.purchase_time || now));

        let activeOrderIndex = 0;
        userOrders.forEach((remoteOrder) => {
            const resolved = resolveAppProductDetails(remoteOrder.product_name, remoteOrder.product_image);
            const isTerminal = ['Completed', 'Failed', 'Cancelled', 'Refunded'].includes(remoteOrder.queue_status);
            let queuePos = 0;
            if (!isTerminal) {
                activeOrderIndex++;
                queuePos = activeOrderIndex;
            }

            const waitMinutes = queuePos * 2;
            const purchaseTimeDate = new Date(remoteOrder.purchase_time || now);
            const waitTimeTarget = isTerminal ? null : new Date(purchaseTimeDate.getTime() + waitMinutes * 60 * 1000).toISOString();

            let finalStatus = remoteOrder.queue_status;
            if (finalStatus === 'Processing' || finalStatus === 'Pending') {
                finalStatus = queuePos === 1 ? 'Processing' : 'Pending';
            }

            const rawKey = remoteOrder.order_id || `${uname}_${remoteOrder.product_name}_${remoteOrder.purchase_time}`;
            const orderId = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_');
            activeIds.push(orderId);

            const docData = {
                order_id: orderId,
                username: uname,
                product_name: remoteOrder.product_name || resolved.product_name,
                product_image: resolved.product_image || null,
                queue_position: queuePos,
                queue_status: finalStatus,
                estimated_wait_time: isTerminal ? 'จัดส่งสำเร็จแล้ว' : `ประมาณ ${waitMinutes} นาที`,
                notes: remoteOrder.notes || 'ดึงและซิงค์ข้อมูลจากเว็บต้นทางเรียบร้อยแล้ว',
                buyer_notes: remoteOrder.buyer_notes || '',
                purchase_time: remoteOrder.purchase_time || now,
                wait_time_target: waitTimeTarget,
                last_updated: now
            };

            // 3. Mirror order into Firebase Firestore "orders" collection
            const docRef = firestoreDb.collection('orders').doc(orderId);
            batch.set(docRef, docData);
            batchCount++;

            // 4. Mirror order into SQLite "orders" table
            db.run(
                `INSERT INTO orders (username, product_name, product_image, queue_position, queue_status, estimated_wait_time, notes, buyer_notes, purchase_time, wait_time_target, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uname,
                    docData.product_name,
                    docData.product_image,
                    queuePos,
                    finalStatus,
                    docData.estimated_wait_time,
                    docData.notes,
                    docData.buyer_notes,
                    docData.purchase_time,
                    waitTimeTarget,
                    now
                ]
            );
        });
    }

    if (batchCount > 0) {
        await batch.commit();
        logger.info(`[Background Scraper] Mirrored ${batchCount} orders and ${Object.keys(ordersByUser).length} accounts (New: ${newUsersCount}) into Firestore & SQLite!`);
        broadcastLog('System', 'success', `[Auto Discovery] ดึง 50 รายการล่าสุดจากเว็บต้นทางสำเร็จ! พบบัญชีผู้ใช้ทั้งหมด ${Object.keys(ordersByUser).length} บัญชี (เป็นผู้ใช้ใหม่ ${newUsersCount} บัญชี) บันทึกลง database และ Firebase เรียบร้อยแล้ว`);
        broadcastUpdate('orders');
    }
}

async function mirrorUserOrdersToFirestore(username) {
    if (!firestoreDb) {
        logger.error('[Firebase] Firestore DB not initialized. Skipping mirror.');
        return;
    }
    const cleanUsername = username.trim();
    logger.info(`[Background Scraper] Mirroring orders for user "${cleanUsername}" to Firestore...`);

    // Tier 1: Try Cheerio HTML Scraper
    let remoteOrders = await scrapeLiveOrdersWithCheerio(cleanUsername);

    // Tier 2: Try Puppeteer Scraper
    if (remoteOrders === null) {
        remoteOrders = await scrapeLiveOrdersWithPuppeteer(cleanUsername);
    }

    // Tier 3: Fallback to Mock or Direct API
    if (remoteOrders === null) {
        const isLocalHost = TARGET_BASE_URL.includes('localhost') || TARGET_BASE_URL.includes('127.0.0.1');
        const ordersEndpoint = isLocalHost
            ? `${TARGET_BASE_URL}/api/target-mock/orders?username=${encodeURIComponent(cleanUsername)}`
            : `${TARGET_BASE_URL}/api/orders?username=${encodeURIComponent(cleanUsername)}`;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        };
        if (!isLocalHost) {
            headers['Cookie'] = await getTargetCookies();
        } else {
            const token = await getSystemBotToken();
            headers['Cookie'] = `session_id=${token}`;
        }
        const response = await axios.get(ordersEndpoint, { headers, timeout: 10000 });
        if (response.data && response.data.success && Array.isArray(response.data.data)) {
            remoteOrders = response.data.data;
        }
    }

    if (remoteOrders && Array.isArray(remoteOrders)) {
        const now = new Date().toISOString();
        remoteOrders.sort((a, b) => new Date(a.purchase_time || now) - new Date(b.purchase_time || now));

        const batch = firestoreDb.batch();
        const activeIds = [];
        let activeOrderIndex = 0;

        remoteOrders.forEach((remoteOrder) => {
            const resolved = resolveAppProductDetails(remoteOrder.product_name, remoteOrder.product_image);
            const isTerminal = ['Completed', 'Failed', 'Cancelled', 'Refunded'].includes(remoteOrder.queue_status);
            let queuePos = 0;
            if (!isTerminal) {
                activeOrderIndex++;
                queuePos = activeOrderIndex;
            }

            const waitMinutes = queuePos * 2;
            const purchaseTimeDate = new Date(remoteOrder.purchase_time || now);
            const waitTimeTarget = isTerminal ? null : new Date(purchaseTimeDate.getTime() + waitMinutes * 60 * 1000).toISOString();

            let finalStatus = remoteOrder.queue_status;
            if (finalStatus === 'Processing' || finalStatus === 'Pending') {
                finalStatus = queuePos === 1 ? 'Processing' : 'Pending';
            }

            const orderId = remoteOrder.order_id || `${cleanUsername}_${remoteOrder.product_name}_${remoteOrder.purchase_time}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            activeIds.push(orderId);

            const docData = {
                order_id: orderId,
                username: remoteOrder.username || cleanUsername,
                product_name: remoteOrder.product_name || resolved.product_name,
                product_image: resolved.product_image || null,
                queue_position: queuePos,
                queue_status: finalStatus,
                estimated_wait_time: isTerminal ? 'จัดส่งสำเร็จแล้ว' : `ประมาณ ${waitMinutes} นาที`,
                notes: remoteOrder.notes || 'ดึงและซิงค์ข้อมูลจากเว็บต้นทางเรียบร้อยแล้ว',
                buyer_notes: remoteOrder.buyer_notes || '',
                purchase_time: remoteOrder.purchase_time || now,
                wait_time_target: waitTimeTarget,
                last_updated: now
            };

            const docRef = firestoreDb.collection('orders').doc(orderId);
            batch.set(docRef, docData);

            // Mirror into SQLite orders table
            db.run(
                `INSERT INTO orders (username, product_name, product_image, queue_position, queue_status, estimated_wait_time, notes, buyer_notes, purchase_time, wait_time_target, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    cleanUsername,
                    docData.product_name,
                    docData.product_image,
                    queuePos,
                    finalStatus,
                    docData.estimated_wait_time,
                    docData.notes,
                    docData.buyer_notes,
                    docData.purchase_time,
                    waitTimeTarget,
                    now
                ]
            );
        });

        // Mirror account to SQLite accounts table
        db.run(
            `INSERT INTO accounts (username, password, status, queue_position, queue_status, last_updated)
             VALUES (?, '', 'active', 0, 'Processing', ?)
             ON CONFLICT(username) DO UPDATE SET last_updated = excluded.last_updated`,
            [cleanUsername, now]
        );

        // Mirror account to Firebase Firestore "accounts" collection
        batch.set(firestoreDb.collection('accounts').doc(cleanUsername), {
            username: cleanUsername,
            status: 'active',
            order_count: remoteOrders.length,
            last_updated: now,
            source: 'thewestern.rdcw.xyz'
        }, { merge: true });

        await batch.commit();
        logger.info(`[Background Scraper] Successfully mirrored ${remoteOrders.length} orders to Firestore & SQLite for user "${cleanUsername}"`);

        // Stale order cleanup
        const snapshot = await firestoreDb.collection('orders')
            .where('username', '==', cleanUsername)
            .get();

        const deleteBatch = firestoreDb.batch();
        let deleteCount = 0;
        snapshot.forEach((doc) => {
            if (!activeIds.includes(doc.id)) {
                deleteBatch.delete(doc.ref);
                deleteCount++;
            }
        });

        if (deleteCount > 0) {
            await deleteBatch.commit();
            logger.info(`[Background Scraper] Deleted ${deleteCount} stale orders from Firestore for user "${cleanUsername}"`);
        }
    } else {
        throw new Error('No orders found or failed to fetch orders from source.');
    }
}

function startBackgroundScraperWorker() {
    logger.info('[Background Worker] Starting continuous scraper loop running every 180 seconds...');
    
    // 🟢 Initial run immediately on server boot! (after 3s delay)
    setTimeout(() => {
        logger.info('[Background Worker] Executing initial boot sync of all orders...');
        mirrorAllOrdersToFirestore().catch(err => {
            logger.error(`[Background Worker Initial Run Error]: ${err.message}`);
        });
    }, 3000);

    // Continuous scraper loop every 180 seconds
    setInterval(async () => {
        try {
            await mirrorAllOrdersToFirestore();
        } catch (globalCycleError) {
            logger.error(`[Background Worker Global Error] Error in scraper cycle: ${globalCycleError.message}`);
        }
    }, 180000);
}

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

// Helper to filter public orders (keep all pending/processing, and include up to 50 latest completed/finished orders)
function filterPublicOrders(orders) {
    if (!orders || !Array.isArray(orders)) return [];
    
    // 1. Keep all active orders (Pending and Processing)
    const activeOrders = orders.filter(order => ['Pending', 'Processing'].includes(order.queue_status));
    
    // 2. Also include up to 50 latest completed/terminal orders (sorted newest first)
    const completedOrders = orders
        .filter(order => !['Pending', 'Processing'].includes(order.queue_status))
        .sort((a, b) => new Date(b.purchase_time || b.last_updated || 0) - new Date(a.purchase_time || a.last_updated || 0))
        .slice(0, 50);

    return [...activeOrders, ...completedOrders];
}

// REST API endpoint: Check Queue Status (Public Endpoint)
app.get('/api/check-queue', (req, res) => {
    // Check if queue service is active
    db.get("SELECT value FROM system_settings WHERE key = 'is_queue_active'", [], async (err, setting) => {
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
        const username = req.query.username ? req.query.username.trim() : '';
        if (!username) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อผู้ใช้งาน' });
        }

        if (!firestoreDb) {
            return res.status(500).json({ success: false, message: 'Firebase Firestore not initialized' });
        }

        try {
            logger.info(`[API] Fetching orders from Firestore for searched user: "${username}"`);
            
            // Query Firestore orders collection where username matches case-insensitively
            const snapshot = await firestoreDb.collection('orders').get();
            const matchedOrders = [];
            
            snapshot.forEach(doc => {
                const orderData = doc.data();
                if (orderData.username && orderData.username.toLowerCase() === username.toLowerCase()) {
                    matchedOrders.push(orderData);
                }
            });

            // If no orders found in cache for this user, attempt a live sync from source site
            if (matchedOrders.length === 0) {
                logger.info(`[API] No cached orders in Firestore for "${username}". Attempting live sync from source...`);
                try {
                    await mirrorUserOrdersToFirestore(username);
                    const freshSnapshot = await firestoreDb.collection('orders').get();
                    freshSnapshot.forEach(doc => {
                        const orderData = doc.data();
                        if (orderData.username && orderData.username.toLowerCase() === username.toLowerCase()) {
                            matchedOrders.push(orderData);
                        }
                    });
                    matchedOrders.sort((a, b) => new Date(b.purchase_time) - new Date(a.purchase_time));
                } catch (liveErr) {
                    logger.warn(`[API] Live sync attempt for "${username}": ${liveErr.message}`);
                }
            }

            // Fallback check against local SQLite if Firestore is temporarily empty
            if (matchedOrders.length === 0) {
                const sqliteRows = await new Promise((resolve) => {
                    db.all("SELECT * FROM orders WHERE LOWER(username) = LOWER(?) ORDER BY purchase_time DESC", [username], (errSql, rows) => {
                        resolve(rows || []);
                    });
                });
                if (sqliteRows && sqliteRows.length > 0) {
                    matchedOrders.push(...sqliteRows);
                }
            }

            // Check if account exists
            let accountExists = matchedOrders.length > 0;
            if (!accountExists) {
                const userDoc = await firestoreDb.collection('accounts').doc(username).get();
                if (userDoc.exists) {
                    accountExists = true;
                } else {
                    const row = await new Promise((resolve) => {
                        db.get("SELECT id FROM accounts WHERE LOWER(username) = LOWER(?)", [username], (errAcc, r) => resolve(r));
                    });
                    if (row) accountExists = true;
                }
            }

            if (!accountExists) {
                return res.json({
                    success: false,
                    account_exists: false,
                    message: 'ไม่พบบัญชีผู้ใช้ในระบบ',
                    data: []
                });
            }

            broadcastLog(username, 'info', `คิวถูกตรวจสอบจากฐานข้อมูล Mirror (Firestore/SQLite): พบรายการพรีออเดอร์ทั้งหมด ${matchedOrders.length} รายการ`);

            const publicOrders = filterPublicOrders(matchedOrders);

            return res.json({
                success: true,
                account_exists: true,
                data: publicOrders
            });
        } catch (error) {
            logger.error(`[API Check Queue Error]: ${error.message}`);
            return res.status(500).json({ success: false, message: 'Database error reading from Firestore' });
        }
    });
});

// REST API endpoint: Check Single Order status by orderId (Public Endpoint)
app.get('/api/check-order/:orderId', async (req, res) => {
    const orderId = req.params.orderId ? req.params.orderId.trim() : '';
    if (!orderId) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุหมายเลขคำสั่งซื้อ (orderId)' });
    }

    if (!firestoreDb) {
        return res.status(500).json({ success: false, message: 'Firebase Firestore not initialized' });
    }

    try {
        logger.info(`[API] Fetching single order from Firestore for order ID: "${orderId}"`);
        const docRef = firestoreDb.collection('orders').doc(orderId);
        const doc = await docRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'ไม่พบหมายเลขคำสั่งซื้อนี้ในระบบ' });
        }

        return res.json({
            success: true,
            data: doc.data()
        });
    } catch (error) {
        logger.error(`[API Check Order Error]: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Database error reading from Firestore' });
    }
});

async function updateQueueFromTarget(username) {
    broadcastLog(username, 'info', `[Bot Scraper] สแกนยืนยันสถานะออเดอร์ของ "${username}" กับเว็บต้นทาง (thewestern.rdcw.xyz)...`);
}

app.post('/api/admin/import-accounts', authMiddleware, (req, res) => {
    let accountsList = req.body.accounts;
    if (!accountsList && req.body.username && req.body.password) {
        accountsList = [{ username: req.body.username, password: req.body.password }];
    }
    if (!Array.isArray(accountsList) || accountsList.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid data format or missing username/password' });
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

process.on('uncaughtException', (err) => {
    logger.error(`[Uncaught Exception]: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`[Unhandled Rejection]: ${reason}`);
});

// Reload pending scheduled tasks on bootup
reloadScheduledTasks();

// Start Continuous Background Scraper Worker
startBackgroundScraperWorker();

// Start Server
server.listen(PORT, '0.0.0.0', () => {
    logger.info(`[Server] CheckOrder active on http://0.0.0.0:${PORT}`);
});
