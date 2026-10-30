# Review guide (HackerRank team only)

Review mode shows everyone's answers in one place. It is read only: the server has no routes that save, so nothing can be changed by mistake.

## Make the task zips

In `hr-bench-annotation` (not this kit):

1. Write `plan.csv` with two columns, `application_id` and `build_id`, one row per build an expert should label.
2. Run:

```bash
python3 -I pipeline/make_task_zips.py --bundles _bundles --private _private --plan plan.csv --calibration b003 --out dist
```

This makes one `tasks_<application id>.zip` per expert, plus `tasks_review.zip` for you.

- **Calibration builds** (`--calibration`, comma separated) go to everyone. They are not marked as calibration builds in the experts' copies.
- **The judges' scores** are removed from experts' copies and kept in yours.
- **Leak scan:** the script refuses to run unless the leak scan is clean.

Send each expert the kit and their own tasks zip.

## Review the answers

1. Use a separate copy of the kit for reviewing.
2. Unzip `tasks_review.zip` into it. This gives you `tasks/` with every build, plus `tasks/calibration.txt`.
3. Unzip every `submission_<application id>.zip` you receive into the same kit folder. Each one lands in `annotations/<application id>/`, so submissions never collide. A newer submission from the same person replaces the older one.
4. Start review mode with one of these:

```bash
python3 start.py review
```

```bash
KIT_MODE=review docker compose up
```

Then open http://localhost:8790.

## What you see

- **Overview:**
  - every annotator with their details (name, application id, email, coding experience, AI tools they use), tasks finished and active time;
  - a list of file problems;
  - the calibration table.
- **File problems** flag answer files that:
  - are damaged;
  - sit in the wrong folder;
  - are for a build that isn't in `tasks/`;
  - were made with an older label schema;
  - were made on a different version of a task, so step numbers may not line up;
  - contain answers that aren't valid.
- **Calibration:** for each person, how often their step answers match the others', and how much higher or lower their session grades are.
- **Builds:** every build, with who labelled it. Each build's page shows agreement between annotators and where they disagree, with links straight to each person's answers on that step.
- **Download finished labels (JSONL):** one line per annotator and build. Annotators appear by application id, never by email.

## Updating the kit

The kit is built from `hr-bench-annotation` so the two stay the same:

```bash
python3 kit/build_kit.py --out ../hr-bench-annotation-kit
```

The kit's own files are in `kit/src/`. The labelling screens, styles, label schema and label logic come from the hosted app. Change them there, rebuild, then commit and push the kit repo.

`kitapp/VERSION` records which commit a kit was built from. Every export's manifest carries it.
