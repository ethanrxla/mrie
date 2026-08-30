import type { DataStore } from "@/lib/data/types";
import { getEnv, isLocalMode } from "@/lib/env";

let storePromise: Promise<DataStore> | undefined;

export function getStore(): Promise<DataStore> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    const env = getEnv();
    if (isLocalMode(env)) {
      const { LocalStore } = await import("@/lib/data/local-store");
      return new LocalStore();
    }
    const { PostgresStore } = await import("@/lib/data/postgres-store");
    return new PostgresStore(env.DATABASE_URL as string);
  })();
  return storePromise;
}

export function resetStoreForTests(): void {
  storePromise = undefined;
}
