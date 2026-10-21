import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import Score from "@/components/score/Score";
import type { ScoreDebug } from "@/components/score/ScoreCanvas";
import { createScoreAnim, stepScoreAnim } from "@/lib/score/animator";
import { HISTORY_STEP_S, ScoreHistory } from "@/lib/score/history";
import { toScoreParams } from "@/lib/score/params";
import { GRID_Y1, GRID_Z, LANES, LANE_H, LEFT_X, NOW_X, UNITS_PER_S, ScoreScene, sceneStats } from "@/lib/score/scene";
import { GlHost, hostStats } from "@/lib/gl/host";
import { AudioPipeline, createSyntheticSource, loadOfflineSource } from "@/lib/pipeline";
import type { AudioFeatureFrame } from "@/lib/pipeline/contract";
import type { FeatureSource } from "@/lib/pipeline/source";

// Preview harness for Score. It owns the pipeline so a browser script can drive the source, and exposes window.__score with
// read-only diagnostics (pixel sampling, synchronous GPU timing, frame timing, history statistics) plus:
//   - a scripted SYNTHETIC source (always labelled synthetic) with its own pausable playhead, for controlled tests,
//   - song(id): the application's offline-source route (loadOfflineSource, the call the source picker makes), and
//   - replay(): a deterministic pass over a recorded offline song with a fake clock and a fixed 1/60 s step.
// Query: ?source=demo (120 BPM synthetic demo), ?source=pattern (scripted kick/mid/high pattern), ?source=song:detty, ?decor=0.

