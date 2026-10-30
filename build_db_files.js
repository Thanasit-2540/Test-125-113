const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const SKILLS_FILE = path.join(DATA_DIR, 'สกิล.json');
const JOP_FILE = path.join(DATA_DIR, 'Jop.json');
const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');
const BOT_STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const BACKLOG_FILE = path.join(DATA_DIR, 'backlog.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe(filePath, defaultVal = null) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`[readJsonSafe] Error reading ${filePath}:`, e.message);
  }
  return defaultVal;
}

function writeJsonSafe(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error(`[writeJsonSafe] Error writing ${filePath}:`, e.message);
    return false;
  }
}

function isAirJob(job) {
  const cat = String(job.category || '').toLowerCase();
  return job.jobType === '3' || cat.includes('air') || cat.includes('แอร์');
}

function isJobMatchedByRules(job, config) {
  if (!config) return false;
  const isAir = isAirJob(job);
  const rules = isAir ? (config.airTechRules || []) : (config.elecTechRules || []);
  const symptomLower = String(job.symptom || '').toLowerCase();
  for (const rule of rules) {
    if (!rule || !rule.enabled || !rule.id) continue;
    const kwRaw = Array.isArray(rule.keywords) ? rule.keywords.join(',') : String(rule.keywords || '');
    const kwList = kwRaw.split(',').map(s => s.trim()).filter(Boolean);
    for (const kw of kwList) {
      if (kw === '*' || symptomLower.includes(kw.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function getCategoryMeta(job) {
  const isAir = isAirJob(job);
  return {
    isAir,
    category: isAir ? 'แอร์' : 'ไฟฟ้า/โทรศัพท์',
    categoryBadge: isAir ? '❄️ [แอร์]' : '⚡ [ไฟฟ้า]'
  };
}

function mergeTechRulesIntoMap(allTechsMap, rules, categoryName) {
  (rules || []).forEach(r => {
    if (!r || (!r.id && !r.name)) return;

    if (!allTechsMap[r.id]) {
      allTechsMap[r.id] = {
        id: r.id,
        name: r.name,
        categories: [],
        skills: [],
        rawKeywords: '',
        enabled: r.enabled !== false
      };
    }

    const techEntry = allTechsMap[r.id];
    if (!techEntry.categories.includes(categoryName)) {
      techEntry.categories.push(categoryName);
    }

    const kwList = String(r.keywords || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    kwList.forEach(kw => {
      if (!techEntry.skills.includes(kw)) {
        techEntry.skills.push(kw);
      }
    });
  });
}

// 1. สร้างฐานข้อมูลความสามารถช่าง (สกิล.json) จากค่าที่ตั้งไว้ในแอปพลิเคชัน
function buildSkillsDb() {
  const cfg = readJsonSafe(BOT_CONFIG_FILE, {}) || {};
  const allTechsMap = {};

  mergeTechRulesIntoMap(allTechsMap, cfg.elecTechRules, 'ไฟฟ้า/โทรศัพท์');
  mergeTechRulesIntoMap(allTechsMap, cfg.airTechRules, 'แอร์');

  const skillsList = Object.values(allTechsMap);
  skillsList.forEach(t => {
    t.rawKeywords = t.skills.join(', ');
    const perm = cfg.permissions?.[t.id] || {};
    const isAirRuleSelfAccept = (cfg.airTechRules || []).some(r => r.id === t.id && (r.canSelfAccept === true));
    const isElecRuleSelfAccept = (cfg.elecTechRules || []).some(r => r.id === t.id && (r.canSelfAccept === true));
    t.canAcceptAir = perm.canAcceptAir !== undefined ? Boolean(perm.canAcceptAir) : (isAirRuleSelfAccept && t.categories.includes('แอร์'));
    t.canAcceptElec = perm.canAcceptElec !== undefined ? Boolean(perm.canAcceptElec) : (isElecRuleSelfAccept && t.categories.includes('ไฟฟ้า/โทรศัพท์'));
  });

  const skillsDb = {
    title: 'ฐานข้อมูลความสามารถช่าง (สกิล)',
    description: 'เก็บรายชื่อช่างและความสามารถที่ตั้งค่าจากแอปพลิเคชัน (เฉพาะในแอพ)',
    updatedAt: new Date().toISOString(),
    count: skillsList.length,
    technicians: skillsList
  };

  writeJsonSafe(SKILLS_FILE, skillsDb);
  return skillsDb;
}

// 2. สร้างฐานข้อมูลงาน (Jop.json) แยกรายบุคคลช่าง และส่วนงานรอแอดมินพิจารณา
function buildJopDb(optionalBacklog = null, optionalPending = null) {
  const skillsDb = buildSkillsDb();
  const technicians = skillsDb.technicians;

  const backlog = optionalBacklog || readJsonSafe(BACKLOG_FILE, []) || [];
  let pending = optionalPending;
  if (!pending) {
    const botState = readJsonSafe(BOT_STATE_FILE, {}) || {};
    pending = botState.pendingJobs || [];
    if (!pending || pending.length === 0) {
      const sqlBridgePath = path.join(__dirname, 'SqlBridge.exe');
      if (fs.existsSync(sqlBridgePath)) {
        try {
          const { execFileSync } = require('child_process');
          const out = execFileSync(sqlBridgePath, ['pending'], { encoding: 'utf8' });
          const res = JSON.parse(out);
          pending = (res && res.items) || [];
        } catch (e) {}
      }
    }
  }

  const config = readJsonSafe(BOT_CONFIG_FILE, {});
  const unmatchedPending = (pending || []).filter(item => !isJobMatchedByRules(item, config));
  const airPending = (pending || []).filter(item => isAirJob(item) && isJobMatchedByRules(item, config));
  const elecPending = (pending || []).filter(item => !isAirJob(item) && isJobMatchedByRules(item, config));

  const pendingAirJobs = airPending.map(item => {
    return {
      docno: item.docno,
      category: 'air',
      categoryBadge: '❄️ [แอร์]',
      statusBadge: '⏳ [รอช่างแอร์รับเรื่อง]',
      jobType: item.jobType || '3',
      symptom: item.symptom,
      deptName: item.deptName,
      location: item.location,
      date1: item.date1,
      time1: item.time1,
      requester: item.requester,
      receiver: '-',
      techs: 'รอช่างแอร์รับเรื่อง & ระบุช่าง',
      picname: item.picname,
      priority: 'high',
      status: 'pending_air',
      taskStatus: 'pending_air',
      isPendingAir: true
    };
  });

  const pendingElecJobs = elecPending.map(item => {
    return {
      docno: item.docno,
      category: 'elec',
      categoryBadge: '⚡ [ไฟฟ้า]',
      statusBadge: '⏳ [รอช่างไฟฟ้ารับเรื่อง]',
      jobType: item.jobType || '7',
      symptom: item.symptom,
      deptName: item.deptName,
      location: item.location,
      date1: item.date1,
      time1: item.time1,
      requester: item.requester,
      receiver: '-',
      techs: 'รอช่างไฟฟ้ารับเรื่อง & ระบุช่าง',
      picname: item.picname,
      priority: 'high',
      status: 'pending_elec',
      taskStatus: 'pending_elec',
      isPendingElec: true
    };
  });

  const byTech = {};
  technicians.forEach(t => {
    byTech[t.id] = {
      id: t.id,
      name: t.name,
      categories: t.categories,
      count: 0,
      jobs: []
    };
  });

  const unassigned = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  backlog.forEach(job => {
    const { category, categoryBadge } = getCategoryMeta(job);
    const isOverdue = Boolean(job.estIso && job.estIso < todayIso);
    const statusBadge = isOverdue
      ? `🔴 [เกินกำหนด ${job.estDate || ''}]`
      : `🟡 [กำหนดเสร็จ ${job.estDate || ''}]`;

    const jobEntry = {
      docno: job.docno,
      category,
      categoryBadge,
      statusBadge,
      jobType: job.jobType,
      symptom: job.symptom,
      deptName: job.deptName,
      location: job.location,
      date1: job.date1,
      time1: job.time1,
      recvDate: job.recvDate,
      estDate: job.estDate,
      estIso: job.estIso,
      requester: job.requester,
      receiver: job.receiver,
      techs: job.techs,
      picname: job.picname,
      priority: isOverdue ? 'urgent' : 'high',
      status: 'in_progress',
      isOverdue
    };

    const assignedTechs = String(job.techs || '').toLowerCase();
    let matchedAny = false;

    technicians.forEach(t => {
      const cleanName = t.name.replace(/^(นาย|นาง|น\.ส\.)\s*/, '').trim().toLowerCase();
      const firstName = cleanName.split(/\s+/)[0];
      if (
        assignedTechs.includes(t.id.toLowerCase()) ||
        assignedTechs.includes(t.name.toLowerCase()) ||
        assignedTechs.includes(cleanName) ||
        (firstName && assignedTechs.includes(firstName))
      ) {
        byTech[t.id].jobs.push(jobEntry);
        byTech[t.id].count++;
        matchedAny = true;
      }
    });

    if (!matchedAny) {
      unassigned.push(jobEntry);
    }
  });

  const pendingAdminJobs = unmatchedPending.map(item => {
    const { category, categoryBadge } = getCategoryMeta(item);
    return {
      docno: item.docno,
      category,
      categoryBadge,
      statusBadge: '⚠️ [รอแอดมินพิจารณา]',
      jobType: item.jobType,
      symptom: item.symptom,
      deptName: item.deptName,
      location: item.location,
      date1: item.date1,
      time1: item.time1,
      requester: item.requester,
      receiver: item.receiver || '-',
      techs: 'รอแอดมินมอบหมาย',
      picname: item.picname,
      priority: 'urgent',
      status: 'pending_admin'
    };
  });

  const airCount = backlog.filter(j => isAirJob(j)).length;
  const elecCount = backlog.length - airCount;

  const jopDb = {
    title: 'ฐานข้อมูลงาน (Jop)',
    description: 'เก็บชุดข้อมูลงานแยกตามรายบุคคล (ช่าง) และส่วนงานไม่ตรงเงื่อนไขรอแอดมินตัดสินใจ',
    updatedAt: new Date().toISOString(),
    summary: {
      totalAccepted: backlog.length,
      elecCount,
      airCount,
      pendingAirCount: pendingAirJobs.length,
      pendingElecCount: pendingElecJobs.length,
      pendingAdminCount: pendingAdminJobs.length
    },
    byTechnician: byTech,
    unassigned,
    pendingAir: {
      description: 'งานแอร์รอช่างแอร์ประเมินวันเสร็จและเลือกช่างรับเรื่องเอง',
      count: pendingAirJobs.length,
      jobs: pendingAirJobs
    },
    pendingElec: {
      description: 'งานไฟฟ้ารอช่างไฟฟ้าประเมินวันเสร็จและเลือกช่างรับเรื่องเอง',
      count: pendingElecJobs.length,
      jobs: pendingElecJobs
    },
    unmatchedPendingAdmin: {
      description: 'งานที่ไม่ตรงกับเงื่อนไขคีย์เวิร์ดของช่างคนใด รอแอดมินพิจารณาตัดสินใจ',
      count: pendingAdminJobs.length,
      jobs: pendingAdminJobs
    },
    allJobs: backlog
  };

  writeJsonSafe(JOP_FILE, jopDb);
  return jopDb;
}

if (require.main === module) {
  console.log('🔄 กำลังสร้างไฟล์ สกิล.json และ Jop.json...');
  const skills = buildSkillsDb();
  console.log(`✅ สร้าง 'สกิล.json' สำเร็จ (${skills.count} ช่าง)`);
  const jop = buildJopDb();
  console.log(`✅ สร้าง 'Jop.json' สำเร็จ (งานค้าง ${jop.summary.totalAccepted} งาน, งานรอแอดมิน ${jop.summary.pendingAdminCount} งาน)`);
  Object.values(jop.byTechnician).forEach(t => {
    console.log(`   👷 ${t.name} (${t.id}): ${t.count} งาน`);
  });
}

module.exports = {
  DATA_DIR,
  SKILLS_FILE,
  JOP_FILE,
  BOT_CONFIG_FILE,
  BOT_STATE_FILE,
  BACKLOG_FILE,
  ensureDir,
  readJsonSafe,
  writeJsonSafe,
  isAirJob,
  isJobMatchedByRules,
  getCategoryMeta,
  buildSkillsDb,
  buildJopDb
};
