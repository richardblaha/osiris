import type { Client } from "@libsql/client";
import { FEATURES, NO_QUOTAS, type Feature, type Guard, type ProjectFeatures, type UserDefaults, type ProjectQuotas } from "@osiris/shared";

/** Everything is on until a system admin switches it off, so existing projects keep working. */
export const DEFAULT_FEATURES: ProjectFeatures = Object.fromEntries(FEATURES.map((f) => [f, true])) as ProjectFeatures;

/** Which features the project may use. Read on every agent step, so implementations cache. */
export interface FeatureSource {
  get(): Promise<ProjectFeatures>;
  enabled(feature: Feature): Promise<boolean>;
  /** Built-in tools a system admin switched off for the project, by name. */
  disabledTools(): Promise<string[]>;
  /** The project's limits (storage, tokens per month, ...). */
  quotas(): Promise<ProjectQuotas>;
  /** Rules for every project, set by system admins; they come before the project's and the user's. */
  systemGuards(): Promise<Guard[]>;
  /** The system's defaults for users' assistant settings. */
  userDefaults?(): Promise<Partial<UserDefaults>>;
}
