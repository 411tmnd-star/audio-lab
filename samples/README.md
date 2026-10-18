# Sample outputs

Real pipeline output for one song, "Detty - Party scatter demo", which is the author's own track. The audio itself is not included.

| File | Contents |
|---|---|
| `detty/song_analysis.json` | Schema `schemas/song_analysis.v1.json`: tempo, diagnostics, per-frame feature curves, detected events and provenance |
| `detty/song_interpretation.json` | Schema `schemas/song_interpretation.v1.json`: the rule-based reading of the analysis, with its vocabulary, skipped rules, stated limitations and provenance |
| `detty/plots/` | Overview, bars, bands, interpretation, motion states, motion timeline and visual comparison |

- The motion timelines that drive the visuals are in `web_kit/public/motion/<song>/` (one per profile: balanced, bass_pulse, cinematic). `track-a` and `track-b` are two further pre-analysed songs, anonymised; only derived analysis data is stored, never audio.

Regenerate with `audiolab analyze <file>` followed by `audiolab interpret`, `audiolab visual` and `audiolab motion`
(see `audiolab --help`). The pipeline accepts any audio file.
