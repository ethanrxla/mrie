import { assertSameOrigin, destroySession } from "@/lib/auth/session";
import { jsonError, noStoreJson } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await assertSameOrigin(request);
    await destroySession();
    return noStoreJson({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
