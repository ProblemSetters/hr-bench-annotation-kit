"""Checks of the local kit: first-run details, saving, crash safety, export and the read-only review mode."""
import importlib
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STEPS = [
    {'id': 'S1.1', 'n': 1, 'session': 'S1', 'labelable': True, 'ts': 't', 'prompt': {'text': 'build it', 'hint': 'typed', 'chars': 8},
     'actions': [{'k': 'tool', 'tool': 'Bash', 'input': {'command': 'pytest'}, 'output': '3 passed'}], 'stats': {'tools': 1}},
    {'id': 'S1.2', 'n': 2, 'session': 'S1', 'labelable': True, 'ts': 't', 'prompt': {'text': 'go', 'hint': 'typed', 'chars': 2}, 'actions': [], 'stats': {}},
]
BEHAVIOURS = ['clarified_goal', 'set_mode', 'gave_examples', 'set_format', 'added_context', 'questioned_reasoning', 'asked_approach', 'checked_claims', 'refined']


def make_kit(app_id='A100'):
    root = tempfile.mkdtemp()
    for bid in ('b001', 'b002'):
        os.makedirs(f'{root}/tasks/{bid}')
        for name, obj in {'build': {'build_id': bid, 'trace_tools': ['Claude Code'], 'sessions': [{'id': 'S1', 'tool': 'Claude Code', 'kind': 'main'}],
                                    'scores': {'judge_total': 71}},
                          'steps': STEPS, 'code': [], 'output': {'summary': {}, 'rows': []}, 'context': {}}.items():
            json.dump(obj, open(f'{root}/tasks/{bid}/{name}.json', 'w'))
    open(f'{root}/tasks/brief.md', 'w').write('# The task\nDelete ghost data.')
    return root


def load_app(root, mode):
    os.environ.update(KIT_DIR=root, KIT_MODE=mode)
    import kitapp.server as server
    server = importlib.reload(server)
    return server, TestClient(server.app, base_url='http://localhost:8790', follow_redirects=False)


def token(c, path):
    m = re.search(r'name="csrf" value="([0-9a-f]+)"|data-csrf="([0-9a-f]+)"', c.get(path).text)
    return m.group(1) or m.group(2)


def details(app_id='A100', **kw):
    return {'application_id': app_id, 'first_name': 'Ada', 'last_name': 'Lovelace', 'email': 'ada@example.test', **kw}


def finish_all(c, bid, steering=4):
    h = {'X-CSRF-Token': token(c, f'/label/{bid}')}
    put = lambda p, t, v: c.put(f'/api/t/{bid}/labels', json={'part': p, 'target': t, 'value': v}, headers=h)
    check = {b: {'answer': 'No'} for b in BEHAVIOURS}
    check['clarified_goal'] = {'answer': 'Yes', 'step': 'S1.1'}
    assert put('session', '', {'steering_quality': steering, 'agent_quality': 3, 'behaviours': check, 'involvement': 'They shared the work equally',
                               'confidence': 'High', 'claims_match': 'Mostly',
                               'earned': 'Partly: some luck, shortcuts or gaming',
                               'rationale': 'The human gave a clear brief and checked each result before moving on to the next part.'}).status_code == 200
    for sid in ('S1.1', 'S1.2'):
        assert put('steps', sid, {'effect': 'Helped'}).status_code == 200
        r = put('prompts', sid, {'intent': ['Build a feature'], 'source': 'Typed by the human', 'reaction': 'Fixing something the agent got wrong'})
        assert r.status_code == 200
    assert r.json()['complete'] is True
    assert c.post(f'/api/t/{bid}/submit', headers=h).status_code == 200
    return h


def test_first_run_details_and_checks():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    assert c.get('/').headers['location'] == '/setup'
    assert c.get('/tasks').headers['location'] == '/setup'
    t = token(c, '/setup')
    assert c.post('/setup', data={**details(), 'csrf': 'nope'}).status_code == 403
    r = c.post('/setup', data={**details('bad id!'), 'csrf': t})
    assert r.status_code == 200 and 'letters, numbers' in r.text
    assert 'value="Ada"' in r.text and 'value="bad id!"' in r.text  # what was typed stays in the form
    r = c.post('/setup', data={**details(email='not-an-email'), 'csrf': t})
    assert 'valid email' in r.text
    r = c.post('/setup', data={**details(years_coding='2 to 5 years', ai_tools=['Codex', 'Cursor', 'Bogus']), 'csrf': t})
    assert r.status_code == 303
    meta = json.load(open(f'{root}/annotations/A100/annotator-metadata.json'))
    assert meta['first_name'] == 'Ada' and meta['ai_tools'] == ['Codex', 'Cursor'] and meta['entered_at']
    page = c.get('/tasks').text
    assert 'Ada Lovelace' in page and '>AL<' in page  # name and initials in the top bar
    assert c.get('/setup').headers['location'] == '/tasks'


