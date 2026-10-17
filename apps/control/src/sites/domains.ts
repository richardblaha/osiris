import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { SiteDomain } from "@osiris/shared";
import { run, type Db } from "@osiris/platform/rqlite.ts";

/** A lowercase hostname with at least two labels; no IPs, no wildcards, no trailing dot. */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const CHALLENGE_PREFIX = "_osiris-challenge";
/** Verified domains are re-checked this often; one that no longer points at us is taken offline. */
const RECHECK_MS = 6 * 60 * 60_000;

export class DomainError extends Error {}

export interface DnsLookup {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
}

/** Public resolvers, so the cluster's own DNS (and its caching or split horizon) doesn't decide. */
export function publicDns(): DnsLookup {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return r;
}

interface Row {
  domain: string;
  tenant_id: string;
  status: string;
  token: string;
  release_id: string | null;
  error: string | null;
  verified_at: number | null;
}

/**
 * Custom domains of tenant sites. A tenant proves a domain is theirs with a TXT record and points it at our ingress;
 * only then does the operator create an ingress and certificate for it (HTTP-01). One domain belongs to one tenant,
 * our own domains can't be claimed, and each tenant has a limit (Let's Encrypt rate limits).
 */
export class DomainStore {
  constructor(
    private readonly db: Db,
    private readonly dns: DnsLookup,
    private readonly options: { ingressIps: string[]; cnameTarget?: string; maxPerTenant: number; reserved: string[] },
  ) {}

  private view = (r: Row): SiteDomain => ({
    domain: r.domain,
    status: r.status as SiteDomain["status"],
    token: r.token,
    error: r.error,
    releaseId: r.release_id,
    verifiedAt: r.verified_at == null ? null : new Date(Number(r.verified_at)).toISOString(),
    target: { ips: this.options.ingressIps, cname: this.options.cnameTarget ?? null },
  });

  async list(tenantId: string): Promise<SiteDomain[]> {
    return (await this.db.query<Row>("SELECT * FROM domains WHERE tenant_id = ? ORDER BY domain", [tenantId])).map(this.view);
  }

  async get(tenantId: string, domain: string, { fresh = true } = {}): Promise<SiteDomain | null> {
    const [row] = await this.db.query<Row>("SELECT * FROM domains WHERE tenant_id = ? AND domain = ?", [tenantId, domain], { fresh });
    return row ? this.view(row) : null;
  }

  async add(tenantId: string, input: string, now = Date.now()): Promise<SiteDomain> {
    const domain = input.trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN.test(domain)) throw new DomainError("Neplatná doména (např. www.mojefirma.cz)");
    if (this.options.reserved.some((r) => domain === r || domain.endsWith(`.${r}`))) throw new DomainError("Tuto doménu nelze použít");
    const existing = await this.list(tenantId);
    if (existing.some((d) => d.domain === domain)) return existing.find((d) => d.domain === domain)!;
    if (existing.length >= this.options.maxPerTenant) throw new DomainError(`Tenant může mít nejvýš ${this.options.maxPerTenant} domén`);
    const [r] = await this.db.execute([
      run(
        "INSERT INTO domains (domain, tenant_id, token, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO NOTHING",
        domain,
        tenantId,
        `osiris-${randomBytes(16).toString("hex")}`,
        now,
      ),
    ]);
    if (!r?.rowsAffected) throw new DomainError("Doménu už používá jiný tenant");
    return (await this.get(tenantId, domain))!;
  }

  /** Checks the TXT record and where the domain points; returns the new state. */
  async verify(tenantId: string, domain: string, now = Date.now()): Promise<SiteDomain> {
    const current = await this.get(tenantId, domain);
    if (!current) throw new DomainError("Doména nenalezena");
    const error = (await this.proofError(domain, current.token)) ?? (await this.pointsError(domain));
    await this.db.execute([
      run(
        `UPDATE domains SET status = ?, error = ?, checked_at = ?, verified_at = CASE WHEN ? = 'verified' THEN COALESCE(verified_at, ?) ELSE verified_at END
         WHERE tenant_id = ? AND domain = ?`,
        error ? "failed" : "verified",
        error,
        now,
        error ? "failed" : "verified",
        now,
        tenantId,
        domain,
      ),
    ]);
    return (await this.get(tenantId, domain))!;
  }

  async remove(tenantId: string, domain: string) {
    const [r] = await this.db.execute([run("DELETE FROM domains WHERE tenant_id = ? AND domain = ?", tenantId, domain)]);
    if (!r?.rowsAffected) throw new DomainError("Doména nenalezena");
  }

  /**
   * Re-checks verified domains that weren't checked for a while. A domain that no longer points at us goes offline,
   * so whoever gets it next can't be served the old tenant's site, and we stop renewing its certificate.
   * Returns the tenants whose set of verified domains changed.
   */
  async recheck(now = Date.now(), limit = 20): Promise<string[]> {
    const due = await this.db.query<Row>(
      "SELECT * FROM domains WHERE status = 'verified' AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?",
      [now - RECHECK_MS, limit],
    );
    const changed = new Set<string>();
    for (const d of due) {
      const error = await this.pointsError(d.domain);
      await this.db.execute([
        run(
          "UPDATE domains SET status = ?, error = ?, checked_at = ? WHERE domain = ?",
          error ? "failed" : "verified",
          error,
          now,
          d.domain,
        ),
      ]);
      if (error) changed.add(d.tenant_id);
    }
    return [...changed];
  }

  private async proofError(domain: string, token: string): Promise<string | null> {
    const records = await this.dns.resolveTxt(`${CHALLENGE_PREFIX}.${domain}`).catch(() => [] as string[][]);
    return records.some((chunks) => chunks.join("") === token)
      ? null
      : `Chybí TXT záznam ${CHALLENGE_PREFIX}.${domain} s hodnotou ${token}`;
  }

  private async pointsError(domain: string): Promise<string | null> {
    const { ingressIps, cnameTarget } = this.options;
    const cnames = await this.dns.resolveCname(domain).catch(() => [] as string[]);
    if (cnameTarget && cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === cnameTarget)) return null;
    const addresses = [...(await this.dns.resolve4(domain).catch(() => [])), ...(await this.dns.resolve6(domain).catch(() => []))];
    // Every address must be ours: a domain still half pointing elsewhere would fail certificate checks randomly.
    if (addresses.length && ingressIps.length && addresses.every((a) => ingressIps.includes(a))) return null;
    const want = [ingressIps.length ? `A záznam na ${ingressIps.join(", ")}` : null, cnameTarget ? `CNAME na ${cnameTarget}` : null]
      .filter(Boolean)
      .join(" nebo ");
    return `Doména nemíří na Osiris: nastav ${want || "záznam podle správce"}`;
  }
}
