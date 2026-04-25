export interface RepoDna {
  framework: string;
  frameworkVersion: string;
  orm: string;
  testRunner: string;
  deployTarget: string;
  monorepoTool: string;
  cssStrategy: string;
  language: string;
  packageManager: string;
}

export function cosineLikeSimilarity(left: RepoDna, right: RepoDna): number {
  const keys = Object.keys(left) as Array<keyof RepoDna>;
  const matches = keys.reduce((total, key) => total + (left[key] === right[key] ? 1 : 0), 0);
  return matches / keys.length;
}