def test_open_page_still_saves_after_a_restart():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    c.post('/setup', data={**details(), 'csrf': token(c, '/setup')})
    h = {'X-CSRF-Token': token(c, '/label/b001')}
    _, c2 = load_app(root, 'annotate')  # the app restarts; the open page keeps its old token
    assert c2.put('/api/t/b001/labels', json={'part': 'steps', 'target': 'S1.1', 'value': {'effect': 'Helped'}}, headers=h).status_code == 200
    assert 'kit-token' not in ''.join(zipfile.ZipFile(c2.post('/export', data={'csrf': h['X-CSRF-Token'], 'pledge': 'yes'}) and f'{root}/exports/submission_A100.zip').namelist())


def test_any_application_id_and_newest_details_win():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    assert c.post('/setup', data={**details('ZZ-77'), 'csrf': token(c, '/setup')}).status_code == 303  # no check against the tasks
    assert 'Ada Lovelace' in c.get('/tasks').text
    # someone unzips another person's folder into this kit: the details entered here still win
    os.makedirs(f'{root}/annotations/OLD1')
    json.dump({'first_name': 'Old', 'last_name': 'Person', 'email': 'o@example.test', 'updated_at': '2020-01-01T00:00:00+00:00'},
              open(f'{root}/annotations/OLD1/annotator-metadata.json', 'w'))
    assert 'Ada Lovelace' in c.get('/tasks').text


def test_only_local_hosts():
    root = make_kit()
    server, _ = load_app(root, 'annotate')
    evil = TestClient(server.app, base_url='http://attacker.example')
    assert evil.get('/healthz').status_code == 400


def test_label_save_finish_reopen_and_export():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    c.post('/setup', data={**details(), 'csrf': token(c, '/setup')})
    assert 'scores' not in c.get('/api/t/b001/data/build').json()  # judges' scores never reach the annotator
    h = finish_all(c, 'b001')
    rec = json.load(open(f'{root}/annotations/A100/b001.json'))
    assert rec['status'] == 'finished' and rec['application_id'] == 'A100' and rec['task_fingerprint'].startswith('sha256:')
    assert rec['answers']['session']['behaviours']['clarified_goal'] == {'answer': 'Yes', 'step': 'S1.1'}
    put = lambda: c.put('/api/t/b001/labels', json={'part': 'steps', 'target': 'S1.1', 'value': {'effect': 'Hurt'}}, headers=h)
    assert put().status_code == 409  # finished tasks are locked
    assert c.post('/api/t/b001/reopen', headers=h).status_code == 200
    assert put().status_code == 200
    assert c.post('/api/t/b001/time', json={'seconds': 999, 'by': {'S1.1': 30, 'x': 5}}, headers=h).status_code == 200
    assert json.load(open(f'{root}/annotations/A100/b001.json'))['active_seconds'] == 120  # one report adds at most 2 minutes
    # the app id is locked once answers exist
    r = c.post('/me', data={**details('A200', first_name='Ada B.'), 'csrf': token(c, '/me')})
    assert r.status_code == 303 and json.load(open(f'{root}/annotations/A100/annotator-metadata.json'))['first_name'] == 'Ada B.'
    assert not os.path.exists(f'{root}/annotations/A200')
    r = c.post('/export', data={'csrf': token(c, '/tasks')})
    assert r.headers['location'] == '/tasks?pledge=missing' and not os.path.exists(f'{root}/exports/submission_A100.zip')  # no pledge, no export
    assert 'Tick the box above to export' in c.get('/tasks?pledge=missing').text
    assert c.post('/export', data={'csrf': token(c, '/tasks'), 'pledge': 'yes'}).headers['location'] == '/tasks?exported=1'
    z = zipfile.ZipFile(f'{root}/exports/submission_A100.zip')
    names = set(z.namelist())
    assert names == {'annotations/A100/annotator-metadata.json', 'annotations/A100/b001.json', 'annotations/A100/manifest.json'}
    man = json.loads(z.read('annotations/A100/manifest.json'))
    assert man['application_id'] == 'A100' and man['unfinished'] == ['b001', 'b002']
    assert 'did not use ChatGPT' in man['pledge']['text'] and man['pledge']['agreed_at']
    assert c.get('/exports/submission_A100.zip').status_code == 200
    assert c.get('/exports/submission_OTHER.zip').status_code == 404
    assert c.post('/api/t/b002/time', json={'seconds': 30}, headers=h).status_code == 200
    assert 'Not started' in c.get('/tasks').text  # opening a task and reading it doesn't start it


