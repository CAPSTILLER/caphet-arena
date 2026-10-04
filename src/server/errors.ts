export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
