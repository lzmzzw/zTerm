// Author: Liz
interface UnknownErrorMessageOptions {
  blankStringFallback?: boolean;
  objectMessage?: boolean;
  stringMessage?: boolean;
}

const fallbackOnlyErrorMessageOptions: UnknownErrorMessageOptions = { stringMessage: false };

export function unknownErrorMessage(
  error: unknown,
  fallback: string,
  options: UnknownErrorMessageOptions = {},
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") {
    if (options.stringMessage === false) return fallback;
    return options.blankStringFallback && !error.trim() ? fallback : error;
  }
  if (options.objectMessage && error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function fallbackOnlyErrorMessage(error: unknown, fallback: string): string {
  return unknownErrorMessage(error, fallback, fallbackOnlyErrorMessageOptions);
}

export function stringifiedErrorMessage(error: unknown): string {
  return unknownErrorMessage(error, String(error));
}
