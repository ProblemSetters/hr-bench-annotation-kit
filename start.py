#!/usr/bin/env python3
"""Start the kit without Docker.

  python3 start.py            label your tasks (opens on http://localhost:8790)
  python3 start.py export     make exports/submission_<application id>.zip
  python3 start.py check      show what the kit can see
  python3 start.py review     read-only review of everyone's answers (for the HackerRank team)

Add --port 8791 if 8790 is taken. The first run sets up a private Python environment in .venv.
If the app stops unexpectedly it is started again; your answers are already saved.
"""
import hashlib
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(HERE, '.venv')
PY = os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')
REQ = os.path.join(HERE, 'requirements.txt')
STOP = 3  # the app exits with this when restarting would not help


def setup():
    if sys.version_info < (3, 10):
        sys.exit(f'This kit needs Python 3.10 or newer. You have {sys.version.split()[0]}. '
                 'Install a newer Python from python.org, or use Docker instead (see README.md).')
    want = hashlib.sha256(open(REQ, 'rb').read()).hexdigest()
    stamp = os.path.join(VENV, '.requirements-installed')
    if os.path.exists(PY) and os.path.exists(stamp) and open(stamp).read() == want:
        return
    print('Setting up the kit (first run only, about a minute)…', flush=True)
    if not os.path.exists(PY):
        subprocess.check_call([sys.executable, '-m', 'venv', VENV])
    subprocess.check_call([PY, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', REQ])
    with open(stamp, 'w') as f:
        f.write(want)


def stop_requested(signum, frame):
    raise KeyboardInterrupt


def main():
    # Ctrl+C, closing the terminal or a plain `kill` all stop the app cleanly, never leaving it running on its own.
    for sig in (signal.SIGINT, signal.SIGTERM) + ((signal.SIGHUP,) if hasattr(signal, 'SIGHUP') else ()):
        signal.signal(sig, stop_requested)
    setup()
    args = sys.argv[1:]
    cmd = [PY, '-m', 'kitapp', *args]
    if args[:1] in (['export'], ['check']):
        sys.exit(subprocess.call(cmd, cwd=HERE))
    starts = []
    while True:
        starts = [t for t in starts if time.time() - t < 600] + [time.time()]
        child = subprocess.Popen(cmd, cwd=HERE)
        try:
            code = child.wait()
        except KeyboardInterrupt:
            try:
                child.send_signal(signal.SIGINT)  # a terminal's Ctrl+C reaches both; a stop sent to this script alone does not
                child.wait(timeout=10)
            except (subprocess.TimeoutExpired, OSError):
                child.kill()
            print('\nStopped. Your answers are saved. Run the same command to start again.')
            return
        if code in (0, STOP, -2, -15):  # normal stop, "do not restart", Ctrl+C or a stop signal
            return
        if len(starts) >= 5:
            sys.exit('The kit stopped 5 times in 10 minutes. Your answers are saved. '
                     'Send the messages above to the HackerRank team.')
        print(f'\nThe kit stopped unexpectedly (code {code}). Starting it again in 2 seconds…', flush=True)
        time.sleep(2)


if __name__ == '__main__':
    main()
