import type { Metadata } from "next";

import Terrain from "@/components/terrain/Terrain";

export const metadata: Metadata = {
  title: "Terrain with Memory: the music becomes land",
  description: "A continuous three-dimensional landscape built from bass, mids and highs. New relief appears at the near edge and recedes, so the terrain keeps the history of the audio. A WebGL scene on the shared audio pipeline.",
};

export default function TerrainPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <Terrain />
    </main>
  );
}
