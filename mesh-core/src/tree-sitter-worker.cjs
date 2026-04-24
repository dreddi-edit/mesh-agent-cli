"use strict";

const { workerData, parentPort } = require("worker_threads");
const crypto = require("crypto");
const path = require("path");

function safeRequire(moduleId) {
  try {
    return require(moduleId);
  } catch {
    return null;
  }
}

const treeSitter = safeRequire("tree-sitter");
const tsJavascript = safeRequire("tree-sitter-javascript");
const tsTypescript = safeRequire("tree-sitter-typescript");
const tsPython = safeRequire("tree-sitter-python");
const tsGo = safeRequire("tree-sitter-go");
const tsHtml = safeRequire("tree-sitter-html");
const tsCss = safeRequire("tree-sitter-css");
const tsJson = safeRequire("tree-sitter-json");
const tsRust = safeRequire("tree-sitter-rust");
const tsCpp = safeRequire("tree-sitter-cpp");
const tsCsharp = safeRequire("tree-sitter-c-sharp");
const tsJava = safeRequire("tree-sitter-java");
const tsRuby = safeRequire("tree-sitter-ruby");
const tsPhp = safeRequire("tree-sitter-php");
const tsKotlin = safeRequire("tree-sitter-kotlin");
const tsSwift = safeRequire("tree-sitter-swift");
const llmCompress = safeRequire("../../llm-compress.js");

const treeSitterLanguages = {
  javascript: tsJavascript,
  typescript: tsTypescript?.typescript,
  tsx: tsTypescript?.tsx,
  python: tsPython,
  go: tsGo,
  html: tsHtml,
  css: tsCss,
  json: tsJson,
  rust: tsRust,
  cpp: tsCpp,
  csharp: tsCsharp,
  java: tsJava,
  ruby: tsRuby,
  // tree-sitter-php exports { php, php_only } — use .php with fallback for forward compat
  php: tsPhp?.php || tsPhp,
  kotlin: tsKotlin,
  swift: tsSwift,
};

const treeSitterParsers = new Map();

