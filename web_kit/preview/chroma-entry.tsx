import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import Chroma from "@/components/chroma/Chroma";
import type { ChromaDebug } from "@/components/chroma/ChromaCanvas";
import { createChromaAnim, stepChromaAnim } from "@/lib/chroma/animator";
import { BURST_SPEED } from "@/lib/chroma/field";
import { toChromaParams } from "@/lib/chroma/params";
import { ChromaScene, sceneStats } from "@/lib/chroma/scene";
import { GlHost, hostStats } from "@/lib/gl/host";
import { AudioPipeline, createSyntheticSource, loadOfflineSource } from "@/lib/pipeline";
import type { AudioFeatureFrame } from "@/lib/pipeline/contract";
import type { FeatureSource } from "@/lib/pipeline/source";
import type { Quality } from "@/lib/chroma/field";

// Preview harness for Chroma Field. It owns the pipeline so a browser script can drive the source, and exposes window.__chroma with
// read-only diagnostics (pixel statistics, projection, synchronous GPU timing, frame timing) plus:
//   - a scripted SYNTHETIC source (always labelled synthetic) with its own pausable playhead,
//   - song(id): the application's offline-source route (loadOfflineSource, the call the source picker makes), and
//   - replay(): a deterministic pass over a recorded offline song with a fake clock and a fixed 1/60 s step.
// Query: ?source=demo (120 BPM synthetic demo), ?source=pattern (scripted pattern), ?source=song:detty, ?quality=lite.

const query = new URLSearchParams(location.search);
const quality: Quality = query.get("quality") === "lite" ? "lite" : "full";
const pipeline = new AudioPipeline();
const debugRef: { current: ChromaDebug | null } = { current: null };
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
  return <div className="mx-auto max-w-7xl px-4 py-4">{mounted && <Chroma pipeline={pipeline} debugRef={debugRef} quality={quality} />}</div>;
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
  playing: true, pattern: false, beatPending: false, onsetStrength: 0.7, clock: 0, last: -1,
};
const scripted: FeatureSource = {
  id: "chroma-script", kind: "synthetic", label: "Scripted input (synthetic)", canSeek: true, latencyMs: 0,
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

/** Hue (degrees) and saturation of an RGB byte triple. */
function hsv(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0 };
}

/** Reads the drawing buffer after one synchronous render (top-down rows): luminance, extent, spread, centre ratio, hue statistics. */
function measure(host: GlHost, scene: ChromaScene) {
  const r = host.three!;
  host.render(scene.scene, scene.camera);
  const gl = r.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  let total = 0, lit = 0, sx = 0, sy = 0, sl = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
  const cx = w / 2, cy = h / 2, cr = 0.12 * Math.min(w, h);
  let cSum = 0, cN = 0;
  const bins = { indigo: 0, teal: 0, magenta: 0, pink: 0, other: 0 };
  let nHue = 0, hs = 0, hc = 0, sat = 0;
  const hist = new Float64Array(36);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = luma(px, i);
    total += v;
    if ((x - cx) ** 2 + (y - cy) ** 2 < cr * cr) { cSum += v; cN++; }
    if (v > 0.02) lit++;
    if (v > 0.05) {
      sx += x * v; sy += y * v; sl += v;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (v > 0.08) {
      const { h: hue, s } = hsv(px[i], px[i + 1], px[i + 2]);
      nHue++; sat += s; if (s > 0.2) hist[Math.min(35, Math.floor(hue / 10))]++; hs += Math.sin((hue * Math.PI) / 180); hc += Math.cos((hue * Math.PI) / 180);
      if (s > 0.35) {
        if (hue >= 215 && hue < 275) bins.indigo++; else if (hue >= 165 && hue < 205) bins.teal++; else if (hue >= 285 && hue < 335) bins.magenta++; else if (hue >= 335 || hue < 12) bins.pink++; else bins.other++;
      } else bins.other++;
    }
  }
  const mxc = sl ? sx / sl : cx, myc = sl ? sy / sl : cy;
  let spread = 0;
  if (sl) for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const v = luma(px, (y * w + x) * 4); if (v > 0.05) spread += v * Math.hypot(x - mxc, y - myc); }
  const R = Math.sqrt(hs * hs + hc * hc) / Math.max(1, nHue);
  const frameMean = total / (w * h);
  return {
    w, h, px, frameMean, litFraction: lit / (w * h), centroid: [mxc / w, myc / h], bbox: sl ? [(x1 - x0) / w, (y1 - y0) / h] : [0, 0],
    spread: sl ? spread / (sl / 4) / Math.min(w, h) : 0, centreRatio: frameMean > 0 ? cSum / cN / frameMean : 0,
    hueEntropy: (() => { const n = hist.reduce((a, v) => a + v, 0); if (!n) return 0; let e = 0; for (const v of hist) if (v) e -= (v / n) * Math.log2(v / n); return e; })(),
    hueStd: nHue ? Math.sqrt(Math.max(0, -2 * Math.log(Math.max(R, 1e-9)))) * 180 / Math.PI : 0, meanSat: nHue ? sat / nHue : 0,
    hue: nHue ? { indigo: bins.indigo / nHue, teal: bins.teal / nHue, magenta: bins.magenta / nHue, pink: bins.pink / nHue, other: bins.other / nHue } : null, hueN: nHue,
    corners: [0, 1, 2, 3].map((k) => { const x = k % 2 ? w - 10 : 2, y = k < 2 ? 2 : h - 10; let s = 0, n = 0; for (let yy = y; yy < Math.min(h, y + 8); yy++) for (let xx = x; xx < Math.min(w, x + 8); xx++) { s += luma(px, (yy * w + xx) * 4); n++; } return s / n; }),
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
  return { ...m, anim: { ...d.anim, burstT: undefined, burstS: undefined, burstO: undefined }, params: d.lastParams };
}

