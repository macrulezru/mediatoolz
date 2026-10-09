export class ImageBatchUsageError extends Error {}

export class ImageBatchAbortError extends Error {
  constructor(message = 'aborted') {
    super(message)
  }
}
