const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Folders setup
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer setup for imageFile uploads (LINE Notify compatible)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load or initialize database
function loadDB() {
  let data;
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
      data = JSON.parse(raw);
    } catch (err) {
      console.error('Error reading DB file, initializing fresh DB:', err);
    }
  }

  // Use environment VAPID keys (for Render/Cloud) or generate on first run
  const vapidKeys = (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : {
        publicKey: 'BC-q8kHavBV9z7xjUyBFvueEtovCQtOCD-h8b--DaqKRZufHzB-StoNhIcnFufRKFaZtgkf7uLF9O7hNzzHRIlA',
        privateKey: 'PGjw0ZwlXtGISVoV3REAcLDPgSnF4SS6ONaVB-4okgo'
      };
  const now = new Date().toISOString();

  const initialDB = {
    vapidKeys,
    channels: [
      {
        id: 'ch_1793091370273',
        name: '⚡ งานค้างซ่อม: ไฟฟ้า',
        description: 'รายการงานค้างซ่อมหมวดไฟฟ้า/โทรศัพท์',
        color: '#F59E0B',
        createdAt: now
      },
      {
        id: 'ch_1793091370293',
        name: '❄️ งานค้างซ่อม: แอร์',
        description: 'รายการงานค้างซ่อมหมวดแอร์ (เครื่องปรับอากาศ)',
        color: '#06B6D4',
        createdAt: now
      }
    ],
    tokens: [
      {
        id: 'tok_demo_1',
        name: 'Token ทดสอบระบบแจกงาน',
        token: 'NOTIFY-TASK-2026-DEMO',
        channelId: 'ch_1793091370273',
        createdAt: now,
        lastUsedAt: null,
        usageCount: 1
      }
    ],
    subscriptions: [],
    notifications: [],
    technicians: []
  };

  if (!data) data = initialDB;

  // Ensure technicians list is seeded
  if (!data.technicians || data.technicians.length === 0) {
    const TECH_SEED_FILE = path.join(DATA_DIR, 'technicians.json');
    if (fs.existsSync(TECH_SEED_FILE)) {
      try {
        const seedRaw = fs.readFileSync(TECH_SEED_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
        const seed = JSON.parse(seedRaw);
        data.technicians = seed.technicians || [];
      } catch (e) {}
    }
    if (!data.technicians || data.technicians.length === 0) {
      data.technicians = [
        { id: '56877', name: 'นาย มี', role: 'technician', active: true },
        { id: '57145', name: 'นาย พิวพิว', role: 'technician', active: true },
        { id: '52B13', name: 'นาย กิตติพงษ์ ศรีโยธา', role: 'technician', active: true },
        { id: '51061', name: 'นาย อาทิตย์ บ้วนนอก', role: 'technician', active: true },
        { id: '61B47', name: 'นาย ศิวกร วงค์ครองศักดิ์', role: 'technician', active: true }
      ];
    }
    saveDB(data);
  }

  return data;
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const db = loadDB();

// Configure Web Push with VAPID keys
webpush.setVapidDetails(
  'mailto:admin@notify.local',
  db.vapidKeys.publicKey,
  db.vapidKeys.privateKey
);

// SSE (Server-Sent Events) Clients for real-time live updates
const sseClients = new Set();

function broadcastSSE(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

// Get Local Network IP addresses so mobile devices on same Wi-Fi can connect
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// ==========================================
// 0. HEALTH CHECK & ADMIN LOGIN ENDPOINTS
// ==========================================
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const validPass = process.env.ADMIN_PASSWORD || 'Thanasit';
  const inputPass = String(password || '').trim();

  if (inputPass === validPass) {
    return res.json({ status: 200, isAdmin: true });
  }
  return res.status(401).json({ status: 401, isAdmin: false, message: 'รหัสผ่านแอดมินไม่ถูกต้อง' });
});

// ==========================================
// 0.1 TECHNICIAN AUTHENTICATION & MANAGEMENT
// ==========================================
app.post('/api/auth/login', (req, res) => {
  const { employeeId } = req.body || {};
  if (!employeeId || !String(employeeId).trim()) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรหัสพนักงาน' });
  }

  const cleanId = String(employeeId).trim().toUpperCase();
  const tech = (db.technicians || []).find(t => t.id && String(t.id).trim().toUpperCase() === cleanId);

  if (!tech || tech.active === false) {
    return res.status(401).json({
      ok: false,
      error: 'ไม่พบรหัสพนักงานนี้ หรือสิทธิ์การใช้งานถูกยกเลิก (พ้นสภาพพนักงานแล้ว)'
    });
  }

  res.json({
    ok: true,
    user: {
      id: tech.id,
      name: tech.name,
      role: tech.role || 'technician'
    }
  });
});

