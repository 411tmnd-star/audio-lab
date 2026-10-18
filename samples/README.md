# Sample outputs

Real output of the pipeline for three songs. The audio itself is not included.

| Folder | Contents |
|---|---|
| `seyi/` | `song_analysis.json`, `song_interpretation.json`, and `plots/` (overview, bars, bands, interpretation, motion states, motion timeline, visual comparison) |
| `detty/` | `song_analysis.json`, `song_interpretation.json` |
| `jeriq-airplane-mode/` | `song_analysis.json` |

- `song_analysis.json` (schema `schemas/song_analysis.v1.json`): tempo, diagnostics, per-frame feature curves, detected events and provenance.
- `song_interpretation.json` (schema `schemas/song_interpretation.v1.json`): the rule-based reading of the analysis, with its vocabulary, skipped rules, stated limitations and provenance.
- The motion timelines that drive the visuals are in `web_kit/public/motion/<song>/` (one per profile: balanced, bass_pulse, cinematic).

Regenerate with `audiolab analyze <file>` followed by `audiolab interpret`, `audiolab visual` and `audiolab motion`
(see `audiolab --help`).
