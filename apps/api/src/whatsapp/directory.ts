import type { Identity } from "../auth/oidc.ts";
import { userAccess } from "../tenants/directory.ts";
import type { UserDirectory } from "../users.ts";

/** Finds the PocketID user behind a WhatsApp number. WhatsApp has no token, so this replaces OIDC for the channel. */
export interface PhoneDirectory {
  /** The user whose custom claim `phone_number` is this number, or null (unknown, disabled or shared by several users). */
  lookup(phone: string): Promise<Identity | null>;
}

/** Digits only, so PocketID's "+420 777 123 456" matches WhatsApp's "420777123456". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "");

/**
 * Indexes the users (PocketID admin API, cached for a minute by the user directory) by `phone_number`.
 * A number claimed by two users matches neither.
 */
export function phoneDirectory(users: UserDirectory): PhoneDirectory {
  return {
    async lookup(phone) {
      const key = phoneKey(phone);
      if (!key) return null;
      const matches = (await users.list()).filter((u) => {
        const claim = u.claims.phone_number;
        return claim && !u.disabled && phoneKey(claim) === key;
      });
      if (matches.length !== 1) return null;
      const user = matches[0]!;
      return {
        sub: user.id,
        email: user.email,
        name: user.name,
        phone: user.claims.phone_number!,
        picture: null,
        access: userAccess(user),
      };
    },
  };
}