app.get('/api/auth/verify', (req, res) => {
  const id = String(req.query.id || '').trim().toUpperCase();
  if (!id) return res.json({ ok: false, active: false });

  const tech = (db.technicians || []).find(t => t.id && String(t.id).trim().toUpperCase() === id);
  if (!tech || tech.active === false) {
    return res.json({ ok: false, active: false, error: 'พ้นสภาพพนักงานแล้ว' });
  }

  res.json({
    ok: true,
    active: true,
    user: { id: tech.id, name: tech.name, role: tech.role || 'technician' }
  });
});

app.get('/api/technicians', (req, res) => {
  res.json({ ok: true, technicians: db.technicians || [] });
});

app.post('/api/technicians', (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) {
    return res.status(400).json({ ok: false, error: 'กรุณาระบุรหัสและชื่อพนักงาน' });
  }

  const cleanId = String(id).trim().toUpperCase();
  if (!db.technicians) db.technicians = [];

  const existing = db.technicians.find(t => t.id && String(t.id).trim().toUpperCase() === cleanId);
  if (existing) {
    existing.name = String(name).trim();
    existing.active = true;
  } else {
    db.technicians.push({
      id: cleanId,
      name: String(name).trim(),
      role: 'technician',
      active: true
    });
  }

  saveDB(db);
  res.json({ ok: true, technicians: db.technicians });
});

app.delete('/api/technicians/:id', (req, res) => {
  const id = String(req.params.id || '').trim().toUpperCase();
  if (!db.technicians) db.technicians = [];

  const idx = db.technicians.findIndex(t => t.id && String(t.id).trim().toUpperCase() === id);
  if (idx >= 0) {
    const deleted = db.technicians.splice(idx, 1)[0];
    saveDB(db);
    return res.json({ ok: true, message: `ลบพนักงาน ${deleted.name} (${deleted.id}) เรียบร้อยแล้ว`, technicians: db.technicians });
  }

  res.status(404).json({ ok: false, error: 'ไม่พบรหัสพนักงานนี้' });
});

app.post('/api/technicians/sync', (req, res) => {
  const { technicians } = req.body || {};
  if (Array.isArray(technicians) && technicians.length > 0) {
    db.technicians = technicians.map(t => ({
      id: String(t.id).trim(),
      name: String(t.name).trim(),
      role: 'technician',
      active: t.active !== false
    }));
    saveDB(db);
    return res.json({ ok: true, count: db.technicians.length });
  }
  res.status(400).json({ ok: false, error: 'Invalid technicians array' });
});

// ==========================================
// 1. SSE REAL-TIME STREAM ENDPOINT
// ==========================================
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'ok', time: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ==========================================
// 2. INITIALIZATION & DASHBOARD DATA
// ==========================================
app.get('/api/init', (req, res) => {
  const localIPs = getLocalIPs();
  res.json({
    vapidPublicKey: db.vapidKeys.publicKey,
    channels: db.channels,
    tokens: db.tokens,
    notifications: db.notifications.slice(0, 100),
    subscriberCount: db.subscriptions.length,
    serverInfo: {
      port: PORT,
      localIPs,
      urls: localIPs.map(ip => `http://${ip}:${PORT}`)
    }
  });
});

