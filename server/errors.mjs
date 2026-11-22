export class AppError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function invalid(message) {
  return new AppError(400, 'invalid_config', message)
}
