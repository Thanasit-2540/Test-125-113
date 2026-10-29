const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const {
  DATA_DIR,
  SKILLS_FILE,
  JOP_FILE,
  BOT_CONFIG_FILE,
  BOT_STATE_FILE,
  ensureDir,
  readJsonSafe,
  writeJsonSafe,
  buildSkillsDb,
  buildJopDb
} = require('./build_db_files');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_DAEMON_URL = 'http://127.0.0.1:3055';

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SQL_BRIDGE = path.join(__dirname, 'SqlBridge.exe');

// SHA-256 digests for cloud fallback (avoids storing plaintext admin password in source code)
const FALLBACK_ADMIN_PASSWORD_HASHES = new Set([
  '6c3c179eb923164b0a08365d2f93ddf3185605ad123ad1a8b0992c985a2e2583',
  'f82576f4cab493dbc199b833ad5e9f7080db40d1516c13e86c6a9e39669c41ec'
]);

ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);

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

// ==========================================
// 0. DATABASE & HELPER UTILITIES
// ==========================================
function loadDB() {
  let data = readJsonSafe(DB_FILE, null);

  const vapidKeys = (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : {
        publicKey: 'BC-q8kHavBV9z7xjUyBFvueEtovCQtOCD-h8b--DaqKRZufHzB-StoNhIcnFufRKFaZtgkf7uLF9O7hNzzHRIlA',
        privateKey: 'PGjw0ZwlXtGISVoV3REAcLDPgSnF4SS6ONaVB-4okgo'
      };
  const now = new Date().toISOString();

  if (!data) {
    data = {
      vapidKeys,
      channels: [
        {
          id: 'ch_1793174210712',
          name: '⚡ งานค้างซ่อม: ไฟฟ้า',
          description: 'รายการงานค้างซ่อมหมวดไฟฟ้า/โทรศัพท์',
          color: '#F59E0B',
          createdAt: now
        },
        {
          id: 'ch_1793174215636',
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
          channelId: 'ch_1793174210712',
          createdAt: now,
          lastUsedAt: null,
          usageCount: 1
        }
      ],
      subscriptions: [],
      notifications: [],
      technicians: []
    };
  }

  if (!data.technicians || data.technicians.length === 0) {
    data.technicians = [
      { id: '56877', name: 'นาย มี', role: 'technician', active: true },
      { id: '57145', name: 'นาย พิวพิว', role: 'technician', active: true },
      { id: '52B13', name: 'นาย กิตติพงษ์ ศรีโยธา', role: 'technician', active: true },
      { id: '51061', name: 'นาย อาทิตย์ บ้วนนอก', role: 'technician', active: true },
      { id: '61B47', name: 'นาย ศิวกร วงค์ครองศักดิ์', role: 'technician', active: true }
    ];
    saveDB(data);
  }

  return data;
}

function saveDB(data) {
  writeJsonSafe(DB_FILE, data);
}

const db = loadDB();

function getSkillsDb() {
  const existing = readJsonSafe(SKILLS_FILE, null);
  if (existing) return existing;
  try {
    return buildSkillsDb();
  } catch (e) {
    return { title: 'สกิล', technicians: [] };
  }
}

function extractDocno(notif) {
  if (!notif) return null;
  if (notif.metadata && notif.metadata.docno) return String(notif.metadata.docno).toUpperCase();
  const match = (notif.title || '').match(/\b(IF\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function enrichJobsWithImages(jobsDb) {
  if (!jobsDb || !db || !Array.isArray(db.notifications)) return jobsDb;
  const docImgMap = new Map();
  for (const n of db.notifications) {
    if (!n.image) continue;
    const doc = extractDocno(n);
    if (doc) docImgMap.set(doc.toUpperCase(), n.image);
  }
  if (docImgMap.size === 0) return jobsDb;

  const enrichJob = (j) => {
    if (!j) return j;
    const doc = (j.docno || '').toUpperCase();
    if (!j.image && docImgMap.has(doc)) {
      return { ...j, image: docImgMap.get(doc) };
    }
    return j;
  };

  const enriched = { ...jobsDb };
  if (Array.isArray(enriched.allJobs)) {
    enriched.allJobs = enriched.allJobs.map(enrichJob);
  }
  if (enriched.byTechnician && typeof enriched.byTechnician === 'object') {
    const newByTech = {};
    for (const [k, v] of Object.entries(enriched.byTechnician)) {
      newByTech[k] = {
        ...v,
        jobs: Array.isArray(v.jobs) ? v.jobs.map(enrichJob) : []
      };
    }
    enriched.byTechnician = newByTech;
  }
  if (enriched.unmatchedPendingAdmin && Array.isArray(enriched.unmatchedPendingAdmin.jobs)) {
    enriched.unmatchedPendingAdmin = {
      ...enriched.unmatchedPendingAdmin,
      jobs: enriched.unmatchedPendingAdmin.jobs.map(enrichJob)
    };
  }
  return enriched;
}

function getJobsDb() {
  const existing = readJsonSafe(JOP_FILE, null);
  let base = existing;
  if (!base) {
    try {
      base = buildJopDb();
    } catch (e) {
      base = { title: 'Jop', byTechnician: {}, allJobs: [], unmatchedPendingAdmin: { count: 0, jobs: [] } };
    }
  }
  return enrichJobsWithImages(base);
}

function removeUploadFileIfUnused(imageUrl) {
  if (!imageUrl || !String(imageUrl).startsWith('/uploads/')) return;
  const stillUsed = (db.notifications || []).some(n => n.image === imageUrl);
  if (stillUsed) return;

  const fileName = path.basename(imageUrl);
  const fullPath = path.join(UPLOAD_DIR, fileName);
  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch (e) {}
}

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
// 1. SECURITY, RATE LIMITING & AUTHENTICATION
// ==========================================
const loginAttempts = new Map();
const activeAdminSessions = new Set();
const SERVER_SECRET = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || 'ADDA_SERVICE_MASTER_SECRET_2026').digest('hex');

function generateAdminToken() {
  const nonce = Date.now().toString(36) + '_' + crypto.randomBytes(8).toString('hex');
  const hmac = crypto.createHmac('sha256', SERVER_SECRET).update(nonce).digest('base64url');
  return `adm_${nonce}_${hmac}`;
}

function isValidAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith('adm_')) return false;
  if (activeAdminSessions.has(token)) return true;

  const parts = token.slice(4).split('_');
  if (parts.length === 3) {
    const nonce = `${parts[0]}_${parts[1]}`;
    const expected = crypto.createHmac('sha256', SERVER_SECRET).update(nonce).digest('base64url');
    try {
      if (crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) {
        activeAdminSessions.add(token);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

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
    record.lockedUntil = now + 15 * 60 * 1000;
  }

  loginAttempts.set(ip, record);
}

function resetFailedAttempts(req) {
  loginAttempts.delete(getClientIP(req));
}

function isLocalOrInternal(req) {
  if (req.headers['x-forwarded-for']) return false;
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function getConfiguredAdminPasswords() {
  const validPasswords = new Set();

  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim()) {
    validPasswords.add(process.env.ADMIN_PASSWORD.trim());
  }

  const passDir = path.join(__dirname, 'Password');
  const customAdminFile = path.join(passDir, 'admin_password.txt');
  if (fs.existsSync(customAdminFile)) {
    try {
      const p = fs.readFileSync(customAdminFile, 'utf8').trim();
      if (p) validPasswords.add(p);
    } catch (e) {}
  }

  const mainPassFile = path.join(passDir, 'Password.txt');
  if (fs.existsSync(mainPassFile)) {
    try {
      const str = fs.readFileSync(mainPassFile).toString('latin1');
      const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.includes('=')) {
          const val = line.split('=')[1].trim();
          if (val) validPasswords.add(val);
        }
      }
    } catch (e) {}
  }

  return validPasswords;
}

function isValidAdminPassword(input) {
  const candidate = String(input || '').trim();
  if (!candidate) return false;

  const configured = getConfiguredAdminPasswords();
  if (configured.has(candidate)) return true;

  const hash = crypto.createHash('sha256').update(candidate).digest('hex');
  return FALLBACK_ADMIN_PASSWORD_HASHES.has(hash);
}

function extractAdminToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const adminTokenHeader = req.headers['x-admin-token'] || '';

  if (authHeader.startsWith('Bearer adm_')) {
    return authHeader.slice(7).trim();
  }
  if (adminTokenHeader.startsWith('adm_')) {
    return adminTokenHeader.trim();
  }
  return '';
}

