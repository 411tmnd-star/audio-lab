import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import Resonator from "@/components/resonator/Resonator";
import type { ResonatorDebug } from "@/components/resonator/ResonatorCanvas";
import { createResonatorAnim, stepResonatorAnim } from "@/lib/resonator/animator";
import { toResonatorParams } from "@/lib/resonator/params";
import { HEART_Y, R_OUT, ResonatorScene, sceneStats, type ResonatorQuality } from "@/lib/resonator/scene";
import { hostStats, GlHost } from "@/lib/gl/host";
import { AudioPipeline, createSyntheticSource, loadOfflineSource } from "@/lib/pipeline";
import type { AudioFeatureFrame } from "@/lib/pipeline/contract";
import type { FeatureSource } from "@/lib/pipeline/source";

// Preview harness for Resonator. It owns the pipeline so a browser script can drive the source, and exposes window.__res with
// read-only diagnostics (pixel sampling, synchronous GPU timing, frame timing, GPU memory) plus:
//   - a scripted SYNTHETIC source (always labelled synthetic) for controlled tests, and
//   - song(id): the application's offline-source route (loadOfflineSource, the same call the source picker makes), and
//   - replay(): a deterministic pass over a recorded offline song with a fake clock and a fixed 1/60 s step.
// Query: ?source=demo starts the 120 BPM synthetic demo; ?source=song:detty loads the Detty offline song and plays its silent
// clock; ?quality=lite selects the lite tier.

const query = new URLSearchParams(location.search);
const quality: ResonatorQuality = query.get("quality") === "lite" ? "lite" : "full";
const pipeline = new AudioPipeline();
const debugRef: { current: ResonatorDebug | null } = { current: null };
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
  return <div className="mx-auto max-w-7xl px-4 py-4">{mounted && <Resonator pipeline={pipeline} debugRef={debugRef} quality={quality} />}</div>;
}

const stats = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], over33: s.filter((x) => x > 33.4).length / s.length };
};

/** A scripted, constant-or-event input. Always labelled synthetic. Frames pass through the same pipeline as any source. */
const ctl = { bass: 0, mid: 0, high: 0, rms: 0, onset: 0, scene: "rest" as AudioFeatureFrame["currentSceneState"], hitAt: -1e9, hitLevel: 0, beatPending: false, playing: true };
const scripted: FeatureSource = {
  id: "resonator-script", kind: "synthetic", label: "Scripted input (synthetic)", canSeek: false, latencyMs: 0,
  sample(nowS) {
    const hit = ctl.hitLevel * Math.exp(-Math.max(0, nowS - ctl.hitAt) / 0.15); // the contract's bassHit: instant attack, 150 ms decay
    const beat = ctl.beatPending;
    ctl.beatPending = false; // an onset is true for exactly one frame, like the real contract
    return Object.freeze({ time: nowS, progress: 0, isPlaying: ctl.playing, bass: Math.min(1, ctl.bass + 0.5 * hit), mid: ctl.mid, high: ctl.high, rmsEnergy: ctl.rms,
      onsetStrength: beat ? Math.max(ctl.onset, 0.8) : ctl.onset, beatDetected: beat, currentSceneState: ctl.scene, bassHit: hit });
  },
  play: () => Promise.resolve(), pause() {}, seek() {}, status: () => ({ playing: true, duration: null, error: null }), onStatus: () => () => {}, dispose() {},
};

const luma = (px: Uint8Array, i: number) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