def test_damaged_file_is_restored_from_backup():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    c.post('/setup', data={**details(), 'csrf': token(c, '/setup')})
    h = {'X-CSRF-Token': token(c, '/label/b001')}
    for eff in ('Helped', 'Neutral'):  # two saves, so a backup exists
        assert c.put('/api/t/b001/labels', json={'part': 'steps', 'target': 'S1.1', 'value': {'effect': eff}}, headers=h).status_code == 200
    path = f'{root}/annotations/A100/b001.json'
    open(path, 'w').write('{"half written')  # what a crash in the middle of a write would leave without atomic saves
    labels = c.get('/api/t/b001/labels').json()['labels']
    assert next(x for x in labels if x['part'] == 'steps' and x['target'] == 'S1.1')['value']['effect'] == 'Helped'  # the backup's answer
    assert any(f.startswith('b001.json.broken-') for f in os.listdir(os.path.dirname(path)))
    assert 'restored from its last good copy' in c.get('/tasks').text


def test_review_mode_is_read_only_and_compares():
    root = make_kit()
    _, c = load_app(root, 'annotate')
    c.post('/setup', data={**details(), 'csrf': token(c, '/setup')})
    finish_all(c, 'b001', steering=4)
    # a second annotator's submission, unzipped into the same kit folder
    other = make_kit('B200')
    b = json.load(open(f'{other}/tasks/b001/build.json'))
    b.pop('scores')  # an expert's copy has no judges' scores; the review copy (root) keeps them
    json.dump(b, open(f'{other}/tasks/b001/build.json', 'w'), indent=2)
    _, c2 = load_app(other, 'annotate')
    c2.post('/setup', data={**details('B200', first_name='Grace', last_name='Hopper', email='grace@example.test'), 'csrf': token(c2, '/setup')})
    finish_all(c2, 'b001', steering=2)
    shutil.copytree(f'{other}/annotations/B200', f'{root}/annotations/B200')
    open(f'{root}/tasks/calibration.txt', 'w').write('b001\n')

    _, r = load_app(root, 'review')
    home = r.get('/').text
    assert 'Ada Lovelace' in home and 'Grace Hopper' in home and 'ada@example.test' in home and 'B200' in home
    assert '+2.0' in home and '-2.0' in home  # calibration: Ada graded steering 4, Grace 2
    assert 'No export manifest in this folder' in home  # copied by hand, not exported: no pledge
    build = r.get('/review/b/b001').text
    assert 'Behaviour checklist agreement' in build and 'Grace Hopper (B200)' in build
    assert r.get('/api/r/A100/b001/data/build').json()['scores'] == {'judge_total': 71}  # reviewers see scores
    assert r.put('/api/t/b001/labels', json={'part': 'steps', 'target': 'S1.1', 'value': {'effect': 'Hurt'}}).status_code in (404, 405)
    assert r.post('/export').status_code in (404, 405)
    assert r.post('/setup').status_code in (404, 405)
    lines = [json.loads(x) for x in r.get('/review/export.jsonl').text.splitlines()]
    assert {x['annotator_id'] for x in lines} == {'A100', 'B200'} and 'example.test' not in json.dumps(lines)
    assert 'different version' not in home  # the review copy has the judges' scores, the experts' copies don't: same task
    # a file made on a different version of the task is flagged
    json.dump({**json.load(open(f'{root}/tasks/b001/context.json')), 'changed': True}, open(f'{root}/tasks/b001/context.json', 'w'))
    assert 'different version of this task' in r.get('/').text
