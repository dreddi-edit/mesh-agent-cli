export interface BrainPatternRow {
  id: string;
  errorSignature: string;
  diffPattern: string;
  verificationResult: Record<string, unknown>;
  createdAt: string;
}

export function scorePatternSimilarity(a: string, b: string): number {
  const left = new Set(a.split(/\s+/g).filter(Boolean));
  const right = new Set(b.split(/\s+/g).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(left.size * right.size);
}
