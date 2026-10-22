import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import { EMPTY_GEO, type GeoLocation } from "@osiris/platform/geoip.ts";
import { parseUserAgent } from "@osiris/platform/user-agent.ts";
import type { LoginEvent, LoginSession } from "@osiris/shared";

type Location = GeoLocation & ReturnType<typeof parseUserAgent>;
const fallback: Location = { ...EMPTY_GEO, ...parseUserAgent("", 0) };

export class AuthActivity {
  constructor(private db: Db, private geo: (ip: string) => GeoLocation = () => EMPTY_GEO) {}
  private location(ip: string, ua: string): Location { return { ...this.geo(ip), ...parseUserAgent(ua.slice(0, 1000), 0) }; }
  async record(user: string, success: boolean, method: string, rawIp: string, ua: string) {
    const ip = isIP(rawIp) ? rawIp : "";
    await this.db.execute([run("INSERT INTO auth_events(id,user_id,at,success,method,ip,location) VALUES(?,?,?,?,?,?,?)", randomUUID(), user, Date.now(), Number(success), method, ip, JSON.stringify(this.location(ip, ua)))]);
  }
  async observe(user: string, uid: string, rawIp: string, ua: string) {
    const now = Date.now();
    const [row] = await this.db.query<{ last_seen_at: number; user_id: string }>("SELECT last_seen_at,user_id FROM auth_session_info WHERE uid = ?", [uid]);
    if (row && row.user_id === user && now - Number(row.last_seen_at) < 5 * 60_000) return;
    const ip = isIP(rawIp) ? rawIp : "";
    await this.db.execute([run(`INSERT INTO auth_session_info(uid,user_id,last_seen_at,ip,location) VALUES(?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET user_id=excluded.user_id, last_seen_at=excluded.last_seen_at, ip=excluded.ip, location=excluded.location
      WHERE auth_session_info.user_id != excluded.user_id OR auth_session_info.last_seen_at < ?`, uid, user, now, ip, JSON.stringify(this.location(ip, ua)), now - 5 * 60_000)]);
  }
  async touch(uid: string) {
    const [row] = await this.db.query<{ last_seen_at: number }>("SELECT last_seen_at FROM auth_session_info WHERE uid = ?", [uid]);
    const now = Date.now();
    if (row && now - Number(row.last_seen_at) >= 5 * 60_000) await this.db.execute([run("UPDATE auth_session_info SET last_seen_at=? WHERE uid=? AND last_seen_at < ?", now, uid, now - 5 * 60_000)]);
  }
  async history(user: string): Promise<LoginEvent[]> {
    const rows = await this.db.query<{ id: string; at: number; success: number; method: string; ip: string; location: string }>("SELECT * FROM auth_events WHERE user_id=? AND at>=? ORDER BY at DESC LIMIT 100", [user, Date.now() - 90 * 86_400_000]);
    return rows.map(r => ({ id: r.id, at: Number(r.at), success: !!r.success, method: r.method, ip: r.ip, ...JSON.parse(r.location) as Location }));
  }
  async sessions(user: string, current?: string): Promise<LoginSession[]> {
    const rows = await this.db.query<{ uid: string; payload: string; expires_at: number; last_seen_at: number | null; ip: string | null; location: string | null }>(`SELECT s.uid,s.payload,s.expires_at,i.last_seen_at,i.ip,i.location FROM oidc_store s
      LEFT JOIN auth_session_info i ON i.uid=s.uid AND i.user_id=?
      WHERE s.model='Session' AND json_extract(s.payload,'$.accountId')=? AND s.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM auth_session_revocations r WHERE r.uid=s.uid) ORDER BY i.last_seen_at DESC`, [user, user, Date.now()]);
    return rows.map(r => {
      const payload = JSON.parse(r.payload) as { loginTs?: number };
      return { id: r.uid, current: r.uid === current, at: (payload.loginTs ?? 0) * 1000, lastSeenAt: Number(r.last_seen_at ?? (payload.loginTs ?? 0) * 1000), expiresAt: Number(r.expires_at), ip: r.ip ?? "", ...(r.location ? JSON.parse(r.location) as Location : fallback) };
    });
  }
  async revoke(user: string, uid: string): Promise<boolean> {
    // Claim ownership and write a tombstone atomically, so an in-flight token issuance cannot recreate this session.
    const [claimed] = await this.db.execute([run(`INSERT INTO auth_session_revocations(uid,at)
      SELECT uid,? FROM oidc_store WHERE model='Session' AND uid=? AND json_extract(payload,'$.accountId')=?
      ON CONFLICT(uid) DO NOTHING`, Date.now(), uid, user)]);
    if (!claimed?.rowsAffected) return false;
    await this.db.execute([
      run(`DELETE FROM oidc_store WHERE grant_id IN (SELECT json_extract(a.value,'$.grantId') FROM oidc_store s, json_each(s.payload,'$.authorizations') a WHERE s.model='Session' AND s.uid=?)`, uid),
      run("DELETE FROM oidc_store WHERE (model='Session' AND uid=?) OR json_extract(payload,'$.sessionUid')=?", uid, uid),
      run("DELETE FROM auth_session_info WHERE uid=? AND user_id=?", uid, user),
    ]);
    return true;
  }
  async revoked(uid: string) { return (await this.db.query("SELECT uid FROM auth_session_revocations WHERE uid=?", [uid])).length > 0; }
  async cleanup(now = Date.now()) {
    // Avoid no-op Raft writes when there is nothing to remove.
    for (const [table, column] of [["auth_events", "at"], ["auth_session_info", "last_seen_at"], ["auth_session_revocations", "at"]] as const) {
      const cutoff = now - 90 * 86_400_000;
      if ((await this.db.query(`SELECT 1 FROM ${table} WHERE ${column}<? LIMIT 1`, [cutoff])).length) await this.db.execute([run(`DELETE FROM ${table} WHERE ${column}<?`, cutoff)]);
    }
  }
}
