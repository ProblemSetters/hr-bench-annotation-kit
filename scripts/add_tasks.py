#!/usr/bin/env python3
"""Put the tasks we sent you into this kit's tasks folder.

    python3 scripts/add_tasks.py ~/Downloads/tasks_A100.zip

On Windows, type `python scripts\\add_tasks.py` instead. It also takes a folder, if your computer already unzipped
the file for you. It only adds or updates tasks: your answers in annotations/ are never touched, and the kit can
stay running while you do this. Reload My tasks in your browser afterwards.

A build that is already in tasks/ and has not changed is left as it is. A build that is there but differs is kept
as it is too, unless you add --replace (then the old copy is moved to tasks/.replaced/).
"""
import argparse
import datetime as dt
import filecmp
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS = os.path.join(KIT, 'tasks')
SAFE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')  # the same rule the kit uses for build folder names
NEEDED = ('build.json', 'steps.json')
MAX_BYTES = 4 * 1024 ** 3  # unzipped size limit, so a damaged or wrong file can't fill the disk
JUNK = ('__MACOSX/', '.DS_Store', 'Thumbs.db')


def fail(msg):
    sys.exit(f'\nNothing was changed. {msg}')


def tasks_part(name):
    """'tasks/b007/steps.json' or 'tasks_A100/tasks/b007/steps.json' -> 'b007/steps.json'. None if outside tasks/."""
    parts = name.replace('\\', '/').split('/')
    for i in (0, 1):
        if len(parts) > i + 1 and parts[i] == 'tasks':
            return '/'.join(parts[i + 1:])
    return None


def unzip(path, into):
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        fail(f'{path} is not a zip file we can open ({e}). Download it again.')
    with z:
        names = [i for i in z.infolist() if not any(j in i.filename for j in JUNK)]
        if sum(i.file_size for i in names) > MAX_BYTES:
            fail('The zip is far bigger than a tasks zip should be. Check that you picked the right file.')
        found = 0
        for info in names:
            rel = tasks_part(info.filename)
            if rel is None:
                continue
            if info.filename.startswith(('/', '\\')) or '..' in rel.split('/') or ':' in rel:
                fail(f'The zip has an unsafe path in it ({info.filename}). Please tell us; don\'t unzip it by hand.')
            if stat.S_ISLNK(info.external_attr >> 16):
                fail(f'The zip has a link in it ({info.filename}). Please tell us; don\'t unzip it by hand.')
            if info.is_dir() or not rel:
                continue
            out = os.path.join(into, *rel.split('/'))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(info) as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst)
            found += 1
    if not found:
        fail(f'{os.path.basename(path)} has no tasks folder inside. It should be the tasks zip we sent you (tasks_<your id>.zip).')


def copy_folder(path, into):
    """A zip that the computer already unzipped: the folder itself, or one that holds a tasks folder."""
    src = path if os.path.basename(os.path.normpath(path)) == 'tasks' else os.path.join(path, 'tasks')
    if not os.path.isdir(src):
        fail(f'There is no tasks folder in {path}. Pick the tasks zip we sent you, or the folder it unzipped to.')
    if os.path.abspath(src) == os.path.abspath(TASKS):
        fail('That is already the kit\'s own tasks folder.')
    shutil.copytree(src, into, dirs_exist_ok=True, symlinks=True,
                    ignore=shutil.ignore_patterns('__MACOSX', '.DS_Store', 'Thumbs.db', '.replaced'))
    for d, _, files in os.walk(into):
        for f in files:
            if os.path.islink(os.path.join(d, f)):
                fail(f'The folder has a link in it ({f}). Please tell us.')


def same(a, b):
    """Two build folders hold the same files with the same content."""
    cmp = filecmp.dircmp(a, b, ignore=['.DS_Store'])
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    if any(not filecmp.cmp(os.path.join(a, f), os.path.join(b, f), shallow=False) for f in cmp.common_files):
        return False
    return all(same(os.path.join(a, d), os.path.join(b, d)) for d in cmp.common_dirs)


def main():
    ap = argparse.ArgumentParser(description='Put the tasks zip we sent you into this kit\'s tasks folder.')
    ap.add_argument('source', help='the tasks zip (tasks_<your id>.zip), or the folder it unzipped to')
    ap.add_argument('--replace', action='store_true', help='replace builds that are already there but differ')
    a = ap.parse_args()
    src = os.path.abspath(os.path.expanduser(a.source))
    if not os.path.exists(src):
        fail(f'There is no file at {src}. Check the path; you can drag the file into the terminal to fill it in.')

    os.makedirs(TASKS, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='.incoming-', dir=TASKS)  # inside tasks/, so moving a build in is instant; the kit ignores dot folders
    try:
        (copy_folder if os.path.isdir(src) else unzip)(src, tmp)
        builds, bad = [], []
        for d in sorted(os.listdir(tmp)):
            full = os.path.join(tmp, d)
            if os.path.isdir(full):
                (builds if SAFE.match(d) and all(os.path.isfile(os.path.join(full, f)) for f in NEEDED) else bad).append(d)
        if not builds:
            fail('No builds were found inside. It should be the tasks zip we sent you (tasks_<your id>.zip).')

        added, kept, replaced, differ = [], [], [], []
        stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
        for b in builds:
            new, old = os.path.join(tmp, b), os.path.join(TASKS, b)
            if not os.path.exists(old):
                os.replace(new, old)
                added.append(b)
            elif same(new, old):
                kept.append(b)
            elif a.replace:
                keep = os.path.join(TASKS, '.replaced', f'{b}-{stamp}')
                os.makedirs(os.path.dirname(keep), exist_ok=True)
                os.replace(old, keep)
                os.replace(new, old)
                replaced.append(b)
            else:
                differ.append(b)
        for f in sorted(os.listdir(tmp)):  # the task brief and similar files next to the builds
            if os.path.isfile(os.path.join(tmp, f)):
                os.replace(os.path.join(tmp, f), os.path.join(TASKS, f))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f'\nTasks folder: {TASKS}')
    if added:
        print(f'  Added {len(added)}: {", ".join(added)}')
    if kept:
        print(f'  Already there, unchanged: {", ".join(kept)}')
    if replaced:
        print(f'  Replaced with the new version: {", ".join(replaced)} (old copies are in tasks/.replaced/)')
    if differ:
        print(f'  Already there but different, left as they were: {", ".join(differ)}')
        print('  If we asked you to update them, run this again with --replace. Your answers are kept either way.')
    if bad:
        print(f'  Skipped, not a complete build: {", ".join(bad)}')
    print(f'\nYou have {sum(1 for d in os.listdir(TASKS) if SAFE.match(d) and os.path.isdir(os.path.join(TASKS, d)))} tasks. '
          'Start the kit (or reload My tasks if it is already running).')


if __name__ == '__main__':
    main()
