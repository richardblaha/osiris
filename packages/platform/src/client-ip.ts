import { BlockList, isIP } from "node:net";

export const blockList = (cidrs: string) => {
  const list = new BlockList();
  for (const cidr of cidrs.split(",").map(v => v.trim()).filter(Boolean)) {
    const [net, prefix] = cidr.split("/");
    if (!isIP(net!)) throw new Error(`Invalid proxy CIDR: ${cidr}`);
    list.addSubnet(net!, Number(prefix), isIP(net!) === 6 ? "ipv6" : "ipv4");
  }
  return list;
};
const plain = (ip: string) => ip.replace(/^::ffff:/i, "");
const family = (ip: string) => isIP(ip) === 6 ? "ipv6" as const : "ipv4" as const;

/** Only the directly connected, trusted ingress may supply the last forwarded hop. */
export function clientIp(peer: string, headers: { realIp?: string; forwardedFor?: string; cdnClientIp?: string }, trusted: BlockList, cdn = new BlockList()): string {
  let ip = plain(peer);
  if (isIP(ip) && trusted.check(ip, family(ip))) {
    const forwarded = plain(headers.realIp?.trim() || headers.forwardedFor?.split(",").at(-1)?.trim() || "");
    if (isIP(forwarded)) ip = forwarded;
  }
  const behind = plain(headers.cdnClientIp?.trim() ?? "");
  return isIP(ip) && cdn.check(ip, family(ip)) && isIP(behind) ? behind : isIP(ip) ? ip : "";
}
