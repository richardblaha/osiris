import type { Identity } from "../auth/oidc.ts";
import { displayName, type PocketIdClient, type PocketIdUser } from "../pocketid.ts";

/** Finds the PocketID user behind a WhatsApp number. WhatsApp has no token, so this replaces OIDC for the channel. */
export interface PhoneDirectory {
  /** The user whose custom claim `phone_number` is this number, or null (unknown, disabled or shared by several users). */
  lookup(phone: string): Promise<Identity | null>;
}

/** Digits only, so PocketID's "+420 777 123 456" matches WhatsApp's "420777123456". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "");

/** How long the user list is reused, so new users, numbers and group changes apply within this time. */
const DIRECTORY_TTL_MS = 60_000;

/**
 * Reads users from the PocketID admin API (`GET /api/users`) and indexes them by `phone_number`.
 * The whole list is cached for a minute; a number claimed by two users matches neither.
 */
export function pocketIdDirectory(pocketId: PocketIdClient): PhoneDirectory {
  let snapshot: Promise<Map<string, Identity | null>> | undefined;
  let loadedAt = 0;

  const load = async () => {
    const byPhone = new Map<string, Identity | null>();
    for (const user of await pocketId.all<PocketIdUser>("api/users")) {
      const phone = user.customClaims?.find((c) => c.key === "phone_number")?.value;
      const key = phone ? phoneKey(phone) : "";
      if (!key || user.disabled) continue;
      if (byPhone.has(key)) {
        byPhone.set(key, null);
        continue;
      }
      const groups = user.userGroups ?? (await pocketId.get<{ name: string }[]>(`api/users/${encodeURIComponent(user.id)}/groups`));
      byPhone.set(key, {
        sub: user.id,
        email: user.email || null,
        name: displayName(user),
        phone: phone!,
        picture: null,
        groups: groups.map((g) => g.name),
      });
    }
    return byPhone;
  };

  return {
    async lookup(phone) {
      if (!snapshot || Date.now() - loadedAt > DIRECTORY_TTL_MS) {
        loadedAt = Date.now();
        const loading = load();
        // Don't cache failures; the next message retries.
        loading.catch(() => {
          if (snapshot === loading) snapshot = undefined;
        });
        snapshot = loading;
      }
      return (await snapshot).get(phoneKey(phone)) ?? null;
    },
  };
}
