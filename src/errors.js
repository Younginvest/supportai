export class AppError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
export class NotFoundError extends AppError { constructor(m) { super('NOT_FOUND', m, 404); } }
export class ValidationError extends AppError {
  constructor(m, issues) { super('VALIDATION_ERROR', m, 400); this.issues = issues || null; }
}
export class ConflictError extends AppError { constructor(m) { super('CONFLICT', m, 409); } }
export class StateError extends AppError { constructor(m) { super('INVALID_STATE', m, 409); } }
export class AuthError extends AppError {
  constructor(code, m) { super(code, m, code === 'UNAUTHENTICATED' ? 401 : 403); }
}
export class RateLimitError extends AppError { constructor(m) { super('RATE_LIMITED', m, 429); } }
export class BodyParseError extends AppError { constructor(m) { super('INVALID_JSON', m, 400); } }
export class TooLargeError extends AppError { constructor(m) { super('PAYLOAD_TOO_LARGE', m, 413); } }
export class UnavailableError extends AppError { constructor(m) { super('UNAVAILABLE', m, 503); } }
