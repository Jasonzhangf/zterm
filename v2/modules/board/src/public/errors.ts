export type BoardErrorCode =
  | 'BOARD_INVALID_REQUEST'
  | 'BOARD_INVALID_RESPONSE'
  | 'BOARD_UNAUTHORIZED'
  | 'BOARD_SCOPE_FORBIDDEN'

export interface BoardErrorOptions {
  cause?: unknown
  details?: Readonly<Record<string, unknown>>
}

export class BoardError extends Error {
  override readonly name = 'BoardError'
  readonly code: BoardErrorCode
  readonly owningModule = 'board'
  readonly retryDisposition = 'none'
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: BoardErrorCode, message?: string, options: BoardErrorOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.details = options.details
  }
}

