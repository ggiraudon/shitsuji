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
export { RulesInjectable, type Rule } from './RulesInjectable.js';
export { ToolIndexInjectable } from './ToolIndexInjectable.js';
export {
  ContextBuilder,
  type BuiltContext,
  type ContextBuilderDeps,
  type RenderedNote,
} from './ContextBuilder.js';
