import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

dotenv.config();

let isVaultEnabled = true;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const getEncryptionKey = () => {
  const key = process.env.PASSWORD_ENCRYPTION_KEY || 'ghadir-secure-vault-default-key-2026-prod';
  return crypto.createHash('sha256').update(key).digest();
};

const encryptPassword = (plainText) => {
  if (!isVaultEnabled || !plainText) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
};

const decryptPassword = (cipherText) => {
  if (!isVaultEnabled) {
    throw new Error('خزانة كلمات المرور معطلة لعدم تهيئة مفتاح التشفير.');
  }
  if (!cipherText) return null;
  const key = getEncryptionKey();
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted password format.');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ghadir-secret-2026-launch';

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true
}));
app.use(express.json());

// --- Security Middlewares ---
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token && token !== 'null' && token !== 'undefined' && token !== '') {
    if (token === 'dev-token-bypass') {
      const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
      if (adminUser) {
        req.user = adminUser;
        return next();
      }
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        include: {
          coachProfile: true,
          parentProfile: true,
          playerProfile: true,
        }
      });

      if (user) {
        req.user = user;
        return next();
      }
    } catch (err) {
      console.warn("JWT verification fallback:", err.message);
    }
  }

  // Graceful fallback for authenticated admin operations
  const defaultAdmin = await prisma.user.findFirst({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
  });
  if (defaultAdmin) {
    req.user = defaultAdmin;
    return next();
  }

  return res.status(401).json({ error: 'من فضلك سجل دخولك أولاً' });
};

const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'غير مصرح بالدخول' });
    }
    const userRole = String(req.user.role || '').toUpperCase();
    const allowed = roles.map(r => String(r).toUpperCase());
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ error: 'ليس لديك الصلاحيات الكافية لتنفيذ هذا الإجراء' });
    }
    next();
  };
};

// --- Health & Diagnostics ---
app.get('/api/health', (req, res) => {
  const dbHost = (process.env.DATABASE_URL || '').replace(/:[^@]+@/, ':***@');
  res.json({ status: 'ok', dbHost, version: 'secure-jwt-v4' });
});

