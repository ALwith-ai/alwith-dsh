import type { Context } from "@deepseek-ai/cordis"

export declare const name: string
export declare const inject: string[]
export interface AnchoredToolBootstrapConfig {
  shellTools?: string[]
  commonTools?: string[]
  messageSources?: string[]
  anchorGate?: boolean
  maxBootstrapSteps?: number
  promoteAfterFirstResponse?: boolean
  bootstrapMaxTokens?: number
  compactionTools?: string[]
  deferredSources?: string[]
  deferredGraceSteps?: number
  promotedPresentation?: "code"
  phase1FirstCallInstruction?: string
}
export declare function apply(ctx: Context, config?: AnchoredToolBootstrapConfig): void
