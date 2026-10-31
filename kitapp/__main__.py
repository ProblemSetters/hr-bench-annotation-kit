"""python -m kitapp [annotate | review | export | check] [--port 8790] [--host 127.0.0.1] [--dir .]"""
import argparse
import os
import socket
import sys

LOCK_NAME = '.kit.lock'
STOP = 3  # exit code for "don't restart me": another copy is running, the port is busy, and so on


def stop(msg):
    print(msg, file=sys.stderr)
    sys.exit(STOP)


def hold_lock(folder):
    """One running kit per annotations folder. The lock is released by the system when the process ends,
    even after a crash, so a stale lock never blocks a restart."""
    os.makedirs(folder, exist_ok=True)
    f = open(os.path.join(folder, LOCK_NAME), 'a+')
    try:
        if os.name == 'nt':
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stop('The kit is already running on this folder in another window. Use that one, or stop it first.')
    return f  # keep the file open for as long as the kit runs


def port_free(host, port):
    with socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != 'nt':
            # Same setting the server uses, so a port left closing by a crash a second ago counts as free.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main():
    ap = argparse.ArgumentParser(prog='kitapp', description='HackerRank Bench annotate, local kit')
    ap.add_argument('command', nargs='?', default='annotate', choices=['annotate', 'review', 'export', 'check'])
    ap.add_argument('--port', type=int, default=int(os.environ.get('KIT_PORT', 8790)))
    ap.add_argument('--host', default=os.environ.get('KIT_HOST', '127.0.0.1'))
    ap.add_argument('--dir', default=os.environ.get('KIT_DIR', os.getcwd()))
    a = ap.parse_args()
    root = os.path.abspath(a.dir)
    os.environ['KIT_DIR'] = root
    os.environ['KIT_MODE'] = 'review' if a.command == 'review' else 'annotate'

    if a.command in ('export', 'check'):
        from .store import Store, StoreError
        st = Store(root)
        app_id = st.current_annotator()
        if a.command == 'check':
            ids = st.task_ids()
            print(f'Tasks found: {len(ids)}' + (f' ({", ".join(ids)})' if ids else '. Copy your tasks into the tasks folder.'))
            print('Your details: ' + (f'saved for application id {app_id}' if app_id else 'not filled in yet. Start the kit and fill in the form.'))
            return
        if not app_id:
            stop('Start the kit and fill in your details first.')
        from .store import PLEDGE
        print(PLEDGE)
        try:
            agreed = input('Type yes if this is true: ').strip().lower() == 'yes'
        except EOFError:
            agreed = False
        if not agreed:
            stop('Not exported. Export again and type yes to agree to the pledge.')
        # Safe while the kit is running: answer files are only ever replaced whole, never half-written.
        vfile = os.path.join(os.path.dirname(__file__), 'VERSION')
        try:
            out, man = st.export(app_id, open(vfile).read().strip() if os.path.exists(vfile) else 'dev', pledged=True)
        except StoreError as e:
            stop(str(e))
        print(f'Saved {out}')
        if man['unfinished']:
            print(f'Not finished yet: {", ".join(man["unfinished"])}. You can export again later.')
        return

    if not os.path.isdir(os.path.join(root, 'tasks')) or not any(
            os.path.isdir(os.path.join(root, 'tasks', d)) for d in os.listdir(os.path.join(root, 'tasks'))):
        print('Note: there are no tasks yet. Add them with: python3 scripts/add_tasks.py <your tasks zip>, then reload the page.')
    lock = hold_lock(os.path.join(root, 'annotations')) if a.command == 'annotate' else None
    if not port_free(a.host, a.port):
        stop(f'Port {a.port} is already in use. Close whatever is using it, or start the kit with --port {a.port + 1}.')
    shown = 'localhost' if a.host in ('127.0.0.1', '0.0.0.0', '::1') else a.host
    print(f'\nHackerRank Bench annotate is running{" in review mode (read only)" if a.command == "review" else ""}.')
    public = os.environ.get('KIT_PUBLIC_PORT') or a.port  # under Docker the app listens on 8790 inside; this is the port on the computer
    print(f'Open http://{shown}:{public} in your browser. Press Ctrl+C to stop.\n', flush=True)
    import uvicorn
    try:
        uvicorn.run('kitapp.server:app', host=a.host, port=a.port, log_level='warning', timeout_graceful_shutdown=5)
    finally:
        if lock:
            lock.close()


if __name__ == '__main__':
    main()
