import fs from 'node:fs';

// This release adds two isolated tables only. Never run db push, reset, seed,
// or alter existing academy tables as part of application startup.
export function additiveSchemaStatements() {
  return ['001_recovery_archive.sql', '002_coach_attendance.sql'].flatMap(name => {
    const sql = fs.readFileSync(new URL(`./sql/${name}`, import.meta.url), 'utf8');
    return sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(s => s && !['BEGIN', 'COMMIT'].includes(s));
  }).map(statement => {
    if (!/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS\b/i.test(statement)) throw new Error('Only additive schema statements are permitted at startup.');
    return statement;
  });
}

export async function prepareRecoverySchema(prisma) {
  const statements = additiveSchemaStatements();
  await prisma.$transaction(async tx => {
    // Serialize simultaneous replicas without touching business records.
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(726304, 1)');
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    // Fail startup rather than serving an incompatible pre-existing table.
    await tx.$queryRawUnsafe('SELECT "id", "origin", "capturedAt", "createdAt", "uploadedBy", "counts", "payload" FROM "RecoverySnapshot" LIMIT 0');
    await tx.$queryRawUnsafe('SELECT "id", "date", "records" FROM "CoachAttendance" LIMIT 0');
  }, { maxWait: 15000, timeout: 30000 });
}
