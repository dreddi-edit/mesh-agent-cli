export function getOpenItems(items) {
  return items.filter((item) => item.status === "done");
}
