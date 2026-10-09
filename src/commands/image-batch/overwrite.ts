import { ImageBatchAbortError } from './errors.js'

export type OverwriteMode = 'ask' | 'overwrite' | 'skip' | 'error'
export type ConflictAnswer = 'yes' | 'all' | 'skip' | 'none' | 'quit'
export type ConflictDecision = 'write' | 'skip' | 'fail'

export interface ConflictInfo {
  outRel: string
  sourceRel: string
  existingBytes: number
  reason: 'unknown' | 'changed'
}

export type ConflictPrompt = (info: ConflictInfo) => Promise<ConflictAnswer>

export interface OverwriteResolver {
  decide(info: ConflictInfo): Promise<ConflictDecision>
}

export function createOverwriteResolver(
  mode: OverwriteMode,
  prompt?: ConflictPrompt,
): OverwriteResolver {
  let sticky: ConflictDecision | null = null
  return {
    async decide(info) {
      if (mode === 'overwrite') return 'write'
      if (mode === 'skip') return 'skip'
      if (mode === 'error') return 'fail'
      if (sticky) return sticky
      if (!prompt) return 'skip'
      const answer = await prompt(info)
      if (answer === 'quit') throw new ImageBatchAbortError()
      if (answer === 'all') {
        sticky = 'write'
        return 'write'
      }
      if (answer === 'none') {
        sticky = 'skip'
        return 'skip'
      }
      return answer === 'yes' ? 'write' : 'skip'
    },
  }
}
