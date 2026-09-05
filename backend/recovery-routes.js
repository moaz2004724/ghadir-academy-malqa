import express from 'express';
import crypto from 'node:crypto';
import { validateSnapshot, snapshotCounts, canonicalJSON, MAX_RECOVERY_BYTES } from './recovery-format.js';

export function createRecoveryRouter({ prisma, authenticateToken, requireRole }) {
  const router = express.Router();
  router.use(authenticateToken, requireRole(['ADMIN', 'SUPER_ADMIN']), express.json({ limit: '6mb' }));
  const summary = { id: true, origin: true, capturedAt: true, createdAt: true, counts: true, uploadedBy: true };
  router.post('/snapshots', async (req, res) => {
    let snapshot;
    try {
      snapshot = validateSnapshot(req.body);
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_RECOVERY_BYTES) throw new Error('حجم النسخة أكبر من 5 ميجابايت.');
      if (!snapshot.entries.length) throw new Error('النسخة لا تحتوي على بيانات.');
    } catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const id = crypto.createHash('sha256').update(canonicalJSON({ origin: snapshot.origin, entries: snapshot.entries })).digest('hex');
      // Archive ONLY. A snapshot never writes to operational academy tables.
      const stored = await prisma.recoverySnapshot.upsert({
        where: { id }, update: {},
        create: { id, origin: snapshot.origin, capturedAt: new Date(snapshot.capturedAt), uploadedBy: req.user.id, counts: snapshotCounts(snapshot), payload: snapshot },
        select: summary,
      });
      return res.status(201).json({ ...stored, archived: true, merged: false });
    } catch (error) {
      console.error('Recovery archive write failed:', error.code || error.name);
      return res.status(503).json({ error: 'تعذّر حفظ أرشيف الإنقاذ على السيرفر. احتفظ بالملف والنسخة المحلية وأعد المحاولة بعد تجهيز خدمة الأرشيف.' });
    }
  });
  router.get('/snapshots', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const page = Math.max(0, Math.min(100000, Number.parseInt(req.query.page, 10) || 0));
    try {
      const items = await prisma.recoverySnapshot.findMany({ select: summary, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * 50, take: 51 });
      res.json({ items: items.slice(0, 50), hasMore: items.length > 50, page });
    } catch { res.status(503).json({ error: 'أرشيف السيرفر غير متاح حاليًا؛ النسخ المحلية لم تتغير.' }); }
  });
  router.get('/snapshots/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const item = await prisma.recoverySnapshot.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: 'النسخة غير موجودة.' });
      res.json(item);
    } catch { res.status(503).json({ error: 'تعذّرت قراءة النسخة من السيرفر.' }); }
  });
  return router;
}
