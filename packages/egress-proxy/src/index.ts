export {
  ALWAYS_BLOCKED,
  METADATA_ADDRESSES,
  blockedReason,
  formatIp,
  normalizeAddress,
  parseCidr,
  parseIp,
  rangeContains,
  rangesOverlap,
  type CidrRange,
  type IpAddress,
} from './address.js';
export { createPolicy, type Decision, type EgressPolicy, type PolicyConfig } from './rules.js';
export {
  createEgressProxy,
  parseAuthority,
  type EgressProxyDeps,
  type ProxyLogger,
} from './proxy.js';