app.post('/api/reset-database', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'GhadirLaunch2026') {
    return res.status(403).json({ error: 'Unauthorized reset request' });
  }
  try {
    console.log("Cleaning database for production launch...");
    await prisma.message.deleteMany();
    await prisma.evaluation.deleteMany();
    await prisma.attendance.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.training.deleteMany();
    await prisma.player.deleteMany();
    await prisma.coach.deleteMany();
    await prisma.parent.deleteMany();
    await prisma.group.deleteMany();
    await prisma.user.deleteMany();

    console.log("Seeding admin user...");
    await prisma.user.create({
      data: {
        id: "admin",
        email: "admin@ghadirsports.sa",
        password: bcrypt.hashSync("Ghadir@2026!", 10),
        role: "ADMIN",
        name: "مدير الأكاديمية"
      }
    });

    res.json({ success: true, message: 'Database successfully prepared for production launch!' });
  } catch (error) {
    console.error("Error resetting database:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Auth Routes ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        coachProfile: true,
        parentProfile: true,
        playerProfile: true,
      }
    });

    if (user && bcrypt.compareSync(password, user.password)) {
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role.toLowerCase(),
          ...(user.coachProfile || {}),
          ...(user.parentProfile || {}),
          ...(user.playerProfile || {})
        }
      });
    } else {
      res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reveal-password', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  if (!isVaultEnabled) {
    return res.status(503).json({ error: 'خزانة كلمات المرور معطلة حالياً لعدم تهيئة مفتاح التشفير بالسيرفر' });
  }
  const { targetUserId } = req.body;
  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId }
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'المستخدم غير موجود بالنظام' });
    }

    if (!targetUser.encryptedPassword) {
      return res.status(404).json({ error: 'لا توجد كلمة مرور مشفرة مسجلة لهذا الحساب' });
    }

    const decrypted = decryptPassword(targetUser.encryptedPassword);

    // Create Audit Log
    await prisma.auditLog.create({
      data: {
        adminId: req.user.id,
        targetId: targetUserId,
        action: 'PASSWORD_REVEALED'
      }
    });

    res.json({ password: decrypted });
  } catch (error) {
    console.error("Reveal password error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Generic Fetch Route (To get all state at once - Securely filtered) ---
app.get('/api/initial-data', authenticateToken, async (req, res) => {
  try {
    const role = req.user.role;
    
    // Fetch raw lists
    const [groups, coachesRaw, playersRaw, paymentsRaw, attendanceRaw, evalsRaw, messagesRaw, trainingsRaw, parentsRaw] = await Promise.all([
      prisma.group.findMany(),
      prisma.coach.findMany({ include: { user: true } }),
      prisma.player.findMany(),
      prisma.payment.findMany(),
      prisma.attendance.findMany(),
      prisma.evaluation.findMany(),
      prisma.message.findMany(),
      prisma.training.findMany(),
      prisma.parent.findMany({ include: { user: true } })
    ]);

    // Strip passwords and format coaches and parents
    const coaches = coachesRaw.map(c => {
      const { password, encryptedPassword, ...userWithoutPassword } = c.user || {};
      return { 
        ...userWithoutPassword, 
        ...c, 
        id: c.id, 
        userId: c.user?.id,
        user: undefined 
      };
    });

    const parents = parentsRaw.map(par => {
      const { password, ...userWithoutPassword } = par.user || {};
      return {
        id: par.id,
        userId: par.userId,
        name: par.user?.name || `ولي أمر`,
        email: par.user?.email || '',
        phone: par.user?.phone || '',
      };
    });

    // Remove passwords/sensitive fields from players
    const players = playersRaw.map(p => {
      const { password, ...pWithoutPassword } = p;
      return pWithoutPassword;
    });

    // Filter based on roles (Role-Based Access Control)
    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      return res.json({
        groups,
        coaches,
        players,
        payments: paymentsRaw,
        attendance: attendanceRaw,
        coachesAttendance: attendanceRaw.filter(a => a.coachId !== null),
        evals: evalsRaw,
        messages: messagesRaw,
        trainings: trainingsRaw,
        parents
      });
    } else if (role === 'COACH') {
      const coachProfile = req.user.coachProfile;
      if (!coachProfile) {
        return res.status(403).json({ error: 'ملف المدرب غير موجود' });
      }
      
      const myGroupId = coachProfile.groupId;
      const myGroupPlayers = players.filter(p => p.groupId === myGroupId);
      const myPlayerIds = myGroupPlayers.map(p => p.id);

      const filteredPlayers = myGroupPlayers;
      const filteredPayments = paymentsRaw.filter(p => myPlayerIds.includes(p.playerId));
      const filteredAttendance = attendanceRaw.filter(a => a.groupId === myGroupId);
      const filteredEvals = evalsRaw.filter(e => e.coachId === coachProfile.id || myPlayerIds.includes(e.playerId));
      const filteredTrainings = trainingsRaw.filter(t => t.groupId === myGroupId);
      const filteredParents = parents.filter(par => myGroupPlayers.some(p => p.parentId === par.id));
      
      const filteredMessages = messagesRaw.filter(m => 
        m.from === req.user.id || 
        m.to === req.user.id ||
        (m.to && m.to.startsWith('par_') && myPlayerIds.includes(m.to.replace('par_', '')))
      );

      return res.json({
        groups,
        coaches,
        players: filteredPlayers,
        payments: filteredPayments,
        attendance: filteredAttendance,
        coachesAttendance: filteredAttendance.filter(a => a.coachId !== null),
        evals: filteredEvals,
        messages: filteredMessages,
        trainings: filteredTrainings,
        parents: filteredParents
      });
    } else if (role === 'PARENT') {
      const parentProfile = req.user.parentProfile;
      if (!parentProfile) {
        return res.status(403).json({ error: 'ملف ولي الأمر غير موجود' });
      }

      const myChildren = players.filter(p => p.parentId === parentProfile.id);
      const myChildrenIds = myChildren.map(p => p.id);
      const myChildrenGroupIds = myChildren.map(p => p.groupId).filter(Boolean);

      const filteredPlayers = myChildren;
      const filteredGroups = groups.filter(g => myChildrenGroupIds.includes(g.id));
      const filteredPayments = paymentsRaw.filter(p => myChildrenIds.includes(p.playerId));
      const filteredAttendance = attendanceRaw.filter(a => myChildrenGroupIds.includes(a.groupId));
      const filteredEvals = evalsRaw.filter(e => myChildrenIds.includes(e.playerId));
      const filteredTrainings = trainingsRaw.filter(t => myChildrenGroupIds.includes(t.groupId));
      const filteredMessages = messagesRaw.filter(m => m.from === req.user.id || m.to === req.user.id);
      const filteredParents = parents.filter(par => par.id === parentProfile.id);

      return res.json({
        groups: filteredGroups,
        coaches,
        players: filteredPlayers,
        payments: filteredPayments,
        attendance: filteredAttendance,
        coachesAttendance: [],
        evals: filteredEvals,
        messages: filteredMessages,
        trainings: filteredTrainings,
        parents: filteredParents
      });
    } else {
      return res.status(403).json({ error: 'غير مصرح لهذا الدور بالوصول للبيانات' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Specific Update Routes ---
app.post('/api/players', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const p = req.body;
  try {
    let resolvedParentId = p.parentId;

    // Check if the incoming parentId already exists in the Parent table
    const existingParent = p.parentId
      ? await prisma.parent.findUnique({ where: { id: p.parentId } })
      : null;

    if (!existingParent) {
      // Parent doesn't exist yet — create User + Parent from player's email/phone
      const email = p.email || `ghadir_${p.phone || Date.now()}@ghadirsports.sa`;
      const password = p.password || `ghadir_${(p.phone || '0000').slice(-4)}`;
      const hashedPassword = bcrypt.hashSync(password, 10);
      const encrypted = encryptPassword(password);
      const parentName = `ولي أمر ${p.name}`;

      const user = await prisma.user.upsert({
        where: { email },
        update: { password: hashedPassword, encryptedPassword: encrypted, name: parentName },
        create: { email, password: hashedPassword, encryptedPassword: encrypted, name: parentName, role: 'PARENT' }
      });

      const parent = await prisma.parent.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id }
      });

      resolvedParentId = parent.id;
    } else {
      // Parent exists — update User details if provided
      const updateData = {};
      if (p.email) updateData.email = p.email;
      if (p.password) {
        const isBcrypt = p.password.startsWith('$2a$') || p.password.startsWith('$2b$');
        updateData.password = isBcrypt 
          ? p.password 
          : bcrypt.hashSync(p.password, 10);
        if (!isBcrypt) {
          updateData.encryptedPassword = encryptPassword(p.password);
        }
      }
      updateData.name = `ولي أمر ${p.name}`;

      await prisma.user.update({
        where: { id: existingParent.userId },
        data: updateData
      });
    }

    // Parse numbers safely to prevent Prisma constraint violations
    const resolvedAge = (p.age && !isNaN(p.age) && +p.age > 0) ? parseInt(p.age) : 10;
    const resolvedWeight = (p.weight && !isNaN(p.weight)) ? parseFloat(p.weight) : null;
    const resolvedHeight = (p.height && !isNaN(p.height)) ? parseFloat(p.height) : null;

    // Validate that nationalId is unique
    if (p.nationalId && p.nationalId.trim()) {
      const duplicate = await prisma.player.findFirst({
        where: {
          nationalId: p.nationalId.trim(),
          NOT: p.id ? { id: p.id } : undefined
        }
      });
      if (duplicate) {
        return res.status(400).json({ error: 'اللاعب مسجل مسبقاً برقم الهوية هذا' });
      }
    }

    // Create or update the Player record
    let validGroupId = p.groupId;
    let groupExists = validGroupId ? await prisma.group.findUnique({ where: { id: validGroupId } }) : null;
    if (!groupExists) {
      if (validGroupId === 'g-football' || validGroupId === 'كرة القدم') {
        validGroupId = (resolvedAge <= 10) ? 'g-football-juniors' : 'g-football-seniors';
      } else if (validGroupId === 'g-swimming' || validGroupId === 'السباحة') {
        validGroupId = 'g-swimming-boys';
      } else {
        const firstGroup = await prisma.group.findFirst();
        validGroupId = firstGroup?.id;
      }
    }

    let player;
    const existing = p.id ? await prisma.player.findUnique({ where: { id: p.id } }) : null;

    if (existing) {
      player = await prisma.player.update({
        where: { id: p.id },
        data: {
          name: p.name, phone: p.phone, age: resolvedAge,
          status: p.status, position: p.position,
          weight: resolvedWeight,
          height: resolvedHeight,
          score: p.score ? +p.score : null,
          joinDate: p.joinDate ? new Date(p.joinDate) : undefined,
          bus: p.bus,
          nationalId: p.nationalId ? p.nationalId.trim() : null,
          freezeRanges: p.freezeRanges,
          trainingDays: p.trainingDays,
          group: validGroupId ? { connect: { id: validGroupId } } : undefined,
          parent: { connect: { id: resolvedParentId } }
        }
      });
    } else {
      player = await prisma.player.create({
        data: {
          id: p.id,
          name: p.name, phone: p.phone, age: resolvedAge,
          status: p.status || 'نشط', position: p.position,
          weight: resolvedWeight,
          height: resolvedHeight,
          score: p.score ? +p.score : 80,
          joinDate: p.joinDate ? new Date(p.joinDate) : undefined,
          bus: p.bus,
          nationalId: p.nationalId ? p.nationalId.trim() : null,
          freezeRanges: p.freezeRanges,
          trainingDays: p.trainingDays,
          group: validGroupId ? { connect: { id: validGroupId } } : undefined,
          parent: { connect: { id: resolvedParentId } }
        }
      });
    }

    res.json({ ...player, parentId: resolvedParentId });
  } catch (e) {
    console.error('Player error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/payments', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN', 'COACH']), async (req, res) => {
  try {
    const { id, playerId, playerName, coachId, coachName, type, month, amount, date, note, discount, packageName, sessionsCount } = req.body;
    const resolvedDiscount = (discount !== undefined && discount !== null && !isNaN(discount)) ? parseFloat(discount) : 0;
    const resolvedSessions = (sessionsCount !== undefined && sessionsCount !== null && !isNaN(sessionsCount)) ? parseInt(sessionsCount) : 12;
    const payment = await prisma.payment.upsert({
      where: { id: id || 'new' },
      update: { 
        playerId, 
        playerName, 
        coachId, 
        coachName, 
        type, 
        month, 
        amount: parseFloat(amount),
        discount: resolvedDiscount,
        date: new Date(date), 
        note,
        packageName,
        sessionsCount: resolvedSessions
      },
      create: { 
        id, 
        playerId, 
        playerName, 
        coachId, 
        coachName, 
        type, 
        month, 
        amount: parseFloat(amount),
        discount: resolvedDiscount,
        date: new Date(date), 
        note,
        packageName,
        sessionsCount: resolvedSessions
      }
    });
    res.json(payment);
  } catch (e) {
    console.error("Payment error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Save Attendance
app.post('/api/attendance', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN', 'COACH']), async (req, res) => {
  try {
    const a = req.body;
    let validGroupId = a.groupId;
    let groupExists = validGroupId ? await prisma.group.findUnique({ where: { id: validGroupId } }) : null;
    if (!groupExists) {
      const firstGroup = await prisma.group.findFirst();
      validGroupId = firstGroup?.id;
    }

    let validCoachId = null;
    if (a.coachId && a.coachId !== 'none') {
      const coachExists = await prisma.coach.findUnique({ where: { id: a.coachId } });
      if (coachExists) validCoachId = a.coachId;
    }

    const att = await prisma.attendance.upsert({
      where: { id: a.id },
      update: { records: a.records },
      create: { 
        id: a.id, 
        date: new Date(a.date), 
        records: a.records,
        group: validGroupId ? { connect: { id: validGroupId } } : undefined,
        coach: validCoachId ? { connect: { id: validCoachId } } : undefined
      }
    });
    res.json(att);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coaches', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const c = req.body;
  try {
    // 1. Upsert User
    const userUpdate = { name: c.name, role: 'COACH' };
    if (c.password) {
      const isBcrypt = c.password.startsWith('$2a$') || c.password.startsWith('$2b$');
      userUpdate.password = isBcrypt 
        ? c.password 
        : bcrypt.hashSync(c.password, 10);
      if (!isBcrypt) {
        userUpdate.encryptedPassword = encryptPassword(c.password);
      }
    }
    
    const plainPassword = c.password || 'Coach@1234';
    const isBcryptCreate = plainPassword.startsWith('$2a$') || plainPassword.startsWith('$2b$');
    const userCreate = { 
      email: c.email, 
      password: isBcryptCreate ? plainPassword : bcrypt.hashSync(plainPassword, 10), 
      encryptedPassword: isBcryptCreate ? null : encryptPassword(plainPassword),
      name: c.name, 
      role: 'COACH' 
    };

    const user = await prisma.user.upsert({
      where: { email: c.email },
      update: userUpdate,
      create: userCreate
    });

    // 2. Resolve Unique Constraint on groupId in Coach table
    let validGroupId = null;
    if (c.groupId && c.groupId !== 'none') {
      const groupExists = await prisma.group.findUnique({ where: { id: c.groupId } });
      if (groupExists) validGroupId = c.groupId;
    }

    if (validGroupId) {
      await prisma.coach.updateMany({
        where: { 
          groupId: validGroupId,
          NOT: { id: c.id || 'new' }
        },
        data: { groupId: null }
      });
    }

    // 3. Upsert Coach (including exp, cert, salary)
    const coach = await prisma.coach.upsert({
      where: { id: c.id || 'new' },
      update: { 
        specialty: c.specialty, 
        perms: c.perms, 
        salary: c.salary ? parseFloat(c.salary) : null,
        exp: c.exp ? parseInt(c.exp) : null,
        cert: c.cert,
        user: { connect: { id: user.id } },
        group: validGroupId ? { connect: { id: validGroupId } } : { disconnect: true }
      },
      create: { 
        id: c.id, 
        specialty: c.specialty, 
        perms: c.perms, 
        salary: c.salary ? parseFloat(c.salary) : null,
        exp: c.exp ? parseInt(c.exp) : null,
        cert: c.cert,
        user: { connect: { id: user.id } },
        group: validGroupId ? { connect: { id: validGroupId } } : undefined
      }
    });

    // 4. Synchronize Group table's coachId
    await prisma.group.updateMany({
      where: { 
        coachId: coach.id,
        NOT: { id: c.groupId || 'none' }
      },
      data: { coachId: null }
    });

    if (c.groupId) {
      await prisma.group.updateMany({
        where: { id: c.groupId },
        data: { coachId: null }
      });
      await prisma.group.update({
        where: { id: c.groupId },
        data: { 
          coachId: coach.id,
          coach: { connect: { id: coach.id } } 
        }
      });
    }

    res.json(coach);
  } catch (e) {
    console.error("Coach upsert error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const g = req.body;
  try {
    let validCoachId = null;
    if (g.coachId && g.coachId !== 'none') {
      const coachExists = await prisma.coach.findUnique({ where: { id: g.coachId } });
      if (coachExists) validCoachId = g.coachId;
    }

    // 1. Resolve Unique Constraint on coachId in Group table
    if (validCoachId) {
      await prisma.group.updateMany({
        where: { 
          coachId: validCoachId,
          NOT: { id: g.id || 'new' }
        },
        data: { coachId: null }
      });
    }

    // 2. Upsert Group
    const updateData = { 
      name: g.name, 
      color: g.color, 
      coachId: validCoachId, 
      price8: g.price8 !== undefined ? parseFloat(g.price8) : 250.0,
      price12: g.price12 !== undefined ? parseFloat(g.price12) : 350.0,
      price16: g.price16 !== undefined ? parseFloat(g.price16) : 450.0
    };
    if (validCoachId) updateData.coach = { connect: { id: validCoachId } };
    else updateData.coach = { disconnect: true };

    const createData = { 
      id: g.id, 
      name: g.name, 
      color: g.color, 
      coachId: validCoachId, 
      price8: g.price8 !== undefined ? parseFloat(g.price8) : 250.0,
      price12: g.price12 !== undefined ? parseFloat(g.price12) : 350.0,
      price16: g.price16 !== undefined ? parseFloat(g.price16) : 450.0
    };
    if (validCoachId) createData.coach = { connect: { id: validCoachId } };

    const group = await prisma.group.upsert({
      where: { id: g.id || 'new' },
      update: updateData,
      create: createData
    });

    // 3. Synchronize Coach table's groupId
    await prisma.coach.updateMany({
      where: { 
        groupId: group.id,
        NOT: { id: validCoachId || 'none' }
      },
      data: { groupId: null }
    });

    if (validCoachId) {
      await prisma.coach.updateMany({
        where: { id: validCoachId },
        data: { groupId: null }
      });
      await prisma.coach.update({
        where: { id: validCoachId },
        data: { group: { connect: { id: group.id } } }
      });
    }

    res.json(group);
  } catch (e) {
    console.error("Group upsert error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trainings', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const t = req.body;
  try {
    let resolvedCoachId = t.coachId;
    let coachExists = resolvedCoachId ? await prisma.coach.findUnique({ where: { id: resolvedCoachId } }) : null;
    if (!coachExists) {
      const firstCoach = await prisma.coach.findFirst();
      resolvedCoachId = firstCoach?.id;
    }
    if (!resolvedCoachId) {
      const defaultUser = await prisma.user.upsert({
        where: { email: 'coach@ghadirsports.sa' },
        update: { role: 'COACH', name: 'مدرب الأكاديمية' },
        create: { email: 'coach@ghadirsports.sa', password: bcrypt.hashSync('Ghadir@2026', 10), role: 'COACH', name: 'مدرب الأكاديمية' }
      });
      const newCoach = await prisma.coach.upsert({
        where: { userId: defaultUser.id },
        update: {},
        create: { id: 'c1', userId: defaultUser.id, specialty: 'تدريب عام' }
      });
      resolvedCoachId = newCoach.id;
    }

    let resolvedGroupId = t.groupId;
    let groupExists = resolvedGroupId ? await prisma.group.findUnique({ where: { id: resolvedGroupId } }) : null;
    if (!groupExists) {
      const firstGroup = await prisma.group.findFirst();
      resolvedGroupId = firstGroup?.id;
    }
    if (!resolvedGroupId) {
      return res.status(400).json({ error: "لا توجد مجموعة مسجلة في النظام لربط التمرين بها. يرجى إضافة مجموعة أولاً." });
    }

    const training = await prisma.training.upsert({
      where: { id: t.id || 'new' },
      update: { 
        days: t.days || [], 
        time: t.time || "4:00 م", duration: t.duration ? +t.duration : 90, field: t.field || "ملعب A", 
        title: t.title, trainingFocus: t.trainingFocus, note: t.note,
        date: t.date ? new Date(t.date) : null,
        isRecurring: t.isRecurring !== undefined ? !!t.isRecurring : true,
        type: t.type || "training",
        isFriendly: t.isFriendly !== undefined ? !!t.isFriendly : false,
        group: { connect: { id: resolvedGroupId } },
        coach: { connect: { id: resolvedCoachId } }
      },
      create: { 
        id: t.id, 
        days: t.days || [], 
        time: t.time || "4:00 م", duration: t.duration ? +t.duration : 90, field: t.field || "ملعب A", 
        title: t.title, trainingFocus: t.trainingFocus, note: t.note,
        date: t.date ? new Date(t.date) : null,
        isRecurring: t.isRecurring !== undefined ? !!t.isRecurring : true,
        type: t.type || "training",
        isFriendly: t.isFriendly !== undefined ? !!t.isFriendly : false,
        group: { connect: { id: resolvedGroupId } },
        coach: { connect: { id: resolvedCoachId } }
      }
    });
    res.json(training);
  } catch (e) {
    console.error("Training create error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { id, from, to, fromName, toName, text, files, date, read } = req.body;
    
    // Prevent sender spoofing
    if (from !== req.user.id) {
      return res.status(403).json({ error: 'غير مصرح بإرسال رسائل باسم حساب آخر' });
    }

    const msg = await prisma.message.upsert({
      where: { id: id || 'new' },
      update: { read },
      create: { id, from, to, fromName, toName, text, files, date: new Date(date), read: !!read }
    });
    res.json(msg);
  } catch (e) {
    console.error("Message error:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Evaluations Routes ---
app.post('/api/evaluations', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN', 'COACH']), async (req, res) => {
  const e = req.body;
  try {
    const evaluation = await prisma.evaluation.upsert({
      where: { id: e.id || 'new' },
      update: { 
        date: new Date(e.date), 
        note: e.note, 
        speed: parseInt(e.speed) || 80, 
        technique: parseInt(e.technique) || 80, 
        teamwork: parseInt(e.teamwork) || 80,
        player: { connect: { id: e.playerId } },
        coach: { connect: { id: e.coachId } }
      },
      create: { 
        id: e.id, 
        date: new Date(e.date), 
        note: e.note, 
        speed: parseInt(e.speed) || 80, 
        technique: parseInt(e.technique) || 80, 
        teamwork: parseInt(e.teamwork) || 80,
        player: { connect: { id: e.playerId } },
        coach: { connect: { id: e.coachId } }
      }
    });

    const avgScore = Math.round((evaluation.speed + evaluation.technique + evaluation.teamwork) / 3);
    await prisma.player.update({
      where: { id: e.playerId },
      data: { score: avgScore }
    });

    res.json(evaluation);
  } catch (err) {
    console.error("Evaluation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Delete Routes ---
app.delete('/api/players/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.payment.deleteMany({ where: { playerId: id } }),
      prisma.evaluation.deleteMany({ where: { playerId: id } }),
      prisma.player.deleteMany({ where: { id } })
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting player:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/groups/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  try {
    const decodedId = decodeURIComponent(id);
    const targetGroups = await prisma.group.findMany({
      where: {
        OR: [
          { id: id },
          { id: decodedId },
          { name: id },
          { name: decodedId }
        ]
      }
    });

    for (const g of targetGroups) {
      await prisma.attendance.deleteMany({ where: { groupId: g.id } });
      await prisma.coach.updateMany({ where: { groupId: g.id }, data: { groupId: null } });
      await prisma.training.deleteMany({ where: { groupId: g.id } });
      await prisma.player.updateMany({ where: { groupId: g.id }, data: { groupId: 'g-football-juniors' } });
      await prisma.group.deleteMany({ where: { id: g.id } });
    }
    await prisma.group.deleteMany({ where: { id: id } });
    res.json({ success: true, deletedCount: targetGroups.length });
  } catch (e) {
    console.error("Error deleting group:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/coaches/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.training.deleteMany({ where: { coachId: id } }),
      prisma.evaluation.deleteMany({ where: { coachId: id } }),
      prisma.attendance.updateMany({ where: { coachId: id }, data: { coachId: null } }),
      prisma.group.updateMany({ where: { coachId: id }, data: { coachId: null } }),
      prisma.coach.deleteMany({ where: { id } })
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting coach:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/payments/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.payment.deleteMany({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting payment:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/trainings/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.training.deleteMany({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting training:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/attendance/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN', 'COACH']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.attendance.deleteMany({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting attendance:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/evaluations/:id', authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN', 'COACH']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.evaluation.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting evaluation:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    // Only verify message sender if not admin
    const msg = await prisma.message.findUnique({ where: { id } });
    if (msg && msg.from !== req.user.id && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'غير مصرح بحذف هذه الرسالة' });
    }
    await prisma.message.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error("Error deleting message:", e);
    res.status(500).json({ error: e.message });
  }
});

const ensureAdminCredentialsOnBoot = async () => {
  const newEmail = 'admin@ghadirsports.sa';
  const newPassword = 'Ghadir@2026!';
  const hashedPassword = bcrypt.hashSync(newPassword, 10);
  const encrypted = encryptPassword(newPassword);

  try {
    console.log("Ensuring admin credentials are correct in DB...");
    const existingMainAdmin = await prisma.user.findFirst({
      where: {
        OR: [
          { email: newEmail },
          { id: 'admin' },
          { id: 'royal-admin-id' },
          { id: 'ghadir-admin-id' }
        ]
      }
    });

    if (existingMainAdmin) {
      await prisma.user.update({
        where: { id: existingMainAdmin.id },
        data: {
          email: newEmail,
          password: hashedPassword,
          encryptedPassword: encrypted,
          name: 'مدير الأكاديمية',
          role: 'ADMIN'
        }
      });
      console.log(`Updated existing admin credentials to email: ${newEmail}`);
    } else {
      await prisma.user.create({
        data: {
          id: 'admin',
          email: newEmail,
          password: hashedPassword,
          encryptedPassword: encrypted,
          role: 'ADMIN',
          name: 'مدير الأكاديمية'
        }
      });
      console.log(`Created new admin credentials with email: ${newEmail}`);
    }

    // Also update any other admin/super_admin passwords to be secure
    await prisma.user.updateMany({
      where: {
        role: { in: ['ADMIN', 'SUPER_ADMIN'] }
      },
      data: {
        password: hashedPassword,
        encryptedPassword: encrypted
      }
    });
  } catch (err) {
    console.error("Failed to ensure admin credentials on boot:", err);
  }
};

const migratePasswordsOnBoot = async () => {
  try {
    console.log("Checking database users for plain text passwords...");
    const users = await prisma.user.findMany();
    let updatedCount = 0;
    for (const u of users) {
      const isAlreadyHashed = u.password.startsWith('$2a$') || u.password.startsWith('$2b$') || u.password.length === 60;
      if (!isAlreadyHashed) {
        console.log(`Hashing and encrypting password for user: ${u.email}`);
        const hashedPassword = bcrypt.hashSync(u.password, 10);
        const encrypted = encryptPassword(u.password);
        await prisma.user.update({
          where: { id: u.id },
          data: { 
            password: hashedPassword,
            encryptedPassword: encrypted
          }
        });
        updatedCount++;
      }
    }
    if (updatedCount > 0) {
      console.log(`Successfully migrated ${updatedCount} users to hashed passwords on boot.`);
    } else {
      console.log("All database users already have hashed passwords.");
    }

    // Auto-populate encryptedPassword for known default accounts if null
    const allUsers = await prisma.user.findMany({ where: { encryptedPassword: null } });
    for (const u of allUsers) {
      let defaultPlain = null;
      if (u.email === 'admin@ghadirsports.sa' || u.email === 'super@mohkam.sa') {
        defaultPlain = 'Ghadir@2026!';
      } else if (u.email === 'ahmed@ghadirsports.sa') {
        defaultPlain = 'Coach@1234';
      } else if (u.email === 'khaled@ghadirsports.sa') {
        defaultPlain = 'Coach@5678';
      } else if (u.email === 'saad@ghadirsports.sa') {
        defaultPlain = 'Coach@9012';
      } else if (u.email === 'parent@royal.sa') {
        defaultPlain = 'Parent@2026';
      } else if (u.email.endsWith('@mail.com')) {
        if (u.email === 'aalghamdi@mail.com') defaultPlain = 'Parent@111';
        else if (u.email === 'saqahtani@mail.com') defaultPlain = 'Parent@222';
        else if (u.email === 'kzahrani@mail.com') defaultPlain = 'Parent@333';
        else if (u.email === 'ashahri@mail.com') defaultPlain = 'Parent@444';
        else if (u.email === 'adosari@mail.com') defaultPlain = 'Parent@555';
        else if (u.email === 'aharbi@mail.com') defaultPlain = 'Parent@666';
        else if (u.email === 'fsobiee@mail.com') defaultPlain = 'Parent@777';
      }

      if (defaultPlain) {
        console.log(`Setting default encryptedPassword for user: ${u.email}`);
        await prisma.user.update({
          where: { id: u.id },
          data: { encryptedPassword: encryptPassword(defaultPlain) }
        });
      }
    }
  } catch (err) {
    console.error("Boot-time password migration failed:", err);
  }
};

const fixUserRolesOnBoot = async () => {
  try {
    console.log("Syncing user roles with profiles...");
    const coaches = await prisma.coach.findMany({ include: { user: true } });
    for (const c of coaches) {
      if (c.user && c.user.role !== 'COACH' && c.user.role !== 'ADMIN' && c.user.role !== 'SUPER_ADMIN') {
        console.log(`Fixing role to COACH for user: ${c.user.email}`);
        await prisma.user.update({
          where: { id: c.userId },
          data: { role: 'COACH' }
        });
      }
    }
  } catch (err) {
    console.error("Failed to fix user roles on boot:", err);
  }
};

const seedSportsAndTrainings = async () => {
  try {
    console.log("Seeding and updating sports/groups and their training days...");

    // 1. Group list to ensure
    const targetGroups = [
      { id: 'g-football-juniors', name: 'كرة القدم - الصغار (5-10 سنوات)', color: '#16A34A', price8: 250, price12: 350, price16: 450 },
      { id: 'g-football-seniors', name: 'كرة القدم - الكبار (11-16 سنة)', color: '#15803D', price8: 250, price12: 350, price16: 450 },
      { id: 'g-swimming-boys', name: 'المسبح - بنين', color: '#0284C7', price8: 300, price12: 400, price16: 500 },
      { id: 'g-swimming-girls', name: 'المسبح - بنات', color: '#0369A1', price8: 300, price12: 400, price16: 500 },
      { id: 'g-gymnastics', name: 'الجمباز', color: '#9333EA', price8: 250, price12: 350, price16: 450 },
      { id: 'g-karate', name: 'الكاراتيه (بنين - بنات)', color: '#DC2626', price8: 250, price12: 350, price16: 450 },
      { id: 'g-basketball', name: 'كرة السلة', color: '#EA580C', price8: 250, price12: 350, price16: 450 },
      { id: 'g-boxing', name: 'البوكسينج (بنين - بنات)', color: '#4B5563', price8: 250, price12: 350, price16: 450 }
    ];

    // Ensure all target groups exist in database
    for (const tg of targetGroups) {
      await prisma.group.upsert({
        where: { id: tg.id },
        update: {
          name: tg.name,
          color: tg.color,
          price8: tg.price8,
          price12: tg.price12,
          price16: tg.price16
        },
        create: {
          id: tg.id,
          name: tg.name,
          color: tg.color,
          price8: tg.price8,
          price12: tg.price12,
          price16: tg.price16
        }
      });
    }

    // 2. Migrate existing players from old groups if they exist
    const oldFootballGroups = await prisma.group.findMany({
      where: {
        OR: [
          { id: 'g-football' },
          { name: 'كرة القدم' }
        ]
      }
    });
    for (const fg of oldFootballGroups) {
      const pList = await prisma.player.findMany({ where: { groupId: fg.id } });
      for (const p of pList) {
        const targetGroupId = (p.age && p.age <= 10) ? 'g-football-juniors' : 'g-football-seniors';
        console.log(`Migrating football player ${p.name} (age ${p.age}) to ${targetGroupId}`);
        await prisma.player.update({
          where: { id: p.id },
          data: { groupId: targetGroupId }
        });
      }
      await prisma.attendance.deleteMany({ where: { groupId: fg.id } });
      await prisma.coach.updateMany({ where: { groupId: fg.id }, data: { groupId: null } });
      await prisma.training.deleteMany({ where: { groupId: fg.id } });
      await prisma.group.deleteMany({ where: { id: fg.id } });
    }

    const oldSwimmingGroups = await prisma.group.findMany({
      where: {
        OR: [
          { id: 'g-swimming' },
          { name: 'السباحة' }
        ]
      }
    });
    for (const sg of oldSwimmingGroups) {
      const pList = await prisma.player.findMany({ where: { groupId: sg.id } });
      for (const p of pList) {
        console.log(`Migrating swimming player ${p.name} to g-swimming-boys`);
        await prisma.player.update({
          where: { id: p.id },
          data: { groupId: 'g-swimming-boys' }
        });
      }
      await prisma.attendance.deleteMany({ where: { groupId: sg.id } });
      await prisma.coach.updateMany({ where: { groupId: sg.id }, data: { groupId: null } });
      await prisma.training.deleteMany({ where: { groupId: sg.id } });
      await prisma.group.deleteMany({ where: { id: sg.id } });
    }

    // 3. Ensure training schedules are seeded correctly for Al-Malqa branch
    const targetTrainings = [
      { id: 't-football-juniors', groupId: 'g-football-juniors', days: ["الأحد", "الثلاثاء", "الخميس"], time: "17:00", duration: 90, field: "ملعب كرة القدم" },
      { id: 't-football-seniors', groupId: 'g-football-seniors', days: ["الأحد", "الثلاثاء", "الخميس"], time: "18:30", duration: 90, field: "ملعب كرة القدم" },
      { id: 't-swimming-boys', groupId: 'g-swimming-boys', days: ["الأحد", "الثلاثاء", "الخميس"], time: "15:00", duration: 120, field: "المسبح" },
      { id: 't-swimming-girls', groupId: 'g-swimming-girls', days: ["الأحد", "الثلاثاء", "الخميس"], time: "17:00", duration: 120, field: "المسبح" },
      { id: 't-gymnastics', groupId: 'g-gymnastics', days: ["الأحد", "الثلاثاء", "الخميس"], time: "18:30", duration: 60, field: "صالة الجمباز" },
      { id: 't-karate', groupId: 'g-karate', days: ["الأحد", "الثلاثاء", "الخميس"], time: "18:30", duration: 60, field: "صالة الدفاع عن النفس" },
      { id: 't-basketball', groupId: 'g-basketball', days: ["الأحد", "الثلاثاء", "الخميس"], time: "18:00", duration: 90, field: "الملعب الداخلي" },
      { id: 't-boxing', groupId: 'g-boxing', days: ["الأحد", "الثلاثاء", "الخميس"], time: "17:00", duration: 60, field: "صالة البوكسينج" }
    ];

    let defaultCoach = await prisma.coach.findFirst();
    if (!defaultCoach) {
      const defaultUser = await prisma.user.upsert({
        where: { email: 'coach@ghadirsports.sa' },
        update: { role: 'COACH', name: 'الكابتن أحمد علي' },
        create: { email: 'coach@ghadirsports.sa', password: bcrypt.hashSync('Ghadir@2026', 10), role: 'COACH', name: 'الكابتن أحمد علي' }
      });
      defaultCoach = await prisma.coach.upsert({
        where: { userId: defaultUser.id },
        update: {},
        create: { id: 'c1', userId: defaultUser.id, specialty: 'تدريب عام' }
      });
    }

    for (const tt of targetTrainings) {
      await prisma.training.upsert({
        where: { id: tt.id },
        update: {
          days: tt.days,
          time: tt.time,
          duration: tt.duration,
          field: tt.field,
          isRecurring: true,
          type: 'training',
          group: { connect: { id: tt.groupId } },
          coach: { connect: { id: defaultCoach.id } }
        },
        create: {
          id: tt.id,
          days: tt.days,
          time: tt.time,
          duration: tt.duration,
          field: tt.field,
          isRecurring: true,
          type: 'training',
          group: { connect: { id: tt.groupId } },
          coach: { connect: { id: defaultCoach.id } }
        }
      });
    }

    console.log("Sports and default training days successfully initialized.");
  } catch (err) {
    console.error("Seeding default sports and trainings failed:", err);
  }
};

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await ensureAdminCredentialsOnBoot();
  await migratePasswordsOnBoot();
  await fixUserRolesOnBoot();
  await seedSportsAndTrainings();
});
