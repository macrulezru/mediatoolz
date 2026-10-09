export { runImageHash } from './commands/image-hash/run.js'
export type {
  ImageHashRunOptions,
  ImageHashReport,
  ImageHashError,
  ImageHashProgress,
  OutdatedOutput,
} from './commands/image-hash/run.js'
export { renderImageHashReport } from './commands/image-hash/report.js'
export type { Components, HashEntry, HashType, OutputFormat } from './commands/image-hash/core.js'

export { runImageBatch } from './commands/image-batch/run.js'
export type {
  BatchJobResult,
  BatchOverrides,
  ImageBatchOptions,
  ImageBatchReport,
} from './commands/image-batch/run.js'
export { renderImageBatchReport } from './commands/image-batch/report.js'
export { parseConfig } from './commands/image-batch/config.js'
export type { BatchConfig } from './commands/image-batch/config.js'
