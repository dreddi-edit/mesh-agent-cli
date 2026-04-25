import { Project, QuoteKind, SourceFile } from "ts-morph";
import path from "node:path";
import fs from "node:fs";

export class TsCompilerRefactor {
  private readonly project: Project;

  constructor(private readonly workspaceRoot: string) {
    const tsconfig = path.join(workspaceRoot, "tsconfig.json");
    this.project = fs.existsSync(tsconfig)
      ? new Project({
          tsConfigFilePath: tsconfig,
          skipAddingFilesFromTsConfig: false,
          manipulationSettings: { quoteKind: QuoteKind.Double }
        })
      : new Project({
          manipulationSettings: { quoteKind: QuoteKind.Double }
        });
  }

  async renameSymbol(filePath: string, oldName: string, newName: string): Promise<{ changed: number }> {
    const source = this.requireSource(filePath);
    const nodes = source.getDescendants().filter((node) => node.getText() === oldName);
    for (const node of nodes) {
      const anyNode = node as any;
      if (typeof anyNode.rename === "function") {
        anyNode.rename(newName);
      }
    }
    await this.project.save();
    return { changed: nodes.length };
  }

  async extractFunction(filePath: string, functionName: string, startLine: number, endLine: number): Promise<{ created: boolean }> {
    const source = this.requireSource(filePath);
    const lines = source.getFullText().split(/\r?\n/g);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    source.addFunction({
      isExported: false,
      name: functionName,
      statements: body
    });
    await this.project.save();
    return { created: true };
  }

  async inlineSymbol(filePath: string, symbolName: string): Promise<{ inlined: number }> {
    const source = this.requireSource(filePath);
    const declarations = source.getVariableDeclarations().filter((decl) => decl.getName() === symbolName);
    if (declarations.length === 0) return { inlined: 0 };
    let inlined = 0;
    for (const decl of declarations) {
      const init = decl.getInitializer()?.getText();
      if (!init) continue;
      const refs = decl.findReferencesAsNodes();
      for (const ref of refs) {
        if (ref.getText() === symbolName && ref !== decl.getNameNode()) {
          ref.replaceWithText(init);
          inlined += 1;
        }
      }
      decl.getVariableStatement()?.remove();
    }
    await this.project.save();
    return { inlined };
  }

  async moveToModule(fromPath: string, toPath: string, symbolName: string): Promise<{ moved: boolean }> {
    const from = this.requireSource(fromPath);
    const to = this.project.addSourceFileAtPathIfExists(path.resolve(this.workspaceRoot, toPath))
      ?? this.project.createSourceFile(path.resolve(this.workspaceRoot, toPath), "", { overwrite: false });
    const fn = from.getFunction(symbolName);
    if (fn) {
      to.addFunction({
        name: symbolName,
        isExported: true,
        parameters: fn.getParameters().map((p) => ({ name: p.getName(), type: p.getType().getText(p) })),
        returnType: fn.getReturnType().getText(fn),
        statements: fn.getBodyText() || ""
      });
      fn.remove();
      await this.project.save();
      return { moved: true };
    }
    const variable = from.getVariableDeclaration(symbolName);
    if (variable) {
      to.addVariableStatement({
        declarations: [{ name: symbolName, initializer: variable.getInitializer()?.getText() || "undefined" }],
        isExported: true
      });
      variable.getVariableStatement()?.remove();
      await this.project.save();
      return { moved: true };
    }
    return { moved: false };
  }

  private requireSource(filePath: string): SourceFile {
    const absolute = path.resolve(this.workspaceRoot, filePath);
    const source = this.project.addSourceFileAtPathIfExists(absolute);
    if (!source) throw new Error(`Source file not found: ${filePath}`);
    return source;
  }
}
