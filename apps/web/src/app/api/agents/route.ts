import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError, noStoreJson } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const store = await getStore();
    const runs = await store.listAgentRuns(user.id);
    const preferences = await store.listPreferences(user.id);
    const names = [...new Set(runs.map((run) => run.agentName))];
    const agents = names.map((name) => {
      const history = runs
        .filter((run) => run.agentName === name)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const current = history.find((run) => ["running", "queued", "waiting_approval"].includes(run.status));
      const finished = history.filter((run) => run.completedAt);
      const successful = finished.filter((run) => run.success).length;
      const paused = preferences.find((item) => item.key === `agent.paused.${name}`)?.value === true;
      return {
        name,
        status: paused ? "paused" : (current?.status ?? history[0]?.status ?? "completed"),
        paused,
        currentTask: current?.request,
        lastRun: history[0]?.completedAt ?? history[0]?.createdAt,
        successRate: finished.length ? Math.round((successful / finished.length) * 1_000) / 10 : null,
        queueLength: history.filter((run) => run.status === "queued").length,
        completedRuns: finished.length,
        successfulRuns: successful,
        recentRuns: history.slice(0, 8),
      };
    });
    return noStoreJson({ agents, runs });
  } catch (error) {
    return jsonError(error);
  }
}
