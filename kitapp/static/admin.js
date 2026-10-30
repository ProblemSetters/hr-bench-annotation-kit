// Admin pages. Inline scripts are blocked by the CSP, so page behaviour lives here.
(function () {
  'use strict';
  document.querySelectorAll('form.confirm').forEach((f) =>
    f.addEventListener('submit', (e) => { if (!confirm('Remove this task and any labels on it? This cannot be undone.')) e.preventDefault(); }));

  const form = document.getElementById('assignform');
  if (!form) return;
  const rows = [...form.querySelectorAll('tr.buildrow')];
  const people = [...form.querySelectorAll('input[name="user"]')];
  const q = document.getElementById('bq');
  const summary = document.getElementById('summary');
  const btn = document.getElementById('assignbtn');
  const calib = document.getElementById('withcalib');  // "also give the calibration builds"
  let filter = 'all';

  const visible = (r) => {
    const text = !q.value || r.dataset.id.toLowerCase().includes(q.value.toLowerCase());
    const n = +r.dataset.count;
    const f = filter === 'all' || (filter === 'none' && n === 0) || (filter === 'lt2' && n < 2);
    return text && f;
  };
  function update() {
    rows.forEach((r) => { r.hidden = !visible(r); r.classList.toggle('sel', r.querySelector('input').checked); });
    const builds = rows.filter((r) => r.querySelector('input').checked);
    if (calib && calib.checked) {
      const ids = new Set(calib.dataset.ids.split(','));
      for (const r of rows) if (ids.has(r.dataset.id) && !builds.includes(r)) builds.push(r);
    }
    const users = people.filter((p) => p.checked);
    let make = 0, skip = 0;
    for (const r of builds) {
      const have = new Set(r.dataset.assigned ? r.dataset.assigned.split(',') : []);
      for (const u of users) have.has(u.value) ? skip++ : make++;
    }
    btn.disabled = make === 0;
    if (!builds.length || !users.length) summary.textContent = 'Pick at least one person and one build.';
    else summary.textContent = `${builds.length} ${builds.length === 1 ? 'build' : 'builds'} × ${users.length} ${users.length === 1 ? 'person' : 'people'} = ${make} new ${make === 1 ? 'task' : 'tasks'}` +
      (skip ? ` (${skip} already ${skip === 1 ? 'exists' : 'exist'} and will be skipped)` : '') + '.';
    btn.textContent = make ? `Create ${make} ${make === 1 ? 'task' : 'tasks'}` : 'Create tasks';
  }
  form.addEventListener('change', update);
  q.addEventListener('input', update);
  form.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    form.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    update();
  }));
  form.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
    const boxes = b.dataset.all === 'user' ? people : rows.filter((r) => !r.hidden).map((r) => r.querySelector('input'));
    const on = !boxes.every((x) => x.checked);
    boxes.forEach((x) => { x.checked = on; });
    b.textContent = on ? 'Clear' : (b.dataset.all === 'user' ? 'Select all' : 'Select all shown');
    update();
  }));
  rows.forEach((r) => r.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const box = r.querySelector('input'); box.checked = !box.checked; update();
  }));
  form.addEventListener('submit', () => { btn.disabled = true; btn.textContent = 'Creating…'; });
  update();
})();
