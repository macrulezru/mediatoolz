import type { InjectionKey } from 'vue'

export type BatchTab = 'convert' | 'configs' | 'sharpen' | 'backups'

export const NAVIGATE: InjectionKey<(tab: BatchTab) => void> = Symbol('image-batch-navigate')

export interface ProjectContext {
  cwd: string
  name: string
  home: string
}

export const PROJECT: InjectionKey<ProjectContext> = Symbol('image-batch-project')

export const EMPTY_PROJECT: ProjectContext = { cwd: '', name: 'this project', home: '' }

export function projectContext(cwd: string, home: string): ProjectContext {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return { cwd, home, name: parts[parts.length - 1] ?? cwd }
}
