import type { Client } from "@libsql/client";
import type { UserSettings } from "@osiris/shared";

export const DEFAULT_SETTINGS: UserSettings = { address: "auto", language: "auto", signature: "", instructions: "" };

/** "Můj profil" of users in one tenant: how the agent should treat each of them. */
export class UserSettingsStore {
  constructor(private readonly db: Client) {}

  async get(userId: string): Promise<UserSettings> {
    const { rows } = await this.db.execute({ sql: "SELECT * FROM user_settings WHERE user_id = ?", args: [userId] });
    const r = rows[0];
    if (!r) return { ...DEFAULT_SETTINGS };
    return {
      address: r.address as UserSettings["address"],
      language: r.language as UserSettings["language"],
      signature: String(r.signature),
      instructions: String(r.instructions),
    };
  }

  async put(userId: string, s: UserSettings): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO user_settings (user_id, address, language, signature, instructions) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET address = excluded.address, language = excluded.language,
              signature = excluded.signature, instructions = excluded.instructions, updated_at = datetime('now')`,
      args: [userId, s.address, s.language, s.signature, s.instructions],
    });
  }
}
