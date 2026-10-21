"use client";

import ScoreCanvas, { type ScoreDebug } from "@/components/score/ScoreCanvas";
import { SourcePicker, Transport } from "@/components/pipeline/Controls";
import type { AudioPipeline } from "@/lib/pipeline";
import { AudioPipelineProvider, useSceneState } from "@/lib/pipeline/react";

/**
 * The Score experience: one shared audio pipeline, the WebGL scene, and the same source and transport controls the other
 * visuals use. The scene reads the pipeline's frames and nothing else.
 */
export default function Score({ pipeline, debugRef, decor }: { pipeline?: AudioPipeline; debugRef?: { current: ScoreDebug | null }; decor?: boolean }) {
  return (
    <AudioPipelineProvider pipeline={pipeline}>
      <Shell debugRef={debugRef} decor={decor} />
    </AudioPipelineProvider>
  );
}

function Shell({ debugRef, decor }: { debugRef?: { current: ScoreDebug | null }; decor?: boolean }) {
  const scene = useSceneState();
  return (
    <section
      aria-labelledby="score-title"
      data-scene={scene}
      className="relative isolate flex min-h-[85vh] flex-col overflow-hidden rounded-3xl bg-[#03040a] text-slate-100 ring-1 ring-white/10"
    >
      <div className="relative min-h-[22rem] flex-1">
        <div className="absolute inset-0">
          <ScoreCanvas debugRef={debugRef} decor={decor} />
        </div>
        <header className="pointer-events-none relative p-5 sm:p-6">
          <h2 id="score-title" className="text-lg font-semibold tracking-tight">
            Score
          </h2>
          <p className="max-w-md text-sm text-slate-300/90">
            The music written as it plays, right to left: bass in amber, mids in cyan, highs in violet. Thin rules mark detected onsets (not a beat grid). Gridlines are one second apart.
          </p>
        </header>
      </div>
      <div className="relative m-3 space-y-3 rounded-2xl border border-white/10 bg-black/45 p-4 backdrop-blur-md sm:m-5 sm:mt-0">
        <SourcePicker />
        <Transport />
      </div>
    </section>
  );
}
