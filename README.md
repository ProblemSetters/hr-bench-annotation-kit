# HackerRank Bench annotate: labelling kit

This kit runs on your own computer. You label the builds we sent you, then send us one file with your answers.

A **build** is one participant's coding session: their prompts to an AI coding tool, everything the tool did, and the finished code. For each build you label every step, grade the session, and list the agent's mistakes. The app explains each question as you go (press **?** at any time).

## 1. Get ready

You need **one** of these:

- **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop/)), or
- **Python 3.10 or newer** ([download](https://www.python.org/downloads/)). Check with `python3 --version`.

Unzip this kit anywhere you like, for example in your Documents folder.

## 2. Add your tasks

We sent you a tasks zip file (`tasks_<your application id>.zip`). Open a terminal in the kit folder and run this, with the path to your zip:

```bash
python3 scripts/add_tasks.py ~/Downloads/tasks_A100.zip
```

On Windows, type `python scripts\add_tasks.py` instead. You can drag the zip into the terminal window to fill in its path. If your computer already unzipped it, give the folder instead.

With Docker only (no Python): copy the zip into the kit's `tasks` folder, then run:

```bash
docker compose run --rm kit python scripts/add_tasks.py tasks/tasks_A100.zip
```

The script checks the zip and puts every build in the right place. It never touches your answers, and the kit can stay running. If we send you more tasks later, run it again with the new zip. You can also unzip the file into the kit folder by hand. Either way you end up with:

```
hr-bench-annotation-kit/
  tasks/
    brief.md
    b007/
    b015/
  annotations/     your answers are saved here
  exports/         the file you send us goes here
```

## 3. Start the app

Open a terminal in the kit folder and run **one** of these.

With Docker:

```bash
docker compose up
```

With Python:

```bash
python3 start.py
```

On Windows, type `python start.py` instead.

Then open **http://localhost:8790** in your browser.

The first time, the app asks for your **application id** (the one you applied with), your first and last name and your email. After that it opens straight to your tasks.

## 4. Label

Open a task and work through it. Your answers save on their own, a moment after each click. The top bar says **All changes saved**.

When both parts of a build are done (every step labelled, and the session grade), go to **Wrap up & finish** and press **Mark as finished**. You can reopen a finished build if you need to change something.

## 5. Send your work

On **My tasks**, tick the pledge that you did the work yourself, without ChatGPT or other AI tools, then press **Export my work**. This makes `exports/submission_<your application id>.zip`. Send that file to us as requested.

You can export as often as you like. Each export replaces the previous file, so always send the newest one.

## Stopping and starting again

- **To stop:** press `Ctrl+C` in the terminal. With Docker, you can also run `docker compose down`.
- **To start again:** run the same command as before. You pick up exactly where you left off.
- **If your computer restarts or the app crashes, nothing is lost.** Every answer is written to the `annotations` folder as soon as it saves. If the app stops unexpectedly, it starts again on its own.
- **While the app is stopped:** the page shows **Not saved yet, retrying…** and saves by itself once the app is back. Don't close the tab while it shows this.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Port 8790 is already in use" | Something else is using that port. Close it, or start the kit with `python3 start.py --port 8791` and open http://localhost:8791. With Docker, run `KIT_PORT=8791 docker compose up` instead. |
| "The kit is already running" | It is open in another terminal window. Use that one, or stop it there first. |
| My tasks is empty | The tasks are not in place yet. Run `python3 scripts/add_tasks.py` with your zip (step 2), then reload. You should see build folders such as `tasks/b007/`. |
| "Python 3.10 or newer" | Install a newer Python, or use Docker. |
| Anything else | Run `python3 start.py check` and send us what it prints. With Docker, use `docker compose logs`. |

## Your data

- Everything stays on your computer until you send the export file. The app only opens on `localhost`, so other computers can't reach it.
- Don't share the tasks or your answers with anyone else.
- Your answers are plain JSON files in `annotations/<your application id>/`. Please don't edit them by hand.
