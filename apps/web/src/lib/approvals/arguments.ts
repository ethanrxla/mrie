import { hashConfirmationArguments } from "@/lib/auth/confirmation";
import type { Automation } from "@/lib/data/types";

export function automationRunArgumentsHash(automation: Automation): string {
  return hashConfirmationArguments({
    action: "automation.run",
    automationId: automation.id,
    name: automation.name,
    description: automation.description ?? null,
    triggerConfig: automation.triggerConfig,
    steps: automation.steps,
    updatedAt: automation.updatedAt,
  });
}
