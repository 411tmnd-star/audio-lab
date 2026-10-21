import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import Terrain from "@/components/terrain/Terrain";
import type { TerrainDebug } from "@/components/terrain/TerrainCanvas";
import { createTerrainAnim, stepTerrainAnim } from "@/lib/terrain/animator";
import { COLS, HALF_WIDTH, ROWS, UNITS_PER_S, WINDOW_S, WAVE_SPEED, colX } from "@/lib/terrain/field";
import { STEP_S, TerrainHistory } from "@/lib/terrain/history";
import { toTerrainParams } from "@/lib/terrain/params";
import { TerrainScene, sceneStats } from "@/lib/terrain/scene";
import { GlHost, hostStats } from "@/lib/gl/host";
import { AudioPipeline, createSyntheticSource, loadOfflineSource } from "@/lib/pipeline";
import type { AudioFeatureFrame } from "@/lib/pipeline/contract";
import type { FeatureSource } from "@/lib/pipeline/source";

// Preview harness for Terrain with Memory. It owns the pipeline so a browser script can drive the source, and exposes
// window.__terrain with read-only diagnostics (pixel sampling, projection, synchronous GPU timing, frame timing, history
// statistics) plus:
//   - a scripted SYNTHETIC source (always labelled synthetic) with its own pausable playhead and a timed bass pulse,
//   - song(id): the application's offline-source route (loadOfflineSource, the call the source picker makes), and
//   - replay(): a deterministic pass over a recorded offline song with a fake clock and a fixed 1/60 s step.
// Query: ?source=demo (120 BPM synthetic demo), ?source=pattern (scripted pattern), ?source=song:detty, ?decor=0.

const query = new URLSearchParams(location.search);
const decor = query.get("decor") !== "0";
const pipeline = new AudioPipeline();
const debugRef: { current: TerrainDebug | null } = { current: null };
let markFrame = 0;
let setMountedFn: ((v: boolean) => void) | null = null;

function Harness() {
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    setMountedFn = setMounted;
    return () => {
      setMountedFn = null;
    };
  }, []);
  return <div className="mx-auto max-w-7xl px-4 py-4">{mounted && <Terrain pipeline={pipeline} debugRef={debugRef} decor={decor} />}</div>;
}

const stats = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], over33: s.filter((x) => x > 33.4).length / s.length };
};

/** A scripted SYNTHETIC input with its own playhead (advances only while `playing`), so pause and resume are real. */
const ctl = {
  bass: 0, mid: 0, high: 0, rms: 0, scene: "rest" as AudioFeatureFrame["currentSceneState"], hitLevel: 0, hitAt: -1e9,
  playing: true, pattern: false, beatPending: false, onsetStrength: 0.7,
  // A single event: `level` on `field` between playhead times `at` and `at + dur` (field: "bass" | "mid" | "high").
  pulse: null as null | { at: number; dur: number; level: number; field: "bass" | "mid" | "high" },
  clock: 0, last: -1,
};
const scripted: FeatureSource = {
  id: "terrain-script", kind: "synthetic", label: "Scripted input (synthetic)", canSeek: true, latencyMs: 0,
  sample(nowS) {
    const dt = ctl.last < 0 ? 0 : Math.min(0.1, Math.max(0, nowS - ctl.last));
    ctl.last = nowS;
    const prev = ctl.clock;
    if (ctl.playing) ctl.clock += dt;
    const t = ctl.clock;
    let { bass, mid, high, rms } = ctl;
    let beat = ctl.beatPending, hit = ctl.hitLevel * Math.exp(-Math.max(0, t - ctl.hitAt) / 0.15);
    ctl.beatPending = false;
    if (ctl.pulse && t >= ctl.pulse.at && t < ctl.pulse.at + ctl.pulse.dur) {
      if (ctl.pulse.field === "bass") bass = ctl.pulse.level;
      else if (ctl.pulse.field === "mid") mid = ctl.pulse.level;
      else high = ctl.pulse.level;
    }
    if (ctl.pattern && ctl.playing) {
      // 120 BPM kick, a slow 4 s mid swell, a fast high shimmer, an onset on each kick.
      const beatPos = t / 0.5;
      const ph = beatPos - Math.floor(beatPos);
      bass = 0.15 + 0.8 * Math.exp(-ph * 4);
      hit = Math.exp(-ph * 7);
      mid = 0.45 + 0.30 * Math.sin((2 * Math.PI * t) / 4) + 0.08 * Math.sin(2 * Math.PI * t * 1.5);
      high = 0.25 + 0.2 * Math.abs(Math.sin(2 * Math.PI * t * 3.1)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / 8));
      rms = 0.5;
      beat = Math.floor(t / 0.5) !== Math.floor(prev / 0.5);
    }
    return Object.freeze({ time: t, progress: 0, isPlaying: ctl.playing, bass: Math.min(1, bass + 0.5 * hit), mid, high, rmsEnergy: rms,
      onsetStrength: beat ? ctl.onsetStrength : 0, beatDetected: beat && ctl.playing, currentSceneState: ctl.scene, bassHit: hit });
  },
  play() { ctl.playing = true; return Promise.resolve(); },
  pause() { ctl.playing = false; },
  seek(t) { ctl.clock = t; },
  status: () => ({ playing: ctl.playing, duration: null, error: null }), onStatus: () => () => {}, dispose() {},
};