/** Mean absolute luminance difference between two frames `gapMs` apart, and the second frame's statistics: how much the field moved. */
async function motion(gapMs: number) {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const a = measure(d.host, d.scene);
  await new Promise((r) => setTimeout(r, gapMs));
  const b = measure(d.host, d.scene);
  let s = 0, n = 0;
  for (let i = 0; i < a.px.length; i += 16) { s += Math.abs(luma(a.px, i) - luma(b.px, i)); n++; }
  const { px: _a, ...ma } = a; const { px: _b, ...mb } = b;
  return { diff: s / n, a: ma, b: mb };
}

/** Frame-to-frame twinkle: the mean over pixels of the luminance standard deviation across `n` frames taken `gapMs` apart. */
async function twinkle(n = 8, gapMs = 70) {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const frames: Float32Array[] = [];
  for (let k = 0; k < n; k++) {
    const m = measure(d.host, d.scene);
    const f = new Float32Array(m.px.length / 16);
    for (let i = 0, j = 0; i < m.px.length; i += 16, j++) f[j] = luma(m.px, i);
    frames.push(f);
    await new Promise((r) => setTimeout(r, gapMs));
  }
  let sd = 0, cnt = 0;
  for (let j = 0; j < frames[0].length; j++) {
    let mu = 0, mx = 0;
    for (const f of frames) { mu += f[j]; mx = Math.max(mx, f[j]); }
    if (mx < 0.03) continue;
    mu /= n;
    let v = 0;
    for (const f of frames) v += (f[j] - mu) ** 2;
    sd += Math.sqrt(v / n); cnt++;
  }
  return { twinkle: cnt ? sd / cnt : 0, litSamples: cnt };
}

/** Screen position (drawing-buffer pixels from the top) of a world point, with the page's current camera. */
function proj(x: number, y: number, z: number) {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const gl = d.host.three.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  d.scene.camera.updateMatrixWorld();
  const p = new THREE.Vector3(x, y, z).project(d.scene.camera);
  return { x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h };
}

/**
 * The newest recorded burst, rendered `ta` seconds after its onset with the shockwave ON and OFF at the same state (the visual clock
 * is set and restored): the difference image is the burst. Returns its energy and the energy-weighted mean distance, in pixels, of
 * the changed pixels from the burst's projected origin.
 */
function burstProbe(ta: number) {
  const d = debugRef.current;
  if (!d || !d.host.three || d.anim.bursts === 0) return null;
  const a = d.anim;
  const k = (a.burstHead - 1 + 8) % 8;
  const saved = a.clock;
  a.clock = a.burstT[k] + ta;
  const p = { ...(d.lastParams!), reduced: false };
  const u = d.scene.uniforms as Record<string, { value: number }>;
  d.scene.update(a, p);
  u.uBurstOn.value = 1;
  const on = measure(d.host, d.scene);
  const o = proj(a.burstO[k * 3], a.burstO[k * 3 + 1], a.burstO[k * 3 + 2])!;
  u.uBurstOn.value = 0;
  const off = measure(d.host, d.scene);
  u.uBurstOn.value = 1;
  let e = 0, ed = 0;
  for (let y = 0; y < on.h; y += 2) for (let x = 0; x < on.w; x += 2) {
    const i = (y * on.w + x) * 4;
    const df = Math.abs(luma(on.px, i) - luma(off.px, i));
    e += df; ed += df * Math.hypot(x - o.x, y - o.y);
  }
  a.clock = saved;
  d.scene.update(a, d.lastParams!);
  return { ta, energy: e, meanDist: e ? ed / e : 0, origin: o, strength: a.burstS[k], speed: BURST_SPEED };
}

type Patch = Partial<{ bass: number; mid: number; high: number; hit: number; exposure: number; shimmer: number; clock: number; flow: [number, number, number]; disp: number }>;

/**
 * Runs `fn` with the animator state patched (and the scene updated to it) in ONE synchronous task, then restores the state. Nothing
 * else can run in between, so the result is a pure function of the patch: no timing, no motion between renders.
 */
