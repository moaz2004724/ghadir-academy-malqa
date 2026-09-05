import { useEffect, useState } from 'react';
import { snapshotCounts, validateSnapshot, RECOVERY_FORMAT, MAX_RECOVERY_BYTES } from '../backend/recovery-format.js';
import { protectLegacyData, preserveSnapshot, listLocalSnapshots, listUnconfirmedRequests, downloadJSON, recoveryState } from './storage.js';
import exporterCode from '../public/recovery-export.js?raw';
import './recovery.css';

const labels = { players: 'اللاعبون', coaches: 'المدربون', groups: 'المجموعات', parents: 'أولياء الأمور', payments: 'المدفوعات', attendance: 'الحضور', coachesAttendance: 'حضور المدربين', evals: 'التقييمات', messages: 'الرسائل', trainings: 'التمارين', prices: 'الأسعار' };
const isAdmin = user => ['ADMIN', 'SUPER_ADMIN'].includes(String(user?.role).toUpperCase());

export default function RecoveryCenter({ user, token, apiBase = '', currentData = {} }) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [requests, setRequests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [tab, setTab] = useState('local');
  const admin = isAdmin(user);
  const refresh = () => {
    try { setLocal(listLocalSnapshots()); setRequests(listUnconfirmedRequests()); }
    catch { setMessage('تعذّرت قراءة التخزين المحلي. حاول تنزيل البيانات من أداة تصدير الرابط القديم.'); }
    setWarnings([...recoveryState.warnings]);
  };
  useEffect(() => {
    refresh();
    window.addEventListener('ghadir-recovery-change', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('ghadir-recovery-change', refresh); window.removeEventListener('storage', refresh); };
  }, []);
  useEffect(() => { setSelected(null); setRemote([]); setMessage(''); setConfirmed(false); setOpen(false); }, [user?.id]);
  const archive = async snapshot => {
    const response = await fetch(`${apiBase}/api/recovery/snapshots`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(snapshot) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.archived !== true) throw new Error(data.error || 'لم يؤكد السيرفر حفظ النسخة. نزّلها واحتفظ بها.');
    return data;
  };
  // Only current-origin snapshots are archived automatically after an admin login.
  // Imported copies from other branches always require a deliberate selection.
  useEffect(() => {
    if (!admin || !token) return;
    let cancelled = false;
    const run = async () => {
      let saved = 0;
      try {
        for (const { snapshot } of listLocalSnapshots().filter(x => x.snapshot.origin === location.origin)) {
          if (cancelled) return;
          await archive(snapshot); saved++;
        }
        if (!cancelled && saved) setArchiveStatus(`تم تأمين ${saved} نسخة على السيرفر للمراجعة. لم تُدمج بالسجلات.`);
      } catch {
        if (!cancelled) setArchiveStatus('نسخة السيرفر غير مؤكدة. النسخ المحلية محفوظة؛ نزّلها من أداة الإنقاذ.');
      }
    };
    run();
    window.addEventListener('online', run);
    return () => { cancelled = true; window.removeEventListener('online', run); };
  }, [admin, token]);
  const action = async fn => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (error) { setMessage(error.message || 'تعذّر تنفيذ العملية.'); }
    finally { setBusy(false); refresh(); }
  };
  const scan = () => {
    const snapshot = protectLegacyData();
    setSelected(snapshot); setConfirmed(false);
    setMessage(snapshot.entries.length ? 'تم فحص هذا الرابط. الأصل لم يتغير؛ نزّل نسخة مستقلة أيضًا.' : 'لا توجد بيانات قديمة قابلة للقراءة على هذا الرابط في هذا المتصفح. هذا لا يثبت خلو الأجهزة أو الروابط الأخرى.');
    refresh();
  };
  const loadFile = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    await action(async () => {
      if (file.size > MAX_RECOVERY_BYTES) throw new Error('اختر ملفًا أصغر من 5 ميجابايت.');
      const snapshot = validateSnapshot(JSON.parse(await file.text()));
      setSelected(snapshot); setConfirmed(false);
      try { preserveSnapshot(snapshot); setMessage('تم فتح الملف وحفظ نسخة محلية للمراجعة. لم تتغير بيانات الأكاديمية.'); }
      catch { setMessage('تم فتح الملف، لكن لم تتوفر مساحة لحفظ نسخة محلية. احتفظ بالملف الأصلي.'); }
    });
  };
  const loadRemote = async (nextPage = 0) => action(async () => {
    const res = await fetch(`${apiBase}/api/recovery/snapshots?page=${nextPage}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'أرشيف السيرفر غير متاح.');
    setRemote(data.items || []); setPage(nextPage); setHasMore(!!data.hasMore); setTab('remote');
  });
  const selectRemote = item => action(async () => {
    const res = await fetch(`${apiBase}/api/recovery/snapshots/${item.id}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'تعذّر تنزيل النسخة.');
    setSelected(validateSnapshot(data.payload)); setConfirmed(false);
  });
  const exportRequests = () => {
    const snapshot = { format: RECOVERY_FORMAT, version: 1, origin: location.origin, capturedAt: new Date().toISOString(), warnings: ['هذه طلبات غير مؤكدة: قد يكون بعضها حُفظ بالفعل. قارنها بالسيرفر قبل أي إعادة إدخال.'], entries: requests.map(request => ({ store: 'request', key: request.key, entity: request.entity, data: { method: request.method, path: request.path, status: request.status, capturedAt: request.capturedAt, payload: request.data } })) };
    setSelected(snapshot); setConfirmed(false);
    downloadJSON(snapshot, `ghadir-unconfirmed-${Date.now()}.json`);
    try { preserveSnapshot(snapshot); } catch { setMessage('تم تجهيز التنزيل لكن لم تُحفظ نسخة محلية إضافية.'); }
  };
  return <>
    <button className="recovery-launch" onClick={() => { refresh(); setOpen(true); }}>إنقاذ البيانات{warnings.length || requests.length ? ' • تنبيه' : ''}</button>
    {open && <div className="recovery-overlay" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <section className="recovery-panel" role="dialog" aria-modal="true" aria-labelledby="recovery-title" dir="rtl">
        <header><div><span className="recovery-eyebrow">حماية بيانات الأكاديمية</span><h2 id="recovery-title">مركز إنقاذ البيانات</h2></div><button aria-label="إغلاق مركز الإنقاذ" onClick={() => setOpen(false)}>إغلاق</button></header>
        <p>نجمع نسخًا من البيانات القديمة ونحفظ مصدرها للمراجعة. حفظ النسخة هنا لا يضيف لاعبين أو مدفوعات ولا يغيّر سجلات الأكاديمية.</p>
        <div className="recovery-callout">الفحص يخص <b dir="ltr">{location.host}</b> في هذا المتصفح فقط. للوصول إلى بيانات رابط آخر، شغّل أداة التصدير عليه ثم افتح ملفه هنا. بيانات جهاز آخر تحتاج تشغيل الأداة على ذلك الجهاز.</div>
        {[...warnings, archiveStatus, message].filter(Boolean).map((text, i) => <p className="recovery-notice" role="status" key={i}>{text}</p>)}
        <div className="recovery-actions">
          <button disabled={busy} onClick={scan}>فحص بيانات هذا الرابط</button>
          <label className="recovery-file">فتح ملف من رابط آخر<input type="file" accept=".json,application/json" disabled={busy} onChange={loadFile} /></label>
          {admin && <button disabled={busy} onClick={() => loadRemote(0)}>أرشيف السيرفر</button>}
        </div>
        <details className="recovery-other"><summary>سحب البيانات من رابط قديم أو فرع آخر</summary>
          <ol><li>اسحب الزر التالي إلى شريط المفضلة في المتصفح.</li><li>اذهب إلى الصفحة المفتوحة للرابط القديم على الجهاز الذي عليه البيانات. تجنّب تحديثها أو تسجيل الخروج قبل التصدير.</li><li>اضغط المفضلة لتنزيل ملف البيانات، ثم افتح الملف هنا للمراجعة.</li></ol>
          <a className="recovery-bookmark" ref={node => { if (node) node.setAttribute('href', 'javascript:' + encodeURIComponent(exporterCode)); }} onClick={e => { e.preventDefault(); setMessage('اسحب الزر إلى شريط المفضلة، ثم شغّله من المفضلة أثناء وجودك على الرابط القديم.'); }}>تصدير بيانات الأكاديمية</a>
          <p>الأداة لا ترسل بيانات إلى أي موقع، ولا تمسح شيئًا، وتستبعد كلمات المرور ورموز الدخول. تبحث عن مفاتيح الأكاديمية المعروفة؛ لا تستطيع استرجاع بيانات مُسحت أو موجودة في ذاكرة الصفحة فقط. ملفات كاش الصور والصفحات ليست سجلات الأكاديمية.</p>
          <details><summary>طريقة بديلة للمسؤول التقني إذا منع المتصفح المفضلة</summary><p>شغّل الكود التالي في أدوات المطور على الرابط القديم نفسه. يمكن تشغيله دون تحديث الصفحة.</p><textarea aria-label="كود تصدير بيانات الرابط القديم" readOnly value={exporterCode} dir="ltr" /><button onClick={() => action(async () => { await navigator.clipboard.writeText(exporterCode); setMessage('تم نسخ أداة التصدير.'); })}>نسخ الكود</button></details>
        </details>
        {!!requests.length && <div className="recovery-callout"><b>{requests.length} طلبًا لم يُؤكّد حفظه</b><p>قد يكون السيرفر استقبل بعض الطلبات رغم انقطاع الرد. نزّلها وقارنها بالسجلات قبل تكرار الإدخال لتجنب ازدواج المدفوعات.</p><button onClick={exportRequests}>تنزيل الطلبات للمراجعة</button></div>}
        <h3>{tab === 'remote' ? 'نسخ السيرفر' : 'نسخ هذا المتصفح'} ({tab === 'remote' ? remote.length : local.length})</h3>
        {tab === 'remote' && <button onClick={() => setTab('local')}>عرض النسخ المحلية</button>}
        <div className="recovery-snapshots">{(tab === 'remote' ? remote : local).map(item => {
          const snapshot = item.snapshot || item;
          return <button key={item.key || item.id} disabled={busy} onClick={() => tab === 'remote' ? selectRemote(item) : (setSelected(snapshot), setConfirmed(false))}><b dir="ltr">{snapshot.origin}</b><span>{new Date(snapshot.capturedAt).toLocaleString('ar-EG')}</span></button>;
        })}</div>
        {tab === 'remote' && <div className="recovery-actions"><button disabled={busy || page === 0} onClick={() => loadRemote(page - 1)}>السابق</button><button disabled={busy || !hasMore} onClick={() => loadRemote(page + 1)}>التالي</button></div>}
        {selected && <section className="recovery-preview"><h3>مراجعة النسخة المختارة</h3><p>المصدر المسجل في الملف: <b dir="ltr">{selected.origin}</b> — هذا وصف من الملف، وليس إثباتًا للفرع.</p>
          {selected.origin !== location.origin && <div className="recovery-callout">هذه النسخة من رابط مختلف. تأكد من الفرع قبل استخدام أي سجلات منها.</div>}
          {selected.warnings.map((warning, i) => <p className="recovery-notice" key={i}>{warning}</p>)}
          <div className="recovery-counts">{Object.entries(snapshotCounts(selected)).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{labels[key]}</span></div>)}</div>
          <p>الأعداد تشمل كل مصادر التخزين وقد تحتوي على تكرار؛ لا تعني عدد سجلات جديدة.</p>
          <div className="recovery-actions"><button onClick={() => downloadJSON(selected, `ghadir-recovery-${Date.now()}.json`)}>تنزيل نسخة JSON</button>
          {admin && <button disabled={busy || !confirmed || !selected.entries.length} onClick={() => action(async () => { await archive(selected); setMessage('أكد السيرفر حفظ النسخة في أرشيف الإنقاذ. لم تُدمج بسجلات الأكاديمية.'); })}>حفظ في أرشيف السيرفر</button>}</div>
          {admin ? <><label className="recovery-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />راجعت المصدر وأريد حفظ هذه النسخة للمراجعة فقط.</label>
          {selected.entries.map((entry, i) => {
            const rows = Array.isArray(entry.data) ? entry.data : [entry.data];
            const current = currentData[entry.entity] || [];
            return <details key={i}><summary>{labels[entry.entity]} — {entry.store} — {rows.length}</summary><p>المطابقة بالمعرّف إشارة للمراجعة فقط؛ اختلاف المعرّف لا يثبت أن السجل جديد.</p><div className="recovery-table"><table><thead><tr><th>السجل</th><th>مقارنة مع البيانات المحملة</th><th>التفاصيل</th></tr></thead><tbody>{rows.slice(0, 200).map((row, j) => <tr key={j}><td>{String(row.name || row.playerName || row.id || j + 1)}</td><td>{entry.store === 'request' ? 'طلب غير مؤكد — راجع قبل الإعادة' : row.id && Array.isArray(current) && current.some(x => String(x.id) === String(row.id)) ? 'يوجد نفس المعرّف؛ راجع التفاصيل' : 'يحتاج مراجعة'}</td><td><details><summary>عرض</summary><pre dir="ltr">{JSON.stringify(row, null, 2)}</pre></details></td></tr>)}</tbody></table></div>{rows.length > 200 && <p>عرض أول 200 سجل. الملف المنزّل يحتوي على النسخة كاملة.</p>}</details>;
          })}</> : <p>سجّل الدخول بحساب الإدارة لمراجعة تفاصيل السجلات وحفظ نسخة على السيرفر. يمكنك تنزيل نسخة الجهاز الآن.</p>}
        </section>}
        <p className="recovery-footer">احتفظ بالملفات في مكان آمن؛ تحتوي على بيانات شخصية. لن تُدمج النسخ تلقائيًا ولن تُمسح أصولها.</p>
      </section>
    </div>}
  </>;
}
