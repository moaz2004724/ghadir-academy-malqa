import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
const tables = ['user', 'coach', 'parent', 'player', 'group', 'payment', 'attendance', 'evaluation', 'message', 'training', 'auditLog'];
const optionalTables = ['recoverySnapshot', 'coachAttendance'];
const prisma = new PrismaClient();

// This script never starts the app, pushes the schema, seeds, or edits records.
try {
  const url = new URL(process.env.DATABASE_URL || '');
  if (!url.hostname || url.hostname === 'host') throw new Error('Configure the verified production DATABASE_URL before backing up.');
  const data = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const existing = await tx.$queryRawUnsafe('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()');
    const names = new Set(existing.map(x => x.table_name));
    const result = {};
    for (const table of [...tables, ...optionalTables.filter(t => names.has(t[0].toUpperCase() + t.slice(1)))]) result[table] = await tx[table].findMany();
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120000 });
  const counts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const content = JSON.stringify({ format: 'ghadir-database-backup', version: 1, timestamp: new Date().toISOString(), counts, data }, null, 2);
  const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `database-${Date.now()}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  const verified = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [table, count] of Object.entries(counts)) if (verified.data[table].length !== count) throw new Error('Backup verification failed.');
  console.log(JSON.stringify({ file, counts, sha256: crypto.createHash('sha256').update(content).digest('hex'), verification: 'File and record counts verified. A restore rehearsal is still required before production changes.' }, null, 2));
} catch (error) {
  // Do not print connection strings, SQL parameters or personal records.
  console.error('Backup failed:', error.code || error.message.split('\n')[0]);
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
