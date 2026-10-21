import type { Metadata } from "next";

import Chroma from "@/components/chroma/Chroma";

export const metadata: Metadata = {
  title: "Chroma Field: music as drifting colour",
  description: "A volumetric field of drifting particles and billowing ink-like colour driven by bass, mids, highs and detected onsets. A WebGL scene on the shared audio pipeline.",
};

export default function ChromaPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <Chroma />
    </main>
  );
}
