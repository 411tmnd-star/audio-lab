"use client";

import ChromaCanvas, { type ChromaDebug } from "@/components/chroma/ChromaCanvas";
import { SourcePicker, Transport } from "@/components/pipeline/Controls";
import type { Quality } from "@/lib/chroma/field";
import type { AudioPipeline } from "@/lib/pipeline";
import { AudioPipelineProvider, useSceneState } from "@/lib/pipeline/react";

/**
 * The Chroma Field experience: one shared audio pipeline, the WebGL scene, and the same source and transport controls
 * the other visuals use. The scene reads the pipeline's frames and nothing else.
 */
export default function Chroma({ pipeline, debugRef, quality }: { pipeline?: AudioPipeline; debugRef?: { current: ChromaDebug | null }; quality?: Quality }) {
  return (
    <AudioPipelineProvider pipeline={pipeline}>
      <Shell debugRef={debugRef} quality={quality} />
    </AudioPipelineProvider>
  );
}

function Shell({ debugRef, quality }: { debugRef?: { current: ChromaDebug | null }; quality?: Quality }) {
  const scene = useSceneState();
  return (
    <section
      aria-labelledby="chroma-title"
      data-scene={scene}
      className="relative isolate flex min-h-[85vh] flex-col overflow-hidden rounded-3xl bg-[#02030a] text-slate-100 ring-1 ring-white/10"
    >
      <div className="relative min-h-[22rem] flex-1">
        <div className="absolute inset-0">
          <ChromaCanvas debugRef={debugRef} quality={quality} />
        </div>
        <header className="pointer-events-none relative p-5 sm:p-6">
          <h2 id="chroma-title" className="text-lg font-semibold tracking-tight">
            Chroma Field
          </h2>
          <p className="max-w-md text-sm text-slate-300/90">
            Music as a drifting volume of colour. Bass swells the cloud in indigo and magenta, mids swirl teal filaments through it, highs add pink sparkle, and each detected onset (not a beat grid) sends a dispersion burst through the field.
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
