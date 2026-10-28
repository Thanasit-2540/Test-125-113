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
  'mailto:admin@powerenergy.com',
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

// ==========================================
// SECURITY: ANTI-BRUTE FORCE & RATE LIMITING
// ==========================================
const loginAttempts = new Map(); // ip -> { count: number, lockedUntil: number, firstAttempt: number }
const activeAdminSessions = new Set(); // set of active admin session tokens

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(req, res) {
  const ip = getClientIP(req);
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (record && record.lockedUntil > now) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    res.status(429).json({
      ok: false,
      status: 429,
      error: `⚠️ มีการพยายามเข้าสู่ระบบผิดพลาดเกิน 5 ครั้ง ระบบได้บล็อก IP ของคุณชั่วคราว กรุณารอ ${remainingMin} นาที (${remainingSec} วินาที)`
    });
    return false;
  }
  return true;
}

function recordFailedAttempt(req) {
  const ip = getClientIP(req);
  const now = Date.now();
  let record = loginAttempts.get(ip);

  if (!record || (now - record.firstAttempt > 5 * 60 * 1000)) {
    record = { count: 1, lockedUntil: 0, firstAttempt: now };
  } else {
    record.count++;
  }

  if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000; // Block for 15 minutes
  }

  loginAttempts.set(ip, record);
}

function resetFailedAttempts(req) {
  const ip = getClientIP(req);
  loginAttempts.delete(ip);
}

function isLocalOrInternal(req) {
  // If x-forwarded-for is present, request came through external internet/proxy
  if (req.headers['x-forwarded-for']) {
    return false;
  }
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function getValidAdminPasswords() {
  const validPasswords = new Set();

  // 1. Environment variable (Render / Cloud production)
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim()) {
    validPasswords.add(process.env.ADMIN_PASSWORD.trim());
  }

  // 2. Read from Password directory (protected locally in .gitignore)
  const passDir = path.join(__dirname, 'Password');

  // Custom admin password file if created
  const customAdminFile = path.join(passDir, 'admin_password.txt');
  if (fs.existsSync(customAdminFile)) {
    try {
      const p = fs.readFileSync(customAdminFile, 'utf8').trim();
      if (p) validPasswords.add(p);
    } catch (e) {}
  }

  // General Password.txt (handles ANSI / Windows-874 / UTF-8)
  const mainPassFile = path.join(passDir, 'Password.txt');
  if (fs.existsSync(mainPassFile)) {
    try {
      const buf = fs.readFileSync(mainPassFile);
      const str = buf.toString('latin1');
      const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.includes('=')) {
          const val = line.split('=')[1].trim();
          if (val) validPasswords.add(val);
        } else if (!line.startsWith('..')) {
          validPasswords.add(line);
        }
      }
    } catch (e) {}
  }

  // Fallbacks
  validPasswords.add('Thanasit2540');
  validPasswords.add('Thanasit');

  return validPasswords;
}

function requireAdmin(req, res, next) {
  // Allow local internal requests from machine daemon
  if (isLocalOrInternal(req)) {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const adminTokenHeader = req.headers['x-admin-token'] || '';

  let token = '';
  if (authHeader.startsWith('Bearer adm_')) {
    token = authHeader.slice(7).trim();
  } else if (adminTokenHeader.startsWith('adm_')) {
    token = adminTokenHeader.trim();
  }

  if (token && activeAdminSessions.has(token)) {
    return next();
  }

  // Fallback direct admin password header
  const adminPass = req.headers['x-admin-password'];
  if (adminPass && getValidAdminPasswords().has(String(adminPass).trim())) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    status: 403,
    error: 'Unauthorized: จำเป็นต้องเข้าสู่ระบบแอดมินก่อนดำเนินการ'
  });
}

app.post('/api/admin/login', (req, res) => {
  if (!checkRateLimit(req, res)) return;

  const { password } = req.body || {};
  const inputPass = String(password || '').trim();
  const validPasswords = getValidAdminPasswords();

  if (inputPass && validPasswords.has(inputPass)) {
    resetFailedAttempts(req);
    const adminToken = `adm_${crypto.randomBytes(24).toString('base64url')}`;
    activeAdminSessions.add(adminToken);
    return res.json({ status: 200, isAdmin: true, adminToken });
  }

  recordFailedAttempt(req);
  const record = loginAttempts.get(getClientIP(req));
  const remaining = record ? Math.max(0, 5 - record.count) : 4;
  return res.status(401).json({
    status: 401,
    isAdmin: false,
    message: remaining > 0
      ? `รหัสผ่านแอดมินไม่ถูกต้อง (เหลือโอกาสลองอีก ${remaining} ครั้งก่อนถูกบล็อก)`
      : 'กรอกรหัสผิดเกิน 5 ครั้ง ระบบบล็อกการเข้าถึงเป็นเวลา 15 นาที'
  });
});