const query = new URLSearchParams(location.search);
const decor = query.get("decor") !== "0";
const pipeline = new AudioPipeline();
const debugRef: { current: ScoreDebug | null } = { current: null };
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
  return <div className="mx-auto max-w-7xl px-4 py-4">{mounted && <Score pipeline={pipeline} debugRef={debugRef} decor={decor} />}</div>;
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
  clock: 0, last: -1,
};
const scripted: FeatureSource = {
  id: "score-script", kind: "synthetic", label: "Scripted input (synthetic)", canSeek: false, latencyMs: 0,
  sample(nowS) {
    const dt = ctl.last < 0 ? 0 : Math.min(0.1, Math.max(0, nowS - ctl.last));
    ctl.last = nowS;
    const prev = ctl.clock;
    if (ctl.playing) ctl.clock += dt;
    const t = ctl.clock;
    let { bass, mid, high, rms } = ctl;
    let beat = ctl.beatPending, hit = ctl.hitLevel * Math.exp(-Math.max(0, t - ctl.hitAt) / 0.15);
    ctl.beatPending = false;
    if (ctl.pattern && ctl.playing) {
      // 120 BPM kick, a slow 4 s mid swell, a fast high shimmer, an onset flag on each kick (and a second one on the "and" of 3).
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

/** Reads the drawing buffer (after one synchronous render): mean luminance and mean RGB in each lane row, the gaps between, and the corners. */
function measure(host: GlHost, scene: ScoreScene) {
  const r = host.three!;
  host.render(scene.scene, scene.camera);
  const gl = r.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cam = scene.camera;
  cam.updateMatrixWorld();
  // readPixels rows run bottom-up, so pixel y here is measured upward from the bottom edge.
  const toPx = (x: number, y: number, z: number) => { const p = new THREE.Vector3(x, y, z).project(cam); return { x: (p.x * 0.5 + 0.5) * w, y: (p.y * 0.5 + 0.5) * h }; };
  const rowRegion = (y0: number, y1: number, z: number, x0: number, x1: number) => {
    const a = toPx(x0, y0, z), b = toPx(x1, y1, z);
    let s = 0, n = 0, mx = 0, pk = 0, sr = 0, sg = 0, sb = 0;
    for (let y = Math.max(0, Math.floor(a.y)); y < Math.min(h, Math.ceil(b.y)); y++) for (let x = Math.max(0, Math.floor(a.x)); x < Math.min(w, Math.ceil(b.x)); x++) {
      const i = (y * w + x) * 4; const v = luma(px, i); s += v; n++; if (v > mx) mx = v; const c3 = (px[i] + px[i + 1] + px[i + 2]) / 765; if (c3 > pk) pk = c3; sr += px[i]; sg += px[i + 1]; sb += px[i + 2];
    }
    // The trace itself: pixels bright enough to be a signal line or fill, not a rule or plate. Its mean height and spread, in world units.
    let cn = 0, cs = 0, css = 0;
    const yMid = (a.y + b.y) / 2;
    const unit = Math.abs(toPx(0, 1, z).y - toPx(0, 0, z).y) || 1;
    for (let y = Math.max(0, Math.floor(a.y)); y < Math.min(h, Math.ceil(b.y)); y++) for (let x = Math.max(0, Math.floor(a.x)); x < Math.min(w, Math.ceil(b.x)); x++) {
      const i = (y * w + x) * 4;
      if ((px[i] + px[i + 1] + px[i + 2]) / 765 > 0.30) { const wy = (y - yMid) / unit; cn++; cs += wy; css += wy * wy; }
    }
    const cy = cn ? cs / cn : 0;
    return { mean: n ? s / n : NaN, max: mx, peak: pk, rgb: n ? [sr / n, sg / n, sb / n] : [0, 0, 0], trace: { n: cn, centre: cy, spread: cn ? Math.sqrt(Math.max(0, css / cn - cy * cy)) : 0 } };
  };
  // Lane rows over the visible window; the gaps are the bands between lane rows (grid only).
  // The live right-hand 2 s of each lane (the part a short scripted hold has fully written), not the whole 12 s window.
  const lane = (l: (typeof LANES)[number]) => rowRegion(l.y - LANE_H * 1.1, l.y + LANE_H * 1.1, l.z, NOW_X - 2.0 * UNITS_PER_S, NOW_X - 0.1);
  const lanes = { high: lane(LANES[0]), mid: lane(LANES[1]), bass: lane(LANES[2]) };
  let total = 0, lit = 0;
  for (let i = 0; i < px.length; i += 4) { const v = luma(px, i); total += v; if (v > 0.03) lit++; }
  const c = (x: number, y: number) => { let s = 0, n = 0; for (let yy = y; yy < Math.min(h, y + 8); yy++) for (let xx = x; xx < Math.min(w, x + 8); xx++) { s += luma(px, (yy * w + xx) * 4); n++; } return s / n; };
  return { w, h, px, frameMean: total / (px.length / 4), litFraction: lit / (px.length / 4), lanes, corners: [c(2, 2), c(w - 10, 2), c(2, h - 10), c(w - 10, h - 10)] };
}

function png(px: Uint8Array, w: number, h: number) {
  const flipped = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(flipped, w, h), 0, 0);
  return c.toDataURL("image/png").split(",")[1];
}

function sample() {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const { px: _px, ...m } = measure(d.host, d.scene);
  return { ...m, anim: { ...d.anim }, params: d.lastParams, stats: { ...d.history.stats }, count: d.history.count, markers: d.history.markerCount };
}

/**
 * The visual hierarchy, measured directly: the page is rendered with each layer ALONE (every other layer hidden) and the mean
 * luminance of the whole frame above the empty background is reported per layer. Layers: the three lanes, the onset markers,
 * the time grid, the lane rules (baselines and limits), the plates (decor), and the current-time boundary. Visibility is restored.
 */
function layerEnergy() {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const sc = d.scene;
  const groups: Record<string, THREE.Object3D[]> = { lanes: [...sc.lanes], markers: [sc.markerLines, sc.markerHeads], plates: [...sc.plates], grid: [], rules: [], boundary: [] };
  sc.scene.children.forEach((c) => {
    const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || sc.lanes.includes(c as THREE.Mesh) || c === sc.markerLines || c === sc.markerHeads || sc.plates.includes(c as THREE.Mesh)) return;
    if (g.getAttribute("aK")) groups.grid.push(c);
    else if (g.getAttribute("aCol")) groups.rules.push(c);
    else groups.boundary.push(c);
  });
  const all = sc.scene.children;
  const saved = all.map((c) => c.visible);
  const mean = () => measure(d.host, sc).frameMean;
  all.forEach((c) => (c.visible = false));
  const background = mean();
  const out: Record<string, number> = { background };
  for (const [name, objs] of Object.entries(groups)) {
    all.forEach((c) => (c.visible = false));
    objs.forEach((o) => (o.visible = true));
    out[name] = mean() - background;
  }
  all.forEach((c, i) => (c.visible = saved[i]));
  return out;
}

/**
 * Pixel-level timeline evidence, from the page's own drawing buffer (after one synchronous render):
 *  - diamonds: screen x of each onset-marker head (the small diamonds above the top lane),
 *  - attacks: screen x where the AMBER bass lane rises from nothing to filled (a kick's leading edge). Selected by colour
 *    (red high, blue low) so the near-white marker rule cannot be mistaken for the bass signal,
 *  - pxPerSecond: how far one second of history is on screen at the markers' depth.
 */
function columns() {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const { px, w, h } = measure(d.host, d.scene);
  const cam = d.scene.camera;
  cam.updateMatrixWorld();
  const P = (x: number, y: number, z: number) => { const p = new THREE.Vector3(x, y, z).project(cam); return { x: (p.x * 0.5 + 0.5) * w, y: (p.y * 0.5 + 0.5) * h }; };
  const k = (d.scene.distance - (GRID_Z + 0.05)) / d.scene.distance;
  const head = P(0, GRID_Y1, GRID_Z + 0.05);
  const pxPerSecond = Math.abs(P(NOW_X * k, 0, GRID_Z + 0.05).x - P((NOW_X - UNITS_PER_S) * k, 0, GRID_Z + 0.05).x);
  const prof = new Float32Array(w);
  for (let y = Math.max(0, Math.floor(head.y) - 5); y < Math.min(h, Math.ceil(head.y) + 5); y++) for (let x = 0; x < w; x++) { const v = luma(px, (y * w + x) * 4); if (v > prof[x]) prof[x] = v; }
  const diamonds: number[] = [];
  for (let x = 0; x < w;) { if (prof[x] > 0.12) { let x1 = x; while (x1 < w && prof[x1] > 0.12) x1++; if (x1 - x >= 3) diamonds.push((x + x1 - 1) / 2); x = x1; } else x++; }
  const bass = LANES[2];
  // The upper half of the bass lane (pixel rows measured from the bottom, so the larger y is the higher on screen).
  const yTop = P(0, bass.y + 0.2 * LANE_H, bass.z).y, yBot = P(0, bass.y + 0.9 * LANE_H, bass.z).y;
  const amber = new Float32Array(w);
  for (let y = Math.max(0, Math.floor(yTop)); y < Math.min(h, Math.ceil(yBot)); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (px[i] > 90 && px[i + 2] < 0.35 * px[i]) amber[x]++; }
  const rows = Math.max(1, yBot - yTop);
  const attacks: number[] = [];
  for (let x = 4; x < w - 1; x++) if (amber[x] / rows > 0.5 && amber[x - 1] / rows < 0.25 && amber[x - 2] / rows < 0.25 && amber[x - 3] / rows < 0.25) attacks.push(x);
  return { diamonds, attacks, pxPerSecond, w, h };
}

/** Advances only the displayed clock by dt seconds, renders synchronously, and returns the marker columns before and after. Restores the clock. */
function scrollTest(dt: number) {
  const d = debugRef.current;
  if (!d) return null;
  const before = columns();
  const saved = d.anim.now;
  d.anim.now = saved + dt;
  d.scene.update(d.history, d.anim, d.lastParams!);
  const after = columns();
  d.anim.now = saved;
  d.scene.update(d.history, d.anim, d.lastParams!);
  return { before, after, dt };
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

/** The live history, summarised: counts, spacing, ordering, and marker times. Read-only. */
function history() {
  const d = debugRef.current;
  if (!d) return null;
  const h = d.history;
  const t: number[] = [];
  for (let i = 0; i < h.count; i++) t.push(h.t[h.indexOf(i)]);
  const marks: number[] = [];
  for (let i = 0; i < h.markerCount; i++) marks.push(h.markT[h.markerIndexOf(i)]);
  let minDt = Infinity, maxDt = 0, ordered = true;
  for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; minDt = Math.min(minDt, dt); maxDt = Math.max(maxDt, dt); if (dt <= 0) ordered = false; }
  return { count: h.count, markerCount: h.markerCount, minDt, maxDt, ordered, first: t[0], last: t[t.length - 1], marks, stats: { ...h.stats }, edge: h.edgeTime, uploads: { ...d.scene.uploads } };
}

/**
 * Deterministic pass over a recorded offline song on its own canvas and renderer (not the page's), fake clock, fixed step.
 * The frames come from OfflineSource.sample(), the frames the application uses; history, animator and scene are the real ones.
 * Returns the history statistics, the frame times at which the source asserted beatDetected, the recorded marker times, and
 * optional PNG captures at the requested times.
 */
async function replay(songId: string, times: number[], o: { profile?: string; step?: number; width?: number; height?: number; images?: boolean; decor?: boolean } = {}) {
  const W = o.width ?? 1280, H = o.height ?? 720, STEP = o.step ?? 1 / 60;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;opacity:0;pointer-events:none`;
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  document.body.appendChild(box);
  const host = new GlHost({ canvas, maxPixelRatio: 1 });
  host.three?.setClearColor(0x03040a, 1);
  let nowMs = 0;
  const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId, profileId: o.profile ?? "balanced", now: () => nowMs });
  const hist = new ScoreHistory();
  const anim = createScoreAnim();
  const scene = new ScoreScene({ decor: o.decor });
  scene.setViewport(W, H, 1);
  await src.play();
  const todo = [...times].sort((a, b) => a - b);
  const caps: Array<Record<string, unknown>> = [];
  const flagged: number[] = [];
  let prevBeat = false, steps = 0, lastT = -1, dupTimes = 0;
  const end = todo.length ? todo[todo.length - 1] : 0;
  while (steps < 60 * 400) {
    const fr = src.sample(nowMs / 1000);
    if (fr.beatDetected && !prevBeat && fr.isPlaying) flagged.push(fr.time);
    prevBeat = fr.beatDetected;
    if (fr.time === lastT) dupTimes++;
    lastT = fr.time;
    const p = toScoreParams(fr, host.reducedMotion);
    hist.push(fr);
    stepScoreAnim(anim, p, fr.time, STEP);
    while (todo.length && fr.time + 1e-9 >= todo[0]) {
      const t = todo.shift()!;
      scene.update(hist, anim, p);
      const { px, ...m } = measure(host, scene);
      caps.push({ requestedT: t, frameTime: fr.time, features: { bass: fr.bass, mid: fr.mid, high: fr.high, rms: fr.rmsEnergy, beat: fr.beatDetected }, metrics: m, anim: { ...anim }, count: hist.count, png: o.images ? png(px, m.w, m.h) : undefined });
    }
    nowMs += STEP * 1000;
    steps++;
    if (fr.time > end + 0.2 || !todo.length && fr.time > end) break;
  }
  const t: number[] = [];
  for (let i = 0; i < hist.count; i++) t.push(hist.t[hist.indexOf(i)]);
  const marks: number[] = [];
  for (let i = 0; i < hist.markerCount; i++) marks.push(hist.markT[hist.markerIndexOf(i)]);
  let minDt = Infinity, maxDt = 0, ordered = true;
  for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; minDt = Math.min(minDt, d); maxDt = Math.max(maxDt, d); if (d <= 0) ordered = false; }
  const out = { captures: caps, flagged, marks, stats: { ...hist.stats }, steps, dupTimes, spacing: { count: t.length, minDt, maxDt, ordered, first: t[0], last: t[t.length - 1] }, stepS: HISTORY_STEP_S, uploads: { ...scene.uploads } };
  scene.dispose();
  host.dispose();
  box.remove();
  src.dispose();
  return out;
}

(window as unknown as { __score: unknown }).__score = {
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
  /** Switches to the scripted SYNTHETIC source with the given constant levels (bass, mid, high, rms, scene, pattern, playing). */
  script: async (o: Partial<typeof ctl>) => {
    Object.assign(ctl, o);
    if (pipeline.source !== scripted) { ctl.clock = 0; ctl.last = -1; pipeline.setSource(scripted); }
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  pause: () => pipeline.pause(),
  resume: () => pipeline.play(),
  hit: (level = 1) => { ctl.hitLevel = level; ctl.hitAt = ctl.clock; },
  /** One detected onset: beatDetected is true for exactly one frame. */
  onset: (strength = 0.7) => { ctl.onsetStrength = strength; ctl.beatPending = true; },
  sample,
  layerEnergy,
  columns,
  scrollTest,
  history,
  gpuTime,
  replay,
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
const api = (window as unknown as { __score: { demo: () => Promise<unknown>; song: (id: string) => Promise<unknown>; script: (o: object) => Promise<unknown> } }).__score;
if (src === "demo") void api.demo();
else if (src === "pattern") void api.script({ pattern: true });
else if (src?.startsWith("song:")) void api.song(src.slice(5));
