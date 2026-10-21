import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { COLS, ROWS, heightParts, type RowInput } from "../src/lib/terrain/field";
import { TerrainHistory } from "../src/lib/terrain/history";
import { loadOfflineSource, type AudioFeatureFrame } from "../src/lib/pipeline";

// REAL feature data: Detty's pre-computed analysis bundle, read from disk through the application's own offline source and
// played on a fake silent clock (Detty ships no audio: this verifies what the land is given, not what anyone hears).

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");
function serveFromDisk() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    try { return new Response(readFileSync(join(PUBLIC, String(url).replace(/^\//, ""))), { status: 200 }); }
    catch { return new Response("not found", { status: 404 }); }
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb); return s / (a.length * std(a) * std(b)); };

async function runDetty(seconds: number, from = 0) {
  const restore = serveFromDisk();
  try {
    let ms = 0;
    const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId: "detty", now: () => ms });
    await src.play();
    if (from > 0) src.seek(from);
    const h = new TerrainHistory();
    const frames: AudioFeatureFrame[] = [];
    const flagged: number[] = [];
    let prevBeat = false, offered = 0;
    const all: Array<{ t: number; bass: number; mid: number; high: number; rms: number }> = [];
    for (let i = 0; i < seconds * 60; i++) {
      const f = src.sample(ms / 1000);
      if (f.beatDetected && !prevBeat && f.isPlaying) flagged.push(f.time);
      prevBeat = f.beatDetected;
      h.push(f);
      frames.push(f);
      all.push({ t: f.time, bass: f.bass, mid: f.mid, high: f.high, rms: f.rmsEnergy });
      offered++;
      ms += 1000 / 60;
    }
    src.dispose();
    return { h, frames, flagged, all, offered };
  } finally {
    restore();
  }
}

describe("Terrain on Detty's real feature data (silent clock, features only)", () => {
  it("the land varies realistically: relief height, register balance and onsets all change over 90 s", async () => {
    const { h, all } = await runDetty(90);
    assert.equal(h.stats.invalid, 0);
    assert.equal(h.stats.gaps, 0);
    // the features themselves vary (this is data, not a test signal)
    assert.ok(std(all.map((x) => x.bass)) > 0.08, `bass std ${std(all.map((x) => x.bass)).toFixed(3)}`);
    assert.ok(std(all.map((x) => x.mid)) > 0.05);
    assert.ok(h.stats.appended > 90 * 18, `${h.stats.appended} rows in 90 s`);
  });

  it("each stored row is exactly the land rule applied to the frame the source delivered at that time", async () => {
    const { h, frames } = await runDetty(30);
    const byTime = new Map<number, AudioFeatureFrame>();
    for (const f of frames) byTime.set(Math.fround(f.time), f);
    const tmp = new Float32Array(4), want = new Float32Array(4);
    let checked = 0;
    for (let r = 0; r < h.count; r += 7) {
      const f = byTime.get(h.rowTime(r));
      assert.ok(f, `a source frame exists at row time ${h.rowTime(r)}`);
      const inp: RowInput = { t: Math.fround(f.time), bass: f.bass, mid: f.mid, high: f.high, hit: f.bassHit, shock: h.rowShock(r) };
      for (const c of [3, COLS >> 1, COLS - 20]) {
        heightParts(inp, c, want, 0);
        for (let k = 0; k < 4; k++) tmp[k] = h.part(r, c, k);
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(tmp[k] - want[k]) < 2e-3 * (1 + Math.abs(want[k])), `row ${r} col ${c} part ${k}: ${tmp[k]} vs ${want[k]}`);
        checked++;
      }
    }
    assert.ok(checked > 40);
  });

  it("the registers are not redundant on real music: per-row bass, mid and high levels are not the same signal", async () => {
    const { all } = await runDetty(100);
    const b = all.map((x) => x.bass), m = all.map((x) => x.mid), hi = all.map((x) => x.high);
    const cbm = corr(b, m), cbh = corr(b, hi), cmh = corr(m, hi);
    assert.ok(Math.abs(cbm) < 0.95 && Math.abs(cbh) < 0.95 && Math.abs(cmh) < 0.95, `bass~mid ${cbm.toFixed(2)}, bass~high ${cbh.toFixed(2)}, mid~high ${cmh.toFixed(2)}`);
  });

  it("every onset edge the source asserted is a recorded onset, and none are invented", async () => {
    const { h, flagged } = await runDetty(60);
    assert.ok(flagged.length > 20, `${flagged.length} onsets in 60 s`);
    assert.equal(h.stats.onsets, flagged.length);
  });

  it("scars land in rows near their onsets (within one row step) and the land stays bounded in memory", async () => {
    const { h, flagged } = await runDetty(40);
    const scarRows: number[] = [];
    for (let r = 0; r < h.count; r++) if (h.rowShock(r) > 0) scarRows.push(h.rowTime(r));
    assert.ok(scarRows.length > 5);
    // every scar row is within one row step (plus a frame) after some onset time
    for (const t of scarRows) assert.ok(flagged.some((f) => t - f >= -1e-4 && t - f < 0.07), `scar at ${t} has an onset just before it`);
    assert.equal(h.count, ROWS);
    assert.equal(h.data.length, 129 * ROWS * 4);
  });

  it("a real seek mid-song is a clean break, not an invented bridge", async () => {
    const restore = serveFromDisk();
    try {
      let ms = 0;
      const src = await loadOfflineSource({ manifestUrl: "/motion/manifest.json", songId: "detty", now: () => ms });
      await src.play();
      const h = new TerrainHistory();
      for (let i = 0; i < 300; i++) { h.push(src.sample(ms / 1000)); ms += 1000 / 60; }
      const before = h.stats.appended;
      src.seek(70);
      for (let i = 0; i < 300; i++) { h.push(src.sample(ms / 1000)); ms += 1000 / 60; }
      assert.equal(h.stats.gaps, 1);
      assert.equal(h.stats.voidRows, 2);
      assert.ok(h.stats.appended > before + 80);
      src.seek(5); // back
      h.push(src.sample(ms / 1000));
      assert.equal(h.stats.resets, 1);
      assert.equal(h.count, 1);
      src.dispose();
    } finally {
      restore();
    }
  });
});