const luma = (px: Uint8Array, i: number) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

/** Projects a world point to drawing-buffer pixels, measured from the TOP (the way an image is read). */
function project(scene: TerrainScene, w: number, h: number, x: number, y: number, z: number) {
  scene.camera.updateMatrixWorld();
  const p = new THREE.Vector3(x, y, z).project(scene.camera);
  return { x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h };
}

/** Reads the drawing buffer after one synchronous render: luminance, colour-class fractions, silhouette, amber centroid. Top-down rows. */
function measure(host: GlHost, scene: TerrainScene) {
  const r = host.three!;
  host.render(scene.scene, scene.camera);
  const gl = r.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  // readPixels rows run bottom-up: flip once so everything below reads like an image.
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  let total = 0, lit = 0, n = 0, sr = 0, sg = 0, sb = 0, amber = 0, cyan = 0, violet = 0;
  const x0 = Math.floor(w * 0.25), x1 = Math.floor(w * 0.75);
  let top = -1, amberSum = 0, amberY = 0, amberPeakX = 0, amberPeakV = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const R = px[i], G = px[i + 1], B = px[i + 2];
    const v = luma(px, i);
    total += v;
    if (v > 0.03) lit++;
    if (v > 0.06) { n++; sr += R; sg += G; sb += B; }
    if (R > 110 && R > 1.25 * G && G > 0.25 * R && B < 0.45 * R) amber++;
    if (G > 110 && B > 110 && R < 0.35 * G) cyan++;
    if (B > 120 && R > 0.3 * B && G < 0.45 * B) violet++;
    if (x >= x0 && x < x1) {
      if (top < 0 && v > 0.06) top = y;
      const a = Math.max(0, R - B - 25) * (R > G ? 1 : 0);
      if (a > 0) { amberSum += a; amberY += a * y; if (a > amberPeakV) { amberPeakV = a; amberPeakX = x; } }
    }
  }
  const c = (x: number, y: number) => { let s = 0, k = 0; for (let yy = y; yy < Math.min(h, y + 8); yy++) for (let xx = x; xx < Math.min(w, x + 8); xx++) { s += luma(px, (yy * w + xx) * 4); k++; } return s / k; };
  return {
    w, h, px, frameMean: total / (w * h), litFraction: lit / (w * h), terrainRgb: n ? [sr / n, sg / n, sb / n] : [0, 0, 0], terrainPx: n,
    amberFrac: n ? amber / n : 0, cyanFrac: n ? cyan / n : 0, violetFrac: n ? violet / n : 0,
    topRow: top, amberCentreY: amberSum ? amberY / amberSum : -1, amberPeak: { x: amberPeakX, v: amberPeakV },
    corners: [c(2, 2), c(w - 10, 2), c(2, h - 10), c(w - 10, h - 10)],
  };
}

function png(px: Uint8Array, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), w, h), 0, 0);
  return c.toDataURL("image/png").split(",")[1];
}

function sample() {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const { px: _px, ...m } = measure(d.host, d.scene);
  return { ...m, anim: { ...d.anim }, params: d.lastParams, stats: { ...d.history.stats }, count: d.history.count };
}

/** Screen position (drawing-buffer pixels from the top) of a world point, with the page's own camera. */
function proj(x: number, y: number, z: number) {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const gl = d.host.three.getContext();
  return project(d.scene, gl.drawingBufferWidth, gl.drawingBufferHeight, x, y, z);
}

/**
 * Renders the page's scene with the displayed clock set to `now` (and restores it). With `waves: false` the travelling
 * shockwave is off. Returns the measurement and, optionally, the pixels' mean luminance per screen row for the central columns.
 */
function renderAt(now: number, o: { waves?: boolean; rows?: boolean } = {}) {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const saved = d.anim.now;
  d.anim.now = now;
  const p = { ...(d.lastParams ?? toTerrainParams(d.history.rowValid(0) ? ({ rmsEnergy: 0.5, isPlaying: true } as AudioFeatureFrame) : ({ rmsEnergy: 0, isPlaying: false } as AudioFeatureFrame), false)), reduced: o.waves === false };
  d.scene.update(d.history, d.anim, p);
  const m = measure(d.host, d.scene);
  const out: Record<string, unknown> = { ...m, px: undefined };
  if (o.rows) {
    const rows = new Float32Array(m.h);
    const x0 = Math.floor(m.w * 0.2), x1 = Math.floor(m.w * 0.8);
    for (let y = 0; y < m.h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += luma(m.px, (y * m.w + x) * 4); rows[y] = s / (x1 - x0); }
    out.rows = Array.from(rows);
  }
  d.anim.now = saved;
  d.scene.update(d.history, d.anim, d.lastParams!);
  return out;
}

