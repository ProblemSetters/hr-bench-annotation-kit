"""Label schema: validation, completeness and consensus."""
import collections
import itertools
import json
import os
from functools import lru_cache

SCHEMA_PATH = os.environ.get('LABEL_SCHEMA', os.path.join(os.path.dirname(os.path.dirname(__file__)), 'label_schema.json'))
PARTS = ('session', 'steps', 'prompts', 'flags')


@lru_cache(maxsize=1)
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def part(pid):
    return next(p for p in schema()['parts'] if p['id'] == pid)


def _clean_field(f, v, step_ids=()):
    """Return a cleaned value or raise ValueError. None means unset."""
    if v is None or v == '' or v == [] or v == {}:
        return None
    t = f['type']
    if t == 'checklist':
        # {item_id: {"answer": "Yes" | "No", "step": step id or None}}
        if not isinstance(v, dict):
            raise ValueError(f'{f["id"]}: must be an object')
        out = {}
        for it in f['items']:
            x = v.get(it['id'])
            if not isinstance(x, dict):
                continue
            ans = x.get('answer') if x.get('answer') in ('Yes', 'No') else None
            step = str(x['step']) if x.get('step') else None
            if step and step not in step_ids:
                raise ValueError(f'{f["id"]}: unknown step')
            if ans or step:
                out[it['id']] = {'answer': ans, 'step': step if ans == 'Yes' else None}
        return out or None
    if t == 'scale':
        v = int(v)
        if not f['min'] <= v <= f['max']:
            raise ValueError(f'{f["id"]} out of range')
        return v
    if t == 'choice':
        if v not in f['options']:
            raise ValueError(f'{f["id"]}: unknown option')
        return v
    if t == 'multi':
        if not isinstance(v, list) or any(x not in f['options'] for x in v):
            raise ValueError(f'{f["id"]}: unknown option')
        return sorted(set(v), key=f['options'].index)
    if t == 'bool':
        return bool(v)
    if t in ('text', 'step_ref'):
        return str(v)[:5000]
    raise ValueError('unknown field type')


def clean_value(pid, value, step_ids):
    if not isinstance(value, dict):
        raise ValueError('value must be an object')
    if pid == 'flags':
        return {fl['id']: bool(value.get(fl['id'])) for fl in schema().get('flags', [])}
    p = part(pid)
    out = {f['id']: _clean_field(f, value.get(f['id']), step_ids) for f in p['fields']}
    for f in p['fields']:
        if not visible(f, out):
            out[f['id']] = None  # for example the mistake type once "the agent made a mistake" is unticked
    return out


def visible(f, v):
    """show_if: the question only applies when other answers have these values."""
    return all(v.get(k) == want for k, want in (f.get('show_if') or {}).items())


def required(f, v, checks=None):
    if not visible(f, v):
        return False
    if any(v.get(k) == want for k, want in (f.get('optional_if') or {}).items()):
        return False
    return bool(f.get('required') or any(v.get(k) == want for k, want in (f.get('required_if') or {}).items())
                or (f.get('required_if_check') and (checks or {}).get(f['required_if_check'])))


def _fields_ok(fields, v, checks=None):
    """checks: the step's automatic checks, for questions that only apply to some steps (show_if_check)."""
    for f in fields:
        x = v.get(f['id'])
        req = required(f, v, checks)
        if req and x in (None, '', []):
            return False
        if x and f.get('min_chars') and len(str(x).strip()) < f['min_chars']:
            return False
        if f['type'] == 'multi' and req and len(x or []) < f.get('min', 1):
            return False
        if f['type'] == 'checklist' and req and not checklist_done(f, x):
            return False
    return True


def checklist_done(f, v):
    """Every item answered, and every Yes points at a step."""
    v = v or {}
    return all((v.get(it['id']) or {}).get('answer') == 'No' or
               ((v.get(it['id']) or {}).get('answer') == 'Yes' and (v.get(it['id']) or {}).get('step')) for it in f['items'])


def progress(labels, labelable_ids, checks=None):
    """labels: {(part, target): value}; checks: {step id: automatic checks}. Returns per-part (done, total) and overall completeness."""
    checks = checks or {}
    out = {}
    s = labels.get(('session', ''))
    out['session'] = (1 if s and _fields_ok(part('session')['fields'], s) else 0, 1)
    for pid in ('steps', 'prompts'):
        fields = part(pid)['fields']
        done = sum(1 for sid in labelable_ids if labels.get((pid, sid)) and _fields_ok(fields, labels[(pid, sid)], checks.get(sid)))
        out[pid] = (done, len(labelable_ids))
    complete = all(d == t for d, t in out.values())
    return out, complete


