import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/data";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const memories = await (await getStore()).listMemories(user.id);
    return new Response(
      JSON.stringify({ exportedAt: new Date().toISOString(), userId: user.id, memories }, null, 2),
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="mre-memory-${new Date().toISOString().slice(0, 10)}.json"`,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  } catch (error) {
    return jsonError(error);
  }
}
