# AudioLab

AudioLab is an active research and development project for per-song audio
analysis, structured interpretation, and audio-driven visual experiences.

The project combines a Python analysis package with a browser-based
visualization workspace. Its implementation and verification status are
evolving; individual capabilities should be treated as complete only where
supported by code and test evidence.

## Project Areas

### Python analysis — `src/audiolab/`
- Audio input and analysis pipeline
- Feature extraction, beats, bars, novelty, and events
- Song analysis schemas and structured exports
- Interpretation rules and validation
- Motion timeline generation and review
- Visual mapping, signal processing, and calibration
- Command-line entry points

### Browser visualization — `web_kit/`
- Audio-reactive visual experiments and rendering
- Constellation and particle-based visualizations
- Motion Lab and instrument visualization work
- Squall visual experiments
- Research notes, design documentation, and test artifacts

### Supporting material
- `configs/` — analysis, interpretation, motion, and visual profiles
- `schemas/` — versioned JSON schemas
- `tests/` — Python tests
- `scripts/` — supporting utilities
- `AUDIO_LAB_UPGRADE_SPEC.md` — upgrade decisions, evidence labels,
  architecture, proposed milestones, risks, and open work

## Python Setup

Python 3.10 or later is required.

From the repository root:

    python -m venv .venv

On Windows PowerShell:

    .\.venv\Scripts\Activate.ps1
    python -m pip install --upgrade pip
    python -m pip install -e ".[dev]"

Run the Python test suite with:

    python -m pytest

Inspect the command-line options with:

    audiolab --help

These are setup and verification instructions; successful execution has not
been asserted by this README.

## Browser Workspace

The `web_kit/` directory contains its own browser-based implementation and
supporting artifacts. Consult `web_kit/package.json` and `web_kit/DESIGN.md`
for the available scripts and design-specific setup.

## Reproducibility and Evidence

Audio analysis and visualization can depend on input media, configuration,
runtime dependencies, and browser or rendering behavior. Record these
conditions when evaluating results. Proposed milestones and research notes
are not proof of completed implementation.

## Data and Media

Personal audio samples and other local media are not required to publish
the source code. Audio files are excluded by the repository ignore rules;
supply media you have permission to use when running local experiments.

## Status

Active development. This repository preserves the current project structure
and supporting research; it does not claim production readiness or
independent validation of every feature.