def failures_of(labels):
    """Agent mistakes marked on steps, as one list for exports: step, types, whether the human noticed, note."""
    return [{'step': t, 'types': v.get('failure_types') or [], 'noticed': v.get('noticed'), 'note': v.get('note')}
            for (p, t), v in sorted(labels.items()) if p == 'steps' and (v or {}).get('failure')]


def _modal_share(vals):
    vals = [v for v in vals if v is not None]
    if len(vals) < 2:
        return None
    return collections.Counter(vals).most_common(1)[0][1] / len(vals)


def _jaccard(a, b):
    a, b = set(a or []), set(b or [])
    return 1.0 if not a and not b else len(a & b) / len(a | b)


def consensus(per_annotator, labelable_ids):
    """per_annotator: {name: {(part, target): value}} for submitted assignments only."""
    names = list(per_annotator)
    res = {'annotators': names, 'n': len(names)}
    if len(names) < 2:
        return res
    sess = {}
    for f in part('session')['fields']:
        vals = [per_annotator[n].get(('session', ''), {}).get(f['id']) for n in names]
        if f['type'] == 'scale':
            nums = [v for v in vals if v is not None]
            sess[f['id']] = {'values': vals, 'spread': (max(nums) - min(nums)) if nums else None}
        elif f['type'] == 'choice':
            sess[f['id']] = {'values': vals, 'agreement': _modal_share(vals)}
    res['session'] = sess
    res['behaviours'] = [{'id': it['id'], 'label': it['label'],
                          'values': [((per_annotator[n].get(('session', ''), {}).get(f['id']) or {}).get(it['id']) or {}).get('answer') for n in names]}
                         for f in part('session')['fields'] if f['type'] == 'checklist' for it in f['items']]
    for r in res['behaviours']:
        r['agreement'] = _modal_share(r['values'])
    res['summary_behaviour_agreement'] = (round(sum(r['agreement'] for r in res['behaviours'] if r['agreement'] is not None) /
                                           max(1, sum(1 for r in res['behaviours'] if r['agreement'] is not None)), 2)
                                          if res['behaviours'] else None)
    step_rows, eff_shares, intent_j, src_shares, react_shares = [], [], [], [], []
    for sid in labelable_ids:
        eff = [per_annotator[n].get(('steps', sid), {}).get('effect') for n in names]
        intents = [per_annotator[n].get(('prompts', sid), {}).get('intent') for n in names]
        src = [per_annotator[n].get(('prompts', sid), {}).get('source') for n in names]
        react = [per_annotator[n].get(('prompts', sid), {}).get('reaction') for n in names]
        es, ss, rs = _modal_share(eff), _modal_share(src), _modal_share(react)
        if rs is not None:
            react_shares.append(rs)
        jj = sum(_jaccard(a, b) for a, b in itertools.combinations(intents, 2)) / max(1, len(names) * (len(names) - 1) // 2)
        if es is not None:
            eff_shares.append(es)
        if ss is not None:
            src_shares.append(ss)
        intent_j.append(jj)
        step_rows.append({'step': sid, 'effect': eff, 'effect_agreement': es, 'intent_overlap': round(jj, 2), 'source': src})
    avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None
    res['steps'] = step_rows
    res['summary'] = {'step_effect_agreement': avg(eff_shares), 'steps_all_agree': sum(1 for x in eff_shares if x == 1.0),
                      'prompt_intent_overlap': avg(intent_j), 'prompt_source_agreement': avg(src_shares),
                      'prompt_reaction_agreement': avg(react_shares)}
    res['failures'] = {n: collections.Counter(t for (p, _), v in per_annotator[n].items() if p == 'steps' and (v or {}).get('failure')
                                              for t in (v.get('failure_types') or ['Not given']))
                       for n in names}
    res['missed'] = {n: sum(1 for (p, _), v in per_annotator[n].items() if p == 'steps' and (v or {}).get('failure')
                            and (v.get('noticed') or '').startswith('No'))
                     for n in names}
    fail = [[bool((per_annotator[n].get(('steps', sid)) or {}).get('failure')) for n in names] for sid in labelable_ids]
    res['summary']['mistake_agreement'] = avg([_modal_share(x) for x in fail if any(x)]) if any(any(x) for x in fail) else None
    pair = {}
    for a, b in itertools.combinations(names, 2):
        both = [(per_annotator[a].get(('steps', s), {}).get('effect'), per_annotator[b].get(('steps', s), {}).get('effect')) for s in labelable_ids]
        both = [x for x in both if None not in x]
        pair[f'{a} / {b}'] = round(sum(x == y for x, y in both) / len(both), 2) if both else None
    res['pairwise_effect_agreement'] = pair
    return res
