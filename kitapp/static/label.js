// Annotator workspace. Three sections, each with one job:
//   Steps       read each step and label it (parts 2 and 3)
//   Final build the finished repo, answers, scores and logs, for reference
//   Wrap up     grade the session, review the mistakes marked on steps, submit
// Everything from a build is untrusted text. It is only inserted as text nodes, never as HTML.
(function () {
  'use strict';
  const root = document.getElementById('app');
  const API = root.dataset.api, CSRF = root.dataset.csrf, READONLY = root.dataset.readonly === 'true';
  // The local kit has no admin: a task is "finished" (the annotator can reopen it), not "submitted" and locked.
  const KIT = root.dataset.kit === 'true', REVIEWER = root.dataset.viewer === 'admin';
  const T = KIT ? {
    wrap: 'Wrap up & finish', done: 'finished', doneTitle: 'Finished', todoTitle: 'Mark this task as finished', button: 'Mark as finished', busy: 'Saving…',
    doneNote: 'Your answers are saved in your annotations folder. Reopen the task if you need to change something.',
    readyNote: 'You can reopen it later if you need to.', intro: 'When all three parts are done, mark the task as finished.',
    confirm: 'Mark this task as finished? You can reopen it later.', readonly: 'Finished. Reopen it on the Wrap up page to make changes.',
    viewing: (done) => `You are viewing this person's labels (${done ? 'finished' : 'not finished yet'}). Nothing can be changed.`,
    loadHelp: 'Reload the page. If it keeps happening, copy this task folder again from the zip you were sent.',
  } : {
    wrap: 'Wrap up & submit', done: 'submitted', doneTitle: 'Submitted', todoTitle: 'Submit this task', button: 'Submit task', busy: 'Submitting…',
    doneNote: 'Your labels are locked. Ask the admin if something needs to change.',
    readyNote: 'After you submit, your labels are locked.', intro: 'When all three parts are done, submit.',
    confirm: 'Submit this task? Your labels will be locked unless the admin reopens it.', readonly: 'Submitted. This task is read only.',
    viewing: (done) => `You are viewing this person's labels (${done ? 'submitted' : 'not submitted yet'}). Nothing can be changed.`,
    loadHelp: 'Reload the page, or tell the admin if it keeps happening.',
  };
  const S = { schema: null, build: null, steps: [], labels: {}, progress: null, complete: false, status: '', cache: {},
              railFilter: 'all', outFilter: 'all', outPage: 0, repoQuery: '', repoChangedOnly: false, openDirs: new Set() };
  const key = (p, t) => p + '|' + (t || '');
  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- tiny DOM helpers ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    setAttrs(n, attrs);
    append(n, kids);
    return n;
  }
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    append(n, kids);
    return n;
  }
  function setAttrs(n, attrs) {
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (['checked', 'disabled', 'selected', 'open', 'value'].includes(k)) n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  function append(n, kids) {
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  const clear = (n) => { n.replaceChildren(); return n; };
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;
  const fmtTime = (ts) => { const d = ts && new Date(ts); return d && !isNaN(d) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
  // Clock time for things inside a step; the full date and timezone are in the tooltip.
  const fmtClock = (ts) => { const d = ts && new Date(ts); return d && !isNaN(d) ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
  const fmtFull = (ts) => { const d = ts && new Date(ts); return d && !isNaN(d) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) : ''; };
  const timeEl = (ts, cls) => ts ? el('time', { class: 'when ' + (cls || ''), datetime: ts, title: fmtFull(ts) }, fmtClock(ts)) : null;
  function fmtDur(s) {
    if (s === null || s === undefined) return '';
    if (s < 60) return `${s} sec`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  }
  // Show file paths relative to the repo: drop the folder prefix that every changed file shares.
  function relPath(p) {
    // Cut each absolute path at the repo folder (the challenge repo is named after Orchestrate or its task).
    const parts = (p || '').replace(/\\/g, '/').split('/');
    const at = parts.findIndex((d) => /orchestrate|ghost[-_]?data|deletion[-_]?audit/i.test(d));
    if (at >= 0 && at < parts.length - 1) return parts.slice(at + 1).join('/');
    const home = parts.findIndex((d) => d === '[USER]');
    return home >= 0 ? '~/' + parts.slice(home + 1).join('/') : parts.join('/');
  }


  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  const shortTool = (t) => (t || '').split('__').pop();

  async function api(path, opts = {}) {
    let r;
    try {
      r = await fetch(API + path, { credentials: 'same-origin', ...opts,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF, ...(opts.headers || {}) } });
    } catch (e) {
      throw Object.assign(new Error('the app is not reachable'), { retry: true });
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || ('Request failed (' + r.status + ')')), { retry: r.status >= 502 });
    return body;
  }
  function data(name) {
    if (!S.cache[name]) {
      S.cache[name] = name === 'brief'
        ? fetch('/api/brief', { credentials: 'same-origin' }).then((r) => r.json())
        : api('/data/' + name);
    }
    return S.cache[name];
  }

  // ---------- label state ----------
  const part = (id) => S.schema.parts.find((p) => p.id === id);
  const labelable = () => S.steps.filter((s) => s.labelable);
  // Codex records a user's answer to the agent's multiple-choice question as tagged JSON. Show it as words.
  function readableReply(text) {
    const m = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/.exec(text || '');
    if (!m) return null;
    try {
      const items = JSON.parse(m[1]);
      return items.map((it) => `The agent asked: ${it.question}\nThe user chose: ${it.answer}`).join('\n\n');
    } catch (e) { return null; }
  }
  const isEmpty = (x) => x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length);
  // ck: the step's automatic checks. Some questions only apply where a check fired (for example, the agent asked a question).
  // show_if: a follow-up question that applies only when another answer has this value (the mistake details).
  // optional_if: a question that may stay empty for some answers ("continue" asks for nothing new).
  const visible = (f, v) => Object.entries(f.show_if || {}).every(([k, want]) => (v || {})[k] === want);
  const isReq = (f, v, ck) => visible(f, v) && !Object.entries(f.optional_if || {}).some(([k, want]) => [].concat(want).includes(v[k])) &&
    !(f.optional_if_check && (ck || {})[f.optional_if_check]) &&
    (f.required || Object.entries(f.required_if || {}).some(([k, want]) => v[k] === want) || !!(f.required_if_check && (ck || {})[f.required_if_check]));
  const shown = (f, ck, v) => (!f.show_if_check || !!(ck || {})[f.show_if_check]) && visible(f, v);
  function fieldsOk(fields, v, ck) {
    if (!v) return false;
    return fields.every((f) => {
      const x = f.type === 'multi' && v[f.id] ? v[f.id].filter((y) => f.options.includes(y)) : v[f.id];  // retired options don't count
      if (isReq(f, v, ck) && isEmpty(x)) return false;
      if (x && f.min_chars && String(x).trim().length < f.min_chars) return false;
      if (f.type === 'checklist' && isReq(f, v) && !checklistDone(f, x)) return false;
      if (f.type === 'test_result' && isReq(f, v, ck) && !(x && (x.none || (x.passed != null && x.total)))) return false;
      if (f.type === 'percent' && isReq(f, v, ck) && !(x && (x.none || x.value != null))) return false;
      return true;
    });
  }
  // Every item answered, and every Yes points at a step.
  const checklistDone = (f, x) => f.items.every((it) => { const a = (x || {})[it.id] || {}; return a.answer === 'No' || (a.answer === 'Yes' && a.step); });
  function stepState(s) {
    if (!s.labelable) return 'none';
    const a = fieldsOk(part('steps').fields, S.labels[key('steps', s.id)], s.checks);
    const b = fieldsOk(part('prompts').fields, S.labels[key('prompts', s.id)], { slash: trivialKind(s) === 'slash' });
    if (a && b) return 'done';
    return (S.labels[key('steps', s.id)] || S.labels[key('prompts', s.id)]) ? 'partial' : 'todo';
  }
  const nextTodo = () => labelable().find((s) => stepState(s) !== 'done');

  // Each label has a revision number, so "All changes saved" only shows once the latest
  // edit of every label has reached the server, and leaving the page warns while saves are pending.
  const timers = {};
  const revisions = {};
  const pending = new Set();
  const retries = {};
  function save(p, target, value, again) {
    const saveKey = key(p, target);
    const revision = again ? revisions[saveKey] : (revisions[saveKey] || 0) + 1;
    revisions[saveKey] = revision;
    if (!again) retries[saveKey] = 0;
    S.labels[saveKey] = value;
    if (READONLY) return;
    pending.add(saveKey);
    const st = $('savestate');
    st.className = 'savestate'; st.textContent = 'Saving…';
    clearTimeout(timers[saveKey]);
    timers[saveKey] = setTimeout(async () => {
      try {
        const r = await api('/labels', { method: 'PUT', body: JSON.stringify({ part: p, target, value }) });
        S.progress = r.progress; S.complete = r.complete;
        retries[saveKey] = 0;
        if (revisions[saveKey] === revision) pending.delete(saveKey);
        st.textContent = pending.size ? 'Saving…' : 'All changes saved';
        renderTaskbar(); refreshRailIcons();
      } catch (e) {
        if (revisions[saveKey] !== revision) return;  // a newer edit of this answer is already on its way
        st.className = 'savestate bad';
        if (e.retry) {
          // The app is not reachable (stopped, restarting, or a crash). Keep the answer and try again on our own.
          const wait = Math.min(30000, 2000 * 2 ** Math.min(4, (retries[saveKey] = (retries[saveKey] || 0) + 1) - 1));
          st.textContent = 'Not saved yet, retrying…';
          timers[saveKey] = setTimeout(() => { if (revisions[saveKey] === revision) save(p, target, value, true); }, wait);
        } else {
          st.textContent = 'Not saved: ' + e.message;
        }
      }
    }, again ? 0 : 400);
  }
  window.addEventListener('beforeunload', (e) => {
    if (!pending.size) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- routing (state lives in the URL hash) ----------
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const mode = ['brief', 'steps', 'final', 'wrap'].includes(parts[0]) ? parts[0] : 'steps';
    if (mode === 'steps') {
      const s = S.steps.find((x) => x.id === parts[1]) || nextTodo() || labelable()[0] || S.steps[0];
      return { mode, step: s, tab: ['overview', 'changes', 'timeline'].includes(parts[2]) ? parts[2] : 'overview' };
    }
    if (mode === 'final') return { mode, section: parts[1] || 'summary', arg: parts.slice(2).join('/') };
    return { mode };
  }
  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };
  const stepHash = (s, tab) => `#/steps/${encodeURIComponent(s.id)}${tab && tab !== 'overview' ? '/' + tab : ''}`;
  window.addEventListener('hashchange', render);

  // ---------- task bar ----------
  function renderTaskbar() {
    const r = route(), L = labelable();
    const doneSteps = L.filter((s) => stepState(s) === 'done').length;
    const parts = S.progress.session[0] === S.progress.session[1] ? 1 : 0;
    const totalUnits = 2 * L.length + 1;
    const doneUnits = S.progress.steps[0] + S.progress.prompts[0] + parts;
    $('t-prog').textContent = `${doneSteps} of ${L.length} steps labelled`;
    $('t-bar').style.width = (totalUnits ? Math.round(100 * doneUnits / totalUnits) : 0) + '%';
    // The bar uses the same columns as the screen below it, so the tabs line up with the middle section.
    root.querySelector('.taskbar').className = 'taskbar ' + (r.mode === 'wrap' ? 'one' : 'three');
    const m = clear($('modes'));
    const s0 = r.mode === 'steps' ? r.step : (nextTodo() || L[0] || S.steps[0]);
    m.append(
      el('a', { href: '#/brief', 'aria-current': r.mode === 'brief' ? 'page' : null, title: 'The task the builder of this build was given' }, "Builder's task"),
      el('a', { href: stepHash(s0), 'aria-current': r.mode === 'steps' ? 'page' : null }, 'Steps'),
      el('a', { href: '#/final/summary', 'aria-current': r.mode === 'final' ? 'page' : null }, 'Final build'),
      el('a', { href: '#/wrap', 'aria-current': r.mode === 'wrap' ? 'page' : null }, T.wrap,
        S.status === 'submitted' ? el('span', { class: 'badge ok' }, T.doneTitle) : S.complete ? el('span', { class: 'badge ok' }, 'Ready') : null),
      S.schema.guide ? el('button', { class: 'guide-open', onclick: () => openGuide(), title: 'Definitions, worked examples and keyboard shortcuts' },
        'Labelling guide', el('span', { class: 'kbd', 'aria-hidden': 'true' }, '?')) : null);
  }

  function render() {
    const r = route();
    renderTaskbar();
    const box = $('mode');
    if (r.mode === 'steps') S.lastStep = r.step;
    if (r.mode === 'steps') {
      box.className = 'workspace';
      clear(box).append(renderRail(r.step), renderStepPane(r.step, r.tab), renderStepLabels(r.step));
      const cur = box.querySelector('.steprow[aria-current="true"]');
      const list = box.querySelector('.rail-list');
      if (cur && list) {
        const top = cur.offsetTop, h = list.clientHeight;
        if (top < list.scrollTop + 40 || top > list.scrollTop + h - 80) list.scrollTop = Math.max(0, top - h / 3);
      }
    } else if (r.mode === 'final') {
      // Same three columns as Steps and the builder's task: section list left, answers for the step you were on right.
      box.className = 'workspace final';
      const s = S.lastStep || nextTodo() || labelable()[0] || S.steps[0];
      clear(box).append(renderFinalNav(r.section), el('div', { class: 'pane' }, el('div', { id: 'final' }, el('p', { class: 'muted' }, 'Loading…'))), renderStepLabels(s));
      renderFinal(r.section, r.arg);
    } else if (r.mode === 'brief') {
      // Same three columns as Steps: the step list on the left and the answers for the step you were on, on the right.
      box.className = 'workspace';
      const s = S.lastStep || nextTodo() || labelable()[0] || S.steps[0];
      const pane = el('div', { class: 'pane calm' }, el('p', { class: 'muted' }, 'Loading…'));
      clear(box).append(renderRail(null), pane, renderStepLabels(s));
      data('brief').then((b) => { if (route().mode === 'brief') clear(pane).append(el('h1', {}, "The builder's task"),
        el('div', { class: 'note info', style: { margin: '8px 0 20px' } }, el('span', {}, 'This is the brief the builder was given in the hackathon. The session you are labelling is them working with an AI coding agent to build it. You don\'t need to build anything: read it once so you can judge whether each step moved the build toward this goal.',
          /^https:\/\/[^\s"<>]+$/.test(b.starter || '') ? [' The dataset and starter code the builder got are in the ',
            el('a', { href: b.starter, target: '_blank', rel: 'noopener noreferrer' }, 'starter repo'), ' (opens in a new tab).'] : null)),
        el('div', { class: 'md' }, renderMarkdown(b.brief || 'No task brief was included with these tasks.'))); });
    } else {
      box.className = 'workspace one';
      clear(box).append(renderWrap());
    }
  }

  // ---------- STEPS: rail ----------
  function stepMarks(s) {
    const st = s.stats || {}, sm = s.summary || {};
    return [];
  }
  function renderRail(cur) {
    const filters = [['all', 'All', 'Every step'], ['todo', 'To label', 'Steps you have not finished labelling']];
    if (!filters.some(([id]) => id === S.railFilter)) S.railFilter = 'all';
    const keep = (s) => S.railFilter !== 'todo' || (s.labelable && stepState(s) !== 'done');
    const list = el('div', { class: 'rail-list', role: 'list' });
    // A build can hold several sessions: each time the builder started a new conversation with the coding tool.
    const multi = S.build.sessions.length > 1;
    const mains = S.build.sessions.filter((x) => x.kind !== 'subagent');
    for (const sess of S.build.sessions) {
      const own = S.steps.filter((s) => s.session === sess.id && keep(s));
      if (!own.length) continue;
      if (multi) {
        const nums = S.steps.filter((s) => s.session === sess.id && s.labelable).map((s) => s.n);
        const head = sess.kind === 'subagent' ? 'Subagent (context only, not labelled)' : `Session ${mains.indexOf(sess) + 1} of ${mains.length}`;
        const sub = [sess.tool.replace(' subagent', ''), nums.length ? (nums.length > 1 ? `steps ${nums[0]} to ${nums[nums.length - 1]}` : `step ${nums[0]}`) : 'nothing to label',
          sess.start ? 'started ' + fmtTime(sess.start) : null].filter(Boolean).join(', ');
        list.append(el('div', { class: 'group', title: 'The builder started a new conversation with the coding tool here. Steps are numbered across all sessions.' },
          el('b', {}, head), el('span', { class: 'group-sub' }, sub)));
      }
      for (const s of own) {
        const txt = s.prompt ? s.prompt.text.replace(/-{5} (end of )?pasted text -{5}/g, ' ').replace(/\s+/g, ' ').trim() : 'Agent work before the first prompt';
        list.append(el('button', { class: 'steprow' + (s.labelable ? '' : ' off'), 'aria-current': s === cur ? 'true' : null, 'data-step': s.id, role: 'listitem',
          onclick: () => go(stepHash(s, route().tab)), 'aria-label': `${s.labelable ? 'Step ' + s.n : s.id}: ${txt.slice(0, 80)}` },
          el('span', { class: 'sticon ' + stepState(s), 'aria-hidden': 'true' }),
          el('span', { class: 'no' }, s.labelable ? s.n : '·'),
          el('span', { class: 'txt' }, txt.slice(0, 120)),
          el('span', { class: 'marks' }, stepMarks(s))));
      }
    }
    if (!list.childNodes.length) list.append(el('p', { class: 'empty small' }, S.railFilter === 'todo' ? 'Every step is labelled.' : 'No steps match this filter.'));
    const tabs = el('div', { class: 'railtabs', role: 'group', 'aria-label': 'Filter steps' },
      filters.map(([id, label, tip]) => el('button', { 'aria-pressed': String(S.railFilter === id), title: tip, onclick: () => { S.railFilter = id; render(); } }, label)));
    const what = filters.find(([id]) => id === S.railFilter)[2];
    return el('aside', { class: 'rail', 'aria-label': 'Steps' }, el('div', { class: 'rail-head' }, tabs, el('p', { class: 'tiny muted rail-what' }, 'Showing: ' + what.toLowerCase())), list);
  }
  function refreshRailIcons() {
    document.querySelectorAll('.steprow[data-step]').forEach((row) => {
      const s = S.steps.find((x) => x.id === row.dataset.step);
      const ic = row.querySelector('.sticon');
      if (s && ic) ic.className = 'sticon ' + stepState(s);
    });
    const badge = $('stepbadge');
    const r = route();
    if (badge && r.step) setStateBadge(badge, r.step);
  }

  // ---------- STEPS: main pane ----------
  const HINTS = { choice: ['Answer to the agent\'s question', 'info'], paste: ['Contains pasted text', 'info'], long: ['Long prompt', 'info'], slash: ['Slash command', 'info'], agent: ['Written by the parent agent', 'warn'] };
  // The pipeline marks a prompt "paste" when the coding tool recorded a paste, or when it is just very long; tell the two apart.
  const promptKind = (s) => {
    const h = s.prompt && s.prompt.hint;
    if (h === 'paste') return /-{5} pasted text -{5}/.test(s.prompt.text || '') ? 'paste' : 'long';
    return h === 'typed' && s.labelable && /^\/[a-z-]+(\s|$)/i.test((s.prompt.text || '').trim()) ? 'slash' : h;
  };
  function promptBody(text) {
    const box = el('div', { class: 'prompt-text' });
    for (const chunk of text.split(/(-{5} (?:end of )?pasted text -{5})/)) {
      if (/^-{5} pasted text -{5}$/.test(chunk)) box.append(el('span', { class: 'pastemark' }, 'Pasted text starts'));
      else if (/^-{5} end of pasted text -{5}$/.test(chunk)) box.append(el('span', { class: 'pastemark' }, 'Pasted text ends'));
      else box.append(chunk.replace(/^\n+|\n+$/g, ''));
    }
    return box;
  }
  function clampable(node, limitChars, len, label) {
    if (len <= limitChars) return node;
    const wrap = el('div', { class: 'clamp' }, node);
    const btn = el('button', { class: 'ghost sm', onclick: () => { const o = wrap.classList.toggle('open'); btn.textContent = o ? 'Show less' : label; } }, label);
    return el('div', {}, wrap, btn);
  }
  function renderStepPane(s, tab) {
    const L = labelable(), sm = s.summary || {}, st = s.stats || {};
    const sess = S.build.sessions.find((x) => x.id === s.session) || {};
    const idx = L.indexOf(s);
    const prev = idx > 0 ? L[idx - 1] : null, next = idx >= 0 && idx < L.length - 1 ? L[idx + 1] : null;
    const pane = el('div', { class: 'pane calm' });

    if (!localStorage.getItem('astra-intro-dismissed') && !READONLY) {
      const intro = el('div', { class: 'tip' },
        el('span', { class: 'grow' }, 'Read the step, then answer on the right. Press ', el('span', { class: 'kbd' }, '?'), ' any time for the labelling guide. The finished repo is under ', el('b', {}, 'Final build'), '.'),
        el('button', { class: 'ghost sm', onclick: () => { try { localStorage.setItem('astra-intro-dismissed', '1'); } catch (e) { /* private mode */ } intro.remove(); } }, 'Got it'));
      pane.append(intro);
    }
    const notes = (S.build.notes || []).filter((x) => !/^Other files|forks of earlier sessions/i.test(x));
    if (READONLY) notes.unshift(REVIEWER ? T.viewing(S.status === 'submitted') : T.readonly);
    if (!s.labelable) notes.push('Context only. You do not label this step.');
    for (const n of notes) pane.append(el('div', { class: 'tip quiet' }, n));

    const hint = s.prompt && HINTS[promptKind(s)];
    pane.append(el('header', { class: 'stephead' },
      el('div', { class: 'stephead-row' },
        el('h1', {}, s.labelable ? ['Step ', s.n, el('span', { class: 'of' }, ` of ${L.length}`)] : (sess.kind === 'subagent' ? 'Subagent work' : 'Setup work')),
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost iconbtn', disabled: !prev, onclick: () => go(stepHash(prev, tab)), 'aria-label': 'Previous step', title: 'Previous step (k)' }, '\u2039'),
        el('button', { class: 'ghost iconbtn', disabled: !next, onclick: () => go(stepHash(next, tab)), 'aria-label': 'Next step', title: 'Next step (j)' }, '\u203a')),
      L.length > 1 ? sessionStrip(s) : null));
    if (s.prompt) pane.append(el('div', { class: 'who-label' }, s.prompt.hint === 'agent' ? 'The parent agent asked' : 'The user asked', hint ? el('span', { class: 'badge ' + hint[1] }, hint[0]) : null),
      el('div', { class: 'promptbox' }, clampable(promptBody(s.prompt.text), 600, s.prompt.text.length, 'Show the full prompt')));
    else pane.append(el('p', { class: 'muted' }, 'The agent worked on its own here, before or between prompts.'));

    // one quiet line instead of a wall of tiles
    const add = (sm.changed || []).reduce((a, c) => a + c.added, 0), rem = (sm.changed || []).reduce((a, c) => a + c.removed, 0);
    const facts = [
      s.ts ? el('time', { datetime: s.ts, title: fmtFull(s.ts) }, 'Started ' + fmtTime(s.ts)) : null,
      sm.duration_s !== null && sm.duration_s !== undefined ? el('span', {}, 'Ran ' + fmtDur(sm.duration_s)) : null,
      el('span', {}, sess.tool),
      st.tools ? el('a', { href: stepHash(s, 'timeline') }, plural(st.tools, 'tool call')) : el('span', { class: 'muted' }, 'No tool calls'),
      (sm.changed || []).length ? el('a', { href: stepHash(s, 'changes') }, plural(sm.changed.length, 'file') + ' changed ', el('span', { class: 'plus' }, `+${add}`), ' ', el('span', { class: 'minus' }, `−${rem}`)) : null,
      st.declined ? el('a', { href: stepHash(s, 'timeline') }, st.declined > 1 ? `User declined ${st.declined} actions` : 'User declined an action') : null,
      st.blocked ? el('a', { href: stepHash(s, 'timeline'), title: 'The coding tool\'s own permission check stopped the action' }, st.blocked > 1 ? `Coding tool blocked ${st.blocked} actions` : 'Coding tool blocked an action') : null,
      st.interrupts ? el('span', { class: 'bad' }, 'Interrupted') : null,
      ...checkFacts(s),
    ].filter(Boolean);
    pane.append(el('div', { class: 'facts' }, facts));

    // tabs
    const toolActs = s.actions.filter((a) => a.k === 'tool');
    const diffs = toolActs.flatMap((a) => a.diffs || []);

    const tabs = [
      ['overview', "Agent's final response", null, 'What the agent told the user at the end of the step, and the files it changed'],
      ['changes', 'Code changes', diffs.length, 'The code the agent changed in this step, file by file'],
      ['timeline', "Agent's raw actions", s.actions.length, 'Everything the agent did, in order: messages, tool calls with their output, and reasoning']];
    pane.append(el('nav', { class: 'subtabs', 'aria-label': 'Step detail' }, tabs.map(([id, label, n, tip]) =>
      el('a', { href: stepHash(s, id), 'aria-current': tab === id ? 'page' : null, title: tip }, label, n ? el('span', { class: 'n num' }, n) : null))),
      el('p', { class: 'small muted tabnote' }, tabs.find((t) => t[0] === tab)[3] + '.'));
    const body = el('div', {});
    if (tab === 'overview') body.append(stepOverview(s, toolActs));
    if (tab === 'changes') append(body, [diffs.length ? diffs.map((d, i) => diffCard(d, i, diffs.length)) : el('p', { class: 'empty' },
      'No files were changed in this step.')]);
    if (tab === 'timeline') body.append(timeline(s.actions));
    pane.append(body);

    // where the build stood: folded away, one line when closed
    return pane;
  }

  function sessionStrip(cur) {
    const L = labelable();
    const strip = el('div', { class: 'strip', role: 'list', 'aria-label': 'Steps in this session' });
    for (const s of L) {
      const st = stepState(s);
      const what = { done: 'labelled', partial: 'partly labelled', todo: 'not labelled' }[st];
      strip.append(el('a', { href: stepHash(s, route().tab), role: 'listitem', 'aria-current': s === cur ? 'step' : null,
        class: `tick ${st}${s === cur ? ' cur' : ''}`, title: `Step ${s.n}: ${what}`, 'aria-label': `Step ${s.n}, ${what}` }, s.n));
    }
    return el('div', {}, strip, el('div', { class: 'strip-key' },
      el('span', {}, el('i', { style: { background: 'var(--data)' } }), 'Labelled'),
      el('span', {}, el('i', { style: { background: 'var(--active)' } }), 'Not labelled yet'),
    ));
  }

  function stepOverview(s, toolActs) {
    const sm = s.summary || {}, box = el('div', { class: 'overview' });
    box.append(el('div', { class: 'who-label' }, 'What the agent said'),
      sm.reply ? el('div', { class: 'reply' }, el('div', { class: 'md' }, renderMarkdown(sm.reply)))  // always in full
        : el('p', { class: 'muted' }, 'The agent did not write a reply in this step.'));
    if ((sm.changed || []).length) {
      const shown = sm.changed.slice(0, 6);
      box.append(el('div', { class: 'who-label mt-16' }, 'Files changed'),
        el('div', { class: 'filechips' }, shown.map((c) => el('a', { href: stepHash(s, 'changes'), class: 'filechip', title: c.file }, relPath(c.file).split('/').pop(),
          el('span', { class: 'plus' }, ` +${c.added}`), el('span', { class: 'minus' }, ` −${c.removed}`))),
          sm.changed.length > 6 ? el('a', { href: stepHash(s, 'changes'), class: 'small' }, `and ${sm.changed.length - 6} more`) : null));
    }
    if (!toolActs.length && !sm.reply) box.append(el('p', { class: 'empty' }, 'Nothing else happened in this step.'));
    return box;
  }



  const OPS = { edit: 'Edited', create: 'New file', write: 'Written in full', delete: 'Deleted' };
  function diffCard(d, i, total) {
    const lines = d.lines || [], LIMIT = 120;
    const body = el('div', { class: 'diff-body' });
    const draw = (all) => { clear(body); for (const ln of (all ? lines : lines.slice(0, LIMIT))) {
      const c = ln.startsWith('@@') ? 'hunk' : ln[0] === '+' ? 'add' : ln[0] === '-' ? 'del' : '';
      body.append(el('span', { class: 'dl ' + c }, c === 'hunk' ? ln : ln.slice(1) || ' '));
    } };
    draw(false);
    const more = lines.length > LIMIT ? el('div', { class: 'diff-more' }, el('button', { class: 'sm', onclick: (e) => { draw(true); e.target.remove(); } }, `Show ${lines.length - LIMIT} more lines`)) : null;
    return el('div', { class: 'diff' },
      el('div', { class: 'diff-head' }, el('span', { class: 'path', title: d.file }, relPath(d.file) || '(unknown file)'), el('span', { class: 'badge ' + (d.op === 'create' ? 'info' : d.op === 'delete' ? 'bad' : '') }, OPS[d.op] || d.op),
        el('span', { class: 'spacer' }), el('span', { class: 'num small' }, el('span', { class: 'plus' }, `+${d.added}`), ' ', el('span', { class: 'minus' }, `−${d.removed}`)),
        total > 1 ? el('span', { class: 'muted tiny' }, `change ${i + 1} of ${total}`) : null),
      body, more, d.more ? el('div', { class: 'diff-more muted small' }, `${d.more} more lines were cut by the pipeline.`) : null);
  }

  // ---------- automatic checks from the pipeline (pointers, not answers) ----------
  function checkFacts(s) {
    const ck = s.checks || {};
    const out = [];
    if (ck.lines_added >= 10) out.push(el('span', { title: 'Share of the lines the agent added in this step that are still in the final repo' }, `${Math.round(100 * ck.lines_kept / ck.lines_added)}% of its lines kept`));
    return out;
  }
  function timeline(actions) {
    if (!actions.length) return el('div', { class: 'empty card' }, 'No agent actions were recorded for this step.');
    const ol = el('ol', { class: 'tl' });
    for (const a of actions) {
      let li;
      if (a.k === 'msg') li = el('li', {}, el('span', { class: 'ic agent', 'aria-hidden': 'true' }, 'A'), el('div', { class: 'head' }, el('span', { class: 'kind' }, 'Agent'), timeEl(a.ts)),
        el('div', { class: 'body' }, clampable(el('div', { class: 'md' }, renderMarkdown(a.text)), 700, a.text.length, 'Show more')));
      else if (a.k === 'tool') {
        const cmd = a.input && a.input.command !== undefined ? String(a.input.command) : null;
        const preview = cmd ? cmd.split('\n').find((l) => l.trim()) : (a.diffs || []).length ? a.diffs.map((d) => relPath(d.file)).join(', ') : (a.input && (a.input.file_path || a.input.pattern || a.input.query)) || '';
        li = el('li', {}, el('span', { class: 'ic tool', 'aria-hidden': 'true' }, 'T'),
          el('details', { open: true }, el('summary', {}, el('div', { class: 'head' }, el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'), el('span', { class: 'kind' }, shortTool(a.tool)), timeEl(a.ts),
            a.declined ? el('span', { class: 'badge warn' }, 'declined by the user') : null, a.blocked ? el('span', { class: 'badge' }, 'blocked by the coding tool') : null, (a.diffs || []).length ? el('span', { class: 'badge' }, plural(a.diffs.length, 'file') + ' changed') : null),
            el('span', { class: 'preview' }, preview || '')),
          el('div', { class: 'body' }, (a.diffs || []).length ? a.diffs.map((d, i) => diffCard(d, i, a.diffs.length)) : cmd !== null ? el('pre', {}, (a.input.description ? '# ' + a.input.description + '\n' : '') + cmd) : el('pre', {}, JSON.stringify(a.input || {}, null, 2)),
            a.output ? el('div', {}, el('div', { class: 'sublabel', style: { margin: '4px 0' } }, 'Output'), el('pre', {}, a.output)) : null)));
      } else if (a.k === 'think') li = el('li', {}, el('span', { class: 'ic', 'aria-hidden': 'true' }, 'R'), el('details', { open: true }, el('summary', {}, el('div', { class: 'head' }, el('span', { class: 'chev' }, '›'), el('span', { class: 'kind muted' }, 'Agent reasoning summary'), timeEl(a.ts))), el('div', { class: 'body' }, el('div', { class: 'prose small' }, a.text))));
      else if (a.k === 'interrupt') li = el('li', {}, el('span', { class: 'ic bad', 'aria-hidden': 'true' }, '!'), el('div', { class: 'head' }, el('span', { class: 'kind', style: { color: 'var(--negative)' } }, 'The user interrupted the agent'), timeEl(a.ts)));
      else li = el('li', {}, el('span', { class: 'ic sys', 'aria-hidden': 'true' }, 'S'), el('details', { open: true }, el('summary', {}, el('div', { class: 'head' }, el('span', { class: 'chev' }, '›'), el('span', { class: 'kind muted' }, a.text.split('\n')[0].slice(0, 120)), timeEl(a.ts))), el('div', { class: 'body' }, el('pre', {}, a.text))));
      ol.append(li);
    }
    return ol;
  }

  // ---------- labelling guide (text lives in label_schema.json -> guide) ----------
  const GUIDE_FOR = { effect: 'effect', human_corrected: 'corrections', reverted: 'corrections', intent: 'intent', source: 'source',
                      steering_quality: 'session', agent_quality: 'session', training_value: 'session', type: 'session',
                      behaviours: 'session', involvement: 'session', confidence: 'session', noticed: 'session',
                      reaction: 'reaction', asked: 'corrections', should_have_asked: 'corrections', claims_match: 'session', earned: 'session',
                      failure: 'mistakes', failure_types: 'mistakes', noticed: 'mistakes' };
  let guideReturn = null;
  function closeGuide() {
    const d = $('guide'); if (!d) return;
    d.remove(); document.removeEventListener('keydown', guideKeys, true);
    if (guideReturn) guideReturn.focus();
  }
  function guideKeys(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGuide(); } }
  function openGuide(section) {
    const G = S.schema.guide;
    if (!G) return;
    closeGuide();
    guideReturn = document.activeElement;
    const close = el('button', { class: 'ghost sm', onclick: closeGuide }, 'Close');
    const body = el('div', { class: 'drawer-body' },
      G.status && root.dataset.viewer === 'admin' ? el('p', { class: 'note warn' }, G.status) : null,
      el('p', {}, G.intro),
      G.sections.map((sec) => el('section', { id: 'guide-' + sec.id, class: 'guide-sec' },
        el('h3', {}, sec.title), sec.help ? el('p', { class: 'muted small' }, sec.help) : null,
        el('dl', {}, sec.items.map((it) => [el('dt', {}, it.term), el('dd', {}, it.text)])))),
      el('section', { id: 'guide-keys', class: 'guide-sec' }, el('h3', {}, 'Keyboard shortcuts'),
        el('dl', { class: 'keys' }, [['j and k', 'Next and previous step'], ['n', 'Next step you have not finished'], ['1 to 4', 'Helped, Neutral, Hurt, Can\'t tell'],
          ['c', 'The user had to correct this step (on or off)'], ['u', 'This step\'s work was undone later (on or off)'],
          ['5 to 8', 'Who wrote the prompt: typed by the user, pasted from another AI, inserted by the coding tool, can\'t tell'], ['?', 'Open this guide'], ['Esc', 'Close it']]
          .map(([k, d]) => [el('dt', {}, el('span', { class: 'kbd' }, k)), el('dd', {}, d)]))),
      (G.examples || []).length ? el('section', { id: 'guide-examples', class: 'guide-sec' }, el('h3', {}, 'Worked examples'),
        G.examples.map((x) => el('div', { class: 'example' }, el('b', {}, x.title),
          el('p', {}, el('span', { class: 'muted' }, 'Prompt: '), x.prompt), el('p', {}, el('span', { class: 'muted' }, 'What happened: '), x.what),
          el('p', {}, el('span', { class: 'muted' }, 'Labels: '), x.answer)))) : null);
    const drawer = el('div', { id: 'guide', class: 'drawer-wrap' },
      el('div', { class: 'drawer-backdrop', onclick: closeGuide }),
      el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'guide-title' },
        el('div', { class: 'drawer-head' }, el('h2', { id: 'guide-title' }, 'Labelling guide'), el('span', { class: 'spacer' }), close), body));
    document.body.append(drawer);
    document.addEventListener('keydown', guideKeys, true);
    close.focus();
    const target = section && $('guide-' + section);
    if (target) target.scrollIntoView({ block: 'start' });
  }
  const guideLink = (section, label) => S.schema.guide ? el('button', { class: 'ghost guidebtn', type: 'button', onclick: () => openGuide(section),
    'aria-label': label || 'How to answer this', title: label || 'How to answer this' }, '?') : null;

  // ---------- trivial steps: fill only the obvious, empty answers ----------
  const GO_AHEAD = /^(continue|go( on| ahead)?|proceed|ok(ay)?|yes|y|yep|sure|next|do it|done|submitted|thanks?|thank you|lgtm)[.!]*$/i;
  function trivialKind(s) {
    if (!s.labelable || !s.prompt) return null;
    const t = s.prompt.text.trim();
    if (s.prompt.hint === 'slash' || /^\/[a-z-]+(\s|$)/i.test(t)) return 'slash';
    if (GO_AHEAD.test(t)) return 'goahead';
    return null;
  }
  function quietStep(s) {
    const st = s.stats || {};
    return (st.tools || 0) <= 1 && !((s.summary || {}).changed || []).length;
  }
  function quickFill(s) {
    const kind = trivialKind(s);
    const filled = [];
    const pv = { ...(S.labels[key('prompts', s.id)] || {}) };
    if (!pv.source) { pv.source = 'Typed by the user'; filled.push('who wrote it'); }
    if (!pv.reaction) { pv.reaction = kind === 'slash' ? 'Not replying to the agent (first prompt, or a new topic)' : 'Accepting it and moving on (ok, yes, continue)'; filled.push('what the user is doing'); }
    if (filled.length) save('prompts', s.id, pv);
    const sv = { ...(S.labels[key('steps', s.id)] || {}) };
    if (!sv.effect && quietStep(s)) { sv.effect = 'Neutral'; save('steps', s.id, sv); filled.push('Neutral, because the agent did almost nothing'); }
    return filled;
  }

  // ---------- later steps that changed the same files ----------
  function laterChanges(s) {
    const mine = new Set(((s.summary || {}).changed || []).map((c) => relPath(c.file)));
    if (!mine.size) return null;
    const hits = [];
    for (const x of labelable()) {
      if (x.n <= s.n) continue;
      const files = ((x.summary || {}).changed || []).map((c) => relPath(c.file)).filter((f) => mine.has(f));
      if (files.length) hits.push({ x, files });
    }
    if (!hits.length) return el('p', { class: 'help evidence' }, 'No later step changed the files from this step.');
    const shown = hits.slice(0, 6);
    return el('p', { class: 'help evidence' }, 'The files from this step were changed again in ',
      shown.map((h, i) => [i ? ', ' : '', el('a', { href: stepHash(h.x, 'changes'), title: h.files.join(', ') }, `step ${h.x.n}`)]),
      hits.length > shown.length ? ` and ${hits.length - shown.length} more` : '', '. Open them to see whether this work was kept.');
  }

  // ---------- STEPS: label panel ----------
  function setStateBadge(b, s) {
    const st = stepState(s);
    b.className = 'badge ' + (st === 'done' ? 'ok' : st === 'partial' ? 'warn' : '');
    b.textContent = st === 'done' ? 'Done' : st === 'partial' ? 'In progress' : 'Not started';
  }
  function renderStepLabels(s) {
    const wrap = el('aside', { class: 'labels', 'aria-label': 'Labels for this step' });
    const body = el('div', { class: 'labels-body' });
    const L = labelable(), idx = L.indexOf(s);
    if (!s.labelable) {
      body.append(el('p', { class: 'muted' }, 'Nothing to label here. This step is shown for context.'));
      const nx = S.steps.slice(S.steps.indexOf(s) + 1).find((x) => x.labelable);
      wrap.append(body, el('div', { class: 'labels-foot' }, el('span', { class: 'spacer' }), nx ? el('button', { class: 'primary', onclick: () => go(stepHash(nx)) }, 'Next step') : null));
      return wrap;
    }
    const badge = el('span', { id: 'stepbadge' }); setStateBadge(badge, s);
    body.append(el('div', { class: 'labels-title' }, el('h2', {}, `Step ${s.n}`), badge));
    const kind = trivialKind(s);
    if (kind && !READONLY) {
      const msg = el('span', { class: 'grow' }, kind === 'slash' ? 'This prompt is a slash command.' : 'This prompt only tells the agent to carry on.',
        ' ', quietStep(s) ? 'The agent did almost nothing here.' : 'The agent did real work after it, so judge that work yourself.');
      body.append(el('div', { class: 'quickfill' }, msg,
        el('button', { class: 'sm', onclick: (e) => {
          const filled = quickFill(s);
          const panel = e.target.closest('.labels');
          const fresh = renderStepLabels(s); panel.replaceWith(fresh);
          const q = fresh.querySelector('.quickfill');
          if (q) q.replaceChildren(el('span', { class: 'grow' }, filled.length ? 'Filled in: ' + filled.join('; ') + '. Check them before you move on.' : 'Nothing to fill: you have already answered these.'));
        } }, 'Fill in the obvious answers')));
    }
    body.append(el('h3', { class: 'panel-sec' }, "The agent's work in this step"), partFields('steps', s.id), el('div', { class: 'divider' }),
      el('h3', { class: 'panel-sec' }, "The user's prompt"), partFields('prompts', s.id));
    // Personal info should already be scrubbed; this is only a way to report anything that slipped through.
    const fv = { ...(S.labels[key('flags', s.id)] || {}) };
    const pii = el('p', { class: 'small report' });
    const drawPii = () => append(clear(pii), fv.pii
      ? [el('span', { class: 'badge warn' }, 'Reported: personal info in this step'), READONLY ? null : el('button', { class: 'linkbtn', onclick: () => { fv.pii = false; save('flags', s.id, { ...fv }); drawPii(); } }, 'Undo'),
         guideLink('personal', 'What counts as personal info')]
      : READONLY ? [] : [el('button', { class: 'linkbtn', onclick: () => { fv.pii = true; save('flags', s.id, { ...fv }); drawPii(); } }, 'Report a real name, email or key in this step'),
         guideLink('personal', 'What counts as personal info')]);
    drawPii();
    body.append(pii);
    const prev = idx > 0 ? L[idx - 1] : null, next = L[idx + 1];
    const todo = L.find((x, i) => i > idx && stepState(x) !== 'done') || L.find((x) => stepState(x) !== 'done' && x !== s);
    const foot = el('div', { class: 'labels-foot' },
      el('button', { class: 'ghost', disabled: !prev, onclick: () => go(stepHash(prev)) }, 'Back'),
      el('span', { class: 'spacer' }),
      S.schema.guide ? el('button', { class: 'ghost sm', onclick: () => openGuide('keys'), title: 'Definitions, worked examples and keyboard shortcuts' }, 'Shortcuts') : null,
      next ? el('button', { class: 'primary', onclick: () => go(stepHash(todo && stepState(s) === 'done' ? todo : next)) }, 'Next step')
        : el('a', { class: 'btn primary', href: '#/wrap' }, 'Go to wrap up'));
    wrap.append(body, foot);
    return wrap;
  }

  // Hints for "Who wrote this prompt?", shown right under it.
  const SOURCE_HINT = {
    choice: 'Hint: the user picked one of the options the coding tool offered, so it was typed or clicked by the user.',
    long: 'Hint: this prompt is very long, which often means it was pasted. Check whether it reads like model output.',
    slash: 'Hint: this is a slash command typed into the coding tool.' };
  function partFields(pid, target) {
    const p = part(pid), k = key(pid, target);
    const v = { ...(S.labels[k] || {}) };
    const box = el('div', {});
    const redraw = (focusId) => {
      const fresh = partFields(pid, target);
      box.replaceWith(fresh);
      if (focusId) { const f = fresh.querySelector(`[data-fid="${focusId}"]`); if (f) f.focus(); }
    };
    const step = S.steps.find((x) => x.id === target), ck = step && { ...step.checks, slash: trivialKind(step) === 'slash' };
    for (const f of p.fields) {
      if (!shown(f, ck, v)) continue;
      const reveals = p.fields.some((x) => x.show_if && f.id in x.show_if);  // ticking it opens follow-up questions
      box.append(field(f, v, (x, opts = {}) => { v[f.id] = x; save(pid, target, { ...v }); if (!opts.quiet) redraw(opts.focus); }, `${pid}-${target}-${f.id}`, ck, reveals));
      if (pid === 'prompts' && f.id === 'source' && step && SOURCE_HINT[promptKind(step)]) box.append(el('p', { class: 'help evidence' }, SOURCE_HINT[promptKind(step)]));
      if (pid === 'steps' && f.id === 'reverted') {
        const s = S.steps.find((x) => x.id === target);
        const h = s && laterChanges(s);
        if (h) box.append(h);
      }
    }
    return box;
  }

  function field(f, v, set, fid, ck, reveals) {
    const value = v[f.id], dis = READONLY;
    const req = isReq(f, v, ck);
    const wrap = el('div', { class: 'field' });
    const q = el('span', { class: 'q', id: fid + '-q' }, f.label.replace(/ \(required if Hurt\)/, ''), req ? el('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null,
      GUIDE_FOR[f.id] && f.type !== 'bool' ? guideLink(GUIDE_FOR[f.id]) : null);
    if (f.type !== 'bool') wrap.append(q);
    if (f.help && f.type !== 'bool' && f.type !== 'checklist') wrap.append(el('div', { class: 'help above' }, f.help));
    if (f.type === 'scale') {
      const row = el('div', { class: 'scale', role: 'group', 'aria-labelledby': fid + '-q' });
      for (let i = f.min; i <= f.max; i++) row.append(el('button', { 'aria-pressed': String(value === i), disabled: dis, 'data-fid': `${fid}-${i}`, title: (f.anchors || {})[i] || '', onclick: () => set(i, { focus: `${fid}-${i}` }) }, i));
      const an = f.anchors || {};
      wrap.append(row, el('div', { class: 'help' }, Object.entries(an).map(([k, t]) => `${k} is ${t.toLowerCase()}`).join('; ')));
    } else if (f.type === 'choice') {
      const short = f.options.every((o) => o.length <= 14);
      const cls = !short ? 'seg col' : f.options.length === 4 ? 'seg wrap' : 'seg';
      wrap.append(el('div', { class: cls, role: 'group', 'aria-labelledby': fid + '-q' }, f.options.map((o, i) => el('button', {
        'aria-pressed': String(value === o), disabled: dis, 'data-fid': `${fid}-${i}`,
        class: o === 'Hurt' ? 'tone-bad' : (o === 'Neutral' || o === "Can't tell") ? 'tone-neutral' : null,
        onclick: () => set(value === o ? null : o, { focus: `${fid}-${i}` }) }, o, f.keys ? el('span', { class: 'key', 'aria-hidden': 'true' }, f.keys[i]) : null))));
    } else if (f.type === 'multi') {
      const cur = new Set(value || []);
      const toggle = (o, i) => { cur.has(o) ? cur.delete(o) : cur.add(o); set([...f.options, ...(f.retired || [])].filter((x) => cur.has(x)), { focus: `${fid}-${i}` }); };
      if (f.options.some((o) => o.length > 30)) {  // long answers read better as a ticked list than as wrapped chips
        wrap.append(el('div', { class: 'ticklist', role: 'group', 'aria-labelledby': fid + '-q' }, f.options.map((o, i) => {
          const m = o.match(/^(.*?) \((.*)\)$/);
          return el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: cur.has(o), disabled: dis, 'data-fid': `${fid}-${i}`, onchange: () => toggle(o, i) }),
            el('span', {}, m ? m[1] : o, m ? el('span', { class: 'sub' }, m[2]) : null));
        })));
        return wrap;
      }
      const FEW = 99;  // show every option: hiding some made the right answer easy to miss
      const showAll = S.showAll || f.options.slice(FEW).some((o) => cur.has(o));
      const opts = showAll ? f.options : f.options.slice(0, FEW);
      wrap.append(el('div', { class: 'chips', role: 'group', 'aria-labelledby': fid + '-q' }, opts.map((o) => { const i = f.options.indexOf(o); return el('button', { 'aria-pressed': String(cur.has(o)), disabled: dis, 'data-fid': `${fid}-${i}`,
        onclick: () => { cur.has(o) ? cur.delete(o) : cur.add(o); set([...f.options, ...(f.retired || [])].filter((x) => cur.has(x)), { focus: `${fid}-${i}` }); } }, o); }),
        !showAll && f.options.length > FEW ? el('button', { class: 'ghost more', onclick: () => { S.showAll = true; set(value || [], {}); } }, `+${f.options.length - FEW} more`) : null));
    } else if (f.type === 'bool') {
      wrap.className = 'field tight';
      wrap.append(el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!value, disabled: dis, 'data-fid': fid + '-cb',
        onchange: (e) => set(e.target.checked, reveals ? { focus: fid + '-cb' } : { quiet: true }) }), el('span', {}, f.label)));
      if (f.help) wrap.append(el('div', { class: 'help' }, f.help));
    } else if (f.type === 'text' && !req && !value && !(S.openNotes || new Set()).has(fid)) {
      wrap.replaceChildren(el('button', { class: 'ghost sm addnote', disabled: dis, onclick: () => { (S.openNotes = S.openNotes || new Set()).add(fid); set(value || '', { focus: fid + '-ta' }); } }, f.add_label || '+ Add a note'));
    } else if (f.type === 'text') {
      const count = el('div', { class: 'help num' });
      const upd = (t) => { count.textContent = f.min_chars ? `${t.trim().length} of at least ${f.min_chars} characters` : ''; };
      const ta = el('textarea', { rows: 3, disabled: dis, 'aria-labelledby': fid + '-q', 'data-fid': fid + '-ta', autocomplete: 'off', placeholder: f.placeholder || (req ? 'Required…' : 'Optional…'), oninput: (e) => { upd(e.target.value); set(e.target.value, { quiet: true }); } });
      ta.value = value || ''; upd(ta.value);
      wrap.append(ta, count);
    } else if (f.type === 'step_ref') {
      wrap.append(stepSelect(value, dis, fid + '-q', (x) => set(x, { quiet: true })));
    } else if (f.type === 'test_result' || f.type === 'percent') {
      // numbers the annotator reads off the last run, or "none"; typing saves without redrawing so focus stays put
      const cur = { ...(value || {}) };
      const num = (k, attrs) => el('input', { type: 'number', min: 0, step: f.type === 'percent' ? 'any' : 1, max: attrs.max, class: 'numin', disabled: dis || !!cur.none,
        value: cur[k] ?? '', 'aria-label': attrs.label, oninput: (e) => { cur[k] = e.target.value === '' ? null : Number(e.target.value); set({ passed: cur.passed, total: cur.total, value: cur.value }, { quiet: true }); } });
      const row = f.type === 'test_result'
        ? el('div', { class: 'numrow' }, num('passed', { label: 'Tests passed' }), el('span', {}, 'passed of'), num('total', { label: 'Total tests' }))
        : el('div', { class: 'numrow' }, num('value', { max: 100, label: 'Accuracy in percent' }), el('span', {}, '%'));
      wrap.append(row, el('label', { class: 'check', style: { marginTop: '6px' } }, el('input', { type: 'checkbox', checked: !!cur.none, disabled: dis,
        onchange: (e) => set(e.target.checked ? { none: true } : null, {}) }), el('span', {}, f.none_label)));
    } else if (f.type === 'checklist') {
      const cur = value || {};
      const done = f.items.filter((it) => { const a = cur[it.id] || {}; return a.answer === 'No' || (a.answer === 'Yes' && a.step); }).length;
      if (f.help) wrap.append(el('div', { class: 'help' }, f.help));
      const list = el('ul', { class: 'checkq', role: 'list' });
      f.items.forEach((it, i) => {
        const a = cur[it.id] || {};
        const put = (patch, opts) => set({ ...cur, [it.id]: { ...a, ...patch } }, opts);
        const qid = `${fid}-${it.id}`;
        list.append(el('li', {}, el('span', { class: 'cq-text', id: qid }, it.label),
          el('div', { class: 'seg', role: 'group', 'aria-labelledby': qid }, ['Yes', 'No'].map((o, j) => el('button', {
            'aria-pressed': String(a.answer === o), disabled: dis, 'data-fid': `${qid}-${j}`,
            onclick: () => put({ answer: a.answer === o ? null : o, step: o === 'Yes' ? a.step : null }, { focus: `${qid}-${j}` }) }, o))),
          a.answer === 'Yes' ? el('div', { class: 'cq-step' }, stepSelect(a.step, dis, qid, (x) => put({ step: x || null }, { quiet: true }), 'Which step shows it?')) : null));
      });
      wrap.append(list, el('div', { class: 'help num' }, `${done} of ${f.items.length} answered`));
    }
    return wrap;
  }

  function stepSelect(value, dis, labelledby, onpick, first = 'Pick a step…') {
    return el('select', { disabled: dis, 'aria-labelledby': labelledby, onchange: (e) => onpick(e.target.value) }, el('option', { value: '' }, first),
      labelable().map((s) => el('option', { value: s.id, selected: value === s.id }, `Step ${s.n}: ${s.prompt.text.replace(/-{5}[^-]+-{5}/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)}`)));
  }

  // ---------- FINAL BUILD ----------
  const SECTIONS = [['summary', 'Summary'], ['repo', 'Repository'], ['answers', 'Answers (output.csv)']];
  function renderFinalNav(cur) {
    return el('nav', { class: 'sidenav', 'aria-label': 'Final build' }, el('h2', {}, 'The finished build'),
      SECTIONS.map(([id, label]) => el('a', { href: '#/final/' + id, 'aria-current': cur === id ? 'page' : null }, label)));
  }
  async function renderFinal(section, arg) {
    const host = $('final');
    let node;
    try {
      if (section === 'summary') node = await finalSummary();
      else if (section === 'repo') node = finalRepo(await data('code'), arg);
      else if (section === 'answers') node = outcomeOpen() ? finalAnswers(await data('output'))
        : el('div', { class: 'pane-narrow' }, el('h1', {}, 'Answers (output.csv)'), el('div', { class: 'note info', style: { marginTop: '14px' } }, el('span', {}, 'The answers and how they compare with other builds appear after you finish the session grade on the Wrap up page. Judging the work first keeps the result from swaying you.')));
      else node = await finalSummary();
    } catch (e) { node = el('div', { class: 'note warn' }, 'Could not load this section: ' + e.message); }
    if (route().mode === 'final') clear(host).append(node);
  }
  async function finalSummary() {
    const b = S.build, st = b.stats || {}, out = await data('output').catch(() => null);
    const sm = out && out.summary;
    const first = b.sessions.map((s) => s.start).filter(Boolean).sort()[0], last = b.sessions.map((s) => s.end).filter(Boolean).sort().pop();
    const span = first && last ? Math.round((new Date(last) - new Date(first)) / 1000) : null;
    const box = el('div', { class: 'pane-narrow' }, el('h1', {}, `Build ${b.build_id}`), el('p', { class: 'muted', style: { marginTop: '4px' } }, b.edition || ''));
    box.append(el('div', { class: 'tiles', style: { marginTop: '14px' } },
      tile('Coding tool', (b.trace_tools || []).join(' and ') || 'Not available', plural(b.sessions.filter((x) => x.kind === 'main').length, 'session')),
      tile('Steps to label', st.labelable_steps, `${st.all_steps} steps in total`),
      tile('Tool calls', (st.tool_calls || 0).toLocaleString(), ''),
      tile('Time span', span ? fmtDur(span) : 'Not available', first ? `${fmtTime(first)} to ${fmtTime(last)}` : ''),
      tile('Repo files', st.code_files, `${st.files_touched} changed during the session`),
      sm && outcomeOpen() ? tile('Answers', sm.rows, `${sm.status_matches_majority} match the batch majority on status`) : null,
      (b.checks || {}).agent_lines_added ? tile('Agent code kept', `${Math.round(100 * b.checks.agent_lines_kept / b.checks.agent_lines_added)}%`, `of ${b.checks.agent_lines_added.toLocaleString()} lines it added are in the final repo`) : null,
      (b.checks || {}).final_code_lines ? tile('Code not from agent edits', `${Math.round(100 * b.checks.final_code_lines_untraced / b.checks.final_code_lines)}%`, 'written by the user, by shell commands, or before the session') : null));
    const models = Object.entries(b.models || {});
    box.append(el('section', { class: 'card', style: { marginTop: '14px' } }, el('h3', { style: { marginBottom: '8px' } }, 'Tools and models'),
      el('dl', { class: 'kv' }, el('dt', {}, 'Coding tools in the trace'), el('dd', {}, (b.trace_tools || []).join(', ') || 'Not available'),
        el('dt', {}, 'Models'), el('dd', {}, models.length ? models.map(([m]) => m).join(', ') : 'Not available'))));
    box.append(el('section', { class: 'section' }, el('h2', {}, 'Sessions'), el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Session', 'Tool', 'Kind', 'Steps', 'Started', 'Ended'].map((h) => el('th', {}, h)))),
      el('tbody', {}, b.sessions.map((s) => el('tr', {}, el('td', {}, s.id), el('td', {}, s.tool), el('td', {}, s.kind === 'main' ? 'Main' : 'Subagent'), el('td', { class: 'num' }, s.steps), el('td', {}, fmtTime(s.start)), el('td', {}, fmtTime(s.end)))))))));
    return box;
  }
  const tile = (label, value, sub) => el('div', { class: 'tile' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value ?? 'Not available'), el('div', { class: 'sub' }, sub || ''));





  function byTree(a, b) {
    const x = a.path.split('/'), y = b.path.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const xd = i < x.length - 1, yd = i < y.length - 1;
      if (xd !== yd) return xd ? -1 : 1;
      if (x[i] !== y[i]) return x[i].localeCompare(y[i], undefined, { sensitivity: 'base' });
    }
    return x.length - y.length;
  }
  function finalRepo(code, sel) {
    code = code.slice().sort(byTree);
    const changed = code.filter((f) => f.touched_in).length;
    const q = el('input', { type: 'search', placeholder: 'Find a file…', value: S.repoQuery, 'aria-label': 'Find a file', autocomplete: 'off', style: { width: '100%' },
      oninput: (e) => { S.repoQuery = e.target.value; drawTree(); } });
    const only = el('label', { class: 'small', style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '8px 2px' } },
      el('input', { type: 'checkbox', checked: S.repoChangedOnly, onchange: (e) => { S.repoChangedOnly = e.target.checked; drawTree(); } }), `Only files changed in the session (${changed})`);
    const tree = el('div', { class: 'tree', role: 'tree', 'aria-label': 'Repository files' });
    const view = el('div', {});
    const dirs = (p) => p.split('/').slice(0, -1);
    function drawTree() {
      clear(tree);
      const query = S.repoQuery.toLowerCase();
      const files = code.filter((f) => (!query || f.path.toLowerCase().includes(query)) && (!S.repoChangedOnly || f.touched_in));
      const shown = new Set();
      for (const f of files) {
        const d = dirs(f.path);
        for (let i = 0; i < d.length; i++) {
          const dp = d.slice(0, i + 1).join('/');
          const parentOpen = i === 0 || S.openDirs.has(d.slice(0, i).join('/')) || query || S.repoChangedOnly;
          if (!shown.has(dp) && parentOpen) {
            shown.add(dp);
            const open = S.openDirs.has(dp) || !!query || S.repoChangedOnly;
            tree.append(el('button', { class: 'dir', style: { paddingLeft: (12 + i * 14) + 'px' }, 'aria-expanded': String(open),
              onclick: () => { S.openDirs.has(dp) ? S.openDirs.delete(dp) : S.openDirs.add(dp); drawTree(); } }, (open ? '▾ ' : '▸ ') + d[i] + '/'));
          }
        }
        const visible = !d.length || S.openDirs.has(d.join('/')) || query || S.repoChangedOnly;
        if (visible) tree.append(el('button', { role: 'treeitem', 'aria-current': f.path === sel ? 'true' : null, style: { paddingLeft: (12 + d.length * 14) + 'px' },
          onclick: () => go('#/final/repo/' + f.path.split('/').map(encodeURIComponent).join('/')) }, f.path.split('/').pop(), f.touched_in ? el('span', { class: 'chg', title: 'Changed during the session' }) : null));
      }
      if (!files.length) tree.append(el('p', { class: 'empty small' }, 'No files match.'));
    }
    const f = code.find((x) => x.path === sel);
    if (f) { dirs(f.path).forEach((_, i, d) => S.openDirs.add(d.slice(0, i + 1).join('/'))); }
    drawTree();
    if (!f) view.append(el('div', { class: 'empty card' }, 'Pick a file on the left. Files with a green dot were changed during the session.'));
    else {
      const head = el('div', { class: 'diff-head' }, el('span', { class: 'path' }, f.path), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny num' }, `${f.size.toLocaleString()} bytes`));
      const changedIn = f.touched_in ? el('div', { class: 'small', style: { padding: '8px 12px', borderBottom: '1px solid var(--border)' } }, 'Changed in: ',
        f.touched_in.map((sid) => { const s = S.steps.find((x) => x.id === sid); return s ? el('a', { href: stepHash(s, 'changes'), style: { marginRight: '8px' } }, s.labelable ? `Step ${s.n}` : sid) : null; })) : null;
      let content;
      if (f.content === undefined) content = el('p', { class: 'empty' }, 'Not shown: ' + f.withheld + '.');
      else {
        const lines = f.content.split('\n').slice(0, 6000);
        content = el('div', { class: 'code' }, el('div', { class: 'ln' }, lines.map((_, i) => i + 1).join('\n')), el('div', { class: 'src' }, lines.join('\n')));
      }
      view.append(el('div', { class: 'diff' }, head, changedIn, content));
    }
    return el('div', {}, el('div', { class: 'page-head', style: { marginBottom: '12px' } }, el('div', {}, el('h1', {}, 'Repository'), el('div', { class: 'sub' }, `The code.zip the participant submitted: ${plural(code.length, 'file')}, ${changed} changed during the session.`))),
      el('div', { class: 'repo' }, el('div', {}, q, only, tree), view));
  }

  function finalAnswers(out) {
    const sm = out.summary, rows = out.rows;
    const counts = Object.entries(sm.status_counts || {});
    const colors = { COMPLETE: 'var(--success)', INCOMPLETE: 'var(--warn)', NOT_APPLICABLE: 'var(--text-3)' };
    const box = el('div', {}, el('h1', {}, 'Answers (output.csv)'),
      el('p', { class: 'muted', style: { marginTop: '4px' } }, `${sm.rows} answers. "Majority" means most of the ${sm.batch_builds} builds in this batch. It is not the answer key, so disagreeing with it is not proof of an error.`));
    box.append(el('div', { class: 'tiles', style: { margin: '14px 0' } },
      el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Statuses'), el('div', { class: 'stack', style: { margin: '10px 0 8px' } }, counts.map(([k, v]) => el('span', { style: { width: (100 * v / sm.rows) + '%', background: colors[k] || 'var(--info)' }, title: `${k}: ${v}` }))),
        el('div', { class: 'legend' }, counts.map(([k, v]) => el('span', {}, el('i', { style: { background: colors[k] || 'var(--info)' } }), `${k.replace('_', ' ').toLowerCase()} ${v}`)))),
      tile('Status matches majority', `${sm.status_matches_majority} of ${sm.rows}`, pct(sm.status_matches_majority / sm.rows)),
      tile('Full plan matches majority', `${sm.plan_matches_majority} of ${sm.rows}`, pct(sm.plan_matches_majority / sm.rows))));
    const filtered = rows.filter((r) => S.outFilter === 'all' || (S.outFilter === 'status' ? !r.status_matches_majority : !r.plan_matches_majority));
    const per = 50, pages = Math.max(1, Math.ceil(filtered.length / per));
    S.outPage = Math.min(S.outPage, pages - 1);
    box.append(el('div', { class: 'toolbar' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter answers' }, [['all', 'All'], ['status', 'Status differs'], ['plan', 'Plan differs']].map(([id, l]) =>
        el('button', { 'aria-pressed': String(S.outFilter === id), onclick: () => { S.outFilter = id; S.outPage = 0; render(); } }, l))),
      el('span', { class: 'spacer' }), el('span', { class: 'small muted num' }, `${filtered.length} cases, page ${S.outPage + 1} of ${pages}`),
      el('button', { class: 'sm', disabled: S.outPage === 0, onclick: () => { S.outPage--; render(); } }, 'Previous'),
      el('button', { class: 'sm', disabled: S.outPage >= pages - 1, onclick: () => { S.outPage++; render(); } }, 'Next')));
    const tb = el('tbody', {});
    for (const r of filtered.slice(S.outPage * per, S.outPage * per + per)) {
      const steps = Array.isArray(r.steps) ? r.steps : [];
      tb.append(el('tr', {}, el('td', { class: 'mono' }, r.case_id),
        el('td', {}, el('span', { class: 'badge ' + (r.status === 'COMPLETE' ? 'ok' : r.status === 'INCOMPLETE' ? 'warn' : '') }, r.status)),
        el('td', {}, r.status_matches_majority ? el('span', { class: 'muted small' }, 'Same') : el('span', { class: 'small' }, 'Majority says ', el('b', {}, r.majority_status))),
        el('td', {}, r.plan_matches_majority ? el('span', { class: 'muted small' }, 'Same') : el('span', { class: 'badge warn' }, 'Different')),
        el('td', {}, steps.length ? el('details', {}, el('summary', { class: 'small' }, plural(r.steps_total || steps.length, 'step')),
          el('table', { style: { marginTop: '6px' } }, el('tbody', {}, steps.map((x) => el('tr', {}, ['step_no', 'phase', 'operation', 'system_id', 'resource_id', 'state', 'evidence_id'].map((k) => el('td', { class: 'tiny mono' }, x[k] ?? '')))))),
          r.steps_total > steps.length ? el('p', { class: 'tiny muted' }, `First ${steps.length} of ${r.steps_total} shown.`) : null) : el('span', { class: 'muted small' }, 'No steps'))));
    }
    box.append(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Case', 'Status', 'Status vs majority', 'Plan vs majority', 'Plan'].map((h) => el('th', {}, h)))), tb)));
    return box;
  }

  function renderMarkdown(md) {
    const box = el('div', {});
    const lines = md.split('\n');
    let i = 0;
    const inline = (t) => t.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((p) => p.startsWith('`') && p.endsWith('`') && p.length > 1 ? el('code', {}, p.slice(1, -1))
      : p.startsWith('**') && p.endsWith('**') && p.length > 4 ? el('b', {}, p.slice(2, -2)) : p);
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('```')) { const buf = []; i++; while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]); i++; box.append(el('pre', {}, buf.join('\n'))); continue; }
      const h = l.match(/^(#{1,3})\s+(.*)/);
      if (h) { box.append(el('h' + h[1].length, {}, inline(h[2]))); i++; continue; }
      if (/^\s*\d+[.)]\s+/.test(l)) { const ol = el('ol', {}); while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) ol.append(el('li', {}, inline(lines[i++].replace(/^\s*\d+[.)]\s+/, '')))); box.append(ol); continue; }
      if (/^\s*[-*]\s+/.test(l)) { const ul = el('ul', {}); while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) ul.append(el('li', {}, inline(lines[i++].replace(/^\s*[-*]\s+/, '')))); box.append(ul); continue; }
      if (/^\|/.test(l)) { const buf = []; while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]); box.append(mdTable(buf)); continue; }
      if (!l.trim()) { i++; continue; }
      const buf = []; while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*[-*]\s)/.test(lines[i])) buf.push(lines[i++]);
      box.append(el('p', {}, inline(buf.join(' '))));
    }
    return box;
  }
  // A cell that is a figure ("87%", "30/32", "1,204", "-0.5 s") is right-aligned in tabular digits.
  const isNumeric = (c) => /^[-+~]?[$£€]?\d[\d,.]*\s*(%|\/\s*\d+|[a-z]{1,3})?$/i.test(String(c).replace(/\*\*/g, '').trim());
  function mdTable(rows) {
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const body = rows.filter((r) => !/^\|\s*-/.test(r));
    const [head, ...rest] = body;
    const numCol = cells(head).map((_, i) => rest.length > 0 && rest.every((r) => { const v = cells(r)[i]; return v === undefined || v === '' || isNumeric(v); }));
    return el('div', { class: 'table-wrap', style: { margin: '8px 0 14px' } }, el('table', {}, el('thead', {}, el('tr', {}, cells(head).map((c, i) => el('th', { class: numCol[i] ? 'num' : null }, c)))),
      el('tbody', {}, rest.map((r) => el('tr', {}, cells(r).map((c) => el('td', { class: isNumeric(c) ? 'small num' : 'small' }, c)))))));
  }

  // ---------- WRAP UP ----------
  function renderWrap() {
    const P = S.progress, L = labelable();
    const pane = el('div', { class: 'pane', style: { maxWidth: '820px', margin: '0 auto', width: '100%' } });
    pane.append(el('div', { class: 'stephead-row' }, el('h1', {}, T.wrap), el('span', { class: 'spacer' }), S.schema.guide ? el('button', { class: 'ghost sm', onclick: () => openGuide('session') }, 'Labelling guide') : null), el('p', { class: 'muted', style: { margin: '4px 0 16px' } }, 'Grade the session as a whole and check the mistakes you marked. ' + T.intro));
    const item = (ok, title, sub, action) => el('li', {}, el('span', { class: 'sticon ' + (ok ? 'done' : 'todo'), 'aria-hidden': 'true' }),
      el('div', { class: 'grow' }, el('b', {}, title), el('div', { class: 'small muted' }, sub)), action || null);
    const todo = nextTodo();
    pane.append(el('section', { class: 'card' }, el('ul', { class: 'checklist' },
      item(P.steps[0] === P.steps[1], 'Part 1. Step labels', `${P.steps[0]} of ${P.steps[1]} steps answered`, todo ? el('a', { class: 'btn sm', href: stepHash(todo) }, 'Go to the next one') : null),
      item(P.prompts[0] === P.prompts[1], 'Part 2. Prompt labels', `${P.prompts[0]} of ${P.prompts[1]} prompts answered`),
      item(P.session[0] === 1, 'Part 3. Session grade', P.session[0] ? 'Done' : 'Fill in the form below'))));
    const sp = part('session');
    pane.append(el('section', { class: 'card' }, mistakesSummary()));
    pane.append(el('section', { class: 'card' }, el('h2', {}, sp.title), el('p', { class: 'small muted', style: { margin: '4px 0 14px' } }, sp.help), wrapPart('session')));
    const submitted = S.status === 'submitted';
    pane.append(el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, submitted ? T.doneTitle : T.todoTitle),
      el('p', { class: 'small muted', style: { marginTop: '4px' } }, submitted ? T.doneNote : S.complete ? T.readyNote : 'Finish the parts marked above first.')),
      el('span', { class: 'spacer' }),
      submitted ? el('span', { class: 'badge ok' }, T.doneTitle) : el('button', { class: 'primary', id: 'submitbtn', disabled: READONLY || !S.complete, onclick: submit }, T.button),
      submitted && KIT && !REVIEWER ? el('button', { id: 'reopenbtn', onclick: reopen }, 'Reopen') : null)));
    return pane;
  }
  function wrapPart(pid) {
    const box = el('div', {});
    const v = { ...(S.labels[key(pid, '')] || {}) };
    for (const f of part(pid).fields) {
      if (f.after_outcome) {
        if (!outcomeOpen()) {
          box.append(el('div', { class: 'note info' }, el('span', {}, 'The result of this build, and one last question, appear here once the rest of the session grade is done. Judging the work first keeps the result from swaying you.')));
          continue;
        }
        box.append(outcomeCard());
      }
      box.append(field(f, v, (x, opts = {}) => { v[f.id] = x; save(pid, '', { ...v }); if (!opts.quiet) { const fresh = wrapPart(pid); box.replaceWith(fresh); const t = opts.focus && fresh.querySelector(`[data-fid="${opts.focus}"]`); if (t) t.focus(); } }, `${pid}--${f.id}`));
    }
    return box;
  }
  // The result (answers against the batch, claims flagged, code kept) stays hidden until the session grade is in.
  function outcomeOpen() {
    if (READONLY) return true;
    const fields = part('session').fields.filter((f) => !f.after_outcome);
    return fieldsOk(fields, S.labels[key('session', '')]);
  }
  function outcomeCard() {
    const box = el('div', { class: 'card outcome' }, el('h3', {}, 'The result'), el('p', { class: 'muted small' }, 'Loading…'));
    data('output').then((out) => {
      const sm = (out || {}).summary || {}, c = S.build.checks || {};
      clear(box).append(el('h3', {}, 'The result'), el('ul', { class: 'cmdlist' },
        sm.rows ? el('li', {}, el('span', { class: 'dot' }), el('span', {}, `Answers: ${sm.status_matches_majority} of ${sm.rows} match most other builds on status, ${sm.plan_matches_majority} on the deletion plan`)) : null,
        c.agent_lines_added ? el('li', {}, el('span', { class: 'dot' }), el('span', {}, `${Math.round(100 * c.agent_lines_kept / c.agent_lines_added)}% of the code the agent added is in the final repo`)) : null),
        el('p', { class: 'small muted' }, 'Most other builds is a comparison with this batch, not the official answer key.'));
    }).catch(() => clear(box).append(el('h3', {}, 'The result'), el('p', { class: 'muted small' }, 'Could not load the result.')));
    return box;
  }
  // Every mistake marked on a step, plus the numbers the pipeline flagged, so nothing is missed before the session grade.
  function mistakesSummary() {
    const box = el('div', {}, el('h2', {}, 'Agent mistakes you marked'), el('p', { class: 'small muted', style: { margin: '4px 0 14px' } },
      'Mark mistakes on the step where they happen. They are listed here so you can check them before you grade the session.'));
    const marked = labelable().filter((s) => (S.labels[key('steps', s.id)] || {}).failure);
    box.append(marked.length ? el('ul', { class: 'cmdlist' }, marked.map((s) => {
      const v = S.labels[key('steps', s.id)] || {};
      return el('li', {}, el('span', { class: 'dot bad', 'aria-hidden': 'true' }),
        el('span', { class: 'cmdtext' }, el('a', { href: stepHash(s), class: 'small' }, `Step ${s.n}`),
          el('span', { class: 'small' }, (v.failure_types || []).join(', ') || el('span', { class: 'muted' }, 'Type not picked yet')),
          el('span', { class: 'small muted' }, [v.noticed, v.note].filter(Boolean).join('. '))));
    })) : el('p', { class: 'muted small' }, 'No mistakes marked on any step.'));
    return box;
  }
  async function submit() {
    if (!confirm(T.confirm)) return;
    const b = $('submitbtn'); b.disabled = true; b.textContent = T.busy;
    try { await api('/submit', { method: 'POST' }); location.reload(); }
    catch (e) { b.disabled = false; b.textContent = T.button; alert(e.message); }
  }
  async function reopen() {
    const b = $('reopenbtn'); b.disabled = true;
    try { await api('/reopen', { method: 'POST' }); location.reload(); }
    catch (e) { b.disabled = false; alert(e.message); }
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $('guide')) return;
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio'].includes(t.type))) return;
    if (e.key === '?') { e.preventDefault(); openGuide(); return; }
    const r = route();
    if (r.mode !== 'steps') return;
    const L = labelable(), idx = L.indexOf(r.step);
    if (e.key === 'j' || e.key === 'ArrowRight') { const n = L[idx + 1] || (idx < 0 ? L[0] : null); if (n) { e.preventDefault(); go(stepHash(n, r.tab)); } }
    else if (e.key === 'k' || e.key === 'ArrowLeft') { const p = L[idx - 1]; if (p) { e.preventDefault(); go(stepHash(p, r.tab)); } }
    else if (e.key === 'n') {
      const todo = L.find((x, i) => i > idx && stepState(x) !== 'done') || L.find((x) => stepState(x) !== 'done' && x !== r.step);
      if (todo) { e.preventDefault(); go(stepHash(todo, r.tab)); }
    }
    else if (r.step.labelable && !READONLY && (/^[1-8]$/.test(e.key) || e.key === 'c' || e.key === 'u')) {
      e.preventDefault();
      const set = (pid, fieldId, val) => { const v = { ...(S.labels[key(pid, r.step.id)] || {}) }; v[fieldId] = typeof val === 'function' ? val(v[fieldId]) : val; save(pid, r.step.id, v); };
      if (/^[1-4]$/.test(e.key)) set('steps', 'effect', part('steps').fields.find((x) => x.id === 'effect').options[+e.key - 1]);
      else if (/^[5-8]$/.test(e.key)) set('prompts', 'source', part('prompts').fields.find((x) => x.id === 'source').options[+e.key - 5]);
      else if (e.key === 'c') set('steps', 'human_corrected', (x) => !x);
      else if (e.key === 'u') set('steps', 'reverted', (x) => !x);
      const panel = document.querySelector('.labels');
      if (panel) panel.replaceWith(renderStepLabels(r.step));
    }
  });

  // ---------- time on task ----------
  // Counts only while the page is visible and the person did something in the last 90 seconds,
  // per step or screen. Reports about every 30 seconds; a failed report is added to the next one.
  function trackTime() {
    if (READONLY) return;
    const TICK = 5, IDLE_MS = 90000, CAP = 120;
    let lastInput = Date.now(), total = 0, by = {}, sending = false;
    const mark = () => { lastInput = Date.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll']) window.addEventListener(ev, mark, { passive: true, capture: true });
    setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE_MS || S.status === 'submitted' || total >= CAP) return;
      const r = route();
      const k = r.mode === 'steps' ? (r.step && r.step.labelable ? r.step.id : null) : r.mode;
      total += TICK;
      if (k) by[k] = (by[k] || 0) + TICK;
    }, TICK * 1000);
    async function flush(keepalive) {
      if (!total || sending) return;
      const body = { seconds: total, by };
      total = 0; by = {}; sending = true;
      try { await api('/time', { method: 'POST', body: JSON.stringify(body), keepalive }); }
      catch (e) {  // put it back for the next report
        total = Math.min(CAP, total + body.seconds);
        for (const [k, x] of Object.entries(body.by)) by[k] = Math.min(CAP, (by[k] || 0) + x);
      } finally { sending = false; }
    }
    setInterval(() => flush(false), 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  }

  // An answer saved under an option's old wording is shown (and saved again) as the new wording.
  function renamedToNew(pid, v) {
    const p = S.schema.parts.find((x) => x.id === pid);
    if (!p || !v || typeof v !== 'object') return v;
    const out = { ...v };
    for (const f of p.fields) {
      const ren = f.renamed || {};
      if (!Object.keys(ren).length || out[f.id] == null) continue;
      out[f.id] = Array.isArray(out[f.id]) ? out[f.id].map((x) => ren[x] || x) : (ren[out[f.id]] || out[f.id]);
    }
    return out;
  }

  // ---------- start ----------
  (async function init() {
    try {
      const [schema, build, steps, lab] = await Promise.all([
        fetch('/api/schema', { credentials: 'same-origin' }).then((r) => r.json()), data('build'), data('steps'), api('/labels')]);
      for (const st of steps) {
        const r = st.prompt && readableReply(st.prompt.text);
        if (r) { st.prompt.text = r; st.prompt.hint = 'choice'; }
      }
      const real = (m) => m.kind !== 'tests' || m.passed + m.failed > 0;
      build.readings = (build.readings || []).filter(real);
      for (const st of steps) if (st.summary) st.summary.metrics = (st.summary.metrics || []).filter(real);
      for (const st of steps) for (const a of st.actions) if (a.metrics) a.metrics = a.metrics.filter(real);
      Object.assign(S, { schema, build, steps, progress: lab.progress, complete: lab.complete, status: lab.status });
      for (const l of lab.labels) S.labels[key(l.part, l.target)] = renamedToNew(l.part, l.value);
      $('t-meta').replaceChildren(el('span', { class: 'badge' }, (build.trace_tools || []).join(' and ')));
      render();
      trackTime();
    } catch (e) { clear($('mode')).append(el('div', { class: 'pane' }, el('div', { class: 'note warn' }, 'Could not load this task: ' + e.message + '. ' + T.loadHelp))); }
  })();
})();
