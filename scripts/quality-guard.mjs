// Author: Liz
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const configPath = path.join(projectRoot, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const checker = program.getTypeChecker();
const sourceFiles = program.getSourceFiles().filter(isProjectSourceFile);
const violations = [];
const commandOwners = new Map();
const symbolReferences = new Map();

for (const sourceFile of sourceFiles) {
  const relativeFile = relativeProjectPath(sourceFile.fileName);
  inspectImports(sourceFile, relativeFile);
  inspectNodes(sourceFile, relativeFile);
}

inspectDuplicateCommandOwnership();
inspectUnusedExports();

if (violations.length > 0) {
  console.error("质量门禁未通过：");
  for (const violation of violations.sort()) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("质量门禁通过：IPC 入口、模块边界、命令所有权和导出引用均符合约定。");
}

function isProjectSourceFile(sourceFile) {
  const normalized = path.resolve(sourceFile.fileName);
  return normalized.startsWith(`${sourceRoot}${path.sep}`) && !sourceFile.isDeclarationFile;
}

function relativeProjectPath(fileName) {
  return path.relative(projectRoot, fileName).replaceAll("\\", "/");
}

function isTestFile(fileName) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName);
}

function inspectImports(sourceFile, relativeFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (
      (specifier === "@tauri-apps/api/core" || specifier === "@tauri-apps/api/event") &&
      relativeFile !== "src/lib/tauriClient.ts"
    ) {
      violations.push(`${relativeFile} 绕过 src/lib/tauriClient.ts 直接导入 ${specifier}`);
    }

    const importedFile = resolveRelativeSourceFile(sourceFile.fileName, specifier);
    if (!importedFile) continue;
    const importedRelative = relativeProjectPath(importedFile);
    if (
      (relativeFile.startsWith("src/lib/") || relativeFile.startsWith("src/components/")) &&
      (importedRelative.startsWith("src/app/") || importedRelative.startsWith("src/features/"))
    ) {
      violations.push(`${relativeFile} 的基础层依赖了上层模块 ${importedRelative}`);
    }
    if (relativeFile.startsWith("src/features/") && importedRelative.startsWith("src/app/")) {
      violations.push(`${relativeFile} 的 feature 层反向依赖了 app 层 ${importedRelative}`);
    }
  }
}

function inspectNodes(sourceFile, relativeFile) {
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      if (symbol) {
        const references = symbolReferences.get(symbol) ?? new Set();
        references.add(relativeFile);
        symbolReferences.set(symbol, references);
      }
    }

    if (
      !isTestFile(relativeFile) &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["invokeTauri", "invokeTypedTauri"].includes(node.expression.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const command = node.arguments[0].text;
      const owners = commandOwners.get(command) ?? new Set();
      owners.add(relativeFile);
      commandOwners.set(command, owners);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function inspectDuplicateCommandOwnership() {
  for (const [command, owners] of commandOwners) {
    if (owners.size > 1) {
      violations.push(`Tauri command "${command}" 分散在多个前端模块：${[...owners].sort().join(", ")}`);
    }
  }
}

function inspectUnusedExports() {
  for (const sourceFile of sourceFiles) {
    const relativeFile = relativeProjectPath(sourceFile.fileName);
    if (isTestFile(relativeFile)) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;

    for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
      let target = exportedSymbol;
      if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
      const declarations = target.getDeclarations() ?? [];
      if (!declarations.some((declaration) => declaration.getSourceFile() === sourceFile)) continue;
      const references = symbolReferences.get(target) ?? new Set();
      const externallyReferenced = [...references].some((referenceFile) => referenceFile !== relativeFile);
      if (!externallyReferenced) {
        violations.push(`${relativeFile} 导出 "${exportedSymbol.getName()}"，但项目内没有外部引用`);
      }
    }
  }
}

function resolveRelativeSourceFile(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
