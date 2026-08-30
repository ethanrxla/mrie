import { getCurrentUser } from "@/lib/auth/session";
import { isLocalMode } from "@/lib/env";
import { jsonError, noStoreJson } from "@/lib/http";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return noStoreJson({
      authenticated: Boolean(user),
      localMode: isLocalMode(),
      user: user
        ? {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            preferredName: user.preferredName,
            company: user.company,
            roleTitle: user.roleTitle,
            timezone: user.timezone,
            onboardingComplete: Boolean(user.onboardingCompletedAt),
          }
        : null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
