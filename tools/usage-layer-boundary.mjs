import fs from "node:fs";
import path from "node:path";

/** Walk only the relative import closure of the supplied generic entry modules. */
export function checkUsageLayerBoundary(ts, entries, read = filename => fs.readFileSync(filename, "utf8")) {
  const visited = new Set();
  const visit = filename => {
    const resolved = path.resolve(filename);
    if (visited.has(resolved)) return;
    if (resolved.split(path.sep).includes("demo")) throw new Error(`forbidden_demo_import:${resolved}`);
    visited.add(resolved);
    const source = read(resolved);
    const ast = ts.createSourceFile(resolved, source, ts.ScriptTarget.Latest, true);
    const walk = node => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith("DEMO_")) throw new Error(`forbidden_demo_setting:${resolved}`);
      if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith("DEMO_")) throw new Error(`forbidden_demo_setting:${resolved}`);
      ts.forEachChild(node, walk);
    };
    walk(ast);
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const item of imports) {
      if (!item.fileName.startsWith(".")) continue;
      const target = path.resolve(path.dirname(resolved), item.fileName);
      if (target.split(path.sep).includes("demo")) throw new Error(`forbidden_demo_import:${target}`);
      const candidates = [target.replace(/\.js$/u, ".ts"), target, `${target}.ts`, path.join(target, "index.ts")];
      const dependency = candidates.find(candidate => fs.existsSync(candidate));
      if (dependency?.endsWith(".ts")) visit(dependency);
    }
  };
  entries.forEach(visit);
  return [...visited];
}
