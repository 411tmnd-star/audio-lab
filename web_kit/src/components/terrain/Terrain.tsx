"use client";

import TerrainCanvas, { type TerrainDebug } from "@/components/terrain/TerrainCanvas";
import { SourcePicker, Transport } from "@/components/pipeline/Controls";
import type { AudioPipeline } from "@/lib/pipeline";
import { AudioPipelineProvider, useSceneState } from "@/lib/pipeline/react";

/**
 * The Terrain with Memory experience: one shared audio pipeline, the WebGL scene, and the same source and transport controls
 * the other visuals use. The scene reads the pipeline's frames and nothing else.
 */
export default function Terrain({ pipeline, debugRef, decor }: { pipeline?: AudioPipeline; debugRef?: { current: TerrainDebug | null }; decor?: boolean }) {
  return (
    <AudioPipelineProvider pipeline={pipeline}>
      <Shell debugRef={debugRef} decor={decor} />
    </AudioPipelineProvider>
  );
}

function Shell({ debugRef, decor }: { debugRef?: { current: TerrainDebug | null }; decor?: boolean }) {
  const scene = useSceneState();
  return (
    <section
      aria-labelledby="terrain-title"
      data-scene={scene}
      className="relative isolate flex min-h-[85vh] flex-col overflow-hidden rounded-3xl bg-[#04060b] text-slate-100 ring-1 ring-white/10"
    >
      <div className="relative min-h-[22rem] flex-1">
        <div className="absolute inset-0">
          <TerrainCanvas debugRef={debugRef} decor={decor} />
        </div>
        <header className="pointer-events-none relative p-5 sm:p-6">
          <h2 id="terrain-title" className="text-lg font-semibold tracking-tight">
            Terrain with Memory
          </h2>
          <p className="max-w-md text-sm text-slate-300/90">
            The music becomes land. Bass raises broad amber ridges, mids roll cyan valleys, highs add fine violet crests. New relief appears at the near edge and recedes, so the landscape keeps what was played. A ripple marks each detected onset (not a beat grid).
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
