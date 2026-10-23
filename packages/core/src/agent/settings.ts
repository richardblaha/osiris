import { idName, type Records } from "../projects/records.ts";
import type { UserSettings } from "@osiris/shared";

export const DEFAULT_SETTINGS: UserSettings = { address: "auto", language: "auto", signature: "", instructions: "" };

/** "Můj profil" of users in one project: how the agent should treat each of them. */
export class UserSettingsStore {
  constructor(
    private readonly records: Records,
    /** The system's defaults for users who haven't saved their own (System > Nastavení). */
    private readonly defaults: () => Promise<Partial<UserSettings>> = async () => ({}),
  ) {}

  async get(userId: string): Promise<UserSettings> {
    const saved = await this.records.read<UserSettings>(`private/users/${idName(userId)}/settings.json`);
    return saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS, ...(await this.defaults().catch(() => ({}))) };
  }

  async put(userId: string, s: UserSettings): Promise<void> {
    const { address, language, signature, instructions } = s;
    await this.records.write(`private/users/${idName(userId)}/settings.json`, { address, language, signature, instructions });
  }
}
