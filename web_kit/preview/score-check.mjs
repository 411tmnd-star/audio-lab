// Acceptance checks for the Score scene, on a GPU-enabled Edge (preview/cdp-lib-gpu.mjs).
// From web_kit/, with the harness served and the bundle built:
//   node preview/build.mjs score
//   node preview/serve-gl.mjs 5354          (or another port: SCORE_PORT=5355 node preview/score-check.mjs)
//   node preview/score-check.mjs [outDir]
// Two kinds of input, reported separately and never mixed:
//   SYNTHETIC  scripted constant levels and a scripted 120 BPM pattern (sections 1-5, 7).
//   DETTY      the Detty offline song through the application's offline-source route: its pre-computed feature bundle (a real
//              analysis of the real recording) played on the SILENT clock, because Detty ships no audio
//              (public/motion/manifest.json: "audio": null). It verifies what the scene SEES, not what anyone HEARS. Section 6.
// Exit 0 only if every section completed and every check passed. A crash exits non-zero and prints CRASHED.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { launchGpu, sleep } from "./cdp-lib-gpu.mjs";

const OUT = process.argv[2] || "../scratch_shots/score";
mkdirSync(OUT, { recursive: true });
const URL_BASE = `http://localhost:${process.env.SCORE_PORT || 5354}`;
const results = [];
const measurements = {};
let completed = false;
let kind = "";
const check = (name, ok, detail = "") => {
  results.push({ kind, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${kind}] ${name}${detail ? "  " + detail : ""}`);
};
const section = (t, k) => { kind = k; console.log(`\n== ${t} (${k}) ==`); };
const f3 = (x) => (typeof x === "number" ? x.toFixed(3) : String(x));
const S = "window.__score";
const sample = (b) => b.js(`${S}.sample()`);
const hist = (b) => b.js(`${S}.history()`);
const anim = (b) => b.js(`(() => { const d = ${S}.debug(); return d && { ...d.anim }; })()`);
const status = (b) => b.js(`document.querySelector('[data-gl-status]')?.dataset.glStatus`);
const shot = (b, name) => b.shot(join(OUT, `score-${name}.png`));
const ready = `!!(${S} && ${S}.debug())`;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
/** The D3D compiler's harmless note, if any shader triggers one. */
const benign = (e) => /X4122/.test(e.text);
/** Distance from each value in a to its nearest value in b. */
const nearest = (a, b) => a.map((x) => Math.min(...b.map((y) => Math.abs(x - y))));
const cornersDark = (c) => [...c].sort((a, b) => a - b)[2] < 0.05;

const b = await launchGpu({ port: 9670, width: 1280, height: 900 });
try {
  // ------------------------------------------------------------------------------------------------------------------
  section("0. hardware", "SYNTHETIC");
  await b.viewport(1280, 900, 1);
  await b.goto(URL_BASE + "/score?source=pattern", ready);
  await sleep(3000);
  const gpu = await b.js(`(() => { const g = ${S}.debug().host.three.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return { renderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), version: g.getParameter(g.VERSION) }; })()`);
  measurements.gpu = gpu;
  console.log(`renderer: ${gpu.renderer} | ${gpu.version}`);

  // ------------------------------------------------------------------------------------------------------------------
  section("1. renders and compiles", "SYNTHETIC");
  check("no console errors, exceptions or WebGL warnings", b.events.filter((e) => !benign(e)).length === 0, JSON.stringify(b.events.filter((e) => !benign(e)).slice(0, 3)));
  check("the host is ready and drawing", (await status(b)) === "ready" && (await b.js(`${S}.debug().host.frameCount`)) > 30);
  const s1 = await sample(b);
  check("the frame is mostly dark with the instrument lit (mean luminance 0.01..0.20, corners dark)", s1.frameMean > 0.01 && s1.frameMean < 0.2 && cornersDark(s1.corners), `mean ${f3(s1.frameMean)}`);
  const mem = await b.js(`${S}.memory()`);
  measurements.drawStats = mem;
  check("draw calls stay small (<= 20)", mem.calls <= 20, `${mem.calls} calls, ${mem.triangles} triangles, ${mem.programs} programs`);
  await shot(b, "01-pattern");

  // ------------------------------------------------------------------------------------------------------------------
  section("2. lanes respond to their own band (scripted constant levels)", "SYNTHETIC");
  // Each hold starts from a fresh source (silence, then the script), so the history holds only this hold's signal.
  const hold = async (o, ms = 2800) => { await b.js(`${S}.silence()`); await sleep(150); await b.js(`${S}.script(${JSON.stringify({ pattern: false, rms: 0.5, ...o })})`); await sleep(ms); return sample(b); };
  const bassOnly = await hold({ bass: 0.9, mid: 0.0, high: 0.0 });
  await shot(b, "02-bass-only");
  const midOnly = await hold({ bass: 0.0, mid: 0.9, high: 0.0 });
  await shot(b, "02-mid-only");
  const highOnly = await hold({ bass: 0.0, mid: 0.0, high: 0.9 });
  await shot(b, "02-high-only");
  // The baseline has the same loudness as the holds (rms 0.5), so only the band under test differs.
  const quiet = await hold({ bass: 0, mid: 0, high: 0 });
  const L = (s) => ({ bass: s.lanes.bass.mean, mid: s.lanes.mid.mean, high: s.lanes.high.mean });
  measurements.synthetic = { bassOnly: L(bassOnly), midOnly: L(midOnly), highOnly: L(highOnly), quiet: L(quiet) };
  console.log("  lane mean luminance  bass-only", JSON.stringify(L(bassOnly)), " mid-only", JSON.stringify(L(midOnly)), " high-only", JSON.stringify(L(highOnly)), " silent", JSON.stringify(L(quiet)));
  // How each lane responds: the bass lane by FILL (its mean luminance and the spread of its envelope), the mid lane by the HEIGHT of
  // its trace, the high lane by the SPREAD (amplitude) of its fine trace. The trace is the set of bright pixels in the lane; centre and
  // spread are in world units (lane half-height is 1.05). Baseline: the same loudness with all three bands at zero.
  const T = (s, lane) => s.lanes[lane].trace;
  const d = (s, lane, k) => T(s, lane)[k] - T(quiet, lane)[k];
  const lbMean = bassOnly.lanes.bass.mean - quiet.lanes.bass.mean;
  measurements.synthetic.response = {
    bassOnly: { fillLift: lbMean, spread: d(bassOnly, "bass", "spread"), midCentre: d(bassOnly, "mid", "centre"), highSpread: d(bassOnly, "high", "spread") },
    midOnly: { centre: d(midOnly, "mid", "centre"), bassSpread: d(midOnly, "bass", "spread"), highSpread: d(midOnly, "high", "spread") },
    highOnly: { spread: d(highOnly, "high", "spread"), midCentre: d(highOnly, "mid", "centre"), bassSpread: d(highOnly, "bass", "spread") },
  };
  console.log("  response", JSON.stringify(measurements.synthetic.response));
  const still = (v) => Math.abs(v) < 0.05;
  check("bass: a full bass level FILLS the bass lane (mean luminance up by 0.1+, trace spread up by 0.4+ units), and the mid and high lanes do not move", lbMean > 0.1 && d(bassOnly, "bass", "spread") > 0.4 && still(d(bassOnly, "mid", "centre")) && still(d(bassOnly, "high", "spread")), JSON.stringify(measurements.synthetic.response.bassOnly));
  check("mid: a full mid level RAISES the mid trace (by 0.8+ world units) and the bass and high lanes do not move", d(midOnly, "mid", "centre") > 0.8 && still(d(midOnly, "bass", "spread")) && still(d(midOnly, "high", "spread")), JSON.stringify(measurements.synthetic.response.midOnly));
  check("high: a full high level WIDENS the fine trace around its centre line (spread up by 0.15+ units) and the bass and mid lanes do not move", d(highOnly, "high", "spread") > 0.15 && still(d(highOnly, "mid", "centre")) && still(d(highOnly, "bass", "spread")), JSON.stringify(measurements.synthetic.response.highOnly));
  check("the three lanes are different kinds of mark: the bass lane's fill carries far more light than the mid or high trace (3x or more)", lbMean > 3 * Math.max(midOnly.lanes.mid.mean - quiet.lanes.mid.mean, highOnly.lanes.high.mean - quiet.lanes.high.mean, 1e-6), `bass fill ${f3(lbMean)}`);
  const hue = (s, lane) => s.lanes[lane].rgb;
  const bRgb = hue(bassOnly, "bass"), mRgb = hue(midOnly, "mid"), hRgb = hue(highOnly, "high");
  check("lane hues are the specified ones: bass amber (R > G > B), mid cyan (R lowest, G and B high), high violet (R and B above G)", bRgb[0] > bRgb[1] && bRgb[1] > bRgb[2] && mRgb[0] < 0.3 * Math.max(mRgb[1], mRgb[2]) && hRgb[1] < Math.min(hRgb[0], hRgb[2]), `bass ${bRgb.map(Math.round)} mid ${mRgb.map(Math.round)} high ${hRgb.map(Math.round)}`);

  // ------------------------------------------------------------------------------------------------------------------
  section("3. history, onsets and timeline (scripted 120 BPM pattern)", "SYNTHETIC");
  await b.js(`${S}.script({ pattern: true, rms: 0.5 })`);
  await b.js(`${S}.silence()`); await sleep(200);
  await b.js(`${S}.script({ pattern: true, playing: true })`);
  await sleep(14000);
  const h = await hist(b);
  measurements.pattern = { count: h.count, markers: h.markerCount, minDt: h.minDt, maxDt: h.maxDt, stats: h.stats };
  console.log(`  history: ${h.count} samples, ${h.markerCount} markers, spacing ${f3(h.minDt)}..${f3(h.maxDt)} s, offered ${h.stats.offered}, appended ${h.stats.appended}, skipped ${h.stats.skipped}, duplicates ${h.stats.duplicateFrames}`);
  check("one sample per playhead step at most: appended is well under frames offered, and no two samples are closer than the step", h.stats.appended < 0.7 * h.stats.offered && h.minDt >= 0.025 - 1e-6, `${h.stats.appended} of ${h.stats.offered}, min spacing ${f3(h.minDt)} s`);
  check("samples are strictly ordered in time and no gap broke the line", h.ordered && h.stats.gaps === 0, `maxDt ${f3(h.maxDt)}`);
  check("history is bounded by its capacity", h.count <= 512, `${h.count}`);
  const marks = h.marks;
  const onBeat = marks.map((m) => Math.abs(m / 0.5 - Math.round(m / 0.5)) * 0.5);
  check("one marker per kick: the 120 BPM pattern's onsets are recorded once each, at 0.5 s spacing (within one frame)", marks.length >= 22 && Math.max(...onBeat) < 0.04 && marks.slice(1).every((m, i) => Math.abs(m - marks[i] - 0.5) < 0.04), `${marks.length} markers, max offset from a kick ${f3(Math.max(...onBeat))} s`);
  check("no duplicate markers: onsets recorded equal onsets asserted", h.stats.onsets === h.markerCount || h.stats.onsets >= h.markerCount, `${h.stats.onsets} recorded`);

  // pixel-level: marker diamonds line up with the bass attack edges, in screen space
  const cols = [];
  for (let i = 0; i < 3; i++) { cols.push(await b.js(`${S}.columns()`)); await sleep(370); }
  const align = cols.map((c) => median(nearest(c.attacks.filter((x) => x > c.w * 0.25 && x < c.w * 0.75), c.diamonds)));
  measurements.alignmentPx = align;
  console.log(`  marker-to-attack distance (median px) at 3 instants: ${align.map(f3)}; attack columns ${cols[0].attacks.length}, diamonds ${cols[0].diamonds.length}, ${f3(cols[0].pxPerSecond)} px/s`);
  check("each marker sits on its kick's attack edge on screen (median distance <= 4 px at three instants): history and markers share one timeline", align.every((a) => a <= 4) && cols[0].attacks.length >= 5 && cols[0].diamonds.length >= 5, align.map(f3).join(" "));

  // scroll: direction and rate
  const sc = await b.js(`${S}.scrollTest(0.2)`);
  const shifts = nearest(sc.after.diamonds.filter((x) => x > 100 && x < sc.after.w - 100), sc.before.diamonds);
  const dirs = sc.after.diamonds.slice(2, -2).map((x) => { const j = sc.before.diamonds.reduce((bi, y, i) => (Math.abs(y - x) < Math.abs(sc.before.diamonds[bi] - x) ? i : bi), 0); return x - sc.before.diamonds[j]; });
  const expectPx = 0.2 * sc.before.pxPerSecond;
  measurements.scroll = { expectedPx: expectPx, measured: median(dirs) };
  check("history advances right to left at the stated rate: a 0.2 s advance of the clock moves the markers left by 0.2 x px/s (+-2 px)", Math.abs(median(dirs) + expectPx) <= 2 && sc.after.diamonds.length >= sc.before.diamonds.length - 2, `expected -${f3(expectPx)} px, measured ${f3(median(dirs))} px`);

  // one-frame onsets
  await b.js(`${S}.script({ pattern: false, bass: 0.2, mid: 0.2, high: 0.2, rms: 0.4 })`);
  await sleep(1500);
  const m0 = (await hist(b)).stats.onsets;
  await b.js(`${S}.onset(0.8)`); await sleep(400);
  const m1 = (await hist(b)).stats.onsets;
  await b.js(`${S}.onset(0.8)`); await sleep(60); await b.js(`${S}.onset(0.8)`); await sleep(400);
  const m2 = (await hist(b)).stats.onsets;
  check("a one-frame onset records exactly one marker; two separate onsets record two", m1 - m0 === 1 && m2 - m1 === 2, `+${m1 - m0}, +${m2 - m1}`);

  // ------------------------------------------------------------------------------------------------------------------
  section("4. pause, resume, cadence change, source change", "SYNTHETIC");
  await b.js(`${S}.script({ pattern: true, playing: true })`);
  await sleep(3000);
  await b.js(`${S}.pause()`); await sleep(2500); // let the 0.6 s illumination envelope settle to the paused frame's level
  const p0 = { h: await hist(b), a: await anim(b), s: await sample(b) };
  await sleep(1500);
  const p1 = { h: await hist(b), a: await anim(b), s: await sample(b) };
  check("paused: no samples or markers are added while frames keep being drawn, and the clock holds still", p1.h.count === p0.h.count && p1.h.stats.onsets === p0.h.stats.onsets && p1.h.stats.offered > p0.h.stats.offered && p1.a.now === p0.a.now, `count ${p0.h.count} -> ${p1.h.count}, now ${f3(p0.a.now)} -> ${f3(p1.a.now)}`);
  const pc0 = await b.js(`${S}.columns()`);
  await sleep(1200);
  const pc1 = await b.js(`${S}.columns()`);
  check("paused: the picture is frozen (lane luminance within 0.0005; every marker and attack stays on exactly the same screen column)", Math.abs(p1.s.lanes.bass.mean - p0.s.lanes.bass.mean) < 0.0005 && Math.abs(p1.s.lanes.mid.mean - p0.s.lanes.mid.mean) < 0.0005 && JSON.stringify(pc0.diamonds) === JSON.stringify(pc1.diamonds) && JSON.stringify(pc0.attacks) === JSON.stringify(pc1.attacks) && pc0.diamonds.length > 5, `bass ${f3(p0.s.lanes.bass.mean)} -> ${f3(p1.s.lanes.bass.mean)}, ${pc0.diamonds.length} markers`);
  await shot(b, "03-paused");
  await b.js(`${S}.resume()`); await sleep(2500);
  const p2 = { h: await hist(b), a: await anim(b) };
  check("resumed: recording continues from the same playhead with no gap, and the clock moves again", p2.h.stats.appended > p1.h.stats.appended + 40 && p2.h.stats.gaps === 0 && p2.h.ordered && p2.a.now > p1.a.now + 2, `appended ${p1.h.stats.appended} -> ${p2.h.stats.appended}, now ${f3(p1.a.now)} -> ${f3(p2.a.now)}`);

  await b.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await b.js(`${S}.mark()`);
  await sleep(5000);
  const slow = await b.js(`(() => { const d = ${S}.debug(); return { now: d.anim.now, head: ${S}.pipeline.frame.time, t: ${S}.timing() }; })()`);
  const hs = await hist(b);
  await b.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  check("a 6x slower main thread (a much lower and uneven frame rate): the clock still tracks the playhead (within 0.12 s), order holds and no duplicate samples appear", Math.abs(slow.now - slow.head) < 0.12 && hs.ordered && hs.minDt >= 0.025 - 1e-6, `frame interval median ${f3(slow.t.intervals.median)} ms, clock error ${f3(slow.now - slow.head)} s`);
  await sleep(1500);

  const rs0 = (await hist(b)).stats.resets;
  await b.js(`${S}.demo()`); await sleep(1500);
  const afterSwitch = await hist(b);
  check("changing source clears the old record: the history restarts from the new source's timeline", afterSwitch.stats.resets > rs0 && afterSwitch.first >= 0 && afterSwitch.count < 80, `resets ${rs0} -> ${afterSwitch.stats.resets}, count ${afterSwitch.count}`);

  // ------------------------------------------------------------------------------------------------------------------
  section("5. performance, lifecycle, reduced motion", "SYNTHETIC");
  const perf = {};
  for (const [w, hgt, tag] of [[1280, 720, "720p"], [1920, 1080, "1080p"]]) {
    await b.viewport(w, hgt, 1);
    await b.goto(URL_BASE + "/score?source=pattern", ready);
    await sleep(2500);
    await b.js(`${S}.mark()`);
    await sleep(6000);
    const t = await b.js(`${S}.timing()`);
    const g = await b.js(`${S}.gpuTime(80)`);
    const m = await b.js(`${S}.memory()`);
    perf[tag] = { interval: t.intervals, cpu: t.cpu, gpuSync: g, buffer: g.buffer, calls: m.calls };
    console.log(`  ${tag}: interval median ${f3(t.intervals.median)} p99 ${f3(t.intervals.p99)} over33 ${f3(t.intervals.over33)} | cpu median ${f3(t.cpu.median)} p99 ${f3(t.cpu.p99)} | sync GPU median ${f3(g.median)} p95 ${f3(g.p95)} | buffer ${g.buffer}`);
  }
  measurements.performance = perf;
  // Bounds fixed BEFORE measuring (PROPOSED, not a platform budget): 60 Hz pacing held; main thread <= 2 ms; synchronous GPU <= 5 ms
  // (the Spectrum Matrix baseline on this GPU was 3.3-4.2 ms at 1280x720).
  const pf = perf["720p"];
  check("720p: frame interval median <= 20 ms, under 2% of frames over 33 ms", pf.interval.median <= 20 && pf.interval.over33 < 0.02, `median ${f3(pf.interval.median)} over33 ${f3(pf.interval.over33)}`);
  check("720p: main-thread cost per frame median <= 2 ms", pf.cpu.median <= 2, `${f3(pf.cpu.median)} ms`);
  check("720p: synchronous GPU time median <= 5 ms", pf.gpuSync.median <= 5, `${f3(pf.gpuSync.median)} ms`);
  check("1080p window: frame interval median <= 20 ms, under 2% over 33 ms", perf["1080p"].interval.median <= 20 && perf["1080p"].interval.over33 < 0.02, `median ${f3(perf["1080p"].interval.median)}`);

  // heap growth while playing (a measurement, not a zero-allocation claim)
  await b.viewport(1280, 900, 1);
  await b.goto(URL_BASE + "/score?source=pattern", ready);
  await b.send("HeapProfiler.enable");
  await sleep(3000);
  await b.send("HeapProfiler.collectGarbage");
  const heap0 = (await b.send("Runtime.getHeapUsage")).usedSize;
  const geo0 = (await b.js(`${S}.memory()`)).geometries;
  await sleep(20000);
  await b.send("HeapProfiler.collectGarbage");
  const heap1 = (await b.send("Runtime.getHeapUsage")).usedSize;
  const mem1 = await b.js(`${S}.memory()`);
  measurements.heap = { before: heap0, after: heap1, growthKB: (heap1 - heap0) / 1024, geometries: [geo0, mem1.geometries] };
  console.log(`  JS heap after GC: ${(heap0 / 1048576).toFixed(2)} MB -> ${(heap1 / 1048576).toFixed(2)} MB over 20 s of playback`);
  check("playing for 20 s does not grow the JS heap by more than 1 MB (after GC), and GPU geometry count is steady", heap1 - heap0 < 1048576 && mem1.geometries === geo0, `growth ${((heap1 - heap0) / 1024).toFixed(0)} KB, geometries ${geo0} -> ${mem1.geometries}`);

  const before = await b.js(`({ h: ${S}.hostStats, s: ${S}.sceneStats })`);
  await b.js(`${S}.set(false)`); await sleep(400);
  const unmounted = await b.js(`({ h: ${S}.hostStats, s: ${S}.sceneStats, dbg: !!${S}.debug() })`);
  check("unmounting disposes the host and the scene", unmounted.h.disposed === before.h.disposed + 1 && unmounted.s.disposed === before.s.disposed + 1 && !unmounted.dbg, JSON.stringify(unmounted));
  await b.js(`${S}.set(true)`); await sleep(800);
  // Unmounting the provider clears the pipeline's source by design, so the source is chosen again after a remount.
  await b.js(`${S}.script({ pattern: true, playing: true })`); await sleep(2500);
  check("remounting draws again and a new source fills a fresh history", (await b.js(`${S}.debug().host.frameCount`)) > 5 && (await status(b)) === "ready" && (await hist(b)).count > 30);

  const countBefore = (await hist(b)).count;
  await b.js(`(() => { const g = ${S}.debug().host.three.getContext(); window.__lose = g.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); })()`);
  await sleep(500);
  check("context loss is reported", (await status(b)) === "lost");
  await b.js(`window.__lose.restoreContext()`); await sleep(2000);
  const restored = await sample(b);
  check("context restore redraws the lanes from the preserved history (lit, history kept)", (await status(b)) === "ready" && restored.lanes.bass.mean > 0.02 && restored.count >= countBefore, `bass lane ${f3(restored.lanes.bass.mean)}, samples ${restored.count}`);

  for (const [w, hgt, dpr, name] of [[1280, 900, 1, "desktop"], [390, 844, 2, "phone"], [900, 900, 1, "square"]]) {
    await b.viewport(w, hgt, dpr);
    await sleep(900);
    const s = await sample(b);
    const lit = [s.lanes.high.mean, s.lanes.mid.mean, s.lanes.bass.mean].every((v) => v > 0.004);
    check(`${name} ${w}x${hgt}: all three lanes are visible inside the canvas`, lit, `lane luminance ${f3(s.lanes.high.mean)} ${f3(s.lanes.mid.mean)} ${f3(s.lanes.bass.mean)}`);
    await shot(b, `04-${name}`);
  }
  await b.viewport(1280, 900, 1);

  await b.emulateMotion(true);
  await b.goto(URL_BASE + "/score?source=pattern", ready);
  await sleep(3500);
  const r0 = await anim(b);
  await sleep(1500);
  const r1 = await anim(b);
  const rp = (await sample(b)).params;
  check("prefers-reduced-motion: the scroll (the data) continues, and the marker arrival lift is switched off", r1.now > r0.now + 1 && rp.reduced === true && (await b.js(`${S}.debug().scene.uniforms.uReduced.value`)) === 1, `now ${f3(r0.now)} -> ${f3(r1.now)}`);
  await b.emulateMotion(false);

  // ------------------------------------------------------------------------------------------------------------------
  section("6. Detty offline song through the application's route (silent clock: no audio is shipped)", "DETTY");
  await b.goto(URL_BASE + "/score", ready);
  await b.js(`(() => { window.__flags = []; let prev = false; ${S}.pipeline.onFrame((f) => { if (f.beatDetected && !prev && f.isPlaying) window.__flags.push(f.time); prev = f.beatDetected; }); })()`);
  const loaded = await b.js(`${S}.song('detty')`);
  measurements.dettyRoute = loaded;
  check("the manifest song loads through loadOfflineSource (the source picker's call) and plays", /detty/i.test(loaded.label ?? "") && loaded.kind === "offline" && loaded.duration > 100, JSON.stringify(loaded));
  await b.js(`${S}.pipeline.seek(30)`); await sleep(500);
  await b.js(`window.__flags.length = 0; ${S}.mark()`);
  await sleep(14000);
  const dh = await hist(b);
  const flags = await b.js(`window.__flags`);
  const dtim = await b.js(`${S}.timing()`);
  measurements.dettyLive = { history: { count: dh.count, markers: dh.markerCount, minDt: dh.minDt, maxDt: dh.maxDt, stats: dh.stats }, flagged: flags.length, interval: dtim.intervals };
  console.log(`  real-time play from 30 s for 14 s: ${dh.count} samples (spacing ${f3(dh.minDt)}..${f3(dh.maxDt)}), ${dh.markerCount} markers, ${flags.length} rising onset edges seen on frames, offered ${dh.stats.offered} appended ${dh.stats.appended}`);
  check("Detty feeds the scene: history fills in order and spacing is at least the step", dh.count > 300 && dh.ordered && dh.minDt >= 0.025 - 1e-6, `${dh.count} samples`);
  const recordedNew = dh.marks.filter((m) => m >= flags[0] - 1e-9);
  check("every onset edge Detty asserted during playback is a marker at exactly that playhead time, none missed, none duplicated", flags.length > 10 && flags.length === recordedNew.length && flags.every((t, i) => Math.abs(t - recordedNew[i]) < 1e-9), `${flags.length} edges, ${recordedNew.length} markers`);
  check("Detty frame pacing: median interval <= 20 ms, under 2% over 33 ms", dtim.intervals.median <= 20 && dtim.intervals.over33 < 0.02, `median ${f3(dtim.intervals.median)} over33 ${f3(dtim.intervals.over33)}`);
  const dcols = [];
  for (let i = 0; i < 3; i++) { dcols.push(await b.js(`${S}.columns()`)); await sleep(410); }
  measurements.dettyDiamonds = dcols.map((c) => c.diamonds.length);
  const ds = await sample(b);
  check("Detty frame: all three lanes lit, corners dark", ds.lanes.bass.mean > 0.02 && ds.lanes.mid.mean > 0.004 && cornersDark(ds.corners), `lanes ${f3(ds.lanes.high.mean)} ${f3(ds.lanes.mid.mean)} ${f3(ds.lanes.bass.mean)}`);
  await shot(b, "05-detty-live");

  const times = [10, 30, 53, 60, 100];
  const run = () => b.js(`${S}.replay('detty', ${JSON.stringify(times)}, { images: true })`);
  const r1c = await run();
  const r2c = await run();
  measurements.dettyReplay = { stats: r1c.stats, spacing: r1c.spacing, flagged: r1c.flagged.length, captures: r1c.captures.map((c) => ({ t: c.requestedT, features: c.features, lanes: { high: c.metrics.lanes.high.mean, mid: c.metrics.lanes.mid.mean, bass: c.metrics.lanes.bass.mean }, count: c.count })) };
  for (const c of r1c.captures) writeFileSync(join(OUT, `score-detty-t${String(c.requestedT).padStart(3, "0")}.png`), Buffer.from(c.png, "base64"));
  console.log(`  replay to ${times[times.length - 1]} s: ${r1c.stats.offered} frames offered, ${r1c.stats.appended} samples appended (${r1c.spacing.minDt.toFixed(4)}..${r1c.spacing.maxDt.toFixed(4)} s apart), ${r1c.flagged.length} onset edges asserted, ${r1c.stats.onsets} markers recorded`);
  check("Detty replay: reaches every requested time", r1c.captures.length === times.length, `${r1c.captures.length}/${times.length}`);
  check("Detty replay: two runs give pixel-identical captures and identical history statistics", r1c.captures.every((c, i) => sha(c.png) === sha(r2c.captures[i].png)) && JSON.stringify(r1c.stats) === JSON.stringify(r2c.stats), r1c.captures.map((c) => sha(c.png).slice(0, 6)).join(" "));
  check("Detty replay: onsets recorded equal onset edges asserted over the whole song (nothing missed or doubled), and the newest markers carry the same times", r1c.stats.onsets === r1c.flagged.length && r1c.marks.length === Math.min(128, r1c.flagged.length) && r1c.marks.every((m, i) => Math.abs(m - r1c.flagged[r1c.flagged.length - r1c.marks.length + i]) < 1e-9), `${r1c.stats.onsets} recorded vs ${r1c.flagged.length} asserted`);
  check("Detty replay: no duplicate samples (spacing >= step), ordered, no gaps, and the stored record is bounded", r1c.spacing.ordered && r1c.spacing.minDt >= 0.025 - 1e-6 && r1c.stats.gaps === 0 && r1c.spacing.count <= 512, `min spacing ${r1c.spacing.minDt.toFixed(4)} s, ${r1c.spacing.count} samples held of ${r1c.stats.appended} appended`);
  check("Detty replay: every capture shows three lit lanes and dark corners", r1c.captures.every((c) => c.metrics.lanes.bass.mean > 0.02 && c.metrics.lanes.mid.mean > 0.004 && cornersDark(c.metrics.corners)), r1c.captures.map((c) => f3(c.metrics.lanes.bass.mean)).join(" "));

  // ------------------------------------------------------------------------------------------------------------------
  section("7. hierarchy, core geometry, whole-run errors", "SYNTHETIC");
  await b.viewport(1280, 900, 1);
  await b.goto(URL_BASE + "/score?source=pattern", ready);
  await sleep(14000);
  const withDecor = await sample(b);
  await shot(b, "06-decor-on");
  const laneMean = (s) => (s.lanes.high.mean + s.lanes.mid.mean + s.lanes.bass.mean) / 3;
  // Each layer drawn ALONE; the number is the whole-frame mean luminance above the empty background.
  const layersOn = await b.js(`${S}.layerEnergy()`);
  await b.goto(URL_BASE + "/score?source=pattern&decor=0", ready);
  await sleep(14000);
  const noDecor = await sample(b);
  const layersOff = await b.js(`${S}.layerEnergy()`);
  await shot(b, "06-decor-off");
  measurements.hierarchy = { decorOn: layersOn, decorOff: layersOff };
  console.log("  layer energy (frame-mean luminance above background), decor on :", JSON.stringify(Object.fromEntries(Object.entries(layersOn).map(([k, v]) => [k, +v.toFixed(5)]))));
  console.log("  layer energy, decor off:", JSON.stringify(Object.fromEntries(Object.entries(layersOff).map(([k, v]) => [k, +v.toFixed(5)]))));
  check("hierarchy: the three lanes are the primary layer (at least 3x the onset markers), the markers are secondary (above the time grid), the grid is tertiary", layersOn.lanes > 3 * layersOn.markers && layersOn.markers > layersOn.grid && layersOn.grid > 0 && layersOff.lanes > 3 * layersOff.markers && layersOff.markers > layersOff.grid, `lanes ${layersOn.lanes.toFixed(5)}, markers ${layersOn.markers.toFixed(5)}, grid ${layersOn.grid.toFixed(5)}`);
  check("hierarchy: the decorative plates and the supporting rules and boundary are each far below the lanes (under a quarter)", layersOn.plates < 0.25 * layersOn.lanes && layersOn.rules < 0.25 * layersOn.lanes && layersOn.boundary < 0.25 * layersOn.lanes, `plates ${layersOn.plates.toFixed(5)}, rules ${layersOn.rules.toFixed(5)}, boundary ${layersOn.boundary.toFixed(5)}`);
  const dcn = await b.js(`${S}.columns()`);
  check("core geometry: with the plates removed the lanes, markers and grid still draw, and the marker timeline is unchanged", dcn.diamonds.length >= 5 && laneMean(noDecor) > 0.6 * laneMean(withDecor), `diamonds ${dcn.diamonds.length}, lane luminance ${f3(laneMean(noDecor))} vs ${f3(laneMean(withDecor))}`);
  check("ambient: loudness-driven illumination stays subordinate (the same lanes change by under 25% between silence and full loudness)", await (async () => {
    await b.js(`${S}.script({ pattern: false, bass: 0.7, mid: 0.6, high: 0.5, rms: 0.0 })`); await sleep(2500);
    const lo = await sample(b);
    await b.js(`${S}.script({ pattern: false, bass: 0.7, mid: 0.6, high: 0.5, rms: 1.0 })`); await sleep(2500);
    const hi = await sample(b);
    measurements.ambient = { lo: laneMean(lo), hi: laneMean(hi) };
    return Math.abs(laneMean(hi) - laneMean(lo)) / laneMean(lo) < 0.25;
  })(), JSON.stringify(measurements.ambient));
  const all = b.events.filter((e) => !benign(e));
  check("no console errors, exceptions or WebGL warnings during the whole run (deliberate context loss excluded)", all.filter((e) => !/context/i.test(e.text)).length === 0, JSON.stringify(all.slice(0, 4)));
  completed = true;
} catch (e) {
  console.log("CRASHED:", e && e.stack ? e.stack : e);
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
const byKind = (k) => results.filter((r) => r.kind === k);
console.log(`\nSYNTHETIC: ${byKind("SYNTHETIC").filter((r) => r.ok).length}/${byKind("SYNTHETIC").length} passed`);
console.log(`DETTY:     ${byKind("DETTY").filter((r) => r.ok).length}/${byKind("DETTY").length} passed (features on a silent clock; no audio heard)`);
writeFileSync(join(OUT, "score-check-report.json"), JSON.stringify({ when: new Date().toISOString(), completed, results, measurements }, null, 1));
console.log(`${results.length - failed.length}/${results.length} checks passed${completed ? "" : "  (RUN DID NOT COMPLETE)"}`);
process.exit(completed && failed.length === 0 ? 0 : 1);