// ==========================================
// 3. WEB PUSH SUBSCRIPTION ENDPOINT
// ==========================================
app.post('/api/subscribe', (req, res) => {
  const { subscription, deviceName, channels } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ status: 400, message: 'Invalid subscription object' });
  }

  const existingIndex = db.subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const subRecord = {
    id: existingIndex >= 0 ? db.subscriptions[existingIndex].id : `sub_${Date.now()}`,
    deviceName: deviceName || 'อุปกรณ์ทั่วไป',
    channels: channels || ['*'],
    subscription,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    db.subscriptions[existingIndex] = subRecord;
  } else {
    db.subscriptions.push(subRecord);
  }

  saveDB(db);
  res.json({ status: 200, message: 'Subscribed successfully', subscriberCount: db.subscriptions.length });
});

// ==========================================
// 4. LINE NOTIFY COMPATIBLE ENDPOINT (/api/notify & /notify)
// ==========================================
async function handleNotify(req, res) {
  try {
    // 1. Extract token from Authorization: Bearer <TOKEN> or headers/body/query
    let rawToken = null;
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      rawToken = authHeader.slice(7).trim();
    } else if (req.headers['x-notify-token']) {
      rawToken = req.headers['x-notify-token'].trim();
    } else if (req.body && req.body.token) {
      rawToken = req.body.token.trim();
    } else if (req.query && req.query.token) {
      rawToken = req.query.token.trim();
    }

    if (!rawToken) {
      return res.status(401).json({
        status: 401,
        message: 'Missing Authorization Bearer token (กรุณาระบุ Authorization: Bearer <TOKEN>)'
      });
    }

    // 2. Verify token
    const tokenObj = db.tokens.find(t => t.token === rawToken);
    if (!tokenObj) {
      return res.status(401).json({
        status: 401,
        message: 'Invalid access token (ไม่พบ Token นี้ในระบบ หรือถูกยกเลิกไปแล้ว)'
      });
    }

    // 3. Validate message
    const message = req.body.message;
    if (!message || String(message).trim() === '') {
      return res.status(400).json({
        status: 400,
        message: 'message is required (กรุณาระบุข้อความในฟิลด์ message)'
      });
    }

    // 4. Find associated channel
    const channel = db.channels.find(c => c.id === tokenObj.channelId) || {
      id: 'ch_default',
      name: 'แจ้งเตือนทั่วไป',
      color: '#06C755'
    };

    // 5. Handle image (uploaded file or URL)
    let imageUrl = req.body.imageFullsize || req.body.imageThumbnail || req.body.image || null;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }

    // 6. Task / Priority metadata
    const isTask = req.body.isTask === true || req.body.isTask === 'true' || Boolean(req.body.assignee) || channel.id === 'ch_tasks';
    const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';

    const notification = {
      id: `notif_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      channelId: channel.id,
      channelName: channel.name,
      channelColor: channel.color,
      tokenName: tokenObj.name,
      title: req.body.title || channel.name,
      message: String(message).trim(),
      priority,
      assignee: req.body.assignee || null,
      isTask,
      taskStatus: isTask ? (req.body.taskStatus || 'pending') : null,
      image: imageUrl,
      url: req.body.url || null,
      createdAt: new Date().toISOString()
    };

    // 7. Save to DB (keep latest 500 notifications)
    db.notifications.unshift(notification);
    if (db.notifications.length > 500) {
      db.notifications = db.notifications.slice(0, 500);
    }

    // Update token usage stats
    tokenObj.lastUsedAt = notification.createdAt;
    tokenObj.usageCount = (tokenObj.usageCount || 0) + 1;
    saveDB(db);

    // 8. Broadcast via SSE (Real-time to all open web/PWA clients)
    broadcastSSE('notification', notification);

    // 9. Send Web Push Notification to subscribed background devices
    const pushPayload = JSON.stringify({
      id: notification.id,
      title: notification.title,
      body: notification.assignee
        ? `[ผู้รับผิดชอบ: ${notification.assignee}] ${notification.message}`
        : notification.message,
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      image: notification.image,
      tag: notification.id,
      priority: notification.priority,
      url: notification.url || '/',
      channelName: notification.channelName,
      createdAt: notification.createdAt
    });

    const invalidEndpoints = [];
    await Promise.allSettled(
      db.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub.subscription, pushPayload);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            invalidEndpoints.push(sub.subscription.endpoint);
          }
        }
      })
    );

    if (invalidEndpoints.length > 0) {
      db.subscriptions = db.subscriptions.filter(s => !invalidEndpoints.includes(s.subscription.endpoint));
      saveDB(db);
    }

    // Return exact LINE Notify compatible status 200 JSON + notification details
    return res.status(200).json({
      status: 200,
      message: 'ok',
      notification
    });
  } catch (error) {
    console.error('Notify error:', error);
    return res.status(500).json({ status: 500, message: error.message });
  }
}

app.post('/api/notify', upload.single('imageFile'), handleNotify);
app.post('/notify', upload.single('imageFile'), handleNotify);

// ==========================================
// 5. CHANNELS & TOKENS MANAGEMENT ENDPOINTS
// ==========================================
app.post('/api/channels', (req, res) => {
  const { name, description, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ status: 400, message: 'กรุณาระบุชื่อห้องแจ้งเตือน' });
  }
  const newChannel = {
    id: `ch_${Date.now()}`,
    name: name.trim(),
    description: (description || '').trim(),
    color: color || '#06C755',
    createdAt: new Date().toISOString()
  };
  db.channels.push(newChannel);
  saveDB(db);
  res.json({ status: 200, channel: newChannel });
});

app.delete('/api/channels/:id', (req, res) => {
  const { id } = req.params;
  db.channels = db.channels.filter(c => c.id !== id);
  saveDB(db);
  res.json({ status: 200, message: 'Deleted channel' });
});

app.post('/api/tokens', (req, res) => {
  const { name, channelId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ status: 400, message: 'กรุณาตั้งชื่อ Token' });
  }
  // Generate human-friendly, secure LINE-Notify-like token
  const randomPart = crypto.randomBytes(18).toString('base64url');
  const newToken = {
    id: `tok_${Date.now()}`,
    name: name.trim(),
    token: `ntfy_${randomPart}`,
    channelId: channelId || 'ch_default',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    usageCount: 0
  };
  db.tokens.unshift(newToken);
  saveDB(db);
  res.json({ status: 200, token: newToken });
});

app.delete('/api/tokens/:id', (req, res) => {
  const { id } = req.params;
  db.tokens = db.tokens.filter(t => t.id !== id);
  saveDB(db);
  res.json({ status: 200, message: 'Token revoked' });
});

// ==========================================
// 6. TASK STATUS & NOTIFICATION ACTIONS
// ==========================================
app.patch('/api/notifications/:id/status', (req, res) => {
  const { id } = req.params;
  const { taskStatus, assignee } = req.body;
  const notif = db.notifications.find(n => n.id === id);
  if (!notif) {
    return res.status(404).json({ status: 404, message: 'Notification not found' });
  }
  if (taskStatus) notif.taskStatus = taskStatus;
  if (assignee !== undefined) notif.assignee = assignee;
  notif.updatedAt = new Date().toISOString();
  saveDB(db);

  broadcastSSE('status_updated', notif);
  res.json({ status: 200, notification: notif });
});

app.delete('/api/notifications/:id', (req, res) => {
  const { id } = req.params;
  db.notifications = db.notifications.filter(n => n.id !== id);
  saveDB(db);
  broadcastSSE('notification_deleted', { id });
  res.json({ status: 200, message: 'Deleted' });
});

app.delete('/api/notifications', (req, res) => {
  db.notifications = [];
  saveDB(db);
  broadcastSSE('notifications_cleared', {});
  res.json({ status: 200, message: 'Cleared all notifications' });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('====================================================');
  console.log(`🚀 ระบบแจ้งเตือน & แจกงาน (Notify Hub) เริ่มทำงานแล้ว!`);
  console.log(`👉 เปิดบนคอมพิวเตอร์: http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`📱 เปิดผ่านมือถือ (Wi-Fi เดียวกัน): http://${ip}:${PORT}`);
  });
  console.log('====================================================');

  // Keep Render server awake (ping every 5 minutes so Free Tier never sleeps)
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://powerenergy-rfik.onrender.com';
  setInterval(() => {
    fetch(`${RENDER_URL}/api/health`)
      .then(r => console.log(`[Keep-Alive] Pinged ${RENDER_URL}/api/health -> ${r.status}`))
      .catch(err => console.warn(`[Keep-Alive] Ping error:`, err.message));
  }, 5 * 60 * 1000);
});
