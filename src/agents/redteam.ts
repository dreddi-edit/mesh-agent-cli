export interface RedTeamResult {
  ok: boolean;
  generatedTests: string[];
  failingInputs: Array<{ input: string; reason: string }>;
}

export function runRedTeam(input: { diffPreview: string }): RedTeamResult {
  const generatedTests: string[] = [];
  const failingInputs: Array<{ input: string; reason: string }> = [];

  if (/parseInt|Number\(/.test(input.diffPreview)) {
    generatedTests.push("property: numeric parsing should reject NaN and Infinity.");
    failingInputs.push({ input: "Infinity", reason: "Potential unchecked numeric coercion." });
  }
  if (/JSON\.parse/.test(input.diffPreview)) {
    generatedTests.push("property: malformed JSON input should never crash request path.");
    failingInputs.push({ input: "{ invalid json }", reason: "Potential unguarded JSON.parse path." });
  }

  return {
    ok: failingInputs.length === 0,
    generatedTests,
    failingInputs
  };
}