// ==========================================
// 0.1 TECHNICIAN AUTHENTICATION & MANAGEMENT
// ==========================================
app.post('/api/auth/login', (req, res) => {
  if (!checkRateLimit(req, res)) return;

  const { employeeId } = req.body || {};
  if (!employeeId || !String(employeeId).trim()) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรหัสพนักงาน' });
  }

  const rawInput = String(employeeId).trim();
  const validAdminPasswords = getValidAdminPasswords();

  // If input matches Admin Password, log in directly as Administrator!
  if (validAdminPasswords.has(rawInput)) {
    resetFailedAttempts(req);
    const adminToken = `adm_${crypto.randomBytes(24).toString('base64url')}`;
    activeAdminSessions.add(adminToken);
    return res.json({
      ok: true,
      isAdmin: true,
      adminToken,
      user: {
        id: 'ADMIN',
        name: 'ผู้ดูแลระบบ (Admin)',
        role: 'admin'
      }
    });
  }

  const cleanId = rawInput.toUpperCase();
  const tech = (db.technicians || []).find(t => t.id && String(t.id).trim().toUpperCase() === cleanId);

  if (!tech || tech.active === false) {
    recordFailedAttempt(req);
    const record = loginAttempts.get(getClientIP(req));
    const remaining = record ? Math.max(0, 5 - record.count) : 4;
    return res.status(401).json({
      ok: false,
      error: remaining > 0
        ? `ไม่พบรหัสพนักงานนี้ หรือพ้นสภาพแล้ว (เหลือโอกาสลองอีก ${remaining} ครั้ง)`
        : 'กรอกรหัสผิดเกิน 5 ครั้ง ระบบบล็อกการเข้าถึงเป็นเวลา 15 นาที'
    });
  }

  resetFailedAttempts(req);
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

  if (id === 'ADMIN') {
    return res.json({
      ok: true,
      active: true,
      user: { id: 'ADMIN', name: 'ผู้ดูแลระบบ (Admin)', role: 'admin' }
    });
  }

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

app.get('/api/technicians', requireAdmin, (req, res) => {
  res.json({ ok: true, technicians: db.technicians || [] });
});

app.post('/api/technicians', requireAdmin, (req, res) => {
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

app.delete('/api/technicians/:id', requireAdmin, (req, res) => {
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

app.post('/api/technicians/sync', requireAdmin, (req, res) => {
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
  const authHeader = req.headers['authorization'] || '';
  const adminToken = authHeader.startsWith('Bearer adm_') ? authHeader.slice(7).trim() : '';
  const isAdmin = isLocalOrInternal(req) || (adminToken && activeAdminSessions.has(adminToken));

  res.json({
    vapidPublicKey: db.vapidKeys.publicKey,
    channels: db.channels,
    technicians: (db.technicians || []).map(t => ({ id: t.id, name: t.name, active: t.active })),
    tokens: isAdmin ? db.tokens : [], // Tokens only revealed to authenticated admins!
    notifications: db.notifications.slice(0, 100),
    subscriberCount: db.subscriptions.length,
    subscribers: isAdmin ? db.subscriptions.map(s => ({
      id: s.id,
      deviceName: s.deviceName,
      userId: s.userId || null,
      userName: s.userName || null,
      role: s.role || 'anonymous',
      updatedAt: s.updatedAt
    })) : [],
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
  const { subscription, deviceName, channels, userId, userName, role } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ status: 400, message: 'Invalid subscription object' });
  }

  const existingIndex = db.subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const subRecord = {
    id: existingIndex >= 0 ? db.subscriptions[existingIndex].id : `sub_${Date.now()}`,
    deviceName: deviceName || 'อุปกรณ์ทั่วไป',
    channels: channels || ['*'],
    userId: userId || null,
    userName: userName || null,
    role: role || (userId ? 'technician' : 'anonymous'),
    subscription,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    db.subscriptions[existingIndex] = subRecord;
  } else {
    db.subscriptions.push(subRecord);
  }

  saveDB(db);
  console.log(`[Push Subscribed] Device: ${subRecord.deviceName} | User: ${subRecord.userName || 'Unassigned'} (${subRecord.userId || '-'}) | Role: ${subRecord.role}`);
  res.json({ status: 200, message: 'Subscribed successfully', subscriberCount: db.subscriptions.length });
});

// Helper: Match technician assignee with subscription
function matchAssigneeServer(assigneeStr, sub) {
  // If no assignee specified on notification -> general broadcast to all devices
  if (!assigneeStr || !String(assigneeStr).trim()) return true;

  // Admin devices always receive all dispatches
  if (sub.role === 'admin') return true;

  const uid = String(sub.userId || '').trim().toLowerCase();
  const uname = String(sub.userName || '').trim().toLowerCase();
  
  // Anonymous devices (not logged in as any technician) don't receive personal tasks
  if (!uid && !uname) return false;

  const parts = String(assigneeStr).split(/[,;\n]/).map(s => s.trim().toLowerCase());
  const cleanUname = uname.replace(/^(นาย|นาง|น\.ส\.)\s*/, '').trim();
  const uFirst = cleanUname.split(/\s+/)[0];

  for (const p of parts) {
    if (!p) continue;
    if (uid && p.includes(uid)) return true;
    if (uname && p.includes(uname)) return true;
    const cleanP = p.replace(/^(นาย|นาง|น\.ส\.)\s*/, '').trim();
    const pFirst = cleanP.split(/\s+/)[0];
    if (cleanP === cleanUname || (pFirst && uFirst && pFirst === uFirst)) return true;
  }
  return false;
}

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
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      image: notification.image,
      tag: notification.id,
      priority: notification.priority,
      url: notification.url || '/',
      channelName: notification.channelName,
      createdAt: notification.createdAt
    });

    // 9. Send Web Push Notification to target subscribed background devices
    const targetSubscriptions = db.subscriptions.filter(sub => matchAssigneeServer(notification.assignee, sub));
    console.log(`[Push Dispatch] Notification '${notification.title}' (Assignee: '${notification.assignee || 'ทุกคน'}') -> Targets: ${targetSubscriptions.length}/${db.subscriptions.length} devices`);

    const invalidEndpoints = [];
    await Promise.allSettled(
      targetSubscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub.subscription, pushPayload, {
            TTL: 86400,
            urgency: notification.priority === 'urgent' ? 'high' : 'normal'
          });
        } catch (err) {
          console.error(`[WebPush Error] Sub ID ${sub.id} (${sub.userName || sub.deviceName}):`, err.statusCode || err.message);
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
app.post('/api/channels', requireAdmin, (req, res) => {
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

app.delete('/api/channels/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.channels = db.channels.filter(c => c.id !== id);
  saveDB(db);
  res.json({ status: 200, message: 'Deleted channel' });
});

app.get('/api/tokens', requireAdmin, (req, res) => {
  res.json({ status: 200, tokens: db.tokens || [] });
});

app.post('/api/tokens', requireAdmin, (req, res) => {
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

app.delete('/api/tokens/:id', requireAdmin, (req, res) => {
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

app.delete('/api/notifications/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.notifications = db.notifications.filter(n => n.id !== id);
  saveDB(db);
  broadcastSSE('notification_deleted', { id });
  res.json({ status: 200, message: 'Deleted' });
});

app.delete('/api/notifications', requireAdmin, (req, res) => {
  db.notifications = [];
  saveDB(db);
  broadcastSSE('notifications_cleared', {});
  res.json({ status: 200, message: 'Cleared all notifications' });
});

// View all registered push notification devices
app.get('/api/subscribers', requireAdmin, (req, res) => {
  const subscribers = db.subscriptions.map(s => ({
    id: s.id,
    deviceName: s.deviceName,
    userId: s.userId || null,
    userName: s.userName || null,
    role: s.role || 'anonymous',
    updatedAt: s.updatedAt
  }));
  res.json({ status: 200, subscribers, count: subscribers.length });
});

// Delete an old/stale subscription device
app.delete('/api/subscribers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const initialLen = db.subscriptions.length;
  db.subscriptions = db.subscriptions.filter(s => s.id !== id);
  if (db.subscriptions.length !== initialLen) {
    saveDB(db);
  }
  res.json({ status: 200, message: 'Deleted subscriber device' });
});

// ==========================================
// 6. BOT MANAGEMENT & AUTO-ACCEPT CONTROL ENDPOINTS
// ==========================================
const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');
const BOT_STATE_FILE = path.join(DATA_DIR, 'bot_state.json');

function getBotConfigData() {
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(BOT_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
      return JSON.parse(raw);
    } catch (e) {}
  }
  return db.botConfig || {
    autoAccept: false,
    pollIntervalSec: 60,
    estimateDays: 7,
    factoryUser: 'THANASIT',
    elecEnabled: true,
    airEnabled: false
  };
}

function saveBotConfigData(cfg) {
  db.botConfig = cfg;
  saveDB(db);
}

app.get('/api/bot/config', requireAdmin, (req, res) => {
  res.json({ status: 200, config: getBotConfigData() });
});

// Bot configuration is restricted to PC only (BotControlCenter.exe)
app.post('/api/bot/config', requireAdmin, (req, res) => {
  return res.status(403).json({ status: 403, message: 'การตั้งค่าบอทกำหนดให้ทำผ่านโปรแกรมบนเครื่อง PC เท่านั้น' });
});

app.get('/api/bot/status', async (req, res) => {
  // 1. Try querying local daemon
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const daemonRes = await fetch('http://127.0.0.1:3055/api/bot/status', {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (daemonRes.ok) {
      const daemonData = await daemonRes.json();
      return res.json({ status: 200, online: true, ...daemonData });
    }
  } catch (e) {}

  // 2. Fallback to cached state from file or db heartbeat
  let cachedState = null;
  if (fs.existsSync(BOT_STATE_FILE)) {
    try {
      const raw = fs.readFileSync(BOT_STATE_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
      cachedState = JSON.parse(raw);
    } catch (e) {}
  }
  if (!cachedState && db.botHeartbeat) {
    cachedState = db.botHeartbeat.state;
  }

  res.json({
    status: 200,
    online: false,
    state: cachedState || { running: false, currentTask: 'บอทไม่ได้เปิดทำงานในขณะนี้' },
    config: getBotConfigData()
  });
});

app.post('/api/bot/check-now', requireAdmin, async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:3055/api/bot/check-now', { method: 'POST' });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(503).json({ status: 503, message: 'ไม่สามารถติดต่อ Bot Daemon ในเครื่องได้ (โปรดตรวจสอบว่าเปิด Bot แล้วหรือไม่)' });
  }
});

app.post('/api/bot/sync-backlog', requireAdmin, async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:3055/api/bot/sync-backlog', { method: 'POST' });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(503).json({ status: 503, message: 'ไม่สามารถติดต่อ Bot Daemon ในเครื่องได้ (โปรดตรวจสอบว่าเปิด Bot แล้วหรือไม่)' });
  }
});

app.post('/api/bot/unlock-user', requireAdmin, async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:3055/api/bot/unlock-user', { method: 'POST' });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(503).json({ status: 503, message: 'ไม่สามารถติดต่อ Bot Daemon ในเครื่องได้ (โปรดตรวจสอบว่าเปิด Bot แล้วหรือไม่)' });
  }
});

