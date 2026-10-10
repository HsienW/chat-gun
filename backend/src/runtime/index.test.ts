import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ApiSurfaceSnapshot {
  runtime: string[];
  types: string[];
}

function readExports(sourceText: string): ApiSurfaceSnapshot {
  const source = ts.createSourceFile("index.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: ApiSurfaceSnapshot = { runtime: [], types: [] };
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const target = statement.isTypeOnly ? result.types : result.runtime;
    for (const element of statement.exportClause.elements) target.push(element.name.text);
  }
  result.runtime.sort();
  result.types.sort();
  return result;
}

describe("runtime public barrel", () => {
  it("matches the @gun-ai/harness-contracts reviewed API surface", () => {
    const expected = JSON.parse(readFileSync(
      new URL("../../node_modules/@gun-ai/harness-contracts/api-surface.json", import.meta.url),
      "utf8"
    )) as ApiSurfaceSnapshot;
    const actual = readExports(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

    expect(actual).toEqual({
      runtime: expected.runtime.sort(),
      types: expected.types.sort(),
    });
  });
});
