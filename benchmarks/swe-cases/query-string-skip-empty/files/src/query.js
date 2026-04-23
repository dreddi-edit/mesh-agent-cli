export function buildQueryString(params) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null);
  return new URLSearchParams(entries).toString();
}