// --- util helpers (duplicated from compression-core, must be self-contained) ---

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxLength = 140) {
  const normalized = String(value || "");
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(32, maxLength - 1))}…` : normalized;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "item";
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function locateLineFromCharIndex(lineStarts, charIndex) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const lineStart = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (charIndex < lineStart) {
      high = mid - 1;
    } else if (charIndex >= nextStart) {
      low = mid + 1;
    } else {
      return { line: mid + 1, column: charIndex - lineStart + 1 };
    }
  }
  return { line: lineStarts.length, column: 1 };
}

function byteOffsetFromCharIndex(text, charIndex) {
  return Buffer.byteLength(String(text || "").slice(0, Math.max(0, charIndex)), "utf8");
}

function charIndexFromLineRange(text, lineStarts, lineNumber) {
  const safeLine = Math.max(1, Math.min(lineNumber, lineStarts.length));
  return lineStarts[safeLine - 1] || 0;
}

function dedupeByText(items = []) {
  const seen = new Set();
  const next = [];
  for (const item of items) {
    const key = `${item?.text || ""}::${(item?.spanIds || []).join(",")}`;
    if (!item || !item.text || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function createSpanManager(text) {
  const rawText = String(text || "");
  const rawBuffer = Buffer.from(rawText, "utf8");
  const asciiOnly = /^[\x00-\x7F]*$/.test(rawText);
  const lineStarts = buildLineStarts(rawText);
  const spans = {};
  let counter = 0;

  function clampCharIndex(value) {
    return Math.max(0, Math.min(rawText.length, Math.trunc(value)));
  }

  function byteOffsetForCharIndex(charIndex) {
    const safeIndex = clampCharIndex(charIndex);
    if (asciiOnly) return safeIndex;
    return byteOffsetFromCharIndex(rawText, safeIndex);
  }

  function addSpan(input = {}) {
    const startIndexInput = Number.isFinite(input.startIndex) ? clampCharIndex(input.startIndex) : null;
    const endIndexInput = Number.isFinite(input.endIndex) ? clampCharIndex(input.endIndex) : null;

    let startIndex = startIndexInput !== null ? startIndexInput : 0;
    let endIndex = endIndexInput !== null ? Math.max(startIndex, endIndexInput) : startIndex;

    let startByte = Number.isFinite(input.startByte) ? Math.max(0, Math.trunc(input.startByte)) : null;
    let endByte = Number.isFinite(input.endByte) ? Math.max(0, Math.trunc(input.endByte)) : null;
    if (startByte === null || endByte === null) {
      startByte = byteOffsetForCharIndex(startIndex);
      endByte = byteOffsetForCharIndex(endIndex);
    }
    if (endByte < startByte) endByte = startByte;

    if (startIndexInput === null || endIndexInput === null) {
      if (asciiOnly) {
        if (startIndexInput === null) startIndex = Math.min(rawText.length, startByte);
        if (endIndexInput === null) endIndex = Math.max(startIndex, Math.min(rawText.length, endByte));
      } else {
        if (startIndexInput === null) {
          startIndex = rawBuffer.slice(0, startByte).toString("utf8").length;
        }
        if (endIndexInput === null) {
          endIndex = Math.max(startIndex, rawBuffer.slice(0, endByte).toString("utf8").length);
        }
      }
    }

    const label = truncateText(normalizeWhitespace(input.label || input.kind || "span"), 80);
    const kind = String(input.kind || "span").trim().toLowerCase() || "span";
    const rowStart = Number.isFinite(input.rowStart) ? Math.max(1, Math.trunc(input.rowStart)) : null;
    const rowEnd = Number.isFinite(input.rowEnd) ? Math.max(rowStart || 1, Math.trunc(input.rowEnd)) : null;
    const columnStart = Number.isFinite(input.columnStart) ? Math.max(1, Math.trunc(input.columnStart)) : null;
    const columnEnd = Number.isFinite(input.columnEnd) ? Math.max(1, Math.trunc(input.columnEnd)) : null;
    const approxText = rawText.slice(startIndex, endIndex);
    const fallbackStart = locateLineFromCharIndex(lineStarts, startIndex);
    const approxLines = approxText.includes("\n") ? approxText.split("\n") : null;
    const trailingLineLength = approxLines ? approxLines[approxLines.length - 1].length : approxText.length;
    const lineDelta = approxLines ? Math.max(0, approxLines.length - 1) : 0;
    const spanId = `sp_${slugify(kind)}_${String(counter += 1).padStart(3, "0")}`;
    spans[spanId] = {
      spanId,
      kind,
      label,
      startByte,
      endByte,
      lineStart: rowStart || fallbackStart.line,
      lineEnd: rowEnd || fallbackStart.line + lineDelta,
      columnStart: columnStart || fallbackStart.column,
      columnEnd: columnEnd || (lineDelta > 0
        ? trailingLineLength + 1
        : fallbackStart.column + approxText.length),
      excerpt: truncateText(normalizeWhitespace(approxText), 200),
    };
    return spanId;
  }

  function addMatchSpan(match, kind, label) {
    if (!match || !Number.isFinite(match.index)) return "";
    return addSpan({
      startIndex: match.index,
      endIndex: match.index + String(match[0] || "").length,
      kind,
      label,
    });
  }

  function addLineSpan(lineNumber, kind, label) {
    const startIndex = charIndexFromLineRange(rawText, lineStarts, lineNumber);
    const endIndex = lineNumber >= lineStarts.length ? rawText.length : Math.max(startIndex, (lineStarts[lineNumber] || rawText.length) - 1);
    return addSpan({
      startIndex,
      endIndex,
      kind,
      label,
      rowStart: lineNumber,
      rowEnd: lineNumber,
      columnStart: 1,
      columnEnd: Math.max(1, endIndex - startIndex + 1),
    });
  }

  return { spans, lineStarts, addSpan, addMatchSpan, addLineSpan };
}

function createSection(name, priority = "P1") {
  return { name, priority, items: [] };
}

function pushSectionItem(section, item) {
  if (!section || !item || !item.text) return;
  section.items.push({
    text: truncateText(normalizeWhitespace(item.text), 220),
    spanIds: Array.isArray(item.spanIds) ? item.spanIds.filter(Boolean) : [],
    priority: String(item.priority || "P1"),
    metadata: item.metadata || undefined,
  });
}

function extractRegexLines(text, regex, mapper) {
  const lines = String(text || "").split(/\r?\n/g);
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = regex.exec(line);
    regex.lastIndex = 0;
    if (!match) continue;
    items.push({
      lineNumber: i + 1,
      line,
      match,
      mapped: mapper ? mapper(match, line, i + 1) : String(match[0] || ""),
    });
  }
  return items;
}

function getTreeSitterParser(parserKey) {
  if (!treeSitter || !parserKey) return null;
  if (treeSitterParsers.has(parserKey)) return treeSitterParsers.get(parserKey);
  const language = treeSitterLanguages[parserKey];
  if (!language) {
    treeSitterParsers.set(parserKey, null);
    return null;
  }
  try {
    const parser = new treeSitter();
    parser.setLanguage(language);
    treeSitterParsers.set(parserKey, parser);
    return parser;
  } catch {
    treeSitterParsers.set(parserKey, null);
    return null;
  }
}

function parseTree(parserKey, text) {
  const parser = getTreeSitterParser(parserKey);
  if (!parser) return null;
  try {
    return parser.parse(String(text || ""));
  } catch {
    return null;
  }
}

function walkTree(node, fn) {
  if (!node || typeof fn !== "function") return true;
  if (fn(node) === false) return false;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    if (walkTree(node.namedChild(i), fn) === false) return false;
  }
  return true;
}

function nodeText(node, source) {
  if (!node) return "";
  return String(source || "").slice(node.startIndex, node.endIndex);
}

function namedNodeText(node, source) {
  if (!node) return "";
  if (typeof node.childForFieldName === "function") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return normalizeWhitespace(nodeText(nameNode, source));
  }
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (/(identifier|property_identifier|type_identifier)/.test(String(child.type || ""))) {
      return normalizeWhitespace(nodeText(child, source));
    }
  }
  return "";
}

function signaturePreview(node, source) {
  const snippet = nodeText(node, source).split("{")[0].split("\n")[0];
  return truncateText(normalizeWhitespace(snippet), 140);
}

function buildCodeCapsule(pathValue, text, fileType, limits) {
  const MAX_TREE_SITTER_SOURCE_BYTES = limits.maxTreeSitterBytes;
  const MAX_TREE_WALK_NODES = limits.maxTreeWalkNodes;
  const MAX_SYMBOL_DISCOVERY = limits.maxSymbols;
  const MAX_CALL_SITES_PER_FILE = limits.maxCallSites || 200;
  const MAX_LLM_FALLBACK_SOURCE_BYTES = limits.maxLlmFallbackBytes;

  const rawText = String(text || "");
  const sourceBytes = Buffer.byteLength(rawText, "utf8");
  
  // Dynamic Verbosity Thresholds
  const isSkeleton = sourceBytes > 2 * 1024 * 1024; // > 2MB
  const isCompact = sourceBytes > 500 * 1024;     // > 500KB

  const spanManager = createSpanManager(rawText);
  const tree = sourceBytes <= MAX_TREE_SITTER_SOURCE_BYTES
    ? parseTree(fileType.parserKey, rawText)
    : null;

  const importsSection = createSection("imports", "P0");
  const symbolsSection = createSection("symbols", "P0");
  const exportsSection = createSection("exports", "P0");
  const routesSection = createSection("routes", "P1");
  const callsSection = createSection("calls", "P1");
  const literalsSection = createSection("literals", "P1");
  const elisionsSection = createSection("elisions", "P2");
  const seenSymbolNames = new Set();
  const symbolDeclarations = [];
  let walkedNodes = 0;

  // Verbosity limits based on file size
  const maxImports = isSkeleton ? 4 : (isCompact ? 8 : 16);
  const maxSymbols = isSkeleton ? 40 : (isCompact ? 180 : MAX_SYMBOL_DISCOVERY);
  const maxRoutes = isSkeleton ? 4 : (isCompact ? 8 : 12);
  const maxLiterals = isSkeleton ? 4 : (isCompact ? 8 : 18);

  // Modernized Regex for broader coverage (supports indentation, comments, and multiple forms)
  const importRegex = /(?:import\s+(?:.+?\s+from\s+)?["'`]([^"'`]+)["'`])|(?:require\(\s*["'`]([^"'`]+)["'`]\s*\))|(?:export\s+.+?\s+from\s+["'`]([^"'`]+)["'`])/g;
  const importItems = [];
  let match;
  while ((match = importRegex.exec(rawText)) !== null) {
    const source = match[1] || match[2] || match[3];
    if (source) {
      importItems.push({
        text: match[0].trim(),
        source: source,
        index: match.index
      });
    }
    if (importItems.length >= 128) break; // Extended limit
  }

  for (const entry of importItems) {
    const spanId = spanManager.addSpan({
      startIndex: entry.index,
      endIndex: entry.index + entry.text.length,
      kind: "import",
      label: entry.text
    });
    pushSectionItem(importsSection, { 
      text: entry.text, 
      spanIds: [spanId], 
      priority: "P0",
      metadata: { source: entry.source }
    });
  }

  if (tree?.rootNode) {
    walkTree(tree.rootNode, (node) => {
      walkedNodes += 1;
      if (walkedNodes > MAX_TREE_WALK_NODES) return false;
      if (symbolsSection.items.length >= maxSymbols) return false;

      const type = String(node.type || "");
      const definitionLike = [
        // JavaScript / TypeScript
        "function_declaration",
        "generator_function_declaration",
        "class_declaration",
        "method_definition",
        "lexical_declaration",
        "variable_declaration",
        // Python / Go
        "function_definition",
        "class_definition",
        "method_declaration",
        "type_declaration",
        "interface_declaration",
        "enum_declaration",
        // Rust
        "function_item",
        "struct_item",
        "enum_item",
        "trait_item",
        "impl_item",
        "mod_item",
        "const_item",
        "type_item",
        // C++ / C
        "class_specifier",
        "struct_specifier",
        "namespace_definition",
        "template_declaration",
        // C#
        "constructor_declaration",
        "property_declaration",
        "namespace_declaration",
        // Ruby
        "method",
        "singleton_method",
        "class",
        "module",
        // PHP
        "trait_declaration",
        // Kotlin
        "object_declaration",
        // Swift
        "protocol_declaration",
        "extension_declaration",
        "init_declaration",
        "computed_property",
      ].includes(type);
      if (!definitionLike) return true;

      // In Skeleton Mode, we might want to prioritize top-level exports/interfaces
      if (isSkeleton && type === "method_definition") return true; // skip methods in skeleton mode to keep it light

      let name = namedNodeText(node, rawText);
      let semanticKind = type;
      if (!name && /(lexical_declaration|variable_declaration)/.test(type)) {
        // Walk variable_declarator children to find `const fn = () => {}` patterns.
        // `namedNodeText` returns "" for lexical_declaration because the node has no
        // "name" field — the name lives inside a nested variable_declarator child.
        // We gate extraction on a function-like initializer so plain consts are excluded.
        const FUNCTION_INIT_TYPES = new Set([
          "arrow_function", "function", "function_expression",
          "async", "generator_function",
        ]);
        for (let ci = 0; ci < node.namedChildCount; ci += 1) {
          const declarator = node.namedChild(ci);
          if (!declarator || declarator.type !== "variable_declarator") continue;
          const nameNode = typeof declarator.childForFieldName === "function"
            ? declarator.childForFieldName("name")
            : null;
          const valueNode = typeof declarator.childForFieldName === "function"
            ? declarator.childForFieldName("value")
            : null;
          if (!nameNode) continue;
          const valueType = String(valueNode?.type || "");
          const isFunctionInit = FUNCTION_INIT_TYPES.has(valueType)
            || valueType.includes("function")
            || valueType.includes("arrow");
          if (!isFunctionInit) continue;
          name = normalizeWhitespace(nodeText(nameNode, rawText));
          semanticKind = "function_declaration";
          break;
        }
      }
      if (!name) return true;
      const uniqueKey = `${type}:${name}:${node.startIndex}`;
      if (seenSymbolNames.has(uniqueKey)) return true;
      seenSymbolNames.add(uniqueKey);
      const spanId = spanManager.addSpan({
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        rowStart: node.startPosition?.row + 1,
        rowEnd: node.endPosition?.row + 1,
        columnStart: node.startPosition?.column + 1,
        columnEnd: node.endPosition?.column + 1,
        kind: "symbol",
        label: `${type} ${name}`,
      });
      const lineCount = Math.max(1, (node.endPosition?.row || 0) - (node.startPosition?.row || 0) + 1);
      
      let sig = signaturePreview(node, rawText);
      if (isSkeleton) {
        sig = sig.slice(0, 80) + "... { implementation elided }";
      }

      const EXPORT_PARENT_TYPES = new Set(['export_statement', 'export_declaration', 'export_default_declaration']);
      const sigTrimmed = String(sig || '').slice(0, 140);
      const isExported = EXPORT_PARENT_TYPES.has(node.parent?.type || '') || /^export\s/.test(sigTrimmed);
      // Exported symbols appear in [exports] — skip them from [symbols] to avoid
      // duplication and reclaim budget for non-exported helpers and call-sites.
      if (!isExported) {
        pushSectionItem(symbolsSection, {
          text: `${type.replace(/_/g, " ")} ${name} lines=${lineCount} sig="${sig}" @${spanId}`,
          spanIds: [spanId],
          // One-liner stubs (lineCount <= 2) are deprioritized so multi-line symbols
          // survive tight tier budgets ahead of trivial helpers.
          priority: lineCount > 2 ? "P0" : "P1",
        });
      }
      symbolDeclarations.push({
        name: String(name || ''),
        kind: String(semanticKind || type || ''),
        lineStart: Number((node.startPosition?.row ?? 0) + 1),
        lineEnd: Number((node.endPosition?.row ?? 0) + 1),
        signature: sigTrimmed,
        isExported,
      });
      if (symbolsSection.items.length >= maxSymbols) return false;
      return true;
    });
  }

  // ── Call site extraction ──────────────────────────────────────────────────
  const callSitesRaw = [];
  if (tree?.rootNode) {
    const CALL_NODE_TYPES = new Set(['call_expression', 'call']);
    let csWalked = 0;
    walkTree(tree.rootNode, (node) => {
      csWalked += 1;
      if (csWalked > 100000) return false;
      if (callSitesRaw.length >= MAX_CALL_SITES_PER_FILE) return false;
      const ntype = String(node.type || '');
      if (!CALL_NODE_TYPES.has(ntype)) return true;
      const fnNode = typeof node.childForFieldName === 'function'
        ? (node.childForFieldName('function') || node.namedChild(0))
        : node.namedChild(0);
      if (!fnNode) return true;
      const fnType = String(fnNode.type || '');
      let calleeName = null;
      if (fnType === 'identifier') {
        calleeName = nodeText(fnNode, rawText).trim();
      } else if (fnType === 'member_expression') {
        const propNode = fnNode.childForFieldName
          ? (fnNode.childForFieldName('property') || fnNode.namedChild(fnNode.namedChildCount - 1))
          : fnNode.namedChild(fnNode.namedChildCount - 1);
        calleeName = propNode ? nodeText(propNode, rawText).trim() : null;
      } else if (fnType === 'attribute') {
        const attrNode = fnNode.childForFieldName
          ? (fnNode.childForFieldName('attribute') || fnNode.namedChild(fnNode.namedChildCount - 1))
          : fnNode.namedChild(fnNode.namedChildCount - 1);
        calleeName = attrNode ? nodeText(attrNode, rawText).trim() : null;
      } else if (fnType === 'selector_expression') {
        const fieldNode = fnNode.childForFieldName
          ? (fnNode.childForFieldName('field') || fnNode.namedChild(fnNode.namedChildCount - 1))
          : fnNode.namedChild(fnNode.namedChildCount - 1);
        calleeName = fieldNode ? nodeText(fieldNode, rawText).trim() : null;
      }
      if (calleeName && calleeName.length >= 2) {
        callSitesRaw.push({
          callerLine: Number((node.startPosition?.row ?? 0) + 1),
          calleeName: String(calleeName).slice(0, 64),
        });
      }
      return true;
    });
  }

  const MAX_EXPORTS_SECTION = 40;
  for (const sym of symbolDeclarations) {
    if (!sym.isExported) continue;
    if (exportsSection.items.length >= MAX_EXPORTS_SECTION) break;
    pushSectionItem(exportsSection, {
      text: sym.signature ? `${sym.name} — ${sym.signature}` : sym.name,
      priority: "P0",
    });
  }

  const MAX_CALLS_SECTION = 30;
  // Common short framework/stdlib names add noise and consume the section budget
  // before project-specific call sites. Filter them so domain names rank first.
  const CALL_SITE_NOISE = new Set([
    "json", "status", "send", "end", "next", "emit", "on", "once", "off",
    "push", "pop", "shift", "unshift", "slice", "splice", "map", "filter",
    "reduce", "forEach", "find", "some", "every", "includes", "indexOf",
    "resolve", "reject", "then", "catch", "finally", "all", "race",
    "toString", "valueOf", "hasOwnProperty", "assign", "keys", "values",
    "entries", "fromEntries", "create", "freeze", "log", "warn", "error",
    "info", "debug", "set", "get", "has", "delete", "clear", "size",
    "trim", "split", "join", "replace", "match", "test", "exec",
  ]);
  const callsSorted = [
    ...callSitesRaw.filter((cs) => !CALL_SITE_NOISE.has(cs.calleeName)),
    ...callSitesRaw.filter((cs) => CALL_SITE_NOISE.has(cs.calleeName)),
  ];
  for (let ci = 0; ci < callsSorted.length; ci += 1) {
    if (callsSection.items.length >= MAX_CALLS_SECTION) break;
    const cs = callsSorted[ci];
    pushSectionItem(callsSection, {
      text: `${cs.calleeName} — line ${cs.callerLine}`,
      // First 5 non-noise call sites are P0 so budget limits don't drop them
      priority: ci < 5 && !CALL_SITE_NOISE.has(cs.calleeName) ? "P0" : "P1",
    });
  }

  // Extract string literals for query index (self-contained — cannot import compression-core)
  const stringLiteralsRaw = [];
  if (tree?.rootNode) {
    const STRING_NODE_TYPES_W = new Set([
      'string',
      'string_fragment',
      'template_string',
      'interpreted_string_literal',
      'raw_string_literal',
    ]);
    let slWalked = 0;
    const MAX_SL_WALK = 100000;
    const maxQueryTokens = limits.maxQueryTokens || 300;
    walkTree(tree.rootNode, (node) => {
      slWalked += 1;
      if (slWalked > MAX_SL_WALK) return false;
      if (stringLiteralsRaw.length >= maxQueryTokens) return false;
      const type = String(node.type || '');
      if (!STRING_NODE_TYPES_W.has(type)) return true;
      const start = node.startIndex;
      const end = node.endIndex;
      const raw = rawText.slice(start, end).replace(/^["'`]|["'`]$/g, '').trim();
      if (raw.length < 4) return true;
      if (/^[0-9]+$/.test(raw)) return true;
      if (/^[^a-zA-Z]+$/.test(raw)) return true;
      stringLiteralsRaw.push({
        value: raw.slice(0, 80),
        lineStart: Number((node.startPosition?.row ?? 0) + 1),
      });
      return true;
    });
  }

  const routeLines = extractRegexLines(
    rawText,
    /\b(?:app|router)\.(get|post|put|delete|patch|use)\s*\(\s*["'`]([^"'`]+)["'`]/,
    (match) => `${String(match[1] || "").toUpperCase()} ${String(match[2] || "")}`,
  ).slice(0, maxRoutes);
  for (const entry of routeLines) {
    const spanId = spanManager.addLineSpan(entry.lineNumber, "route", entry.mapped);
    pushSectionItem(routesSection, { text: entry.mapped, spanIds: [spanId], priority: "P1" });
  }

  const literalPatterns = [
    { regex: /\bprocess\.env\.([A-Z0-9_]+)/g, kind: "env" },
    { regex: /\b[A-Z][A-Z0-9_]{3,}\b/g, kind: "const" },
    { regex: /["'`](https?:\/\/[^"'`\s]+|\/api\/[^"'`\s]+|[^"'`\n]{12,80})["'`]/g, kind: "literal" },
  ];
  const literalItems = [];
  for (const pattern of literalPatterns) {
    for (const match of rawText.matchAll(pattern.regex)) {
      if (!match || !Number.isFinite(match.index)) continue;
      literalItems.push({
        text: normalizeWhitespace(match[1] || match[0]),
        spanId: spanManager.addMatchSpan(match, pattern.kind, match[0]),
      });
      if (literalItems.length >= maxLiterals) break;
    }
    if (literalItems.length >= maxLiterals) break;
  }
  for (const entry of literalItems) {
    pushSectionItem(literalsSection, { text: entry.text, spanIds: [entry.spanId], priority: "P1" });
  }

  const bodyElisionsCount = isSkeleton ? 5 : (isCompact ? 12 : 18);
  const bodyElisions = symbolsSection.items.slice(0, bodyElisionsCount).map((item) => ({
    text: `implementation elided; recover raw span for exact control flow ${item.spanIds[0] ? `@${item.spanIds[0]}` : ""}`.trim(),
    spanIds: item.spanIds,
    priority: "P2",
  }));
  for (const entry of bodyElisions) {
    pushSectionItem(elisionsSection, entry);
  }

  const parseOk = Boolean(tree?.rootNode || symbolsSection.items.length || importsSection.items.length);

  // llm-compress fallback for small files that tree-sitter couldn't parse
  if (!parseOk && sourceBytes <= MAX_LLM_FALLBACK_SOURCE_BYTES && llmCompress?.compress) {
    try {
      const result = llmCompress.compress(rawText, llmCompress.getLang(pathValue), pathValue, "llm80");
      const fallbackSpanManager = createSpanManager(rawText);
      const section = createSection("fallback", "P0");
      result.output.split(/\r?\n/g).filter(Boolean).slice(0, 32).forEach((line, index) => {
        const spanId = fallbackSpanManager.addLineSpan(Math.min(index + 1, fallbackSpanManager.lineStarts.length), "fallback-line", line);
        pushSectionItem(section, { text: line, spanIds: [spanId], priority: index < 8 ? "P0" : "P1" });
      });
      return {
        parserFamily: "heuristic-llm-compress",
        parseOk: true,
        fallbackReason: "",
        symbolDeclarations,
        callSitesRaw,
        stringLiteralsRaw,
        sections: [section],
        spanMap: fallbackSpanManager.spans,
        isSkeleton: false,
      };
    } catch {
      // fall through to heuristic result below
    }
  }

  // Regex fallback when tree-sitter native bindings are unavailable or found nothing.
  if (symbolDeclarations.length === 0) {
    const SYMBOL_PATTERNS = [
      { re: /^[\t ]*(export\s+)?(async\s+)?function\s+(\w+)\s*\(/, nameGroup: 3, kind: "function" },
      { re: /^[\t ]*(export\s+)?(abstract\s+|sealed\s+|data\s+|open\s+|final\s+)?(class|interface|enum|type)\s+(\w+)/, nameGroup: 4, kind: "class" },
      { re: /^[\t ]*(public|private|protected|static|async|override|abstract)?\s*(async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/, nameGroup: 3, kind: "method" },
      { re: /^[\t ]*(pub(\(crate\))?\s+)?(async\s+)?fn\s+(\w+)\s*[<(]/, nameGroup: 4, kind: "fn" },
      { re: /^[\t ]*def\s+(\w+)\s*[(\[]/, nameGroup: 1, kind: "fn" },
    ];
    const seenNames = new Set();
    const lines = rawText.split(/\r?\n/g);
    for (let i = 0; i < lines.length && symbolsSection.items.length < MAX_SYMBOL_DISCOVERY; i += 1) {
      const line = lines[i];
      for (const { re, nameGroup, kind } of SYMBOL_PATTERNS) {
        const m = re.exec(line);
        if (!m) continue;
        const name = (m[nameGroup] || "").trim();
        if (!name || seenNames.has(name) || /^(if|for|while|switch|return|const|let|var)$/.test(name)) break;
        seenNames.add(name);
        const spanId = spanManager.addLineSpan(i + 1, kind, line);
        const sig = line.trim().slice(0, 120);
        const isExported = /^export\s/.test(line.trim());
        symbolDeclarations.push({ name, kind, lineStart: i + 1, lineEnd: i + 1, signature: sig, isExported });
        if (isExported) {
          pushSectionItem(exportsSection, { text: `${name} — ${sig}`, priority: "P0" });
        } else {
          pushSectionItem(symbolsSection, { text: `${kind} ${name} line=${i + 1} sig="${sig}"`, spanIds: [spanId], priority: "P0" });
        }
        break;
      }
    }
  }

  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    isSkeleton,
    fallbackReason: parseOk ? "" : "tree-sitter parse unavailable; heuristic code capsule used",
    symbolDeclarations,
    callSitesRaw,
    stringLiteralsRaw,
    sections: [
      exportsSection,
      symbolsSection,
      importsSection,
      callsSection,
      routesSection,
      literalsSection,
      elisionsSection,
    ].flatMap((section) => {
      section.items = dedupeByText(section.items);
      return section.items.length ? [section] : [];
    }),
    spanMap: spanManager.spans,
  };
}

// --- Worker message loop ---
parentPort.on("message", ({ id, pathValue, text, fileType, limits }) => {
  let result;
  try {
    result = buildCodeCapsule(pathValue, text, fileType, limits);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