function withState<T>(patch: Patch, fn: () => T): T | null {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const a = d.anim;
  const saved = { bass: a.bass, mid: a.mid, high: a.high, hit: a.hit, exposure: a.exposure, shimmer: a.shimmer, clock: a.clock, flow: [...a.flow] as [number, number, number] };
  const { disp, ...state } = patch;
  Object.assign(a, state);
  if (patch.flow) a.flow = [...patch.flow];
  const p = { ...(d.lastParams!), reduced: false };
  d.scene.update(a, p);
  // `disp` overrides only the colour-dispersion uniform (normally the high envelope), after the update has written it.
  if (disp !== undefined) (d.scene.uniforms.uDisp as { value: number }).value = disp;
  try { return fn(); } finally { Object.assign(a, saved); a.flow = saved.flow; d.scene.update(a, d.lastParams!); }
}

/** Statistics of one render with the animator state patched. */
function stateStats(patch: Patch) {
  const d = debugRef.current;
  return withState(patch, () => { const { px: _p, ...m } = measure(d!.host, d!.scene); return m; });
}

/** Mean absolute luminance difference between two renders whose states differ by the given patches, plus both renders' statistics. */
function stateDiff(pa: Patch, pb: Patch) {
  const d = debugRef.current;
  const A = withState(pa, () => measure(d!.host, d!.scene));
  const B = withState(pb, () => measure(d!.host, d!.scene));
  if (!A || !B) return null;
  let s = 0, n = 0, c = 0;
  for (let i = 0; i < A.px.length; i += 8) { s += Math.abs(luma(A.px, i) - luma(B.px, i)); c += (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2])) / 765; n++; }
  const { px: _a, ...ma } = A; const { px: _b, ...mb } = B;
  return { diff: s / n, rgbDiff: c / n, a: ma, b: mb };
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

/**
 * Deterministic pass over a recorded offline song on its own canvas and renderer, fake clock, fixed step. Frames come from
 * OfflineSource.sample(); the animator and scene are the real ones. Returns the onset edges the source asserted, the onsets the
 * animator recorded, and per-capture statistics and optional PNGs.
 */
async function replay(songId: string, times: number[], o: { profile?: string; step?: number; width?: number; height?: number; images?: boolean } = {}) {
  const W = o.width ?? 1280, H = o.height ?? 720, STEP = o.step ?? 1 / 60;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;opacity:0;pointer-events:none`;
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  document.body.appendChild(box);
  const host = new GlHost({ canvas, maxPixelRatio: 1 });
  host.three?.setClearColor(0x02030a, 1);
  let nowMs = 0;
  const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId, profileId: o.profile ?? "balanced", now: () => nowMs });
  const anim = createChromaAnim();
  const scene = new ChromaScene({ quality });
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
    const p = toChromaParams(fr, host.reducedMotion);
    stepChromaAnim(anim, p, STEP);
    while (todo.length && fr.time + 1e-9 >= todo[0]) {
      const t = todo.shift()!;
      scene.update(anim, p);
      const { px, ...m } = measure(host, scene);
      caps.push({ requestedT: t, frameTime: fr.time, features: { bass: fr.bass, mid: fr.mid, high: fr.high, rms: fr.rmsEnergy }, metrics: m, env: { bass: anim.bass, mid: anim.mid, high: anim.high, exposure: anim.exposure }, png: o.images ? png(px, m.w, m.h) : undefined });
    }
    nowMs += STEP * 1000;
    steps++;
    if (fr.time > end + 0.2 || (!todo.length && fr.time > end)) break;
  }
  const out = { captures: caps, flagged, onsets: anim.onsets, steps, clock: anim.clock };
  scene.dispose();
  host.dispose();
  box.remove();
  src.dispose();
  return out;
}

(window as unknown as { __chroma: unknown }).__chroma = {
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
  /** Switches to the scripted SYNTHETIC source (constant levels, a 120 BPM pattern, play/pause). */
  script: async (o: Partial<typeof ctl>) => {
    Object.assign(ctl, o);
    if (pipeline.source !== scripted) { ctl.clock = 0; ctl.last = -1; pipeline.setSource(scripted); }
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  clock: () => ctl.clock,
  pause: () => pipeline.pause(),
  resume: () => pipeline.play(),
  seek: (t: number) => { ctl.clock = t; },
  hit: (level = 1) => { ctl.hitLevel = level; ctl.hitAt = ctl.clock; },
  /** One detected onset: beatDetected is true for exactly one frame. */
  onset: (strength = 0.7) => { ctl.onsetStrength = strength; ctl.beatPending = true; },
  sample,
  motion,
  twinkle,
  proj,
  burstProbe,
  stateStats,
  stateDiff,
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
    return r ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? null, calls: r.info.render.calls, points: r.info.render.points, triangles: r.info.render.triangles } : null;
  },
  sceneStats,
  hostStats,
};

createRoot(document.getElementById("root")!).render(<Harness />);
const src = query.get("source");
const api = (window as unknown as { __chroma: { demo: () => Promise<unknown>; song: (id: string) => Promise<unknown>; script: (o: object) => Promise<unknown> } }).__chroma;
if (src === "demo") void api.demo();
else if (src === "pattern") void api.script({ pattern: true });
else if (src?.startsWith("song:")) void api.song(src.slice(5));
