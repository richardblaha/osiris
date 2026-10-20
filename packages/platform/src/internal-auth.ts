import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from "jose";
import type { Channel, Role } from "@osiris/shared";

/**
 * Identity carried between Osiris services in a short-lived ES256 JWT. Only the gateway sees PocketID tokens; it
 * verifies them and passes on who the user is. Control (scheduled runs, WhatsApp) and the operator (activity,
 * snapshots) sign the same way for their own calls. Runtimes hold only the public key.
 */
export interface InternalUser {
  sub: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  picture: string | null;
}

export interface InternalClaims {
  /** The user the call is made for; absent for system calls (operator, control housekeeping). */
  user?: InternalUser;
  /** The tenant the call is about, with the user's role in it. */
  tenant?: string;
  role?: Role;
  channel?: Channel;
  /** A customer on the tenant's public chat (no user, no role): the visitor's random id from their browser. */
  visitor?: string;
  /** Gateway → control: every tenant the user may open, and whether they are a system admin. */
  memberships?: { tenantId: string; role: Role }[];
  systemAdmin?: boolean;
  /** Claim names PocketID returned, to explain a refused account. */
  claimKeys?: string[];
}

export interface VerifiedCall extends InternalClaims {
  /** Which service signed the call: `gateway`, `control` or `operator`. */
  issuer: string;
}

const ALG = "ES256";
const DEFAULT_TTL_S = 60;
const CLAIM = "osiris";

export const tenantAudience = (tenant: string) => `tenant:${tenant}`;
export const CONTROL_AUDIENCE = "control";

export class InternalSigner {
  private key?: Promise<CryptoKey>;

  constructor(
    private readonly privateKeyPem: string,
    readonly issuer: string,
  ) {}

  async sign(audience: string, claims: InternalClaims, ttlSeconds = DEFAULT_TTL_S): Promise<string> {
    this.key ??= importPKCS8(this.privateKeyPem, ALG);
    return new SignJWT({ [CLAIM]: claims })
      .setProtectedHeader({ alg: ALG })
      .setIssuer(this.issuer)
      .setSubject(claims.user?.sub ?? `system:${this.issuer}`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(await this.key);
  }

  /** `authorization` header value for a call to `audience`. */
  async header(audience: string, claims: InternalClaims = {}, ttlSeconds?: number) {
    return `Bearer ${await this.sign(audience, claims, ttlSeconds)}`;
  }
}

export class InternalAuthError extends Error {}

export class InternalVerifier {
  private key?: Promise<CryptoKey>;

  constructor(
    private readonly publicKeyPem: string,
    private readonly issuers: string[] = ["gateway", "control", "operator"],
  ) {}

  async verify(token: string, audience: string): Promise<VerifiedCall> {
    this.key ??= importSPKI(this.publicKeyPem, ALG);
    try {
      const { payload } = await jwtVerify(token, await this.key, { audience, issuer: this.issuers, algorithms: [ALG] });
      const claims = (payload[CLAIM] ?? {}) as InternalClaims;
      if (claims.user && claims.user.sub !== payload.sub) throw new InternalAuthError("Subject mismatch");
      return { ...claims, issuer: payload.iss! };
    } catch (err) {
      if (err instanceof InternalAuthError) throw err;
      throw new InternalAuthError(`Invalid internal token: ${(err as Error).message}`);
    }
  }

  /** Verifies the `authorization: Bearer` header of a request. */
  verifyHeader(header: string | undefined, audience: string): Promise<VerifiedCall> {
    const token = header?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return Promise.reject(new InternalAuthError("Missing internal token"));
    return this.verify(token, audience);
  }
}

/** A fresh key pair (PEM), for `pnpm --filter @osiris/platform gen-keys` and tests. */
export async function generateInternalKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  return { privateKey: await exportPKCS8(privateKey), publicKey: await exportSPKI(publicKey) };
}
