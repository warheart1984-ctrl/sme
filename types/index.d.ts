export type SmeNodeId =
  | 'sme-core'
  | 'sme-txt'
  | 'sme-vis'
  | 'sme-aud'
  | 'sme-vid'
  | 'sme-gen'
  | 'sme-log'
  | 'constitutional-gate';

export interface LatticeRequestFields {
  originNodeId: SmeNodeId | string;
  targetNodeId: SmeNodeId | string;
  actorId: string;
  action: string;
  context?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface LatticeResponse<T = unknown> {
  requestId: string | null;
  nodeId: string | null;
  ok: boolean;
  violation: string | null;
  violationReason: string | null;
  evidence: Record<string, unknown> | null;
  replayHandle: string | null;
  result: T | null;
}

export interface SmeModuleBinding {
  [action: string]: ((input: unknown) => unknown | Promise<unknown>) | unknown;
}

export interface LatticeConfig {
  modules?: Map<string, SmeModuleBinding>;
  continuityFloor?: number;
  extraCenInvariants?: unknown[];
  lrcVersion?: string;
}

export interface SmeLatticeRuntime {
  call<T = unknown>(request: LatticeRequestFields): Promise<LatticeResponse<T>>;
  route<T = unknown>(request: Record<string, unknown>): Promise<LatticeResponse<T>>;
  buildRequest(request: LatticeRequestFields): Record<string, unknown>;
  healthCheck(): Promise<boolean>;
  healthCheckDetailed(): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

export const packageName: '@mandala/sme';
export const version: string;
export const stability: Readonly<{
  packageContract: 'stable-v0';
  lattice: 'enforced';
  evidenceAndReplay: 'enforced';
  modelBackends: 'experimental';
}>;
export const LRC_VERSION: string;
export const LAWBOOK_CHAIN: readonly string[];
export function createLattice(config?: LatticeConfig): Promise<SmeLatticeRuntime>;

export const SmeLatticeModule: new () => SmeLatticeRuntime;
export const SmeCoreModule: new (...args: any[]) => any;
export const SmeTxtModule: new (...args: any[]) => any;
export const SmeVisModule: new (...args: any[]) => any;
export const SmeAudModule: new (...args: any[]) => any;
export const SmeVidModule: new (...args: any[]) => any;
export const SmeGenModule: new (...args: any[]) => any;
export const SmeLogModule: new (...args: any[]) => any;
