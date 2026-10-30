"""HackerRank Bench annotate, local kit.

Annotate mode (default): one annotator labels the builds in tasks/ and their answers are saved under
annotations/<application_id>/. Review mode (KIT_MODE=review): reads every annotator's files and shows
progress, agreement and problems. Review mode has no routes that write.
"""
import datetime as dt
import json
import os
import re
import secrets
from types import SimpleNamespace
from urllib.parse import urlsplit

from fastapi import Body, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import labels as L
from . import review as R
from .store import FILES, Store, StoreError, safe_id

HERE = os.path.dirname(__file__)
KIT_DIR = os.environ.get('KIT_DIR', os.getcwd())
MODE = 'review' if os.environ.get('KIT_MODE', 'annotate') == 'review' else 'annotate'
REVIEW = MODE == 'review'
VERSION = open(os.path.join(HERE, 'VERSION')).read().strip() if os.path.exists(os.path.join(HERE, 'VERSION')) else 'dev'


def write_token():
    """Every write must carry this token. It is kept in the kit folder so a page left open across a restart
    or a crash can still save; other web pages can't read it, so they can't write."""
    if REVIEW:
        return secrets.token_hex(16)  # review mode has no writes
    path = os.path.join(KIT_DIR, 'annotations', '.kit-token')
    try:
        tok = open(path).read().strip()
        if re.fullmatch(r'[0-9a-f]{32}', tok):
            return tok
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tok = secrets.token_hex(16)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(tok)
    return tok


TOKEN = write_token()
LOCAL_HOSTS = {'localhost', '127.0.0.1', '[::1]', '::1'}
EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
YEARS = ['Less than 2 years', '2 to 5 years', '6 to 10 years', 'More than 10 years']
TOOLS = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Devin', 'Windsurf', 'Other']
MAX_TICK = 120

store = Store(KIT_DIR, readonly=REVIEW)
app = FastAPI(title='HackerRank Bench annotate', docs_url=None, redoc_url=None, openapi_url=None)
app.mount('/static', StaticFiles(directory=os.path.join(HERE, 'static')), name='static')
templates = Jinja2Templates(directory=os.path.join(HERE, 'templates'))
templates.env.globals.update(product='HackerRank Bench annotate', mode=MODE, version=VERSION,
                             v=lambda: str(int(max(os.path.getmtime(os.path.join(HERE, 'static', f)) for f in os.listdir(os.path.join(HERE, 'static'))))))
def when(iso):
    """'2026-10-30T14:45:32+00:00' as '30 Oct 2026 at 14:45 UTC'."""
    try:
        return dt.datetime.fromisoformat(iso).astimezone(dt.timezone.utc).strftime('%d %b %Y at %H:%M UTC')
    except (TypeError, ValueError):
        return iso or ''


templates.env.filters['when'] = when
templates.env.filters['ts'] = lambda t: dt.datetime.fromtimestamp(float(t)).strftime('%d %b at %H:%M')
templates.env.filters['dur'] = lambda s: '' if not s else f'{s // 3600}h {s % 3600 // 60:02d}m' if s >= 3600 else f'{max(1, s // 60)} min'
STATUS_WORD = {'not_started': 'Not started', 'in_progress': 'In progress', 'finished': 'Finished'}
STATUS_CLASS = {'not_started': '', 'in_progress': 'in_progress', 'finished': 'submitted'}
templates.env.globals.update(status_word=STATUS_WORD, status_class=STATUS_CLASS)


