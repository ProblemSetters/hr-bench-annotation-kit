"""Review mode: read every annotator's files, check them, and compare annotators. Never writes anything."""
import itertools
import os

from . import labels as L
from .store import META, StoreError, safe_id, to_map


def check_record(store, app_id, bid, rec):
    """Problems with one answer file, as short sentences."""
    out = []
    if bid not in store.task_ids():
        return [f'{bid}.json is for a build that is not in tasks/.']
    if rec.get('application_id') != app_id:
        out.append(f'{bid}.json says it belongs to {rec.get("application_id") or "nobody"}, but it is in the folder for {app_id}.')
    if rec.get('build_id') not in (None, bid):
        out.append(f'{bid}.json says it is for build {rec.get("build_id")}.')
    if rec.get('schema_version') != L.schema()['version']:
        out.append(f'{bid}.json was made with label schema {rec.get("schema_version")}, not {L.schema()["version"]}.')
    fp = rec.get('task_fingerprint')
    if fp and fp != store.fingerprint(bid):
        out.append(f'{bid}.json was made on a different version of this task. Step numbers may not line up.')
    ids = set(store.labelable_ids(bid))
    a = rec.get('answers') or {}
    for part in ('steps', 'prompts', 'flags'):
        unknown = [t for t in (a.get(part) or {}) if t not in ids]
        if unknown:
            out.append(f'{bid}.json has {part} answers for steps that are not in the task: {", ".join(unknown[:5])}.')
    for (part, target), v in to_map(a).items():
        try:
            L.clean_value(part, v, ids)
        except (ValueError, TypeError) as e:
            out.append(f'{bid}.json: an answer in {part}{" for " + target if target else ""} is not valid ({e}).')
            break
    return out


def scan(store):
    """Every annotator with their details, tasks and problems."""
    people, problems = [], []
    tasks = store.task_ids()
    for app_id in store.annotator_ids():
        meta = store.meta(app_id) or {}
        row = {'id': app_id, 'meta': meta, 'name': f'{meta.get("first_name", "")} {meta.get("last_name", "")}'.strip() or app_id,
               'tasks': [], 'problems': [], 'finished': 0, 'secs': 0}
        if meta.get('application_id') not in (None, app_id):
            row['problems'].append(f'{META} says {meta.get("application_id")}, but the folder is {app_id}.')
        folder = os.path.join(store.ann_dir, app_id)
        files = sorted(f[:-5] for f in os.listdir(folder) if f.endswith('.json') and f not in (META, 'manifest.json'))
        for bid in files:
            if not safe_id(bid):
                continue
            try:
                rec = store.load(app_id, bid, repair=False)
            except StoreError as e:
                row['problems'].append(str(e))
                continue
            if rec is None:
                continue
            row['problems'] += check_record(store, app_id, bid, rec)
            if bid not in tasks:
                continue
            p = store.progress(app_id, bid)
            row['tasks'].append({'bid': bid, **p})
            row['finished'] += p['status'] == 'finished'
            row['secs'] += p['secs']
        problems += [(app_id, row['name'], x) for x in row['problems']]
        people.append(row)
    return people, problems


def finished_maps(store, people, bid):
    """{display name: label map} for everyone who marked this build finished."""
    out = {}
    for r in people:
        t = next((t for t in r['tasks'] if t['bid'] == bid), None)
        if t and t['status'] == 'finished':
            out[f'{r["name"]} ({r["id"]})'] = (r['id'], to_map(t['rec'].get('answers') or {}))
    return out


def calibration(store, people, ids):
    """Per person, on calibration builds at least two people finished: step-effect agreement with each other person,
    and how much higher or lower their session grades are than the others' average."""
    acc = {}
    for bid in ids:
        done = finished_maps(store, people, bid)
        if len(done) < 2:
            continue
        steps = store.labelable_ids(bid)
        for name, (app_id, mine) in done.items():
            r = acc.setdefault(app_id, {'name': name, 'builds': 0, 'agree': [], 'steering': [], 'agent': []})
            r['builds'] += 1
            others = [m for n, (_, m) in done.items() if n != name]
            for other in others:
                pairs = [((mine.get(('steps', s)) or {}).get('effect'), (other.get(('steps', s)) or {}).get('effect')) for s in steps]
                pairs = [p for p in pairs if None not in p]
                if pairs:
                    r['agree'].append(sum(x == y for x, y in pairs) / len(pairs))
            for fid, slot in (('steering_quality', 'steering'), ('agent_quality', 'agent')):
                me = (mine.get(('session', '')) or {}).get(fid)
                vals = [x for x in ((o.get(('session', '')) or {}).get(fid) for o in others) if x is not None]
                if me is not None and vals:
                    r[slot].append(me - sum(vals) / len(vals))
    avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None
    return sorted(({'id': k, 'name': r['name'], 'builds': r['builds'], 'agree': avg(r['agree']),
                    'steering': avg(r['steering']), 'agent': avg(r['agent'])} for k, r in acc.items()), key=lambda x: x['name'])


def pair_names(names):
    return [f'{a} / {b}' for a, b in itertools.combinations(names, 2)]
