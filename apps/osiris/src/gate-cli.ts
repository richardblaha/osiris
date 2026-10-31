// The gate container of a contained local agent (see gate.ts): egress proxy on GATE_PROXY_PORT, the agent's port
// forwarded from GATE_LISTEN_PORT to GATE_AGENT (host:port).
import { createEgressProxy, createForwarder } from "./gate.ts";

const proxyPort = Number(process.env.GATE_PROXY_PORT ?? 3128);
const listenPort = Number(process.env.GATE_LISTEN_PORT ?? 7777);
const [agentHost = "agent", agentPort = "7777"] = (process.env.GATE_AGENT ?? "agent:7777").split(":");
const allow = (process.env.OSIRIS_EGRESS_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const proxy = createEgressProxy({ allow, log: (line) => console.log(`egress: ${line}`) }).listen(proxyPort, "0.0.0.0");
const forward = createForwarder(agentHost, Number(agentPort)).listen(listenPort, "0.0.0.0");
console.log(`gate: egress proxy :${proxyPort}${allow.length ? ` (allowed: ${allow.join(", ")})` : ""}, agent :${listenPort} → ${agentHost}:${agentPort}`);
const stop = () => (proxy.close(), forward.close(), process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
