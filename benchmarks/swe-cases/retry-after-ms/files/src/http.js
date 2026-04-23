export function parseRetryAfterMs(headerValue) {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds);
}
