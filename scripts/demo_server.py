"""Local upload demo: drop an audio file, run the whole AudioLab pipeline, watch the result play.

    python scripts/demo_server.py [--port 8765]   then open http://localhost:8765

Stages per upload (same CLI as the README): analyze -> interpret -> visual run -> motion run.
Everything lands in outputs/demo/<job>/ . Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import re
import time
import shutil
import subprocess
import sys
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
JOBS = ROOT / "outputs" / "demo"
STATE: dict[str, dict] = {}
STAGES = ["analyze", "interpret", "visual", "motion", "export"]
MAX_UPLOAD = 300 * 1024 * 1024  # bytes
STAGE_TIMEOUT = 900  # seconds per CLI stage
RUN_LOCK = threading.Lock()  # one pipeline at a time: each run is CPU- and memory-heavy
MIN_SECONDS = 3.0  # measured: 1 s and 2 s click tracks fail in interpret/visual, 3 s and longer pass all four stages
MIN_ONSETS = 4  # fewer detected onsets and the core tempo estimate fails (a steady tone crashes analyze with NaN)
TERMINAL = ("done", "error")
JOB_ID = re.compile(r"^[0-9a-f]{8}$")


def preflight(path: Path) -> str | None:
    """Return a plain-language reason this file cannot be analyzed, or None when it looks usable.

    Uses the audio stack the core already depends on (soundfile, librosa). Reads at most the first 60 s.
    """
    import librosa
    import soundfile as sf

    try:
        info = sf.info(str(path))
        dur = info.frames / info.samplerate
    except Exception:  # noqa: BLE001 - soundfile cannot open it; librosa may still decode it (mp3, m4a)
        dur = None
    try:
        y, sr = librosa.load(str(path), sr=22050, mono=True, duration=60)
    except Exception:  # noqa: BLE001
        return "This file could not be read as audio. Upload a WAV, MP3, FLAC, OGG or M4A file that is not corrupt."
    if dur is None:
        dur = librosa.get_duration(y=y, sr=sr)
    if dur < MIN_SECONDS:
        return f"This audio is only {dur:.1f} s long. Upload at least {MIN_SECONDS:.0f} seconds of music."
    if not np.isfinite(y).all() or float(np.abs(y).max()) < 1e-3:
        return "This audio is silent. Upload a recording that has sound in it."
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    if len(onsets) < MIN_ONSETS:
        return (f"Only {len(onsets)} beat-like event{'s' if len(onsets) != 1 else ''} found, so there is not enough rhythm to build motion from. "
                "Try a recording with a clearer beat.")
    return None


def save_job(jid: str) -> None:
    """Persist the job record so the list and the result survive a page reload or a server restart."""
    job = STATE[jid]
    try:
        (JOBS / jid / "job.json").write_text(json.dumps(job), encoding="utf-8")
    except OSError:
        pass


def get_job(jid: str) -> dict | None:
    if jid in STATE:
        return STATE[jid]
    f = JOBS / jid / "job.json"
    if not JOB_ID.match(jid) or not f.is_file():
        return None
    try:
        job = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if job.get("stage") not in TERMINAL:  # the server that was running it is gone
        job["stage"] = "error"
        job["error"] = "This job was interrupted when the server stopped. Upload the file again."
    return job


def list_jobs(limit: int = 20) -> list[dict]:
    rows = []
    for f in JOBS.glob("*/job.json"):
        job = get_job(f.parent.name)
        if job:
            rows.append({"id": f.parent.name, "name": job.get("name", "?"), "created": job.get("created", 0), "stage": job["stage"]})
    return sorted(rows, key=lambda r: -r["created"])[:limit]


def run(cmd: list[str], job: dict) -> None:
    job["log"].append("$ audiolab " + " ".join(cmd))
    try:
        p = subprocess.run(
            [sys.executable, "-m", "audiolab", *cmd], cwd=ROOT, capture_output=True, text=True, timeout=STAGE_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{cmd[0]} timed out after {STAGE_TIMEOUT}s") from None
    out = (p.stdout + p.stderr).strip().splitlines()
    job["log"].extend(out[-12:])
    if p.returncode:
        last = next((ln.strip() for ln in reversed(out) if ln.strip()), "no output")
        raise RuntimeError(f"{cmd[0]} failed (exit {p.returncode}): {last}")


def export_viz(song_dir: Path) -> None:
    a = np.load(song_dir / "analysis.npz")
    step = 3
    viz = {
        "duration": float(a["duration"]),
        "tempo": float(a["tempo"]),
        "feat_rate": float(a["sample_rate"]) / float(a["hop_length"]) / step,
        "bass": np.round(np.clip((a["band_bass_db"][::step] + 60) / 60, 0, 1), 3).tolist(),
        "mid": np.round(np.clip((a["band_mid_db"][::step] + 60) / 60, 0, 1), 3).tolist(),
        "high": np.round(np.clip((a["band_high_db"][::step] + 60) / 60, 0, 1), 3).tolist(),
        "onset": np.round(a["onset_env"][::step] / max(float(a["onset_env"].max()), 1e-9), 3).tolist(),
        "beats": np.round(a["beat_times"], 3).tolist(),
        "profiles": {},
    }
    for npz in sorted((song_dir / "motion").glob("motion_timeline.*.npz")):
        prof = npz.stem.split(".", 1)[1]
        meta = json.loads(npz.with_suffix(".json").read_text(encoding="utf-8"))
        z = np.load(npz)
        viz["profiles"][prof] = {
            "rate": meta["timebase"]["rate_hz"],
            "props": {k[6:]: np.round(z[k], 3).tolist() for k in z.files if k.startswith("prop__")},
            "level": np.round(z["scene_level"], 3).tolist(),
            "states": [
                {"state": s["state"], "start": s["start_s"], "end": s["end_s"]} for s in meta["states"]
            ],
        }
    (song_dir / "viz.json").write_text(json.dumps(viz), encoding="utf-8")


def pipeline(job_id: str, audio: Path) -> None:
    job = STATE[job_id]
    try:
        out = audio.parent / "out"
        job["stage"] = "analyze"
        save_job(job_id)
        run(["analyze", str(audio), "--out", str(out)], job)
        song_dir = out / audio.stem
        analysis = str(song_dir / "song_analysis.json")
        for stage, cmd in [("interpret", ["interpret", analysis]), ("visual", ["visual", "run", analysis]),
                           ("motion", ["motion", "run", analysis])]:
            job["stage"] = stage
            save_job(job_id)
            run(cmd, job)
        job["stage"] = "export"
        export_viz(song_dir)
        job["song"] = song_dir.relative_to(JOBS).as_posix()
        job["audio"] = audio.name
        job["plots"] = sorted(p.name for p in (song_dir / "plots").glob("*.png"))
        job["stage"] = "done"
        save_job(job_id)
    except Exception as e:  # noqa: BLE001
        job["log"].append(f"ERROR: {e}")
        job["error"] = (
            f"The pipeline could not process this file at the '{job['stage']}' stage. It may be too short, "
            f"corrupt or not a supported audio format. Details: {e}"
        )
        # Do not leave a half-built result behind: drop the upload and partial artifacts, keep a log.
        job_dir = audio.parent
        shutil.rmtree(job_dir / "out", ignore_errors=True)
        audio.unlink(missing_ok=True)
        (job_dir / "error.log").write_text("\n".join(job["log"]), encoding="utf-8")
        job["stage"] = "error"
        save_job(job_id)
    finally:
        RUN_LOCK.release()


PAGE = """<!doctype html><meta charset=utf-8><title>AudioLab demo</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
:root{--bg:#07090f;--fg:#e6ecf5;--mut:#8896ab;--card:#111827;--acc:#5eead4;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}p.s{color:var(--mut);margin:0 0 20px}
#drop{border:2px dashed #2b3a52;border-radius:14px;padding:48px;text-align:center;cursor:pointer;background:var(--card)}
#drop.over{border-color:var(--acc)}
.stages{display:flex;gap:8px;margin:20px 0;flex-wrap:wrap}.stg{padding:6px 12px;border-radius:99px;background:#1b2536;color:var(--mut)}
.stg.on{background:#134e4a;color:var(--acc)}.stg.ok{background:#14532d;color:#86efac}.stg.bad{background:#7f1d1d;color:#fecaca}
#err{background:#3b1219;color:#fecaca;border-radius:10px;padding:12px;margin:12px 0}
pre{background:#0b1220;padding:12px;border-radius:10px;max-height:240px;overflow:auto;color:#9fb0c8;font-size:12px}
canvas{width:100%;border-radius:14px;background:#050912;display:block}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}select,button{background:#1b2536;color:var(--fg);border:0;border-radius:8px;padding:8px 12px}
audio{flex:1;min-width:240px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.grid figure{margin:0;background:var(--card);border-radius:10px;padding:8px}.grid img{width:100%;border-radius:6px}figcaption{color:var(--mut);font-size:12px;padding:4px}
#rj{list-style:none;padding:0;margin:0}#rj li{display:flex;gap:12px;align-items:center;padding:8px 12px;margin:4px 0;background:var(--card);border-radius:8px}#rj a{color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#rj .t{color:var(--mut);font-size:12px}#rj .b{font-size:12px;padding:2px 8px;border-radius:99px;background:#134e4a;color:var(--acc)}#rj .b.done{background:#14532d;color:#86efac}#rj .b.error{background:#7f1d1d;color:#fecaca}[hidden]{display:none}h2{margin:28px 0 8px}
</style><main>
<h1>AudioLab</h1><p class=s>Upload a song. It runs analyze → interpret → visual mapping → motion, then plays the result.</p>
<div id=drop>Drop an audio file here or click to choose<input id=f type=file accept="audio/*" hidden></div>
<div id=run hidden><div class=stages id=stages></div><div id=err hidden></div><pre id=log></pre><button id=again hidden>Try another file</button></div>
<div id=res hidden>
 <h2>Playback driven by the motion timeline</h2>
 <canvas id=cv height=520></canvas>
 <div class=row><audio id=au controls></audio><label>Profile <select id=prof></select></label><span id=info></span>
 <button id=sq type=button>Open in Squall</button><span id=sqmsg></span>
 <label><input type=checkbox id=diag> Diagnostics</label><select id=iso hidden><option value=off>all bands<option value=bass>bass only<option value=mid>mid only<option value=high>high only</select></div>
 <h2>Stage outputs</h2><div class=grid id=plots></div>
</div>
<section id=recent hidden><h2>Recent jobs</h2><ul id=rj></ul></section></main>
<script>
const $=id=>document.getElementById(id),ST=%STAGES%;
$('drop').onclick=()=>$('f').click();$('diag').onchange=()=>{$('iso').hidden=!$('diag').checked};
['dragover','dragenter'].forEach(e=>$('drop').addEventListener(e,x=>{x.preventDefault();$('drop').classList.add('over')}));
['dragleave','drop'].forEach(e=>$('drop').addEventListener(e,x=>{x.preventDefault();$('drop').classList.remove('over')}));
$('drop').addEventListener('drop',x=>go(x.dataTransfer.files[0]));$('f').onchange=()=>go($('f').files[0]);
function fail(msg){$('err').hidden=false;$('err').textContent=msg;$('again').hidden=false}
$('again').onclick=()=>{location.hash='';location.reload()};
async function go(file){if(!file)return;
 $('drop').hidden=true;$('run').hidden=false;$('res').hidden=true;$('err').hidden=true;$('again').hidden=true;
 $('au').src=URL.createObjectURL(file);
 try{const r=await fetch('/upload?name='+encodeURIComponent(file.name),{method:'POST',body:file});
  const j=await r.json().catch(()=>({}));if(!r.ok)return fail(j.error||('Upload failed (HTTP '+r.status+').'));
  location.hash='job='+j.id;poll(j.id,false)}catch(e){fail('Upload failed: '+e.message)}}
async function poll(id,resumed){let j;
 try{j=await (await fetch('/status/'+id)).json()}catch(e){return fail('Lost connection to the server. Is it still running?')}
 if(resumed&&j.log.length===1&&j.log[0]==='unknown job'){location.hash='';return fail('That job no longer exists (the server was restarted).')}
 if(resumed){$('drop').hidden=true;$('run').hidden=false}
 const i=ST.indexOf(j.stage);
 $('stages').innerHTML=ST.map((s,k)=>`<span class="stg ${j.stage=='done'||k<i?'ok':k==i?(j.stage=='error'?'bad':'on'):''}">${s}</span>`).join('');
 if(j.stage=='error'){$('stages').innerHTML+='<span class="stg bad">error</span>';fail(j.error||'Processing failed.')}
 $('log').textContent=j.log.join('\\n');$('log').scrollTop=1e9;
 if(j.stage=='done')return show(j,resumed);if(j.stage!='error')setTimeout(()=>poll(id,resumed),1000)}
{const m=location.hash.match(/job=([a-f0-9]+)/);if(m)poll(m[1],true)}
let V,P;
$('sq').onclick=async()=>{const m=location.hash.match(/job=([a-f0-9]+)/);if(!m)return;const w=window.open('about:blank','_blank');
 $('sq').disabled=true;$('sqmsg').textContent=' Preparing the weather map (about a minute)...';
 try{const r=await fetch('/export/'+m[1],{method:'POST'});const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.url)throw new Error(j.error||('HTTP '+r.status));$('sqmsg').textContent='';if(w)w.location=j.url;else location.href=j.url}
 catch(e){if(w)w.close();$('sqmsg').textContent=' Could not open Squall: '+e.message}$('sq').disabled=false};
fetch('/jobs').then(r=>r.json()).then(js=>{if(!js.length)return;$('recent').hidden=false;
 $('rj').innerHTML=js.map(j=>`<li><a href="#job=${j.id}" data-id="${j.id}">${j.name.replace(/[<>&]/g,'')}</a><span class=t>${new Date(j.created*1000).toLocaleString()}</span><span class="b ${j.stage}">${j.stage=='done'?'completed':j.stage=='error'?'failed':'running: '+j.stage}</span></li>`).join('');
 $('rj').querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();location.hash='job='+a.dataset.id;location.reload()})}).catch(()=>{});
async function show(j,resumed){$('res').hidden=false;
 const base='/files/'+j.song+'/';
 if(resumed)$('au').src='/files/'+j.song.split('/')[0]+'/'+encodeURIComponent(j.audio||'');V=await (await fetch(base+'viz.json')).json();
 $('prof').innerHTML=Object.keys(V.profiles).map(p=>`<option>${p}</option>`).join('');
 $('prof').onchange=()=>P=V.profiles[$('prof').value];$('prof').onchange();
 $('info').textContent=`${V.tempo.toFixed(1)} BPM · ${V.duration.toFixed(0)} s`;
 $('plots').innerHTML=j.plots.filter(n=>!n.includes('_zoom')).map(n=>`<figure><img loading=lazy src="${base}plots/${encodeURIComponent(n)}"><figcaption>${n}</figcaption></figure>`).join('');
 $('res').scrollIntoView({behavior:'smooth'});draw()}
const at=(a,r,t)=>{const x=Math.max(0,Math.min(a.length-1,t*r));return a[Math.floor(x)]||0};
const parts=Array.from({length:260},()=>({x:Math.random(),y:Math.random(),z:Math.random()}));
function draw(){requestAnimationFrame(draw);if(!V)return;const c=$('cv'),w=c.width=c.clientWidth*devicePixelRatio,h=c.height=520*devicePixelRatio,x=c.getContext('2d');
 const t=$('au').currentTime,g=(n)=>at(P.props[n]||[],P.rate,t),f=(a)=>at(a,V.feat_rate,t);
 const DG=$('diag').checked,iso=DG?$('iso').value:'off';
 const bass=iso=='off'||iso=='bass'?f(V.bass):0,mid=iso=='off'||iso=='mid'?f(V.mid):0,high=iso=='off'||iso=='high'?f(V.high):0,on=f(V.onset);
 const st=P.states.find(s=>t>=s.start&&t<s.end),sname=st?st.state:'—';
 const push=g('camera__push'),punch=g('camera__punch'),shake=g('camera__shake');
 const dr=g('background__drift'),cs=g('background__color_shift'),sc=g('main_element__scale'),sw=g('main_element__sway'),ac=g('main_element__accent');
 const dens=g('particles__density'),sp=g('particles__sparkle'),bu=g('particles__burst');
 x.setTransform(1,0,0,1,0,0);x.fillStyle=`hsl(${220+cs*120},50%,${4+dr*7}%)`;x.fillRect(0,0,w,h);
 const cx=w/2+Math.sin(t*3)*shake*40*devicePixelRatio,cy=h/2+(Math.random()-.5)*shake*30,z=1+push*.35+punch*.6;
 x.translate(cx,cy);x.scale(z,z);x.translate(-w/2,-h/2);
 for(const p of parts){const s=.3+p.z;p.y=(p.y+.0006*s*(1+dr*4)+bu*.004*s)%1;
  const on=p.z<dens;if(!on)continue;x.globalAlpha=.25+Math.min(1,sp+.35*high)*.7*Math.random();x.fillStyle=`hsl(${180+cs*150+p.z*50},80%,${60+sp*25}%)`;
  x.beginPath();x.arc(p.x*w,p.y*h,(1+p.z*2+bu*3)*devicePixelRatio,0,7);x.fill()}
 x.globalAlpha=1;const R=Math.min(w,h)*(.12+.12*sc+bass*.08+ac*.05),mx=w/2+Math.sin(t*1.3)*sw*w*.12,my=h/2;
 const hue=170+cs*160,dp=devicePixelRatio;
 for(let k=4;k>=0;k--){x.beginPath();x.fillStyle=`hsla(${hue+mid*14},85%,${50+k*6+mid*6}%,${.08+(4-k)*.05+on*.1})`;x.arc(mx,my,R*(1+k*.35),0,7);x.fill()}
 x.beginPath();x.strokeStyle=`hsl(${hue},90%,70%)`;x.lineWidth=(2+ac*8)*dp;x.arc(mx,my,R,0,7);x.stroke();
 /* mid: rotating dashed inner ring that opens up and brightens with the mid band */
 x.save();x.beginPath();x.setLineDash([R*.22,R*.14]);x.lineDashOffset=-t*R*.35;x.lineWidth=2.5*dp;x.strokeStyle=`hsla(${hue+30},80%,78%,${.08+.5*mid})`;x.arc(mx,my,R*(.5+.22*mid),0,7);x.stroke();x.restore();
 /* high: shimmer ticks around the edge; length and brightness follow the high band, each tick flickers on its own phase */
 const hs=Math.min(1,Math.max(0,(high-.15)/.5)); /* real songs sit around 0.15-0.65, so stretch that range to 0-1 */
 x.save();x.lineWidth=2*dp;x.lineCap='round';for(let i=0;i<64;i++){const a=i/64*6.2832,fl=.5+.5*Math.sin(t*23+i*12.9898),len=R*(.02+.16*hs*fl);
  x.strokeStyle=`hsla(${hue+50},100%,93%,${.08+.9*hs*fl})`;x.beginPath();x.moveTo(mx+Math.cos(a)*R*1.03,my+Math.sin(a)*R*1.03);x.lineTo(mx+Math.cos(a)*(R*1.03+len),my+Math.sin(a)*(R*1.03+len));x.stroke()}x.restore();
 x.setTransform(1,0,0,1,0,0);x.fillStyle='#9fb0c8';x.font=`${13*devicePixelRatio}px system-ui`;
 x.fillText(`state: ${sname}   level ${at(P.level,P.rate,t).toFixed(2)}   bass ${bass.toFixed(2)}  mid ${mid.toFixed(2)}  high ${high.toFixed(2)}`,16*devicePixelRatio,24*devicePixelRatio);
 if(DG){[['bass',bass,'#f472b6'],['mid',mid,'#fbbf24'],['high',high,'#67e8f9']].forEach(([n,v,cl],i)=>{const X=w-150*dp,Y=(16+i*18)*dp;x.fillStyle='#1b2536';x.fillRect(X,Y,110*dp,8*dp);x.fillStyle=cl;x.fillRect(X,Y,110*dp*v,8*dp);x.fillStyle='#9fb0c8';x.fillText(n,X-34*dp,Y+8*dp)})}
 const bw=w-32*devicePixelRatio,y0=h-22*devicePixelRatio;x.fillStyle='#1b2536';x.fillRect(16*devicePixelRatio,y0,bw,8*devicePixelRatio);
 const col={rest:'#334155',build:'#0e7490',active:'#0d9488',settle:'#6d28d9'};
 for(const s of P.states){x.fillStyle=col[s.state]||'#0f766e';x.fillRect(16*devicePixelRatio+s.start/V.duration*bw,y0,(s.end-s.start)/V.duration*bw,8*devicePixelRatio)}
 x.fillStyle='#fff';x.fillRect(16*devicePixelRatio+t/V.duration*bw-1,y0-4*devicePixelRatio,2*devicePixelRatio,16*devicePixelRatio)}
</script>"""


WEB_KIT = ROOT / "web_kit"
WEB_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
             ".bin": "application/octet-stream", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac"}


def serve_web_kit(path: str) -> tuple[int, bytes, str] | None:
    """Serve the prebuilt Squall page (web_kit/preview) and the exported songs (web_kit/public/motion).

    Returns None when the path is not one of those. Build the bundles first: cd web_kit && npm run build:preview
    """
    if path == "/squall":
        f = WEB_KIT / "preview" / "squall.html"
    elif path in ("/squall.js", "/squall.css"):
        f = WEB_KIT / "preview" / "dist" / path[1:]
    elif path.startswith("/motion/"):
        f = (WEB_KIT / "public" / path[1:]).resolve()
        if (WEB_KIT / "public" / "motion").resolve() not in f.parents:
            return 404, b"not found", "text/plain"
    else:
        return None
    if not f.is_file():
        return 404, b"Squall is not built. Run: cd web_kit && npm run build:preview", "text/plain"
    return 200, f.read_bytes(), WEB_TYPES.get(f.suffix.lower(), "application/octet-stream")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_ranged(self, ctype: str, data: bytes) -> None:
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        if m and (m[1] or m[2]):  # single byte range, so seeking works for audio
            a = int(m[1]) if m[1] else max(0, len(data) - int(m[2]))
            z = min(int(m[2]), len(data) - 1) if m[1] and m[2] else len(data) - 1
            if a > z:
                return self._send(416, b"", "text/plain")
            self.send_response(206)
            self.send_header("content-type", ctype)
            self.send_header("content-range", f"bytes {a}-{z}/{len(data)}")
            self.send_header("content-length", str(z - a + 1))
            self.send_header("accept-ranges", "bytes")
            self.end_headers()
            self.wfile.write(data[a : z + 1])
            return
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.send_header("accept-ranges", "bytes")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/":
            return self._send(200, PAGE.replace("%STAGES%", json.dumps(STAGES)).encode())
        if path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        web = serve_web_kit(path)
        if web is not None:
            return self._send_ranged(web[2], web[1]) if web[0] == 200 else self._send(*web)
        if path == "/jobs":
            return self._send(200, json.dumps(list_jobs()).encode(), "application/json")
        if path.startswith("/status/"):
            job = get_job(path[8:])
            if job is None:  # the page keys off this body to say "that job no longer exists"
                return self._send(404, json.dumps({"stage": "error", "log": ["unknown job"]}).encode(), "application/json")
            return self._send(200, json.dumps(job).encode(), "application/json")
        if path.startswith("/files/"):
            f = (JOBS / path[7:]).resolve()
            if JOBS.resolve() in f.parents and f.is_file():
                ctype = {".json": "application/json", ".png": "image/png", ".wav": "audio/wav", ".mp3": "audio/mpeg",
                         ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg"}.get(f.suffix.lower(), "application/octet-stream")
                return self._send_ranged(ctype, f.read_bytes())
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.startswith("/export/"):
            if not RUN_LOCK.acquire(blocking=False):
                return self._send(409, json.dumps({"error": "Another song is still being processed."}).encode(), "application/json")
            try:
                song_id = export_web(u.path[8:], None)
            except SystemExit as e:  # export_web reports problems with sys.exit(message)
                return self._send(400, json.dumps({"error": str(e.code)}).encode(), "application/json")
            finally:
                RUN_LOCK.release()
            return self._send(200, json.dumps({"song": song_id, "url": f"/squall?source=song:{song_id}"}).encode(), "application/json")
        if u.path != "/upload":
            return self._send(404, b"", "text/plain")
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > MAX_UPLOAD or not RUN_LOCK.acquire(blocking=False):
            left = min(n, MAX_UPLOAD)  # drain what we can so the client sees the status, not a reset
            while left > 0 and self.rfile.read(min(1 << 20, left)):
                left -= 1 << 20
            if n <= 0:
                msg, code = "The file is empty.", 400
            elif n > MAX_UPLOAD:
                msg, code = f"File too large (limit {MAX_UPLOAD >> 20} MB).", 413
            else:
                msg, code = "Another song is still being processed. Wait for it to finish, then try again.", 409
            return self._send(code, json.dumps({"error": msg}).encode(), "application/json")
        name = re.sub(r"[^\w.\- ()]", "_", unquote(u.query.split("name=", 1)[-1]))[:120] or "song.wav"
        jid = uuid.uuid4().hex[:8]
        d = JOBS / jid
        d.mkdir(parents=True, exist_ok=True)
        audio = d / name
        try:
            with audio.open("wb") as fh:
                left = n
                while left:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    fh.write(chunk)
                    left -= len(chunk)
            if left:
                raise OSError("upload interrupted")
        except OSError:
            shutil.rmtree(d, ignore_errors=True)
            RUN_LOCK.release()
            return
        try:
            reason = preflight(audio)
        except Exception as e:  # noqa: BLE001 - never leave the lock held on an unexpected failure
            reason = f"This file could not be checked ({type(e).__name__}). Try a different file."
        if reason:
            shutil.rmtree(d, ignore_errors=True)
            RUN_LOCK.release()
            return self._send(400, json.dumps({"error": reason}).encode(), "application/json")
        STATE[jid] = {"stage": "analyze", "log": [f"received {name} ({n/1e6:.1f} MB)"], "song": None, "plots": [], "audio": None,
                      "error": None, "name": name, "created": time.time()}
        threading.Thread(target=pipeline, args=(jid, audio), daemon=True).start()
        self._send(200, json.dumps({"id": jid}).encode(), "application/json")


def export_web(jid: str, song_id: str | None) -> str:
    """Add a finished job to the web_kit Squall/Constellation song list (web_kit/public/motion).

    Runs scripts/export_web.py into a temp folder, then merges that one song into manifest.json so the songs
    already there are left alone. The uploaded audio is copied next to it so the instrument can play it.
    """
    job = get_job(jid)
    if not JOB_ID.match(jid) or not job or job.get("stage") != "done":
        sys.exit(f"job {jid} is not a finished job")
    job_dir = JOBS / jid
    audio = job_dir / job["audio"]
    if not audio.is_file():
        sys.exit(f"the uploaded audio is missing: {audio}")
    song_id = song_id or re.sub(r"[^a-z0-9]+", "-", Path(job["name"]).stem.lower()).strip("-")[:24] or f"job-{jid}"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", song_id):
        sys.exit("--song-id must be lowercase letters, digits and dashes")
    pub = ROOT / "web_kit" / "public" / "motion"
    (pub / "audio").mkdir(parents=True, exist_ok=True)
    web_audio = f"/motion/audio/{song_id}{audio.suffix.lower()}"
    shutil.copyfile(audio, pub / "audio" / f"{song_id}{audio.suffix.lower()}")
    spec = [{"id": song_id, "title": Path(job["name"]).stem, "motionDir": str(job_dir / job["song"].split("/", 1)[1] / "motion"),
             "source": str(audio), "audio": web_audio, "rights": "local test upload; the audio file is not committed (*.wav etc. are git-ignored)"}]
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "export_web.py"), "--spec", str(Path(tmp) / "spec.json"),
                            "--out", str(Path(tmp) / "out")], cwd=ROOT, capture_output=True, text=True,
                           env={**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(ROOT / "src"), os.environ.get("PYTHONPATH")]))})
        print(r.stdout + r.stderr)
        if r.returncode:
            sys.exit("export_web.py failed; web_kit/public/motion/manifest.json was not changed")
        shutil.rmtree(pub / song_id, ignore_errors=True)
        shutil.copytree(Path(tmp) / "out" / song_id, pub / song_id)
        entry = json.loads((Path(tmp) / "out" / "manifest.json").read_text(encoding="utf-8"))["songs"][0]
    mf = pub / "manifest.json"
    manifest = json.loads(mf.read_text(encoding="utf-8"))
    manifest["songs"] = [x for x in manifest["songs"] if x["id"] != song_id] + [entry]
    mf.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"added '{song_id}' to {mf} ({len(manifest['songs'])} songs). Squall: node web_kit/preview/serve.mjs 5353, "
          f"then http://localhost:5353/squall?source=song:{song_id} (or open it from this demo's page)")
    return song_id


def clean_old_jobs(port: int, keep: int, yes: bool) -> None:
    """List (and with --yes delete) old job folders under outputs/demo/. Never runs at server start."""
    root = JOBS.resolve()
    dirs = sorted((d for d in root.iterdir() if d.is_dir() and JOB_ID.match(d.name)), key=lambda d: -d.stat().st_mtime) if root.is_dir() else []
    active: set[str] = set()
    try:  # a running server knows which job is in progress
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/jobs", timeout=2) as r:
            active |= {j["id"] for j in json.load(r) if j["stage"] not in TERMINAL}
    except Exception:  # noqa: BLE001 - no server on that port
        pass
    for d in dirs:  # a record that says "running" and was touched recently is treated as active too
        f = d / "job.json"
        if f.is_file() and time.time() - f.stat().st_mtime < 7200:
            try:
                if json.loads(f.read_text(encoding="utf-8")).get("stage") not in TERMINAL:
                    active.add(d.name)
            except (OSError, ValueError):
                pass
    cands = [d for d in dirs[keep:] if d.name not in active]
    print(f"{root}: {len(dirs)} job folders, keeping newest {keep}, active: {sorted(active) or 'none'}")
    for d in cands:
        mb = sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) / 1e6
        print(f"  delete? {d.name}  {time.strftime('%Y-%m-%d %H:%M', time.localtime(d.stat().st_mtime))}  {mb:.1f} MB")
    if not cands:
        return print("nothing to delete")
    if not yes:
        return print(f"{len(cands)} folders listed. Dry run: nothing deleted. Re-run with --yes to delete them.")
    for d in cands:
        d = d.resolve()
        if d.parent == root and JOB_ID.match(d.name):  # belt and braces: only direct children of outputs/demo
            shutil.rmtree(d)
    print(f"deleted {len(cands)} folders")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--clean-old-jobs", action="store_true", help="list old job folders (add --yes to delete) and exit")
    ap.add_argument("--yes", action="store_true", help="confirm deletion for --clean-old-jobs")
    ap.add_argument("--keep", type=int, default=5, help="with --clean-old-jobs: newest folders to keep (default 5)")
    ap.add_argument("--export-web", metavar="JOB", help="add a finished job to web_kit's Squall/Constellation song list and exit")
    ap.add_argument("--song-id", help="with --export-web: id for the song (default: slug of the file name)")
    args = ap.parse_args()
    port = args.port
    if args.export_web:
        export_web(args.export_web, args.song_id)
        sys.exit(0)
    if args.clean_old_jobs:
        sys.exit(clean_old_jobs(port, args.keep, args.yes))
    JOBS.mkdir(parents=True, exist_ok=True)
    print(f"AudioLab demo on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
