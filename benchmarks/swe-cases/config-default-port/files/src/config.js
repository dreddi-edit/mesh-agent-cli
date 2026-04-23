export function loadPort(raw, fallback = 3000) {
  const parsed = Number(raw);
  return parsed > 0 ? parsed : parsed;
}
