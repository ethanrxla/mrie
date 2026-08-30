import type { Metadata } from "next";

import { MemoryView } from "@/components/pages/memory-view";

export const metadata: Metadata = { title: "Memory" };

export default function MemoryPage() {
  return <MemoryView />;
}
