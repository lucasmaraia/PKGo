import type {ErrorInfo} from '@shared/types';

/**
 * An error the interface can explain. `code` maps to a translated message
 * (`errors.<code>` in the locale files); `params` fill its placeholders.
 */
export class AppError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(code: string, params: Record<string, string | number> = {}) {
    super(params.detail ? `${code}: ${params.detail}` : code);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }

  toInfo(): ErrorInfo {
    return {code: this.code, params: this.params};
  }
}

/** Any thrown value as ErrorInfo; unexpected errors keep their message as detail. */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof AppError) return error.toInfo();
  return {code: 'unexpected', params: {detail: error instanceof Error ? error.message : String(error)}};
}

export const hex = (code: number): string => `0x${(code >>> 0).toString(16).toUpperCase()}`;
