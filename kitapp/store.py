"""Files on disk are the whole state of the kit.

tasks/
  brief.md                      the task the participants were given
  <build_id>/build.json ...     one cleaned build per folder
annotations/
  <application_id>/
    annotator-metadata.json     the annotator's details
    <build_id>.json             their answers for one build
exports/
  submission_<application_id>.zip

Every write goes to a temporary file first and then replaces the real file, so a crash or a power cut
never leaves a half-written answer file. The previous good copy is kept as <name>.bak and is used if
the main file is ever damaged.
"""
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import threading
import zipfile

from . import labels as L

SAFE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
FILES = ('build', 'steps', 'code', 'output', 'context')
META = 'annotator-metadata.json'
FORMAT = 'hr-bench-annotation/1'
PLEDGE = 'I labelled these builds myself. I did not use ChatGPT or any other AI tool to produce my answers.'
KEYED = ('steps', 'prompts', 'flags')  # parts answered once per step; session and failures are answered once per build


class StoreError(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def safe_id(x):
    return bool(x) and bool(SAFE.match(x))


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json(path, obj):
    """Atomic replace with a backup of the previous version."""
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    tmp = f'{path}.tmp-{os.getpid()}-{threading.get_ident()}'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(path):
        try:
            read_json(path)  # only back up a file that is itself readable
            shutil.copy2(path, path + '.bak')
        except (OSError, ValueError):
            pass
    os.replace(tmp, path)
    try:
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass  # not supported on every system (for example Windows)


def to_map(answers):
    """Answer-file shape to {(part, target): value}, the shape labels.py works with."""
    m = {}
    for p in ('session', 'failures'):
        if answers.get(p) is not None:
            m[(p, '')] = answers[p]
    for p in KEYED:
        for t, v in (answers.get(p) or {}).items():
            m[(p, t)] = v
    return m


def empty_answers():
    return {'session': None, 'steps': {}, 'prompts': {}, 'failures': None, 'flags': {}}


class Store:
    def __init__(self, root, readonly=False):
        self.root = os.path.abspath(root)
        self.tasks_dir = os.path.join(self.root, 'tasks')
        self.ann_dir = os.path.join(self.root, 'annotations')
        self.exports_dir = os.path.join(self.root, 'exports')
        self.readonly = readonly
        self.lock = threading.RLock()
        self.notices = []  # things the annotator should know, such as a file restored from its backup
        self._cache = {}

    # ---------- tasks ----------
    def task_ids(self):
        if not os.path.isdir(self.tasks_dir):
            return []
        out = []
        for d in sorted(os.listdir(self.tasks_dir)):
            full = os.path.join(self.tasks_dir, d)
            if safe_id(d) and os.path.isdir(full) and all(os.path.exists(os.path.join(full, f + '.json')) for f in ('build', 'steps')):
                out.append(d)
        return out

    def bundle(self, bid, name):
        if not safe_id(bid) or name not in FILES:
            raise StoreError('bad task path')
        path = os.path.join(self.tasks_dir, bid, name + '.json')
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            if name in ('code', 'output', 'context'):
                return [] if name == 'code' else {}
            raise StoreError(f'Task {bid} is missing {name}.json')
        key = (bid, name)
        hit = self._cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        try:
            obj = read_json(path)
        except ValueError:
            raise StoreError(f'Task {bid}: {name}.json is damaged. Copy the task folder again from the zip you were sent.')
        self._cache[key] = (mtime, obj)
        return obj

    def brief(self):
        for p in (os.path.join(self.tasks_dir, 'brief.md'), os.path.join(self.tasks_dir, 'task', 'brief.md')):
            if os.path.exists(p):
                with open(p, encoding='utf-8', errors='replace') as f:
                    return f.read()
        return ''

    def labelable_ids(self, bid):
        return [s['id'] for s in self.bundle(bid, 'steps') if s.get('labelable')]

    def step_checks(self, bid):
        return {s['id']: s.get('checks') or {} for s in self.bundle(bid, 'steps') if s.get('labelable')}

    def fingerprint(self, bid):
        """Fingerprint of a task's data, so answers can be matched to the exact version they were made on."""
        h = hashlib.sha256()
        for name in FILES:
            p = os.path.join(self.tasks_dir, bid, name + '.json')
            if not os.path.exists(p):
                continue
            h.update(name.encode() + b'\0')
            if name == 'build':
                # The reviewer's copy keeps the judges' scores and the experts' copies don't; that is the same task.
                b = {k: v for k, v in read_json(p).items() if k != 'scores'}
                h.update(json.dumps(b, sort_keys=True, ensure_ascii=False).encode())
                continue
            with open(p, 'rb') as f:
                for chunk in iter(lambda: f.read(1 << 20), b''):
                    h.update(chunk)
        return 'sha256:' + h.hexdigest()

    # ---------- annotator ----------
    def annotator_ids(self):
        if not os.path.isdir(self.ann_dir):
            return []
        return [d for d in sorted(os.listdir(self.ann_dir))
                if safe_id(d) and os.path.exists(os.path.join(self.ann_dir, d, META))]

    def meta(self, app_id):
        try:
            return read_json(os.path.join(self.ann_dir, app_id, META))
        except (OSError, ValueError):
            return None

    def current_annotator(self):
        """In annotate mode the kit belongs to one person: the details entered on this computer. If someone has
        unzipped a second person's folder here, the most recently updated details win."""
        ids = self.annotator_ids()
        if len(ids) <= 1:
            return ids[0] if ids else None
        return max(ids, key=lambda i: (self.meta(i) or {}).get('updated_at') or '')

    def has_answers(self, app_id):
        d = os.path.join(self.ann_dir, app_id)
        return os.path.isdir(d) and any(f.endswith('.json') and f not in (META, 'manifest.json') for f in os.listdir(d))

    def save_meta(self, app_id, data):
        self._writable()
        if not safe_id(app_id):
            raise StoreError('bad application id')
        with self.lock:
            old = self.meta(app_id) or {}
            rec = {**data, 'application_id': app_id, 'entered_at': old.get('entered_at') or now(), 'updated_at': now()}
            write_json(os.path.join(self.ann_dir, app_id, META), rec)
            return rec

    # ---------- answers ----------
    def _path(self, app_id, bid):
        if not safe_id(app_id) or not safe_id(bid):
            raise StoreError('bad path')
        return os.path.join(self.ann_dir, app_id, bid + '.json')

    def load(self, app_id, bid, repair=True):
        """Read an answer file. A damaged file is replaced by its backup (annotate mode only)."""
        path = self._path(app_id, bid)
        if not os.path.exists(path):
            return None
        try:
            return read_json(path)
        except (OSError, ValueError):
            bak = path + '.bak'
            try:
                good = read_json(bak)
            except (OSError, ValueError):
                raise StoreError(f'The answer file for {bid} is damaged and has no usable backup. Tell the HackerRank team.')
            if repair and not self.readonly:
                stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
                os.replace(path, f'{path}.broken-{stamp}')
                shutil.copy2(bak, path)
                self.notices.append(f'The answer file for {bid} was damaged. It was restored from its last good copy; '
                                    f'the damaged file was kept as {bid}.json.broken-{stamp}.')
            return good

    def answers_file(self, app_id, bid):
        rec = self.load(app_id, bid)
        if rec is None:
            rec = {'format': FORMAT, 'schema_version': L.schema()['version'], 'application_id': app_id, 'build_id': bid,
                   'task_fingerprint': self.fingerprint(bid), 'status': 'not_started', 'started_at': None, 'updated_at': None,
                   'finished_at': None, 'active_seconds': 0, 'active_seconds_by_step': {}, 'answers': empty_answers()}
        rec.setdefault('answers', empty_answers())
        return rec

    def put(self, app_id, bid, part, target, value):
        self._writable()
        with self.lock:
            rec = self.answers_file(app_id, bid)
            if rec['status'] == 'finished':
                raise StoreError('This task is marked as finished. Reopen it to change your answers.')
            a = rec['answers']
            if part in KEYED:
                a.setdefault(part, {})[target] = value
            else:
                a[part] = value
            t = now()
            rec['started_at'] = rec.get('started_at') or t
            rec['updated_at'] = t
            rec['status'] = 'in_progress'
            rec['schema_version'] = L.schema()['version']
            rec['task_fingerprint'] = self.fingerprint(bid)
            write_json(self._path(app_id, bid), rec)
            return rec

    def set_status(self, app_id, bid, status):
        self._writable()
        with self.lock:
            rec = self.answers_file(app_id, bid)
            rec['status'] = status
            rec['finished_at'] = now() if status == 'finished' else None
            rec['updated_at'] = now()
            write_json(self._path(app_id, bid), rec)
            return rec

    def add_time(self, app_id, bid, seconds, by):
        self._writable()
        with self.lock:
            rec = self.answers_file(app_id, bid)
            if rec['status'] == 'finished':
                return rec
            rec['active_seconds'] = int(rec.get('active_seconds') or 0) + seconds
            b = dict(rec.get('active_seconds_by_step') or {})
            for k, x in by.items():
                b[k] = int(b.get(k, 0)) + x
            rec['active_seconds_by_step'] = b
            if rec['status'] == 'not_started':
                rec['status'] = 'in_progress'
                rec['started_at'] = now()
            write_json(self._path(app_id, bid), rec)
            return rec

    def progress(self, app_id, bid):
        rec = self.load(app_id, bid, repair=False) or {}
        prog, complete = L.progress(to_map(rec.get('answers') or {}), self.labelable_ids(bid), self.step_checks(bid))
        done = sum(d for d, _ in prog.values())
        total = sum(t for _, t in prog.values()) or 1
        return {'prog': prog, 'complete': complete, 'pct': round(100 * done / total),
                'parts': sum(1 for d, t in prog.values() if d == t), 'status': rec.get('status', 'not_started'),
                'secs': int(rec.get('active_seconds') or 0), 'rec': rec}

    # ---------- export ----------
    def export(self, app_id, kit_version='', pledged=False):
        """Write exports/submission_<id>.zip: the annotator's details, every answer file and a manifest.
        The annotator must agree to the pledge first; the manifest records the wording and when they agreed."""
        self._writable()
        if not pledged:
            raise StoreError('Tick the pledge before you export.')
        with self.lock:
            folder = os.path.join(self.ann_dir, app_id)
            meta = self.meta(app_id)
            if not meta:
                raise StoreError('Fill in your details first.')
            tasks, files = [], {}
            for bid in self.task_ids():
                p = self.progress(app_id, bid)
                rec = p['rec']
                tasks.append({'build_id': bid, 'status': p['status'], 'complete': p['complete'],
                              'steps_answered': p['prog']['steps'][0], 'steps_total': p['prog']['steps'][1],
                              'active_seconds': p['secs'], 'task_fingerprint': self.fingerprint(bid),
                              'answers_made_on': rec.get('task_fingerprint')})
            names = [META] + sorted(f for f in os.listdir(folder) if f.endswith('.json') and f not in (META, 'manifest.json'))
            for n in names:
                with open(os.path.join(folder, n), 'rb') as f:
                    files[n] = 'sha256:' + hashlib.sha256(f.read()).hexdigest()
            manifest = {'format': FORMAT + '-submission', 'kit_version': kit_version, 'schema_version': L.schema()['version'],
                        'application_id': app_id, 'exported_at': now(), 'tasks': tasks,
                        'unfinished': [t['build_id'] for t in tasks if t['status'] != 'finished'], 'files': files,
                        'pledge': {'text': PLEDGE, 'agreed_at': now()}}
            os.makedirs(self.exports_dir, exist_ok=True)
            out = os.path.join(self.exports_dir, f'submission_{app_id}.zip')
            tmp = out + f'.tmp-{os.getpid()}'
            with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
                for n in names:
                    z.write(os.path.join(folder, n), f'annotations/{app_id}/{n}')
                z.writestr(f'annotations/{app_id}/manifest.json', json.dumps(manifest, indent=1, ensure_ascii=False))
            os.replace(tmp, out)
            return out, manifest

    def _writable(self):
        if self.readonly:
            raise StoreError('Review mode is read only.')