function isAdminRequest(req) {
  if (isLocalOrInternal(req)) return true;
  const token = extractAdminToken(req);
  if (token && isValidAdminToken(token)) return true;
  const adminPass = req.headers['x-admin-password'];
  return Boolean(adminPass && isValidAdminPassword(adminPass));
}

function requireAdmin(req, res, next) {
  if (isAdminRequest(req)) {
    return next();
  }
  return res.status(403).json({
    ok: false,
    status: 403,
    error: 'Unauthorized: จำเป็นต้องเข้าสู่ระบบแอดมินก่อนดำเนินการ'
  });
}

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.post('/api/admin/login', (req, res) => {
  if (!checkRateLimit(req, res)) return;

  const { password } = req.body || {};
  if (isValidAdminPassword(password)) {
    resetFailedAttempts(req);
    const adminToken = generateAdminToken();
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
// 1.1 TECHNICIAN AUTHENTICATION & MANAGEMENT
// ==========================================
app.post('/api/auth/login', (req, res) => {
  if (!checkRateLimit(req, res)) return;

  const { employeeId } = req.body || {};
  if (!employeeId || !String(employeeId).trim()) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกรหัสพนักงาน' });
  }

  const rawInput = String(employeeId).trim();

  // Direct Admin Login if input matches Admin Password
  if (isValidAdminPassword(rawInput)) {
    resetFailedAttempts(req);
    const adminToken = generateAdminToken();
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
    const token = extractAdminToken(req);
    const validSession = Boolean(token && isValidAdminToken(token));
    if (!validSession && !isLocalOrInternal(req)) {
      return res.json({ ok: false, active: false, error: 'เซสชันแอดมินหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
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

// ==========================================
// 2. SSE REAL-TIME STREAM & DASHBOARD INIT
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

app.get('/api/init', (req, res) => {
  const localIPs = getLocalIPs();
  const isAdmin = isAdminRequest(req);

  res.json({
    vapidPublicKey: db.vapidKeys.publicKey,
    channels: db.channels,
    technicians: (db.technicians || []).map(t => ({ id: t.id, name: t.name, active: t.active })),
    tokens: isAdmin ? db.tokens : [],
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
    jobsData: getJobsDb(),
    skillsData: getSkillsDb(),
    serverInfo: {
      port: PORT,
      localIPs,
      urls: localIPs.map(ip => `http://${ip}:${PORT}`)
    }
  });
});

// ==========================================
// 2.1 SKILLS & JOBS (สกิล.json & Jop.json) API
// ==========================================
app.get('/api/skills', (req, res) => {
  res.json({ ok: true, data: getSkillsDb() });
});

app.post('/api/skills/sync', (req, res) => {
  try {
    const payload = req.body;
    if (payload && (payload.technicians || Array.isArray(payload))) {
      const dataToSave = Array.isArray(payload)
        ? { technicians: payload, updatedAt: new Date().toISOString() }
        : payload;
      writeJsonSafe(SKILLS_FILE, dataToSave);
      broadcastSSE('skills_update', { count: (dataToSave.technicians || []).length, updatedAt: dataToSave.updatedAt });
      return res.json({ ok: true, message: 'Skills database synchronized successfully' });
    }
    res.status(400).json({ ok: false, error: 'Invalid skills payload' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/jobs', (req, res) => {
  const jobsDb = getJobsDb();
  const techId = req.query.techId ? String(req.query.techId).trim() : null;

  if (techId) {
    const techData = jobsDb.byTechnician ? (jobsDb.byTechnician[techId] || null) : null;
    return res.json({
      ok: true,
      techId,
      technician: techData ? { id: techData.id, name: techData.name } : null,
      jobs: techData ? techData.jobs : [],
      count: techData ? techData.count : 0,
      allJobsCount: (jobsDb.allJobs || []).length
    });
  }

  if (isAdminRequest(req)) {
    return res.json({
      ok: true,
      isAdmin: true,
      summary: jobsDb.summary,
      unmatchedPendingAdmin: jobsDb.unmatchedPendingAdmin,
      byTechnician: jobsDb.byTechnician,
      unassigned: jobsDb.unassigned,
      allJobs: jobsDb.allJobs
    });
  }

  res.json({ ok: true, data: jobsDb });
});

app.post('/api/jobs/sync', (req, res) => {
  try {
    const payload = req.body;
    if (payload && (payload.byTechnician || payload.allJobs)) {
      writeJsonSafe(JOP_FILE, payload);
      broadcastSSE('jobs_update', { summary: payload.summary, updatedAt: payload.updatedAt });
      return res.json({ ok: true, message: 'Jop database synchronized successfully', summary: payload.summary });
    }
    res.status(400).json({ ok: false, error: 'Invalid jobs payload' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 3. WEB PUSH SUBSCRIPTION & DISPATCH
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
  res.json({ status: 200, message: 'Subscribed successfully', subscriberCount: db.subscriptions.length });
});

function matchAssigneeServer(assigneeStr, sub) {
  if (!assigneeStr || !String(assigneeStr).trim()) return true;
  if (sub.role === 'admin') return true;

  const isPendingAdmin = String(assigneeStr).includes('แอดมิน') || String(assigneeStr).includes('admin');
  if (isPendingAdmin) {
    return sub.role === 'admin' || !sub.userId || sub.role === 'anonymous';
  }

  const uid = String(sub.userId || '').trim().toLowerCase();
  const uname = String(sub.userName || '').trim().toLowerCase();
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

async function dispatchWebPush(payloadObj, assignee, priority = 'normal') {
  const pushPayload = JSON.stringify(payloadObj);
  const targetSubscriptions = db.subscriptions.filter(sub => matchAssigneeServer(assignee, sub));
  const invalidEndpoints = [];

  await Promise.allSettled(
    targetSubscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, pushPayload, {
          TTL: 86400,
          urgency: priority === 'urgent' ? 'high' : 'normal'
        });
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
}

// ==========================================
// 4. LINE NOTIFY COMPATIBLE ENDPOINT (/api/notify & /notify)
// ==========================================
async function handleNotify(req, res) {
  try {
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

    const tokenObj = db.tokens.find(t => t.token === rawToken);
    if (!tokenObj) {
      return res.status(401).json({
        status: 401,
        message: 'Invalid access token (ไม่พบ Token นี้ในระบบ หรือถูกยกเลิกไปแล้ว)'
      });
    }

    const message = req.body.message;
    if (!message || String(message).trim() === '') {
      return res.status(400).json({
        status: 400,
        message: 'message is required (กรุณาระบุข้อความในฟิลด์ message)'
      });
    }

    const channel = db.channels.find(c => c.id === tokenObj.channelId) || {
      id: 'ch_default',
      name: 'แจ้งเตือนทั่วไป',
      color: '#06C755'
    };

    let imageUrl = req.body.imageFullsize || req.body.imageThumbnail || req.body.image || null;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }

    if (String(message).trim() === 'temp_upload') {
      return res.status(200).json({
        status: 200,
        message: 'Image uploaded',
        notification: { id: 'temp_upload', image: imageUrl }
      });
    }

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
      metadata: req.body.metadata || null,
      createdAt: new Date().toISOString()
    };

    // Deduplicate by factory ticket number (IF...)
    const cleanDoc = extractDocno(notification);
    let isBrandNew = true;
    let isStatusOrAssigneeChange = false;

    if (cleanDoc) {
      const oldMatches = db.notifications.filter(n => extractDocno(n) === cleanDoc);
      if (oldMatches.length > 0) {
        isBrandNew = false;
        const prev = oldMatches[0];
        if (prev.taskStatus !== notification.taskStatus || prev.assignee !== notification.assignee) {
          isStatusOrAssigneeChange = true;
        }
        // Preserve previous image if this update did not provide a new one
        if (!notification.image) {
          const oldWithImg = oldMatches.find(m => m.image);
          if (oldWithImg) {
            notification.image = oldWithImg.image;
          }
        }
        db.notifications = db.notifications.filter(n => !oldMatches.includes(n));
        oldMatches.forEach(old => {
          if (old.image && old.image !== notification.image) {
            removeUploadFileIfUnused(old.image);
          }
          broadcastSSE('notification_deleted', { id: old.id });
        });
      }
    }

    db.notifications.unshift(notification);
    if (db.notifications.length > 500) {
      const removed = db.notifications.slice(500);
      db.notifications = db.notifications.slice(0, 500);
      removed.forEach(r => removeUploadFileIfUnused(r.image));
    }

    tokenObj.lastUsedAt = notification.createdAt;
    tokenObj.usageCount = (tokenObj.usageCount || 0) + 1;
    saveDB(db);

    const isSilent = req.body.silent === true || req.body.silent === 'true' || req.body.isSync === true || req.body.isSync === 'true';
    const shouldAlert = (isBrandNew || isStatusOrAssigneeChange) && !isSilent;

    broadcastSSE('notification', { ...notification, silent: !shouldAlert });

    if (shouldAlert) {
      await dispatchWebPush(
        {
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
        },
        notification.assignee,
        notification.priority
      );
    }

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
  const target = db.notifications.find(n => n.id === id);
  db.notifications = db.notifications.filter(n => n.id !== id);
  if (target && target.image) {
    removeUploadFileIfUnused(target.image);
  }
  saveDB(db);
  broadcastSSE('notification_deleted', { id });
  res.json({ status: 200, message: 'Deleted' });
});

app.delete('/api/notifications', requireAdmin, (req, res) => {
  const oldImages = db.notifications.map(n => n.image).filter(Boolean);
  db.notifications = [];
  oldImages.forEach(img => removeUploadFileIfUnused(img));
  saveDB(db);
  broadcastSSE('notifications_cleared', {});
  res.json({ status: 200, message: 'Cleared all notifications' });
});

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
// 7. BOT MANAGEMENT & AUTO-ACCEPT CONTROL
// ==========================================
function getBotConfigData() {
  const fileCfg = readJsonSafe(BOT_CONFIG_FILE, null);
  if (fileCfg) return fileCfg;
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

async function proxyPostToBotDaemon(endpointPath, res) {
  try {
    const r = await fetch(`${BOT_DAEMON_URL}${endpointPath}`, { method: 'POST' });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(503).json({
      status: 503,
      message: 'ไม่สามารถติดต่อ Bot Daemon ในเครื่องได้ (โปรดตรวจสอบว่าเปิด Bot แล้วหรือไม่)'
    });
  }
}

app.get('/api/bot/config', requireAdmin, (req, res) => {
  res.json({ status: 200, config: getBotConfigData() });
});

app.post('/api/bot/config', requireAdmin, (req, res) => {
  return res.status(403).json({ status: 403, message: 'การตั้งค่าบอทกำหนดให้ทำผ่านโปรแกรมบนเครื่อง PC เท่านั้น' });
});

app.get('/api/bot/status', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const daemonRes = await fetch(`${BOT_DAEMON_URL}/api/bot/status`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (daemonRes.ok) {
      const daemonData = await daemonRes.json();
      return res.json({ status: 200, online: true, ...daemonData });
    }
  } catch (e) {}

  const cachedState = readJsonSafe(BOT_STATE_FILE, null) || (db.botHeartbeat && db.botHeartbeat.state);

  res.json({
    status: 200,
    online: false,
    state: cachedState || { running: false, currentTask: 'บอทไม่ได้เปิดทำงานในขณะนี้' },
    config: getBotConfigData()
  });
});

app.post('/api/bot/check-now', requireAdmin, (req, res) => proxyPostToBotDaemon('/api/bot/check-now', res));
app.post('/api/bot/sync-backlog', requireAdmin, (req, res) => proxyPostToBotDaemon('/api/bot/sync-backlog', res));
app.post('/api/bot/unlock-user', requireAdmin, (req, res) => proxyPostToBotDaemon('/api/bot/unlock-user', res));

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

app.post('/api/bot/action-ack', (req, res) => {
  const { actionId } = req.body || {};
  if (actionId && db.botPendingActions) {
    db.botPendingActions = db.botPendingActions.filter(a => a.id !== actionId);
    saveDB(db);
  }
  return res.json({ status: 200, ok: true });
});

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
    const botRes = await fetch(`${BOT_DAEMON_URL}/api/bot/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docno, techId, techName, estimateDays: estDays, user: factoryUser })
    });
    if (botRes.ok) {
      acceptResult = await botRes.json();
      executedLocally = true;
    }
  } catch (e) {}

  // 2. Fallback to SqlBridge.exe directly if available locally
  if (!executedLocally && fs.existsSync(SQL_BRIDGE)) {
    try {
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

  // 3. Queue action for bot daemon via heartbeat if running on Render Cloud
  if (!executedLocally) {
    if (!db.botPendingActions) db.botPendingActions = [];
    db.botPendingActions.push({
      id: `act_${Date.now()}`,
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

  // 4. Update notification in-place & send push notification to assigned technician
  let targetNotif = notifId ? (db.notifications || []).find(n => n.id === notifId) : null;
  if (!targetNotif && docno) {
    const upperDoc = String(docno).toUpperCase();
    targetNotif = (db.notifications || []).find(n => extractDocno(n) === upperDoc);
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

    // Update Jop database so unmatched count updates immediately
    try {
      const jop = readJsonSafe(JOP_FILE, null);
      if (jop) {
        if (jop.unmatchedPendingAdmin && Array.isArray(jop.unmatchedPendingAdmin.jobs)) {
          const found = jop.unmatchedPendingAdmin.jobs.find(j => j.docno === docno);
          jop.unmatchedPendingAdmin.jobs = jop.unmatchedPendingAdmin.jobs.filter(j => j.docno !== docno);
          jop.unmatchedPendingAdmin.count = jop.unmatchedPendingAdmin.jobs.length;
          if (jop.summary) {
            jop.summary.pendingAdminCount = jop.unmatchedPendingAdmin.count;
          }

          if (found) {
            found.techs = techName;
            found.status = 'in_progress';
            found.statusBadge = '🟡 [กำลังดำเนินการ]';
            if (!jop.allJobs) jop.allJobs = [];
            jop.allJobs.unshift(found);
            if (jop.summary) jop.summary.totalAccepted = jop.allJobs.length;

            if (techId && jop.byTechnician && jop.byTechnician[techId]) {
              if (!jop.byTechnician[techId].jobs) jop.byTechnician[techId].jobs = [];
              jop.byTechnician[techId].jobs.unshift(found);
              jop.byTechnician[techId].count = jop.byTechnician[techId].jobs.length;
            }
          }
        }
        writeJsonSafe(JOP_FILE, jop);
        broadcastSSE('jobs_update', { ok: true, data: jop });
      }
    } catch (jopErr) {
      console.warn('Error updating Jop.json in accept-and-assign:', jopErr.message);
    }

    await dispatchWebPush(
      {
        id: targetNotif.id,
        title: `⚡ [มอบหมายงาน] ${docno} - ${targetNotif.channelName || 'งานแจ้งซ่อม'}`,
        body: `[ช่าง: ${techName}] ${targetNotif.message}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: targetNotif.id,
        priority: 'high',
        url: '/',
        createdAt: targetNotif.updatedAt
      },
      techName,
      'high'
    );
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

app.post('/api/admin/dismiss-unmatched', requireAdmin, async (req, res) => {
  const { notifId, docno } = req.body || {};
  if (!notifId && !docno) {
    return res.status(400).json({ status: 400, message: 'กรุณาระบุ notifId หรือ docno' });
  }

  const upperDoc = docno ? String(docno).toUpperCase() : '';
  const idx = (db.notifications || []).findIndex(n =>
    n.id === notifId || (upperDoc && extractDocno(n) === upperDoc)
  );
  if (idx >= 0) {
    const deleted = db.notifications.splice(idx, 1)[0];
    if (deleted.image) removeUploadFileIfUnused(deleted.image);
    saveDB(db);
    broadcastSSE('notification_deleted', { id: deleted.id });
  }

  if (docno) {
    try {
      await fetch(`${BOT_DAEMON_URL}/api/bot/dismiss`, {
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
  console.log('🚀 ADDA Service - ระบบแจ้งเตือน & แจกงาน เริ่มทำงานแล้ว!');
  console.log(`👉 เปิดบนคอมพิวเตอร์: http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`📱 เปิดผ่านมือถือ (Wi-Fi เดียวกัน): http://${ip}:${PORT}`);
  });
  console.log('====================================================');

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://powerenergy-rfik.onrender.com';
  setInterval(() => {
    fetch(`${RENDER_URL}/api/health`).catch(() => {});
  }, 5 * 60 * 1000);
});