/** The mean absolute difference between two renders at the same clock, shockwave on and off, per screen row: where the wave is. */
function waveRows(now: number) {
  const a = renderAt(now, { waves: true, rows: true }) as { rows: number[]; w: number; h: number } | null;
  const b = renderAt(now, { waves: false, rows: true }) as { rows: number[]; w: number; h: number } | null;
  if (!a || !b) return null;
  const diff = a.rows.map((v, i) => Math.abs(v - b.rows[i]));
  let s = 0, sy = 0;
  for (let y = 0; y < diff.length; y++) { s += diff[y]; sy += diff[y] * y; }
  return { energy: s, centreY: s ? sy / s : -1, h: a.h, w: a.w };
}

function gpuTime(n = 60) {
  const d = debugRef.current;
  const r = d?.host.three;
  if (!d || !r) return null;
  const gl = r.getContext();
  const one = new Uint8Array(4);
  const ts: number[] = [];
  for (let i = 0; i < n + 5; i++) {
    const t0 = performance.now();
    d.host.render(d.scene.scene, d.scene.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    if (i >= 5) ts.push(performance.now() - t0);
  }
  return { ...stats(ts), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], pixelRatio: d.host.pixelRatioInUse };
}

/** The live history, summarised: counts, spacing, ordering, per-part peaks, onset times. Read-only. */
function history() {
  const d = debugRef.current;
  if (!d) return null;
  const h = d.history;
  const t: number[] = [], voids: number[] = [], peakBass: number[] = [], peakMid: number[] = [], peakHigh: number[] = [], scar: number[] = [];
  for (let r = h.count - 1; r >= 0; r--) { // oldest first
    t.push(h.rowTime(r)); voids.push(h.rowIsVoid(r) ? 1 : 0); scar.push(h.rowShock(r));
    let pb = 0, pm = 0, ph = 0;
    for (let c = 0; c < COLS; c++) { pb = Math.max(pb, h.part(r, c, 0)); pm = Math.max(pm, Math.abs(h.part(r, c, 1))); ph = Math.max(ph, h.part(r, c, 2)); }
    peakBass.push(pb); peakMid.push(pm); peakHigh.push(ph);
  }
  const marks: number[] = [];
  for (let i = h.onsetCount - 1; i >= 0; i--) marks.push(h.onsetTime(i));
  let minDt = Infinity, maxDt = 0, ordered = true;
  for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; minDt = Math.min(minDt, dt); maxDt = Math.max(maxDt, dt); if (dt <= 0) ordered = false; }
  return { count: h.count, onsetCount: h.onsetCount, minDt, maxDt, ordered, t, voids, peakBass, peakMid, peakHigh, scar, marks, stats: { ...h.stats }, edge: h.edgeTime, uploads: d.scene.uploads };
}

/** The tallest bass ridge among rows recorded in [t0, t1]: its time, column, world x and total height. Read-only. */
function crest(t0: number, t1: number) {
  const d = debugRef.current;
  if (!d) return null;
  const h = d.history;
  let best: null | { t: number; col: number; x: number; y: number; row: number } = null;
  for (let r = 0; r < h.count; r++) {
    const t = h.rowTime(r);
    if (t < t0 || t > t1) continue;
    for (let c = 0; c < COLS; c++) {
      const y = h.height(r, c);
      if (!best || y > best.y) best = { t, col: c, x: colX(c) * HALF_WIDTH, y, row: r };
    }
  }
  return best;
}

/**
 * Deterministic pass over a recorded offline song on its own canvas and renderer (not the page's), fake clock, fixed step. The
 * frames come from OfflineSource.sample(), the frames the application uses; history, animator and scene are the real ones.
 * Returns statistics, the frame times at which the source asserted beatDetected, the recorded onset times, per-capture metrics
 * and optional PNG captures.
 */
