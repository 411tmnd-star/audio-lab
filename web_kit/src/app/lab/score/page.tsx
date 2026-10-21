import type { Metadata } from "next";

import Score from "@/components/score/Score";

export const metadata: Metadata = {
  title: "Score: music written as it plays",
  description: "Three horizontal lanes record bass, mids and highs as the music unfolds, scrolling right to left, with detected onsets marked on the same timeline. A WebGL scene on the shared audio pipeline.",
};

export default function ScorePage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <Score />
    </main>
  );
}