# ---------- safety: local only, and writes need this run's token ----------
@app.middleware('http')
async def guard(request: Request, call_next):
    if request.url.hostname not in LOCAL_HOSTS:
        # Blocks other web pages from reaching the kit through a look-alike address (DNS rebinding).
        return PlainTextResponse('Open the kit at http://localhost:8790', status_code=400)
    resp = await call_next(request)
    resp.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['Referrer-Policy'] = 'same-origin'
    resp.headers['X-Frame-Options'] = 'DENY'
    if not request.url.path.startswith('/static'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


def check_write(request: Request, form_token: str = ''):
    origin = request.headers.get('origin')
    if origin and urlsplit(origin).hostname not in LOCAL_HOSTS:
        raise HTTPException(403, 'Requests from other sites are not allowed.')
    sent = request.headers.get('x-csrf-token') or form_token or ''
    if not secrets.compare_digest(sent, TOKEN):
        raise HTTPException(403, 'This page is out of date. Reload it and try again.')


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    if request.url.path.startswith('/api'):
        return JSONResponse({'error': exc.detail}, status_code=exc.status_code)
    return templates.TemplateResponse(request, 'error.html', {'code': exc.status_code, 'message': exc.detail, 'user': viewer()}, status_code=exc.status_code)


@app.exception_handler(StoreError)
async def store_error(request: Request, exc: StoreError):
    if request.url.path.startswith('/api'):
        return JSONResponse({'error': str(exc)}, status_code=409)
    return templates.TemplateResponse(request, 'error.html', {'code': 409, 'message': str(exc), 'user': viewer()}, status_code=409)


class NeedSetup(Exception):
    pass


@app.exception_handler(NeedSetup)
async def need_setup(request: Request, exc: NeedSetup):
    if request.url.path.startswith('/api'):
        return JSONResponse({'error': 'Fill in your details first.'}, status_code=409)
    return RedirectResponse('/setup', 303)


def viewer():
    if REVIEW:
        return SimpleNamespace(name='Reviewer', first_name='R', last_name='', role='admin', app_id=None, email='')
    app_id = store.current_annotator()
    m = store.meta(app_id) if app_id else None
    if not m:
        return None
    return SimpleNamespace(name=f'{m["first_name"]} {m["last_name"]}', first_name=m['first_name'], last_name=m['last_name'],
                           role='annotator', app_id=app_id, email=m.get('email', ''))


def page(request, name, **ctx):
    return templates.TemplateResponse(request, name, {'user': viewer(), 'csrf': TOKEN, **ctx})


def task_info(bid):
    b = store.bundle(bid, 'build')
    return {'trace_tools': b.get('trace_tools') or [], 'steps': len(store.labelable_ids(bid))}


def need_task(bid):
    if not safe_id(bid) or bid not in store.task_ids():
        raise HTTPException(404, 'There is no such task in your tasks folder.')


@app.get('/healthz')
def healthz():
    return {'ok': True, 'mode': MODE, 'version': VERSION}


@app.get('/api/schema')
def api_schema():
    return L.schema()


@app.get('/api/brief')
def api_brief():
    return {'brief': store.brief()}


def labels_payload(rec, bid):
    lm = R.to_map(rec.get('answers') or {})
    prog, complete = L.progress(lm, store.labelable_ids(bid), store.step_checks(bid))
    status = {'finished': 'submitted', 'in_progress': 'in_progress'}.get(rec.get('status'), 'assigned')
    return {'status': status, 'labels': [{'part': p, 'target': t, 'value': v} for (p, t), v in lm.items()],
            'progress': prog, 'complete': complete}


def build_data(bid, name, keep_scores):
    if name not in FILES:
        raise HTTPException(404, 'Unknown file')
    out = store.bundle(bid, name)
    if name == 'build' and not keep_scores:
        out = {k: v for k, v in out.items() if k != 'scores'}  # judges' scores would anchor the session grade
    return out


if not REVIEW:
    # ---------- annotate mode ----------
    def me_or_setup():
        u = viewer()
        if not u:
            raise NeedSetup()
        return u

    def details_form(request, values=None, error='', editing=False):
        u = viewer()
        locked = bool(editing and u and store.has_answers(u.app_id))
        return page(request, 'setup.html', f=values or {}, error=error, years=YEARS, tools=TOOLS, editing=editing, locked=locked,
                    expected=bool(store.kit_info().get('application_id')))

    def read_details(application_id, first_name, last_name, email, years_coding, ai_tools):
        v = {'application_id': application_id.strip(), 'first_name': first_name.strip()[:100], 'last_name': last_name.strip()[:100],
             'email': email.strip().lower()[:320], 'years_coding': years_coding if years_coding in YEARS else None,
             'ai_tools': [t for t in TOOLS if t in ai_tools]}
        if not safe_id(v['application_id']):
            return v, 'Enter your application id. It uses letters, numbers, - and _ only.'
        want = store.kit_info().get('application_id')
        if want and v['application_id'] != want:
            return v, ('That application id does not match the one these tasks were made for. '
                       'Check the email we sent you, and make sure you unzipped your own tasks file.')
        if not v['first_name'] or not v['last_name']:
            return v, 'Enter your first and last name.'
        if not EMAIL.match(v['email']):
            return v, 'Enter a valid email address.'
        return v, ''

    @app.get('/', response_class=HTMLResponse)
    def home():
        return RedirectResponse('/tasks' if viewer() else '/setup', 303)

    @app.get('/setup', response_class=HTMLResponse)
    def setup(request: Request):
        if viewer():
            return RedirectResponse('/tasks', 303)
        return details_form(request)

    @app.post('/setup')
    async def setup_post(request: Request):
        form = await request.form()
        check_write(request, form.get('csrf', ''))
        if viewer():
            return RedirectResponse('/tasks', 303)
        v, err = read_details(form.get('application_id', ''), form.get('first_name', ''), form.get('last_name', ''),
                              form.get('email', ''), form.get('years_coding', ''), form.getlist('ai_tools'))
        if err:
            return details_form(request, v, err)
        store.save_meta(v.pop('application_id'), v)
        return RedirectResponse('/tasks', 303)

    @app.get('/me', response_class=HTMLResponse)
    def me_page(request: Request):
        u = me_or_setup()
        return details_form(request, {**(store.meta(u.app_id) or {}), 'application_id': u.app_id}, editing=True)

    @app.post('/me')
    async def me_post(request: Request):
        form = await request.form()
        check_write(request, form.get('csrf', ''))
        u = me_or_setup()
        locked = store.has_answers(u.app_id)
        app_id = u.app_id if locked else form.get('application_id', '')
        v, err = read_details(app_id, form.get('first_name', ''), form.get('last_name', ''),
                              form.get('email', ''), form.get('years_coding', ''), form.getlist('ai_tools'))
        if err:
            return details_form(request, v, err, editing=True)
        new_id = v.pop('application_id')
        store.save_meta(new_id, v)
        if new_id != u.app_id:  # nothing answered yet, so the old folder holds only the details file
            old = os.path.join(store.ann_dir, u.app_id)
            os.remove(os.path.join(old, 'annotator-metadata.json'))
            for f in os.listdir(old):
                if f.startswith('annotator-metadata.json'):
                    os.remove(os.path.join(old, f))
            if not os.listdir(old):
                os.rmdir(old)
        return RedirectResponse('/tasks?saved=1', 303)

    @app.get('/tasks', response_class=HTMLResponse)
    def tasks(request: Request, exported: int = 0, saved: int = 0):
        u = me_or_setup()
        rows, broken = [], []
        for bid in store.task_ids():
            try:
                rows.append({'bid': bid, 'info': task_info(bid), **store.progress(u.app_id, bid)})
            except StoreError as e:
                broken.append(str(e))
        order = {'in_progress': 0, 'not_started': 1, 'finished': 2}
        rows.sort(key=lambda r: (order.get(r['status'], 3), r['bid']))
        out = os.path.join(store.exports_dir, f'submission_{u.app_id}.zip')
        last = os.path.getmtime(out) if os.path.exists(out) else None
        notices, store.notices[:] = list(store.notices), []
        return page(request, 'tasks.html', rows=rows, broken=broken, notices=notices, exported=exported, saved=saved,
                    last_export=last, export_name=os.path.basename(out), kit=store.kit_info())

    @app.post('/export')
    async def export(request: Request):
        form = await request.form()
        check_write(request, form.get('csrf', ''))
        u = me_or_setup()
        store.export(u.app_id, VERSION)
        return RedirectResponse('/tasks?exported=1', 303)

    @app.get('/exports/{name}')
    def download(name: str):
        u = me_or_setup()
        if name != f'submission_{u.app_id}.zip':
            raise HTTPException(404, 'Not found')
        path = os.path.join(store.exports_dir, name)
        if not os.path.exists(path):
            raise HTTPException(404, 'Export your work first.')
        return FileResponse(path, media_type='application/zip', filename=name)

    @app.get('/label/{bid}', response_class=HTMLResponse)
    def label_page(request: Request, bid: str):
        u = me_or_setup()
        need_task(bid)
        rec = store.answers_file(u.app_id, bid)
        return page(request, 'label.html', kit=True, readonly=rec['status'] == 'finished', api=f'/api/t/{bid}', title=f'Build {bid}')

    @app.get('/api/t/{bid}/data/{name}')
    def api_data(bid: str, name: str):
        me_or_setup()
        need_task(bid)
        return build_data(bid, name, keep_scores=False)

    @app.get('/api/t/{bid}/labels')
    def api_labels(bid: str):
        u = me_or_setup()
        need_task(bid)
        return labels_payload(store.answers_file(u.app_id, bid), bid)

    @app.put('/api/t/{bid}/labels')
    def api_save(request: Request, bid: str, body: dict = Body(...)):
        check_write(request)
        u = me_or_setup()
        need_task(bid)
        pid, target = body.get('part'), str(body.get('target') or '')
        if pid not in L.PARTS:
            raise HTTPException(400, 'Unknown part')
        ids = set(store.labelable_ids(bid))
        if pid in ('steps', 'prompts', 'flags') and target not in ids:
            raise HTTPException(400, 'Unknown step')
        if pid == 'session':
            target = ''
        try:
            value = L.clean_value(pid, body.get('value') or {}, ids)
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e))
        rec = store.put(u.app_id, bid, pid, target, value)
        out = labels_payload(rec, bid)
        return {'ok': True, 'value': value, 'progress': out['progress'], 'complete': out['complete']}

    @app.post('/api/t/{bid}/submit')
    def api_finish(request: Request, bid: str):
        check_write(request)
        u = me_or_setup()
        need_task(bid)
        if not labels_payload(store.answers_file(u.app_id, bid), bid)['complete']:
            raise HTTPException(400, 'All four parts must be finished first.')
        store.set_status(u.app_id, bid, 'finished')
        return {'ok': True}

    @app.post('/api/t/{bid}/reopen')
    def api_reopen(request: Request, bid: str):
        check_write(request)
        u = me_or_setup()
        need_task(bid)
        store.set_status(u.app_id, bid, 'in_progress')
        return {'ok': True}

    @app.post('/api/t/{bid}/time')
    def api_time(request: Request, bid: str, body: dict = Body(...)):
        check_write(request)
        u = me_or_setup()
        need_task(bid)
        allowed = set(store.labelable_ids(bid)) | {'final', 'wrap'}
        try:
            add = max(0, min(MAX_TICK, int(body.get('seconds') or 0)))
            by = {str(k): max(0, min(MAX_TICK, int(x))) for k, x in (body.get('by') or {}).items() if str(k) in allowed}
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(400, 'Bad time report')
        if add:
            store.add_time(u.app_id, bid, add, by)
        return {'ok': True}

