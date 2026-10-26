import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { UserRecord } from "./users.ts";
import { CredentialError, type Credentials } from "./credentials.ts";

export interface RelyingParty {
  /** The host the passkeys belong to (`osiris.k6labs.cz`); they work only there and on its subdomains. */
  id: string;
  name: string;
  /** Origin of the pages that create and use them. */
  origin: string;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Passkeys (WebAuthn) as a full sign-in: discoverable credentials with user verification, so the device's PIN or
 * biometrics is the second factor and no TOTP is asked after them.
 */
export class Passkeys {
  constructor(
    private readonly credentials: Credentials,
    private readonly rp: RelyingParty,
  ) {}

  async registrationOptions(user: UserRecord): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.credentials.passkeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: this.rp.name,
      rpID: this.rp.id,
      userName: user.email ?? user.id,
      userDisplayName: user.name ?? user.email ?? "",
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await this.credentials.putChallenge(`passkey-register:${user.id}`, options.challenge, CHALLENGE_TTL_MS);
    return options;
  }

  async register(userId: string, response: RegistrationResponseJSON, name: string) {
    const challenge = await this.credentials.takeChallenge<string>(`passkey-register:${userId}`);
    if (!challenge) throw new CredentialError("errors.passkey.expired");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rp.id,
      requireUserVerification: true,
    }).catch((err: Error) => {
      throw new CredentialError("errors.passkey.verifyFailedDetail", { detail: err.message });
    });
    if (!result.verified) throw new CredentialError("errors.passkey.verifyFailed");
    const { credential } = result.registrationInfo;
    await this.credentials.addPasskey({
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name,
    });
  }

  /** Options for signing in; `key` ties the challenge to one sign-in (the interaction). */
  async authenticationOptions(key: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({ rpID: this.rp.id, userVerification: "required" });
    await this.credentials.putChallenge(`passkey-signin:${key}`, options.challenge, CHALLENGE_TTL_MS);
    return options;
  }

  /** The user the passkey belongs to, or null when it isn't one of ours or doesn't verify. */
  async authenticate(key: string, response: AuthenticationResponseJSON): Promise<string | null> {
    const challenge = await this.credentials.takeChallenge<string>(`passkey-signin:${key}`);
    if (!challenge) return null;
    const passkey = await this.credentials.passkey(response.id);
    if (!passkey) return null;
    // A discoverable credential names its user; it must be the one we stored it for.
    if (response.response.userHandle && Buffer.from(response.response.userHandle, "base64url").toString() !== passkey.userId) return null;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rp.id,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified) return null;
    await this.credentials.usePasskey(passkey.id, result.authenticationInfo.newCounter);
    return passkey.userId;
  }
}
