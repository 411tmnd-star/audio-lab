import type { Metadata } from "next";

import Resonator from "@/components/resonator/Resonator";

export const metadata: Metadata = {
  title: "Resonator: a glass orb inside waves of sound",
  description: "Bass pulses a glass orb and its plasma heart, mids lift the inner wave ribbons, highs ripple the outer ones and speed the orbiting beads, and detected onsets flash the gold tracks. A WebGL scene on the shared audio pipeline.",
};

export default function ResonatorPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <Resonator />
    </main>
  );
}