else:
    # ---------- review mode (read only) ----------
    def calibration_ids():
        ids = set()
        for p in (os.path.join(KIT_DIR, 'calibration.txt'), os.path.join(store.tasks_dir, 'calibration.txt')):
            if os.path.exists(p):
                with open(p, encoding='utf-8') as f:
                    ids |= {x.strip() for x in f if x.strip() and not x.startswith('#')}
        return sorted(i for i in ids if i in store.task_ids())

    def person(app_id):
        people, _ = R.scan(store)
        r = next((p for p in people if p['id'] == app_id), None)
        if not r:
            raise HTTPException(404, 'There is no annotator with that application id in annotations/.')
        return r, people

    @app.get('/', response_class=HTMLResponse)
    def overview(request: Request):
        people, problems = R.scan(store)
        builds = store.task_ids()
        calib = calibration_ids()
        by_build = {b: [(p, t) for p in people for t in p['tasks'] if t['bid'] == b] for b in builds}
        stats = {'people': len(people), 'builds': len(builds), 'tasks': sum(len(p['tasks']) for p in people),
                 'finished': sum(p['finished'] for p in people), 'problems': len(problems),
                 'covered': sum(1 for b in builds if sum(1 for _, t in by_build[b] if t['status'] == 'finished') >= 2)}
        return page(request, 'review_home.html', people=people, problems=problems, stats=stats, calib=calib,
                    calib_rows=R.calibration(store, people, calib))

    @app.get('/review/builds', response_class=HTMLResponse)
    def review_builds(request: Request):
        people, _ = R.scan(store)
        rows = []
        for b in store.task_ids():
            ts = [(p, t) for p in people for t in p['tasks'] if t['bid'] == b]
            rows.append({'bid': b, 'info': task_info(b), 'people': len(ts), 'finished': sum(1 for _, t in ts if t['status'] == 'finished')})
        return page(request, 'review_builds.html', rows=rows, calib=calibration_ids())

    @app.get('/review/a/{app_id}', response_class=HTMLResponse)
    def review_person(request: Request, app_id: str):
        r, _ = person(app_id)
        return page(request, 'review_person.html', p=r)

    @app.get('/review/b/{bid}', response_class=HTMLResponse)
    def review_build(request: Request, bid: str):
        need_task(bid)
        people, _ = R.scan(store)
        rows = [(p, t) for p in people for t in p['tasks'] if t['bid'] == bid]
        done = R.finished_maps(store, people, bid)
        ids = store.labelable_ids(bid)
        cons = L.consensus({n: m for n, (_, m) in done.items()}, ids)
        view_ids = [a for a, _ in done.values()]
        step_no = {sid: i + 1 for i, sid in enumerate(ids)}
        return page(request, 'review_build.html', bid=bid, info=task_info(bid), rows=rows, cons=cons, view_ids=view_ids,
                    step_no=step_no, calib=bid in calibration_ids())

    @app.get('/review/view/{app_id}/{bid}', response_class=HTMLResponse)
    def review_view(request: Request, app_id: str, bid: str):
        need_task(bid)
        r, _ = person(app_id)
        return page(request, 'label.html', kit=True, readonly=True, api=f'/api/r/{app_id}/{bid}',
                    title=f'Build {bid}, labelled by {r["name"]} ({app_id})')

    @app.get('/api/r/{app_id}/{bid}/data/{name}')
    def review_data(app_id: str, bid: str, name: str):
        need_task(bid)
        return build_data(bid, name, keep_scores=True)

    @app.get('/api/r/{app_id}/{bid}/labels')
    def review_labels(app_id: str, bid: str):
        need_task(bid)
        if not safe_id(app_id):
            raise HTTPException(404, 'Not found')
        rec = store.load(app_id, bid, repair=False) or {}
        return labels_payload(rec, bid)

    @app.get('/review/export.jsonl')
    def review_export(include_unfinished: bool = False):
        """One line per annotator and build. Annotators appear by application id, never by email."""
        people, _ = R.scan(store)
        calib = set(calibration_ids())

        def gen():
            for p in people:
                for t in p['tasks']:
                    if t['status'] != 'finished' and not include_unfinished:
                        continue
                    rec, a = t['rec'], t['rec'].get('answers') or {}
                    yield json.dumps({
                        'build_id': t['bid'], 'annotator_id': p['id'], 'status': t['status'],
                        'schema_version': rec.get('schema_version'), 'finished_at': rec.get('finished_at'),
                        'task_fingerprint': rec.get('task_fingerprint'), 'calibration_build': t['bid'] in calib,
                        'active_seconds': t['secs'], 'active_seconds_by_step': rec.get('active_seconds_by_step') or {},
                        'session': a.get('session'), 'failures': L.failures_of(R.to_map(a)), 'steps': a.get('steps') or {},
                        'prompts': a.get('prompts') or {}, 'flags': {k: v for k, v in (a.get('flags') or {}).items() if any(v.values())},
                    }, ensure_ascii=False) + '\n'
        return StreamingResponse(gen(), media_type='application/x-ndjson',
                                 headers={'Content-Disposition': 'attachment; filename="hr-bench-labels.jsonl"'})
