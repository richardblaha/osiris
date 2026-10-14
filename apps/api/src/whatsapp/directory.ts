import type { Identity } from "../auth/oidc.ts";

/** Finds the PocketID user behind a WhatsApp number. WhatsApp has no token, so this replaces OIDC for the channel. */
export interface PhoneDirectory {
  /** The user whose custom claim `phone_number` is this number, or null (unknown, disabled or shared by several users). */
  lookup(phone: string): Promise<Identity | null>;
}

/** Digits only, so PocketID's "+420 777 123 456" matches WhatsApp's "420777123456". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "");

/** How long the user list is reused, so new users, numbers and group changes apply within this time. */
const DIRECTORY_TTL_MS = 60_000;
const PAGE_SIZE = 100;

interface PocketIdUser {
  id: string;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  disabled?: boolean;
  customClaims?: { key: string; value: string }[];
  userGroups?: { name: string }[];
}

interface UserPage {
  data: PocketIdUser[];
  pagination?: { totalPages?: number };
}

/**
 * Reads users from the PocketID admin API (`GET /api/users` with `X-API-KEY`) and indexes them by `phone_number`.
 * The whole list is cached for a minute; a number claimed by two users matches neither.
 */
export function pocketIdDirectory(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): PhoneDirectory {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  let snapshot: Promise<Map<string, Identity | null>> | undefined;
  let loadedAt = 0;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(new URL(path, base), { headers: { "x-api-key": apiKey, accept: "application/json" } });
    if (!res.ok) throw new Error(`PocketID ${path.split("?")[0]} failed: ${res.status}`);
    return (await res.json()) as T;
  };

  const load = async () => {
    const byPhone = new Map<string, Identity | null>();
    for (let page = 1; ; page++) {
      const { data, pagination } = await get<UserPage>(`api/users?pagination[page]=${page}&pagination[limit]=${PAGE_SIZE}`);
      for (const user of data) {
        const phone = user.customClaims?.find((c) => c.key === "phone_number")?.value;
        const key = phone ? phoneKey(phone) : "";
        if (!key || user.disabled) continue;
        if (byPhone.has(key)) {
          byPhone.set(key, null);
          continue;
        }
        const groups = user.userGroups ?? (await get<{ name: string }[]>(`api/users/${encodeURIComponent(user.id)}/groups`));
        byPhone.set(key, {
          sub: user.id,
          email: user.email || null,
          name: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          phone: phone!,
          groups: groups.map((g) => g.name),
        });
      }
      if (!data.length || page >= (pagination?.totalPages ?? page)) break;
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
