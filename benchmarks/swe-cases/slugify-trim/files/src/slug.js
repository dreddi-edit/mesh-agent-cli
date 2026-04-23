export function slugifyTitle(title) {
  return String(title).trim().toLowerCase().replace(/\s/g, "-");
}
