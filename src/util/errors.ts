/** A thrown value as a message: an error's `message`, else the value itself as a string. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return String(message ?? e);
}
