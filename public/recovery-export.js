(function exportAcademyBrowserData() {
  // Runs only on the currently open academy site. Makes NO network requests.
  const allowed = /^(?:ghadir|royals|royal)_(players|coaches|groups|parents|payments|attendance|coachesAttendance|evals|messages|trainings|prices)$/;
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/password|passwd|token|secret|authorization|cookie|credential/i.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k)).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  const snapshot = { format: 'ghadir-recovery', version: 1, origin: location.origin, capturedAt: new Date().toISOString(), entries: [], warnings: [] };
  for (const store of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[store];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i), match = allowed.exec(key);
        if (!match) continue;
        try {
          const data = JSON.parse(storage.getItem(key));
          if (data && typeof data === 'object' && Object.keys(data).length) snapshot.entries.push({ store, key, entity: match[1], data: clean(data) });
        } catch { snapshot.warnings.push('تعذرت قراءة ' + key + '؛ لم يُعدّل الأصل.'); }
      }
    } catch { snapshot.warnings.push('تعذرت قراءة ' + store); }
  }
  if (!snapshot.entries.length) { alert('لم نعثر على بيانات أكاديمية محفوظة على هذا الرابط في هذا المتصفح. البيانات الموجودة في صفحة مفتوحة فقط لا يشملها هذا الفحص.' + (snapshot.warnings.length ? '\n' + snapshot.warnings.join('\n') : '')); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'academy-recovery-' + location.hostname + '-' + Date.now() + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
})();
