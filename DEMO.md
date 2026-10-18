# AudioLab upload demo

A local page that runs the four-stage pipeline (analyze, interpret, visual mapping, motion) on one uploaded
song and plays the result. It wraps the existing `audiolab` CLI and does not change it.

## Start

From the repository root, with the project virtualenv active:

    python scripts/demo_server.py            # http://localhost:8765
    python scripts/demo_server.py --port 8766

The server binds to 127.0.0.1 only. It needs numpy, librosa and soundfile, which the project already installs.

## Use

1. Open the page, then drop an audio file on it or click to choose one.
2. The file is checked first (see "Minimum audio"). If it is rejected, the page says why and nothing is created.
3. Watch the five stage chips (analyze, interpret, visual, motion, export) and the log. A 2-minute song takes
   about 80-90 s.
4. When it finishes the page scrolls to the player. Press play: the canvas follows the motion timeline, and the
   bar along its bottom shows the scene states (rest, build, active, settle) with a playhead.
5. Use the Profile menu to switch between `balanced`, `bass_pulse` and `cinematic`.
6. The gallery below shows each stage's plots (the `*_zoom` variants are generated but not shown).

7. Press **Open in Squall** under the player. It adds the finished song to the web_kit song list (about a minute:
   it computes the audio features), then opens Squall, the weather-map visual, playing that song at
   `/squall?source=song:<id>`. The demo server serves Squall itself, so no second server is needed. Squall needs
   its bundle built once: `cd web_kit && npm run build:preview`. The same export is available as
   `python scripts/demo_server.py --export-web <job>`.

Only one song is processed at a time; a second upload gets "Another song is still being processed" (HTTP 409).

## What the three bands do

The motion timeline (camera, main element, background, particles) drives the picture as before. The song's
bass, mid and high band energy are layered on top:

| Band | Visual response |
|---|---|
| Bass | The main circle's radius grows (the strongest effect). |
| Mid | A dashed inner ring rotates, opens up and brightens; the halos shift slightly in hue and lightness. |
| High | 64 shimmer ticks around the circle's edge lengthen and brighten, each flickering on its own phase; particles sparkle a little more. The drive is stretched over the 0.15-0.65 range real songs sit in, so the ticks stay visible on a normal mix. |

Tick the **Diagnostics** box under the player (off by default) to show three band meters on the canvas and a
menu that isolates one band (bass only, mid only, high only) so its effect can be seen alone.

## Minimum audio

Checked before the pipeline runs; a failing file gets HTTP 400 and a message on the page.

- Readable audio: decodable by soundfile or librosa (WAV, MP3, FLAC, OGG, M4A where the backend supports it).
- At least 3 seconds. Measured: 1 s and 2 s click tracks fail in the interpret and visual stages; 3 s and
  longer pass all four.
- Not silent.
- At least 4 detected onsets in the first 60 s. A steady tone has no rhythm and crashes the core beat
  analysis, so it is rejected.
- At most 300 MB.

The check does not pad, loop or invent beats. These limits come from measurements on synthetic signals and one
real song; real music near the limits may behave differently.

## Recent jobs and resume

Each job writes `job.json` into its folder. The page lists recent jobs (newest first, up to 20) with name,
time and status; click one to restore it. A completed job reopens its player and plots, a failed job shows its
saved error. While a job exists the URL carries `#job=<id>`, so reloading the page resumes it (the audio is
then served from the job folder). Jobs survive a server restart; one that was still running when the
server stopped shows as failed ("interrupted").

## Cleaning old jobs

    python scripts/demo_server.py --clean-old-jobs            # lists candidates, deletes nothing
    python scripts/demo_server.py --clean-old-jobs --yes      # deletes them
    python scripts/demo_server.py --clean-old-jobs --keep 10  # keep the newest 10 instead of 5

Only 8-hex-digit folders directly under `outputs/demo/` are considered. The newest `--keep` folders and any
job that is still running are skipped. It never runs automatically and does nothing else.

## Send a finished job to Squall / Constellation

    python scripts/demo_server.py --export-web <job-id> [--song-id my-song]
    node web_kit/preview/serve.mjs 5353       # then open http://localhost:5353/squall?source=song:<song-id>

This runs `scripts/export_web.py` into a temp folder and merges that one song into
`web_kit/public/motion/manifest.json`, leaving the songs already listed alone. The uploaded audio is copied to
`web_kit/public/motion/audio/` so the instrument plays it (audio extensions are git-ignored, so the file stays
local while the manifest entry is committed-looking; remove the entry before sharing). The job id is the
`#job=<id>` in the page URL. The Squall preview needs `web_kit/preview/dist/squall.js`; rebuild it with the
command in `web_kit/preview/README.txt` (on Windows keep the single quotes around `'"development"'`).

## Verified (2026-10-17, headless Edge over CDP, Detty test file, 113 s)

- Upload, stage tracking, completion, playback, seeking, profile switching and the plot gallery work through the
  real page with no console errors.
- Band wiring measured on rendered frames against a noise floor of 0 (all other controls zeroed): bass 36.5,
  mid 3.1, high 1.0 mean absolute pixel difference; choosing a different band in the isolation menu removes each
  band's effect. Mid and high together change the picture by 8.6, versus 36.5 for bass alone.
- Preflight: empty, 0.1 s, 1 s, corrupt, non-audio, silent and beat-less files each return 400 and create no job
  folder; a 3 s click track and the Detty file complete.
- Recent jobs, restoring completed and failed jobs, and refresh during processing resume.
- Failure paths: empty upload (400), second upload while busy (409), nonexistent job `viz.json` (404), unknown
  job status (404), path traversal (404).
- Exported the Jeriq test song (258 s) to `web_kit`; Squall at `/squall?source=song:jeriq-airplane-mode` loads its
  timeline, curves, features and audio, shows the weather map with a forecast strip, and the playhead advances.

## Known limitations

- The canvas is a simple Canvas 2D visualizer. It is not the Squall or Constellation instrument in `web_kit/`.
- The high-band shimmer is subtle on purpose and best seen with Diagnostics isolation.
- The preflight thresholds are measured, not proven. A file can pass them and still fail inside core analysis;
  it then fails with the generic message and `error.log`.
- The Squall preview shows "Detail reduced to keep the map smooth" in the headed test window, so its adaptive quality was active.
- Job folders under `outputs/demo/` are never deleted automatically; use the cleanup command.
- Browser support verified: Microsoft Edge (headless, Chromium). Not verified: Chrome, Firefox, Safari, touch or
  mobile layouts, headed (GPU) frame rate, and audible playback (the test browser has no audio output).

## Browser requirements

A current Chromium-based browser. It needs Canvas 2D, the `<audio>` element, `fetch`, and the ability to play
the uploaded file's format.

## Where artifacts are stored

    outputs/demo/<job>/<uploaded file>             the upload (removed if the job fails)
    outputs/demo/<job>/job.json                    name, time, status, log, error
    outputs/demo/<job>/out/<song>/                 analysis, interpretation, visual/, motion/, plots/, viz.json
    outputs/demo/<job>/error.log                   only for failed jobs

`outputs/demo/` is covered by the repository's ignore rules.
