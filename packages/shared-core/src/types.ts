/**
 * Domain types shared across the Osiris extensions. Keep this file free of
 * runtime code so it can be imported from anywhere (including webviews).
 */

/* ---------------------------------------------------------------- osiris-ai */

export interface AgentDescriptor {
  id: string;
  label: string;
  description?: string;
  /** System prompt / instructions for the agent. */
  instructions: string;
  /** Names of MCP tools the agent is allowed to call; `*` for all. */
  allowedTools?: string[] | '*';
}

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  /** Stable key, also used as the tool namespace prefix. */
  id: string;
  transport: McpTransport;
  /** stdio: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: base URL of the server. */
  url?: string;
  /** Milliseconds before a request is considered failed. */
  timeoutMs?: number;
  enabled?: boolean;
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  agent: AgentDescriptor;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------- osiris-dexpi */

export interface DexpiPosition {
  x: number;
  y: number;
  z?: number;
}

export interface DexpiExtent {
  width: number;
  height: number;
}

export interface DexpiNode {
  /** Value of the `ID` attribute if present. */
  id?: string;
  /** XML tag name, e.g. `Equipment`, `PipingNetworkSegment`. */
  tag: string;
  componentClass?: string;
  componentName?: string;
  position?: DexpiPosition;
  extent?: DexpiExtent;
  /** Generic attributes as a flat bag (`GenericAttribute` / `@_` attributes). */
  attributes: Record<string, string>;
}

export interface DexpiNozzle extends DexpiNode {
  tag: 'Nozzle';
  ownerId?: string;
}

export interface DexpiEquipment extends DexpiNode {
  tag: 'Equipment';
  nozzles: DexpiNozzle[];
}

export interface DexpiConnection {
  fromId?: string;
  toId?: string;
}

export interface DexpiSegment extends DexpiNode {
  tag: 'PipingNetworkSegment';
  connections: DexpiConnection[];
  /** Ordered polyline coordinates when the file carries a `CenterLine`. */
  centerLine: DexpiPosition[];
}

export interface DexpiPlantInformation {
  schemaVersion?: string;
  originatingSystem?: string;
  date?: string;
  attributes: Record<string, string>;
}

export interface DexpiModel {
  plantInformation: DexpiPlantInformation;
  equipment: DexpiEquipment[];
  segments: DexpiSegment[];
  instrumentation: DexpiNode[];
  /** Every node keyed by its `ID` for reference resolution. */
  index: Record<string, DexpiNode>;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  /** Slash-separated path to the offending node, e.g. `PlantModel/Equipment[2]`. */
  path: string;
  nodeId?: string;
}

/* -------------------------------------------------------------- osiris-step */

export type StepValue =
  | { kind: 'ref'; id: number }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'derived' }
  | { kind: 'list'; items: StepValue[] }
  | { kind: 'typed'; typeName: string; value: StepValue };

export interface StepEntity {
  id: number;
  type: string;
  parameters: StepValue[];
}

export interface StepHeader {
  description: string[];
  implementationLevel: string;
  name: string;
  timeStamp: string;
  author: string[];
  organization: string[];
  preprocessorVersion: string;
  originatingSystem: string;
  authorization: string;
  schemaIdentifiers: string[];
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface StepGeometry {
  /** Flat point cloud from every `CARTESIAN_POINT`. */
  points: Vec3[];
  /** Pairs of indices into `points` describing wireframe line segments. */
  lineSegments: [number, number][];
  bbox: BoundingBox;
}