async function replay(songId: string, times: number[], o: { profile?: string; step?: number; width?: number; height?: number; images?: boolean; decor?: boolean } = {}) {
  const W = o.width ?? 1280, H = o.height ?? 720, STEP = o.step ?? 1 / 60;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;opacity:0;pointer-events:none`;
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  document.body.appendChild(box);
  const host = new GlHost({ canvas, maxPixelRatio: 1 });
  host.three?.setClearColor(0x04060b, 1);
  let nowMs = 0;
  const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId, profileId: o.profile ?? "balanced", now: () => nowMs });
  const hist = new TerrainHistory();
  const anim = createTerrainAnim();
  const scene = new TerrainScene({ decor: o.decor });
  scene.setViewport(W, H, 1);
  await src.play();
  const todo = [...times].sort((a, b) => a - b);
  const caps: Array<Record<string, unknown>> = [];
  const flagged: number[] = [];
  let prevBeat = false, steps = 0;
  const end = todo.length ? todo[todo.length - 1] : 0;
  while (steps < 60 * 400) {
    const fr = src.sample(nowMs / 1000);
    if (fr.beatDetected && !prevBeat && fr.isPlaying) flagged.push(fr.time);
    prevBeat = fr.beatDetected;
    const p = toTerrainParams(fr, host.reducedMotion);
    hist.push(fr);
    stepTerrainAnim(anim, p, fr.time, STEP);
    while (todo.length && fr.time + 1e-9 >= todo[0]) {
      const t = todo.shift()!;
      scene.update(hist, anim, p);
      const { px, ...m } = measure(host, scene);
      caps.push({ requestedT: t, frameTime: fr.time, features: { bass: fr.bass, mid: fr.mid, high: fr.high, rms: fr.rmsEnergy, beat: fr.beatDetected }, metrics: m, anim: { ...anim }, count: hist.count, png: o.images ? png(px, m.w, m.h) : undefined });
    }
    nowMs += STEP * 1000;
    steps++;
    if (fr.time > end + 0.2 || (!todo.length && fr.time > end)) break;
  }
  const marks: number[] = [];
  for (let i = hist.onsetCount - 1; i >= 0; i--) marks.push(hist.onsetTime(i));
  const out = { captures: caps, flagged, marks, stats: { ...hist.stats }, steps, stepS: STEP_S, uploads: scene.uploads };
  scene.dispose();
  host.dispose();
  box.remove();
  src.dispose();
  return out;
}

(window as unknown as { __terrain: unknown }).__terrain = {
  pipeline,
  debug: () => debugRef.current,
  set: (v: boolean) => setMountedFn?.(v),
  demo: async () => {
    pipeline.setSource(createSyntheticSource(() => performance.now()));
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  /** The application's offline-source route. Detty has no shipped audio, so this plays its silent clock. */
  song: async (id: string, profileId?: string) => {
    const s = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId: id, profileId });
    pipeline.setSource(s);
    await pipeline.play();
    return { kind: pipeline.getState().source?.kind, label: pipeline.getState().source?.label, duration: s.status().duration };
  },
  silence: () => pipeline.setSource(null),
  /** Switches to the scripted SYNTHETIC source (constant levels, a 120 BPM pattern, a timed pulse, play/pause). */
  script: async (o: Partial<typeof ctl>) => {
    Object.assign(ctl, o);
    if (pipeline.source !== scripted) { ctl.clock = 0; ctl.last = -1; pipeline.setSource(scripted); }
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  /** Current playhead of the scripted source. */
  clock: () => ctl.clock,
  pause: () => pipeline.pause(),
  resume: () => pipeline.play(),
  seek: (t: number) => { ctl.clock = t; },
  hit: (level = 1) => { ctl.hitLevel = level; ctl.hitAt = ctl.clock; },
  /** One detected onset: beatDetected is true for exactly one frame. */
  onset: (strength = 0.7) => { ctl.onsetStrength = strength; ctl.beatPending = true; },
  sample,
  proj,
  crest,
  renderAt,
  waveRows,
  history,
  gpuTime,
  replay,
  consts: { COLS, ROWS, UNITS_PER_S, WINDOW_S, STEP_S, WAVE_SPEED },
  mark: () => { markFrame = debugRef.current?.frames ?? 0; return markFrame; },
  timing: () => {
    const d = debugRef.current;
    if (!d) return null;
    const ring = d.intervals.length;
    const n = Math.min(d.frames - markFrame, ring);
    const pick = (arr: Float64Array) => { const out: number[] = []; for (let k = d.frames - n; k < d.frames; k++) out.push(arr[k % ring]); return out; };
    return { frames: n, intervals: stats(pick(d.intervals)), cpu: stats(pick(d.cpu)) };
  },
  memory: () => {
    const r = debugRef.current?.host.three;
    return r ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? null, calls: r.info.render.calls, triangles: r.info.render.triangles } : null;
  },
  sceneStats,
  hostStats,
};

createRoot(document.getElementById("root")!).render(<Harness />);
const src = query.get("source");
const api = (window as unknown as { __terrain: { demo: () => Promise<unknown>; song: (id: string) => Promise<unknown>; script: (o: object) => Promise<unknown> } }).__terrain;
if (src === "demo") void api.demo();
else if (src === "pattern") void api.script({ pattern: true });
else if (src?.startsWith("song:")) void api.song(src.slice(5));