/** Reads the drawing buffer (after one synchronous render) and measures it: overall mean, the heart, the ribbon band, the floor, the corners. */
function measure(host: GlHost, scene: ResonatorScene) {
  const r = host.three!;
  host.render(scene.scene, scene.camera);
  const gl = r.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cam = scene.camera;
  cam.updateMatrixWorld();
  const heart = new THREE.Vector3(0, HEART_Y, 0).project(cam);
  const hx = (heart.x * 0.5 + 0.5) * w, hy = (heart.y * 0.5 + 0.5) * h;
  const region = (cx: number, cy: number, rx: number, ry: number) => {
    let s = 0, n = 0, mx = 0;
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(h, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(w, Math.ceil(cx + rx)); x++) { const v = luma(px, (y * w + x) * 4); s += v; n++; if (v > mx) mx = v; }
    return { mean: n ? s / n : NaN, max: mx };
  };
  let total = 0, lit = 0;
  for (let i = 0; i < px.length; i += 16) { const v = luma(px, i); total += v; if (v > 0.03) lit++; }
  const corners = [region(w * 0.03, h * 0.03, w * 0.02, h * 0.02), region(w * 0.97, h * 0.03, w * 0.02, h * 0.02), region(w * 0.03, h * 0.97, w * 0.02, h * 0.02), region(w * 0.97, h * 0.97, w * 0.02, h * 0.02)];
  return {
    w, h, px,
    frameMean: total / (px.length / 16), litFraction: lit / (px.length / 16),
    heart: region(hx, hy, w * 0.04, h * 0.06),
    ribbons: region(w * 0.5, h * 0.62, w * 0.3, h * 0.08),
    corners: corners.map((c) => c.mean),
  };
}

function sample() {
  const d = debugRef.current;
  if (!d || !d.host.three) return null;
  const m = measure(d.host, d.scene);
  const { px: _px, ...rest } = m;
  return { ...rest, anim: { ...d.anim }, params: d.lastParams };
}

/** Projects the outer ribbon's four extremes through the live camera: are they inside the canvas? */
function fits() {
  const d = debugRef.current;
  if (!d) return null;
  const cam = d.scene.camera;
  d.scene.update(d.anim, { azimuth: 0, elevation: 0 });
  cam.updateMatrixWorld();
  const P = (x: number, z: number) => new THREE.Vector3(x, 0, z).project(cam);
  const pts = { left: P(-R_OUT, 0), right: P(R_OUT, 0), near: P(0, R_OUT), far: P(0, -R_OUT) };
  return { maxAbsX: Math.max(Math.abs(pts.left.x), Math.abs(pts.right.x)), nearY: pts.near.y, farY: pts.far.y, distance: d.scene.distance, aspect: cam.aspect };
}

/** Synchronous GPU timing: draw then read one pixel, which waits for the GPU to finish. Includes the read stall. */
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

/** Canvas contents as PNG (base64), for screenshots from the page's own drawing buffer. */
function png(px: Uint8Array, w: number, h: number) {
  const flipped = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(flipped, w, h), 0, 0);
  return c.toDataURL("image/png").split(",")[1];
}

/**
 * Deterministic pass over a recorded offline song, on its own canvas and renderer (not the page's), with a fake clock and a
 * fixed step. The frames come from OfflineSource.sample(), the same feature frames the application uses; params, animator and
 * scene are the real ones. Returns per-capture features, animator state and metrics, and optionally the PNG.
 */
