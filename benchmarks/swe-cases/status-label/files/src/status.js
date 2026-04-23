export function formatStatusLabel(status) {
  switch (String(status)) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "Done";
    default:
      return "Unknown";
  }
}