// Heartbeat receiver for cloud-to-local sync
app.post('/api/bot/heartbeat', (req, res) => {
  const { state: botState, config: botCfg } = req.body || {};
  db.botHeartbeat = {
    state: botState,
    reportedAt: new Date().toISOString()
  };
  if (botCfg && typeof botCfg === 'object' && Object.keys(botCfg).length > 0) {
    db.botConfig = { ...getBotConfigData(), ...botCfg };
    saveBotConfigData(db.botConfig);
  } else {
    saveDB(db);
  }

  res.json({
    status: 200,
    remoteConfig: getBotConfigData(),
    pendingActions: db.botPendingActions || []
  });
});

// Acknowledge processed bot action from cloud queue
app.post('/api/bot/action-ack', (req, res) => {
  const { actionId } = req.body || {};
  if (actionId && db.botPendingActions) {
    db.botPendingActions = db.botPendingActions.filter(a => a.id !== actionId);
    saveDB(db);
  }
  return res.json({ status: 200, ok: true });
});

// Manual Accept & Assign by Admin for unmatched / review tickets
app.post('/api/admin/accept-and-assign', requireAdmin, async (req, res) => {
  const { notifId, docno, techId, techName, estimateDays, user } = req.body || {};
  if (!docno || !techId) {
    return res.status(400).json({ status: 400, message: 'กรุณาระบุ docno และ techId' });
  }

  const factoryUser = user || (getBotConfigData() ? getBotConfigData().factoryUser : 'THANASIT') || 'THANASIT';
  const estDays = Math.max(1, parseInt(estimateDays, 10) || 7);

  let acceptResult = null;
  let executedLocally = false;

  // 1. Try local bot daemon first (port 3055)
  try {
    const botRes = await fetch('http://127.0.0.1:3055/api/bot/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docno, techId, techName, estimateDays: estDays, user: factoryUser })
    });
    if (botRes.ok) {
      acceptResult = await botRes.json();
      executedLocally = true;
    }
  } catch (e) {
    // bot daemon not running on port 3055
  }

  // 2. If bot daemon didn't answer, check if SqlBridge.exe exists locally on this host
  if (!executedLocally) {
    const SQL_BRIDGE = path.join(__dirname, 'SqlBridge.exe');
    if (fs.existsSync(SQL_BRIDGE)) {
      try {
        const { execFile } = require('child_process');
        const output = await new Promise((resolve, reject) => {
          execFile(SQL_BRIDGE, ['accept', docno, String(estDays), factoryUser, techId], { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
            if (err && !stdout) return reject(err);
            resolve(stdout);
          });
        });
        const clean = (output || '').trim().replace(/^\uFEFF/, '');
        const parsed = JSON.parse(clean);
        if (parsed.ok) {
          acceptResult = parsed;
          executedLocally = true;
        }
      } catch (err) {
        console.error('SqlBridge direct accept error:', err.message);
      }
    }
  }

  // 3. If neither ran locally (e.g. server is on Render cloud), queue action for bot daemon to pick up via heartbeat
  if (!executedLocally) {
    if (!db.botPendingActions) db.botPendingActions = [];
    db.botPendingActions.push({
      id: 'act_' + Date.now(),
      type: 'accept_and_assign',
      docno,
      techId,
      techName,
      estimateDays: estDays,
      user: factoryUser,
      notifId,
      createdAt: new Date().toISOString()
    });
    saveDB(db);
  }

  // 4. Update notification in-place in db.notifications
  let targetNotif = null;
  if (notifId) {
    targetNotif = (db.notifications || []).find(n => n.id === notifId);
  }
  if (!targetNotif && docno) {
    targetNotif = (db.notifications || []).find(n =>
      (n.metadata && n.metadata.docno === docno) ||
      (n.title && n.title.includes(docno))
    );
  }

  if (targetNotif) {
    targetNotif.taskStatus = 'in_progress';
    targetNotif.assignee = techName;
    targetNotif.title = targetNotif.title.replace('⚠️ [รอแอดมินพิจารณา]', '⚡ [แอดมินมอบหมาย]');
    targetNotif.priority = 'high';
    targetNotif.updatedAt = new Date().toISOString();
    if (!targetNotif.metadata) targetNotif.metadata = {};
    targetNotif.metadata.assignedTechId = techId;
    targetNotif.metadata.assignedTechName = techName;
    targetNotif.metadata.estimateDays = estDays;
    saveDB(db);
    broadcastSSE('status_updated', targetNotif);

    // Send Web Push notification to target technician
    try {
      const pushPayload = JSON.stringify({
        id: targetNotif.id,
        title: `⚡ [มอบหมายงาน] ${docno} - ${targetNotif.channelName || 'งานแจ้งซ่อม'}`,
        body: `[ช่าง: ${techName}] ${targetNotif.message}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: targetNotif.id,
        priority: 'high',
        url: '/',
        createdAt: targetNotif.updatedAt
      });
      const targets = db.subscriptions.filter(sub => matchAssigneeServer(techName, sub));
      for (const sub of targets) {
        webpush.sendNotification(sub.subscription, pushPayload, { TTL: 86400, urgency: 'high' }).catch(() => {});
      }
    } catch (e) {}
  }

  return res.json({
    status: 200,
    ok: true,
    executedLocally,
    message: executedLocally
      ? `รับเรื่อง ${docno} ในระบบโรงงานและมอบหมายให้ ${techName} เรียบร้อยแล้ว`
      : `ส่งคำสั่งรับเรื่อง ${docno} ให้ ${techName} ไปยังบอทโรงงานเรียบร้อยแล้ว`,
    job: acceptResult?.job || null
  });
});

// Dismiss unmatched ticket without accepting
app.post('/api/admin/dismiss-unmatched', requireAdmin, async (req, res) => {
  const { notifId, docno } = req.body || {};
  if (!notifId && !docno) {
    return res.status(400).json({ status: 400, message: 'กรุณาระบุ notifId หรือ docno' });
  }

  const idx = (db.notifications || []).findIndex(n =>
    n.id === notifId || (docno && ((n.metadata && n.metadata.docno === docno) || (n.title && n.title.includes(docno))))
  );
  let deleted = null;
  if (idx >= 0) {
    deleted = db.notifications.splice(idx, 1)[0];
    saveDB(db);
    broadcastSSE('notification_deleted', { id: deleted.id });
  }

  if (docno) {
    try {
      await fetch('http://127.0.0.1:3055/api/bot/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docno })
      });
    } catch (e) {}
  }

  return res.json({ status: 200, ok: true, message: `ปฏิเสธ/ไม่รับงาน ${docno || ''} เรียบร้อยแล้ว` });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('====================================================');
  console.log(`🚀 ADDA Service - ระบบแจ้งเตือน & แจกงาน เริ่มทำงานแล้ว!`);
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
