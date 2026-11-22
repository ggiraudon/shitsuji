export {
  type ContextInjectable,
  type AgentRenderContext,
  type InjectionPlacement,
  type InjectionCondition,
  type InjectionConditionAlways,
  type InjectionConditionToolUsed,
  type InjectionConditionPatternDetected,
  type InjectionConditionCustom,
  type InjectionConditionOnce,
  type InjectionConditionSessionKind,
  BaseContextInjectable,
} from '../../ports/ContextInjectable.js';

export { IdentityInjectable, type IdentityConfig } from './IdentityInjectable.js';
export { SoulInjectable } from './SoulInjectable.js';
export { RulesInjectable, type Rule } from './RulesInjectable.js';
export { ToolIndexInjectable } from './ToolIndexInjectable.js';
export { ComputerUseInjectable } from './ComputerUseInjectable.js';
export { OwnerProfileInjectable } from './OwnerProfileInjectable.js';
export { ClockInjectable } from './ClockInjectable.js';
export { CompactionSummaryInjectable } from './CompactionSummaryInjectable.js';
export { Compactor, type Compaction, type CompactorDeps } from './Compactor.js';
export {
  ContextBuilder,
  type BuiltContext,
  type ContextBuilderDeps,
  type RenderedNote,
} from './ContextBuilder.js';