async function replay(songId: string, times: number[], o: { profile?: string; step?: number; width?: number; height?: number; images?: boolean; quality?: ResonatorQuality } = {}) {
  const W = o.width ?? 1280, H = o.height ?? 720, STEP = o.step ?? 1 / 60;
  // GlHost gives its canvas 100% width and height of the container, so the container carries the fixed size.
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;opacity:0;pointer-events:none`;
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  document.body.appendChild(box);
  const host = new GlHost({ canvas, maxPixelRatio: 1 });
  host.three?.setClearColor(0x02030a, 1);
  let nowMs = 0;
  const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId, profileId: o.profile ?? "balanced", now: () => nowMs });
  const anim = createResonatorAnim();
  const scene = new ResonatorScene({ quality: o.quality ?? quality });
  scene.setViewport(W, H, 1);
  await src.play();
  const todo = [...times].sort((a, b) => a - b);
  const out: Array<Record<string, unknown>> = [];
  let steps = 0, beats = 0, accepted = 0;
  const series: number[][] = [];
  while (todo.length && steps < 60 * 400) {
    const fr = src.sample(nowMs / 1000);
    const p = toResonatorParams(fr, host.reducedMotion);
    stepResonatorAnim(anim, p, STEP, host.reducedMotion);
    if (fr.beatDetected) beats++;
    series.push([fr.time, fr.bass, fr.mid, fr.high, fr.rmsEnergy, fr.beatDetected ? 1 : 0, fr.onsetStrength, anim.flash, anim.burst, anim.kick]);
    while (todo.length && fr.time + 1e-9 >= todo[0].valueOf()) {
      const t = todo.shift()!;
      scene.update(anim, { azimuth: 0, elevation: 0 });
      const m = measure(host, scene);
      const { px, ...metrics } = m;
      out.push({
        requestedT: t, frameTime: fr.time, scene: fr.currentSceneState, features: { bass: fr.bass, mid: fr.mid, high: fr.high, rms: fr.rmsEnergy, onset: fr.onsetStrength, beat: fr.beatDetected, bassHit: fr.bassHit },
        anim: { ...anim }, params: p, metrics, png: o.images ? png(px, m.w, m.h) : undefined,
      });
    }
    nowMs += STEP * 1000;
    steps++;
  }
  accepted = anim.flashesAccepted;
  const info = { steps, beats, flashesAccepted: accepted, flashesRejected: anim.flashesRejected, duration: src.status().duration };
  // The per-step series is returned as a flat summary (means), not 20k rows, to keep the report readable.
  const mean = (i: number) => series.reduce((a, r) => a + r[i], 0) / Math.max(1, series.length);
  const summary = { bass: mean(1), mid: mean(2), high: mean(3), rms: mean(4), flashMax: Math.max(...series.map((r) => r[7])), burstMax: Math.max(...series.map((r) => r[8])), kickMax: Math.max(...series.map((r) => r[9])) };
  scene.dispose();
  host.dispose();
  box.remove();
  src.dispose();
  return { captures: out, info, summary };
}

(window as unknown as { __res: unknown }).__res = {
  pipeline,
  quality,
  debug: () => debugRef.current,
  set: (v: boolean) => setMountedFn?.(v),
  demo: async () => {
    pipeline.setSource(createSyntheticSource(() => performance.now()));
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  /** The application's offline-source route: the call the source picker makes for a manifest song. Detty has no shipped audio, so this plays its silent clock. */
  song: async (id: string, profileId?: string) => {
    const s = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId: id, profileId });
    pipeline.setSource(s);
    await pipeline.play();
    return { kind: pipeline.getState().source?.kind, label: pipeline.getState().source?.label, duration: s.status().duration };
  },
  silence: () => pipeline.setSource(null),
  /** Switches to the scripted synthetic source with the given constant levels (bass, mid, high, rms, onset, scene). */
  script: async (o: Partial<typeof ctl>) => {
    Object.assign(ctl, o);
    if (pipeline.source !== scripted) pipeline.setSource(scripted);
    await pipeline.play();
    return pipeline.getState().source?.kind;
  },
  hit: (level = 1) => { ctl.hitLevel = level; ctl.hitAt = performance.now() / 1000; return performance.now(); },
  /** One detected onset: beatDetected is true for exactly one frame. */
  onset: (strength = 0.8) => { ctl.onset = strength; ctl.beatPending = true; },
  sample,
  fits,
  gpuTime,
  replay,
  mark: () => { markFrame = debugRef.current?.frames ?? 0; return markFrame; },
  /** Statistics over the frames since the last mark() (at most the ring size). */
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
const api = (window as unknown as { __res: { demo: () => Promise<unknown>; song: (id: string) => Promise<unknown> } }).__res;
if (src === "demo") void api.demo();
else if (src?.startsWith("song:")) void api.song(src.slice(5));
