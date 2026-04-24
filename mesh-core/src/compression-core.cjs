"use strict";

const crypto = require("crypto");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { Worker } = require("worker_threads");

function safePromisify(fn) {
  return typeof fn === "function" ? promisify(fn) : null;
}

const legacyBrotliCompress = safePromisify(zlib.brotliCompress);
const legacyBrotliDecompress = safePromisify(zlib.brotliDecompress);
const zstdCompress = safePromisify(zlib.zstdCompress);
const zstdDecompress = safePromisify(zlib.zstdDecompress);
const HAS_ZSTD_TRANSPORT = Boolean(zstdCompress && zstdDecompress);

function safeRequire(moduleId) {
  try {
    return require(moduleId);
  } catch {
    return null;
  }
}

const ini = safeRequire("ini");
const TOML = safeRequire("toml");
const YAML = safeRequire("yaml");
const fastXml = safeRequire("fast-xml-parser");
const marked = safeRequire("marked");
const sqlParserModule = safeRequire("node-sql-parser");
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

const WORKSPACE_RECORD_VERSION = 2;
const TRANSPORT_ENVELOPE_VERSION = "mesh-envelope-v2";
const TRANSPORT_ENCODING_ZSTD = "zstd-chunked";
const TRANSPORT_ENCODING_BROTLI = "brotli-chunked";
const TRANSPORT_CONTENT_ENCODING = HAS_ZSTD_TRANSPORT ? TRANSPORT_ENCODING_ZSTD : TRANSPORT_ENCODING_BROTLI;
const LEGACY_WORKSPACE_ENCODING = "base64-brotli";
const DEFAULT_CHUNK_SIZE = 256 * 1024;
const MAX_TRANSPORT_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_TRANSPORT_CHUNKS = 512;
const MAX_TRANSPORT_CHUNK_BYTES = 256 * 1024;
const TRANSPORT_CHUNK_PARALLELISM = (() => {
  const configured = Number(process.env.MESH_TRANSPORT_CHUNK_PARALLELISM);
  const fallback = 4;
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(1, Math.min(normalized, 16));
})();
const MAX_TREE_SITTER_SOURCE_BYTES = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_TREE_SITTER_BYTES);
  const fallback = 2500 * 1024; // Increased from 450 KB to 2.5 MB
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(64 * 1024, Math.min(normalized, 16 * 1024 * 1024));
})();
const MAX_TREE_WALK_NODES = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_TREE_WALK_NODES);
  const fallback = 50000; // Increased from 12000
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(1000, Math.min(normalized, 1000000));
})();
const MAX_SYMBOL_DISCOVERY = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_SYMBOLS);
  const fallback = 1200; // Increased from 280
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(32, Math.min(normalized, 10000));
})();
const MAX_CALL_SITES_PER_FILE = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_CALL_SITES);
  const fallback = 200;
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(10, Math.min(normalized, 2000));
})();
const MAX_QUERY_TOKENS_PER_FILE = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_QUERY_TOKENS);
  const fallback = 300;
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(10, Math.min(normalized, 5000));
})();
const MAX_LLM_FALLBACK_SOURCE_BYTES = (() => {
  const configured = Number(process.env.MESH_CAPSULE_MAX_LLM_FALLBACK_BYTES);
  const fallback = 800 * 1024; // Increased from 220 KB
  const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
  return Math.max(32 * 1024, Math.min(normalized, 8 * 1024 * 1024));
})();
const LARGE_FILE_LINE_THRESHOLD = 300;
const CHUNK_TARGET_LINES = 150;
const MAX_CONTEXT_LINES = 20;
const MAX_RENDER_ITEMS = {
  verbose: 14,
  compact: 8,
  // Per-section caps for dense/emergency are now controlled by buildCapsuleTierProfile.
  // These fallback values are only used when no profile is provided.
  dense: 8,
  emergency: 6,
};

// --- Tree-Sitter Worker Thread Pool ---
// Runs buildCodeCapsule in parallel worker threads so the main event loop
// is not blocked during parse + walk of large source files.
const TREE_SITTER_WORKER_COUNT = (() => {
  const configured = Number(process.env.MESH_TREE_SITTER_WORKERS);
  if (Number.isFinite(configured) && configured > 0) return Math.min(Math.trunc(configured), 16);
  try {
    const os = require("os");
    return Math.max(2, Math.min(os.cpus().length, 8));
  } catch {
    return 4;
  }
})();
const TREE_SITTER_WORKER_PATH = path.join(__dirname, "tree-sitter-worker.cjs");

let _tsWorkerPool = null;
let _tsWorkerIndex = 0;
const _tsPending = new Map(); // id -> { resolve, reject }
let _tsIdCounter = 0;

function getTreeSitterWorkerPool() {
  if (_tsWorkerPool) return _tsWorkerPool;
  _tsWorkerPool = Array.from({ length: TREE_SITTER_WORKER_COUNT }, () => {
    const w = new Worker(TREE_SITTER_WORKER_PATH);
    w.unref(); // don't keep process alive if main thread finishes
    w.on("message", ({ id, ok, result, error }) => {
      const pending = _tsPending.get(id);
      if (!pending) return;
      _tsPending.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error || "tree-sitter worker failed"));
    });
    w.on("error", (err) => {
      // On fatal worker error, reject all pending tasks assigned to this worker
      for (const [id, pending] of _tsPending) {
        _tsPending.delete(id);
        pending.reject(err);
      }
      // Remove from pool so next call rebuilds it
      _tsWorkerPool = null;
    });
    return w;
  });
  return _tsWorkerPool;
}

const TREE_SITTER_DISPATCH_TIMEOUT_MS = 15000;

function dispatchToTreeSitterWorker(pathValue, text, fileType) {
  return new Promise((resolve, reject) => {
    const id = _tsIdCounter += 1;
    const timeout = setTimeout(() => {
      _tsPending.delete(id);
      reject(new Error(`tree-sitter worker timed out after ${TREE_SITTER_DISPATCH_TIMEOUT_MS}ms for ${pathValue}`));
    }, TREE_SITTER_DISPATCH_TIMEOUT_MS);
    _tsPending.set(id, {
      resolve: (val) => { clearTimeout(timeout); resolve(val); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    const pool = getTreeSitterWorkerPool();
    const worker = pool[_tsWorkerIndex % pool.length];
    _tsWorkerIndex += 1;
    worker.postMessage({
      id,
      pathValue,
      text,
      fileType,
      limits: {
        maxTreeSitterBytes: MAX_TREE_SITTER_SOURCE_BYTES,
        maxTreeWalkNodes: MAX_TREE_WALK_NODES,
        maxSymbols: MAX_SYMBOL_DISCOVERY,
        maxCallSites: MAX_CALL_SITES_PER_FILE,
        maxQueryTokens: MAX_QUERY_TOKENS_PER_FILE,
        maxLlmFallbackBytes: MAX_LLM_FALLBACK_SOURCE_BYTES,
      },
    });
  });
}

const CODE_LANGUAGE_MAP = {
  js: {
    family: "code",
    language: "javascript",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "javascript",
  },
  mjs: {
    family: "code",
    language: "javascript",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "javascript",
  },
  cjs: {
    family: "code",
    language: "javascript",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "javascript",
  },
  jsx: {
    family: "code",
    language: "javascript",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "javascript",
  },
  ts: {
    family: "code",
    language: "typescript",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "typescript",
  },
  tsx: {
    family: "code",
    language: "tsx",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "tsx",
  },
  py: {
    family: "code",
    language: "python",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "python",
  },
  go: {
    family: "code",
    language: "go",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "go",
  },
  css: {
    family: "markup",
    language: "css",
    capsuleType: "dom-outline",
    parserFamily: "tree-sitter",
    parserKey: "css",
  },
  scss: {
    family: "markup",
    language: "css",
    capsuleType: "dom-outline",
    parserFamily: "heuristic",
    parserKey: "",
  },
  html: {
    family: "markup",
    language: "html",
    capsuleType: "dom-outline",
    parserFamily: "tree-sitter",
    parserKey: "html",
  },
  htm: {
    family: "markup",
    language: "html",
    capsuleType: "dom-outline",
    parserFamily: "tree-sitter",
    parserKey: "html",
  },
  json: {
    family: "config",
    language: "json",
    capsuleType: "key-path",
    parserFamily: "tree-sitter",
    parserKey: "json",
  },
  rs: {
    family: "code",
    language: "rust",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "rust",
  },
  cpp: {
    family: "code",
    language: "cpp",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "cpp",
  },
  cc: {
    family: "code",
    language: "cpp",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "cpp",
  },
  h: {
    family: "code",
    language: "cpp",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "cpp",
  },
  hpp: {
    family: "code",
    language: "cpp",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "cpp",
  },
  cs: {
    family: "code",
    language: "csharp",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "csharp",
  },
  java: {
    family: "code",
    language: "java",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "java",
  },
  rb: {
    family: "code",
    language: "ruby",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "ruby",
  },
  php: {
    family: "code",
    language: "php",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "php",
  },
  kt: {
    family: "code",
    language: "kotlin",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "kotlin",
  },
  kts: {
    family: "code",
    language: "kotlin",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "kotlin",
  },
  swift: {
    family: "code",
    language: "swift",
    capsuleType: "structure",
    parserFamily: "tree-sitter",
    parserKey: "swift",
  },
};

const NON_TREE_FILE_TYPES = {
  yaml: {
    family: "config",
    language: "yaml",
    capsuleType: "key-path",
    parserFamily: "yaml",
  },
  yml: {
    family: "config",
    language: "yaml",
    capsuleType: "key-path",
    parserFamily: "yaml",
  },
  toml: {
    family: "config",
    language: "toml",
    capsuleType: "key-path",
    parserFamily: "toml",
  },
  ini: {
    family: "config",
    language: "ini",
    capsuleType: "key-path",
    parserFamily: "ini",
  },
  xml: {
    family: "markup",
    language: "xml",
    capsuleType: "dom-outline",
    parserFamily: "xml-parser",
  },
  sql: {
    family: "sql",
    language: "sql",
    capsuleType: "lineage",
    parserFamily: "node-sql-parser",
  },
  md: {
    family: "docs",
    language: "markdown",
    capsuleType: "outline-evidence",
    parserFamily: "marked",
  },
  markdown: {
    family: "docs",
    language: "markdown",
    capsuleType: "outline-evidence",
    parserFamily: "marked",
  },
  txt: {
    family: "docs",
    language: "text",
    capsuleType: "outline-evidence",
    parserFamily: "heuristic",
  },
};

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

const {
  sha256Hex, safeJsonClone, finiteInteger, mapWithConcurrency,
  trimPath, extensionOf, basename, slugify, normalizeWhitespace,
  truncateText, estimateTextTokens, buildLineStarts, locateLineFromCharIndex,
  byteOffsetFromCharIndex, charIndexFromLineRange, sliceTextByLines,
  dedupeByText, createSpanManager,
} = require('./compression-utils.cjs');

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

function pushSectionItem(section, item) {
  if (!section || !item || !item.text) return;
  section.items.push({
    text: truncateText(normalizeWhitespace(item.text), 220),
    spanIds: Array.isArray(item.spanIds) ? item.spanIds.filter(Boolean) : [],
    priority: String(item.priority || "P1"),
  });
}

function createSection(name, priority = "P1") {
  return {
    name,
    priority,
    items: [],
  };
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

function resolveWorkspacePath(sourcePath, importString, workspaceFilePaths = []) {
  const source = trimPath(sourcePath);
  const target = trimPath(importString);
  if (!target || !source) return "";

  // 1. Absolute paths (within workspace) or empty strings
  if (target === "" || target === "/") return "";
  
  const dir = path.posix.dirname(source);
  const rootsToTry = [
    dir === "." ? "" : dir, // Relative to file
    "",                     // Relative to root
    source.split('/')[0]    // Relative to top-level folder
  ];

  const targetsToTry = [];
  if (target.startsWith("./") || target.startsWith("../")) {
     targetsToTry.push(path.posix.join(rootsToTry[0], target));
  } else if (target.startsWith("/")) {
     targetsToTry.push(trimPath(target));
  } else {
     // Bare specifiers: try both as relative and as root-relative
     targetsToTry.push(path.posix.join(rootsToTry[0], target));
     targetsToTry.push(target);
  }

  const exts = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".html", ".css", ".json"];

  for (const tBase of targetsToTry) {
    const t = trimPath(tBase);
    if (workspaceFilePaths.includes(t)) return t;

    for (const ext of exts) {
        if (workspaceFilePaths.includes(t + ext)) return t + ext;
        if (ext && workspaceFilePaths.includes(path.posix.join(t, "index" + ext))) return path.posix.join(t, "index" + ext);
    }
  }

  // 3. Alias support (e.g. @/ -> src/)
  if (target.startsWith("@/")) {
    const aliased = trimPath(target.slice(2));
    if (workspaceFilePaths.includes(aliased)) return aliased;
    for (const ext of exts) {
      if (workspaceFilePaths.includes(aliased + ext)) return aliased + ext;
    }
  }

  return "";
}

/**
 * Extract call sites from a parsed AST tree.
 * Returns raw call site data (callee names + caller lines) — resolution happens separately.
 *
 * @param {Object} tree - tree-sitter parse tree (may be null for non-tree-sitter files)
 * @param {string} rawText - raw file text
 * @param {string} parserFamily - 'javascript'|'typescript'|'python'|'go'|other
 * @returns {{ callerLine: number, calleeName: string }[]}
 */
function extractCallSites(tree, rawText, parserFamily) {
  const callSites = [];
  if (!tree?.rootNode) return callSites;

  const CALL_NODE_TYPES = new Set([
    'call_expression', // JS, TS, Go
    'call',            // Python
  ]);

  let walked = 0;
  const MAX_WALK = 100000;

  walkTree(tree.rootNode, (node) => {
    walked += 1;
    if (walked > MAX_WALK) return false;
    if (callSites.length >= MAX_CALL_SITES_PER_FILE) return false;

    const type = String(node.type || '');
    if (!CALL_NODE_TYPES.has(type)) return true;

    const calleeName = extractCalleeName(node, rawText, parserFamily);
    if (!calleeName || calleeName.length < 2) return true;

    callSites.push({
      callerLine: Number((node.startPosition?.row ?? 0) + 1),
      calleeName: String(calleeName).slice(0, 64),
    });
    return true;
  });

  return callSites;
}

/**
 * Extract string literals from a parsed AST tree for query index building.
 * Returns {value, lineStart} entries for non-trivial string values.
 *
 * @param {Object} tree - tree-sitter parse tree (may be null)
 * @param {string} rawText - raw file text
 * @returns {{ value: string, lineStart: number }[]}
 */
function extractStringLiterals(tree, rawText) {
  const literals = [];
  if (!tree?.rootNode) return literals;

  const STRING_NODE_TYPES = new Set([
    'string',
    'string_fragment',
    'template_string',
    'interpreted_string_literal',
    'raw_string_literal',
  ]);

  let walked = 0;
  const MAX_WALK = 100000;

  walkTree(tree.rootNode, (node) => {
    walked += 1;
    if (walked > MAX_WALK) return false;
    if (literals.length >= MAX_QUERY_TOKENS_PER_FILE) return false;

    const type = String(node.type || '');
    if (!STRING_NODE_TYPES.has(type)) return true;

    const raw = nodeText(node, rawText).replace(/^["'`]|["'`]$/g, '').trim();
    if (raw.length < 4) return true;
    if (/^[0-9]+$/.test(raw)) return true;
    if (/^[^a-zA-Z]+$/.test(raw)) return true;

    literals.push({
      value: raw.slice(0, 80),
      lineStart: Number((node.startPosition?.row ?? 0) + 1),
    });
    return true;
  });

  return literals;
}

/**
 * Extract the callee function name from a call_expression / call node.
 *
 * @param {Object} callNode - tree-sitter call node
 * @param {string} rawText - raw file text
 * @param {string} parserFamily - grammar family string
 * @returns {string|null}
 */
function extractCalleeName(callNode, rawText, parserFamily) {
  const fnNode = typeof callNode.childForFieldName === 'function'
    ? (callNode.childForFieldName('function') || callNode.namedChild(0))
    : callNode.namedChild(0);
  if (!fnNode) return null;

  const fnType = String(fnNode.type || '');

  if (fnType === 'identifier') {
    return nodeText(fnNode, rawText).trim();
  }

  // JS/TS member_expression: obj.method() → extract 'method'
  if (fnType === 'member_expression') {
    const propNode = fnNode.childForFieldName
      ? (fnNode.childForFieldName('property') || fnNode.namedChild(fnNode.namedChildCount - 1))
      : fnNode.namedChild(fnNode.namedChildCount - 1);
    return propNode ? nodeText(propNode, rawText).trim() : null;
  }

  // Python attribute: obj.method() → attribute node
  if (fnType === 'attribute') {
    const attrNode = fnNode.childForFieldName
      ? (fnNode.childForFieldName('attribute') || fnNode.namedChild(fnNode.namedChildCount - 1))
      : fnNode.namedChild(fnNode.namedChildCount - 1);
    return attrNode ? nodeText(attrNode, rawText).trim() : null;
  }

  // Go selector_expression: pkg.Func() → field_identifier
  if (fnType === 'selector_expression') {
    const fieldNode = fnNode.childForFieldName
      ? (fnNode.childForFieldName('field') || fnNode.namedChild(fnNode.namedChildCount - 1))
      : fnNode.namedChild(fnNode.namedChildCount - 1);
    return fieldNode ? nodeText(fieldNode, rawText).trim() : null;
  }

  return null;
}

function buildCodeCapsule(pathValue, text, fileType, workspaceFilePaths = []) {
  const rawText = String(text || "");
  const sourceBytes = Buffer.byteLength(rawText, "utf8");
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
      if (symbolsSection.items.length >= MAX_SYMBOL_DISCOVERY) return false;

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

      let name = namedNodeText(node, rawText);
      if (!name && /(lexical_declaration|variable_declaration)/.test(type)) {
        const match = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(nodeText(node, rawText));
        name = match ? match[1] : "";
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
      let symbolText;
      if (llmCompress && typeof llmCompress.pseudo === "function") {
        const bodyText = nodeText(node, rawText);
        const sig = signaturePreview(node, rawText);
        const pseudoResult = llmCompress.pseudo(name, bodyText, sig);
        if (pseudoResult) {
          symbolText = `${type.replace(/_/g, " ")} ${name} \u2192 ${pseudoResult} @${spanId}`;
        }
      }
      if (!symbolText) {
        symbolText = `${type.replace(/_/g, " ")} ${name} lines=${lineCount} sig="${signaturePreview(node, rawText)}" @${spanId}`;
      }
      pushSectionItem(symbolsSection, {
        text: symbolText,
        spanIds: [spanId],
        priority: "P0",
      });
      const EXPORT_PARENT_TYPES = new Set(['export_statement', 'export_declaration', 'export_default_declaration']);
      const sig = String(signaturePreview(node, rawText) || '').slice(0, 140);
      const isExported = EXPORT_PARENT_TYPES.has(node.parent?.type || '') || /^export\s/.test(sig);
      symbolDeclarations.push({
        name: String(name || ''),
        kind: String(type || ''),
        lineStart: Number((node.startPosition?.row ?? 0) + 1),
        lineEnd: Number((node.endPosition?.row ?? 0) + 1),
        signature: sig,
        isExported,
      });
      if (symbolsSection.items.length >= MAX_SYMBOL_DISCOVERY) return false;
      return true;
    });
  }

  // Regex fallback when tree-sitter native bindings are unavailable or found nothing.
  if (symbolsSection.items.length === 0) {
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
        pushSectionItem(symbolsSection, { text: `${kind} ${name} line=${i + 1} sig="${sig}"`, spanIds: [spanId], priority: "P0" });
        const isExported = /^export\s/.test(line.trim());
        symbolDeclarations.push({ name, kind, lineStart: i + 1, lineEnd: i + 1, signature: sig, isExported });
        break;
      }
    }
  }

  const callSitesRaw = extractCallSites(tree, rawText, fileType?.parserFamily || '');
  const stringLiteralsRaw = extractStringLiterals(tree, rawText);

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
  for (const cs of callSitesRaw) {
    if (callsSection.items.length >= MAX_CALLS_SECTION) break;
    pushSectionItem(callsSection, {
      text: `${cs.calleeName} — line ${cs.callerLine}`,
      priority: "P1",
    });
  }

  const routeLines = extractRegexLines(
    rawText,
    /\b(?:app|router)\.(get|post|put|delete|patch|use)\s*\(\s*["'`]([^"'`]+)["'`]/,
    (match) => `${String(match[1] || "").toUpperCase()} ${String(match[2] || "")}`,
  ).slice(0, 12);
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
      if (literalItems.length >= 18) break;
    }
    if (literalItems.length >= 18) break;
  }
  for (const entry of literalItems) {
    pushSectionItem(literalsSection, { text: entry.text, spanIds: [entry.spanId], priority: "P1" });
  }

  const bodyElisions = symbolsSection.items.slice(0, 18).map((item) => ({
    text: `implementation elided; recover raw span for exact control flow ${item.spanIds[0] ? `@${item.spanIds[0]}` : ""}`.trim(),
    spanIds: item.spanIds,
    priority: "P2",
  }));
  for (const entry of bodyElisions) {
    pushSectionItem(elisionsSection, entry);
  }

  const parseOk = Boolean(tree?.rootNode || symbolsSection.items.length || importsSection.items.length);
  const fallbackReason = parseOk ? "" : "tree-sitter parse unavailable; heuristic code capsule used";
  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    fallbackReason,
    symbolDeclarations,
    callSitesRaw,
    stringLiteralsRaw,
    sections: [
      exportsSection,
      symbolsSection,
      importsSection,
      routesSection,
      callsSection,
      literalsSection,
      elisionsSection,
    ].flatMap((section) => {
      section.items = dedupeByText(section.items);
      return section.items.length ? [section] : [];
    }),
    spanMap: spanManager.spans,
  };
}

function parseStructuredConfig(rawText, language) {
  if (language === "json") return JSON.parse(rawText);
  if (language === "yaml") return YAML ? YAML.parse(rawText) : null;
  if (language === "toml") return TOML ? TOML.parse(rawText) : null;
  if (language === "ini") return ini ? ini.parse(rawText) : null;
  if (language === "xml" && fastXml?.XMLParser) {
    const parser = new fastXml.XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    return parser.parse(rawText);
  }
  return null;
}

function flattenStructuredValue(value, prefix = "", depth = 0, out = []) {
  if (depth > 6) return out;
  if (Array.isArray(value)) {
    out.push({
      keyPath: prefix || "$",
      type: "array",
      preview: `len=${value.length}`,
      depth,
    });
    value.slice(0, 12).forEach((entry, index) => flattenStructuredValue(entry, `${prefix}[${index}]`, depth + 1, out));
    return out;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    out.push({
      keyPath: prefix || "$",
      type: "object",
      preview: `keys=${keys.length}`,
      depth,
    });
    keys.slice(0, 48).forEach((key) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenStructuredValue(value[key], nextPrefix, depth + 1, out);
    });
    return out;
  }

  let type = typeof value;
  if (value === null) type = "null";
  out.push({
    keyPath: prefix || "$",
    type,
    preview: truncateText(normalizeWhitespace(JSON.stringify(value)), 120),
    depth,
  });
  return out;
}

function buildConfigCapsule(pathValue, text, fileType) {
  const rawText = String(text || "");
  const spanManager = createSpanManager(rawText);
  const topSection = createSection("top-level", "P0");
  const schemaSection = createSection("schema", "P1");
  const evidenceSection = createSection("evidence", "P2");
  let parseOk = false;
  let fallbackReason = "";

  try {
    const parsed = parseStructuredConfig(rawText, fileType.language);
    const flattened = flattenStructuredValue(parsed);
    const topKeys = [];
    for (const item of flattened) {
      if (item.keyPath !== "$" && !item.keyPath.includes(".") && !item.keyPath.includes("[")) topKeys.push(item);
    }
    topKeys.slice(0, 16).forEach((item, topIdx) => {
      const leaf = item.keyPath.split(".").pop();
      const lineMatch = new RegExp(`(^|\\n)\\s*["']?${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`, "i").exec(rawText);
      const spanId = lineMatch ? spanManager.addMatchSpan(lineMatch, "key", item.keyPath) : "";
      pushSectionItem(topSection, {
        text: `${item.keyPath} type=${item.type} ${item.preview}`,
        spanIds: spanId ? [spanId] : [],
        // Only the first top-level key is P0 — subsequent keys are context, not the primary value.
        priority: topIdx === 0 ? "P0" : "P1",
      });
    });
    // Leaf values (depth >= 2) first, then structural nodes — prevents wide shallow
    // filler sections from flooding BFS-ordered output and burying specific config values.
    const leafItems = flattened.filter((i) => i.depth >= 2).slice(0, 30);
    const shallowItems = flattened.filter((i) => i.depth < 2).slice(0, 16);
    for (const item of [...leafItems, ...shallowItems]) {
      const leaf = item.keyPath.split(".").pop();
      const lineMatch = leaf ? new RegExp(`(^|\\n)\\s*["']?${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`, "i").exec(rawText) : null;
      const spanId = lineMatch ? spanManager.addMatchSpan(lineMatch, "key-path", item.keyPath) : "";
      pushSectionItem(schemaSection, {
        text: `${item.keyPath} => ${item.type}${item.preview ? ` ${item.preview}` : ""}`.trim(),
        spanIds: spanId ? [spanId] : [],
        // Leaf paths (depth >= 2) are P0 — they carry the actual config values that
        // LLMs need. Structural nodes (depth <= 1) are P1 context.
        priority: item.depth >= 2 ? "P0" : "P1",
      });
    }
    parseOk = true;
  } catch (error) {
    fallbackReason = error?.message ? `structured parse failed: ${error.message}` : "structured parse failed";
  }

  if (!parseOk) {
    const lines = rawText.split(/\r?\n/g).filter(Boolean).slice(0, 20);
    lines.forEach((line, index) => {
      const spanId = spanManager.addLineSpan(index + 1, "config-line", line);
      pushSectionItem(evidenceSection, { text: truncateText(line, 160), spanIds: [spanId], priority: "P1" });
    });
  }

  const sections = [topSection, schemaSection, evidenceSection].filter((section) => {
    section.items = dedupeByText(section.items);
    return section.items.length > 0;
  });
  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    fallbackReason,
    sections,
    spanMap: spanManager.spans,
  };
}

function splitSqlStatements(text) {
  const rawText = String(text || "");
  const parts = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rawText.length; i += 1) {
    const char = rawText[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === "\"" && !inSingle) inDouble = !inDouble;
    else if (char === ";" && !inSingle && !inDouble) {
      parts.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < rawText.length) parts.push({ start, end: rawText.length });
  return parts.filter((entry) => entry.end > entry.start);
}

function buildSqlCapsule(pathValue, text, fileType) {
  const rawText = String(text || "");
  const spanManager = createSpanManager(rawText);
  const statementsSection = createSection("statements", "P0");
  const tablesSection = createSection("tables", "P1");
  const columnsSection = createSection("columns", "P1");
  let parseOk = false;
  let fallbackReason = "";
  try {
    const SQLParser = sqlParserModule?.Parser;
    if (!SQLParser) throw new Error("node-sql-parser unavailable");
    const parser = new SQLParser();
    const ast = parser.astify(rawText);
    const statements = Array.isArray(ast) ? ast : [ast];
    const statementRanges = splitSqlStatements(rawText);
    statements.forEach((statement, index) => {
      const range = statementRanges[index] || { start: 0, end: rawText.length };
      const spanId = spanManager.addSpan({
        startIndex: range.start,
        endIndex: range.end,
        kind: "sql-statement",
        label: statement?.type || `statement-${index + 1}`,
      });
      pushSectionItem(statementsSection, {
        text: `${statement?.type || "statement"} ${truncateText(normalizeWhitespace(rawText.slice(range.start, range.end)), 160)} @${spanId}`,
        spanIds: [spanId],
        priority: "P0",
      });
    });
    const tableList = parser.tableList(rawText).slice(0, 30);
    tableList.forEach((entry) => {
      pushSectionItem(tablesSection, { text: String(entry || ""), spanIds: [], priority: "P1" });
    });
    const columnList = parser.columnList(rawText).slice(0, 30);
    columnList.forEach((entry) => {
      pushSectionItem(columnsSection, { text: String(entry || ""), spanIds: [], priority: "P1" });
    });
    parseOk = true;
  } catch (error) {
    fallbackReason = error?.message ? `sql parse failed: ${error.message}` : "sql parse failed";
    splitSqlStatements(rawText).slice(0, 12).forEach((range, index) => {
      const spanId = spanManager.addSpan({
        startIndex: range.start,
        endIndex: range.end,
        kind: "sql-statement",
        label: `statement-${index + 1}`,
      });
      pushSectionItem(statementsSection, {
        text: truncateText(normalizeWhitespace(rawText.slice(range.start, range.end)), 160),
        spanIds: [spanId],
        priority: "P0",
      });
    });
  }

  const sections = [statementsSection, tablesSection, columnsSection].filter((section) => {
    section.items = dedupeByText(section.items);
    return section.items.length > 0;
  });
  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    fallbackReason,
    sections,
    spanMap: spanManager.spans,
  };
}

function buildMarkupCapsule(pathValue, text, fileType) {
  const rawText = String(text || "");
  const spanManager = createSpanManager(rawText);
  const outlineSection = createSection("outline", "P0");
  const anchorsSection = createSection("anchors", "P1");
  const scriptsSection = createSection("scripts", "P1");
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of rawText.matchAll(headingRegex)) {
    const textValue = String(match[2] || "").replace(/<[^>]+>/g, " ").trim();
    const spanId = spanManager.addMatchSpan(match, "heading", textValue);
    pushSectionItem(outlineSection, {
      text: `h${match[1]} ${truncateText(textValue, 120)}`,
      spanIds: [spanId],
      priority: "P0",
    });
    if (outlineSection.items.length >= 18) break;
  }

  const idRegex = /\bid=["']([^"']+)["']/gi;
  for (const match of rawText.matchAll(idRegex)) {
    const spanId = spanManager.addMatchSpan(match, "id", match[1]);
    pushSectionItem(anchorsSection, {
      text: `id ${match[1]}`,
      spanIds: [spanId],
      priority: "P1",
    });
    if (anchorsSection.items.length >= 18) break;
  }

  const classRegex = /\bclass=["']([^"']+)["']/gi;
  for (const match of rawText.matchAll(classRegex)) {
    const classes = String(match[1] || "").split(/\s+/g).filter(Boolean).slice(0, 4).join(", ");
    const spanId = spanManager.addMatchSpan(match, "class", classes);
    pushSectionItem(anchorsSection, {
      text: `class ${classes}`,
      spanIds: [spanId],
      priority: "P1",
    });
    if (anchorsSection.items.length >= 30) break;
  }

  const scriptRegex = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of rawText.matchAll(scriptRegex)) {
    const spanId = spanManager.addMatchSpan(match, "embedded", match[1]);
    pushSectionItem(scriptsSection, {
      text: `${match[1]} block bytes=${Buffer.byteLength(String(match[2] || ""), "utf8")}`,
      spanIds: [spanId],
      priority: "P1",
    });
    if (scriptsSection.items.length >= 12) break;
  }

  const parseOk = Boolean(outlineSection.items.length || anchorsSection.items.length);
  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    fallbackReason: parseOk ? "" : "markup parsing fell back to regex outline",
    sections: [outlineSection, anchorsSection, scriptsSection].filter((section) => {
      section.items = dedupeByText(section.items);
      return section.items.length > 0;
    }),
    spanMap: spanManager.spans,
  };
}

function buildDocsCapsule(pathValue, text, fileType) {
  const rawText = String(text || "");
  const spanManager = createSpanManager(rawText);
  const outlineSection = createSection("outline", "P0");
  const evidenceSection = createSection("evidence", "P1");
  const codeSection = createSection("code-blocks", "P1");
  let parseOk = false;
  try {
    const lexer = marked?.lexer || marked?.marked?.lexer;
    if (!lexer) throw new Error("marked lexer unavailable");
    const tokens = lexer(rawText);
    for (const token of tokens) {
      if (token.type === "heading") {
        const raw = String(token.raw || token.text || "");
        const index = raw ? rawText.indexOf(raw) : -1;
        const spanId = index >= 0
          ? spanManager.addSpan({ startIndex: index, endIndex: index + raw.length, kind: "heading", label: token.text })
          : "";
        pushSectionItem(outlineSection, {
          text: `h${token.depth || 1} ${token.text}`,
          spanIds: spanId ? [spanId] : [],
          priority: "P0",
        });
      } else if (token.type === "paragraph" || token.type === "list") {
        const raw = String(token.raw || "");
        const index = raw ? rawText.indexOf(raw) : -1;
        const spanId = index >= 0
          ? spanManager.addSpan({ startIndex: index, endIndex: index + raw.length, kind: "evidence", label: raw })
          : "";
        pushSectionItem(evidenceSection, {
          text: truncateText(normalizeWhitespace(raw), 160),
          spanIds: spanId ? [spanId] : [],
          priority: "P1",
        });
      } else if (token.type === "code") {
        const raw = String(token.raw || token.text || "");
        const index = raw ? rawText.indexOf(raw) : -1;
        const spanId = index >= 0
          ? spanManager.addSpan({ startIndex: index, endIndex: index + raw.length, kind: "code", label: token.lang || "code" })
          : "";
        pushSectionItem(codeSection, {
          text: `code ${token.lang || "plain"} ${truncateText(normalizeWhitespace(token.text || raw), 120)}`,
          spanIds: spanId ? [spanId] : [],
          priority: "P1",
        });
      }
    }
    parseOk = outlineSection.items.length > 0 || evidenceSection.items.length > 0;
  } catch (error) {
    const lines = rawText.split(/\r?\n/g).filter(Boolean).slice(0, 24);
    lines.forEach((line, index) => {
      const spanId = spanManager.addLineSpan(index + 1, "doc-line", line);
      pushSectionItem(evidenceSection, {
        text: truncateText(line, 160),
        spanIds: [spanId],
        priority: line.startsWith("#") ? "P0" : "P1",
      });
    });
  }

  return {
    parserFamily: parseOk ? fileType.parserFamily : "heuristic",
    parseOk,
    fallbackReason: parseOk ? "" : "document parsing fell back to line outline",
    sections: [outlineSection, evidenceSection, codeSection].filter((section) => {
      section.items = dedupeByText(section.items);
      return section.items.length > 0;
    }),
    spanMap: spanManager.spans,
  };
}

function buildTextFallbackCapsule(pathValue, text, fileType) {
  const rawText = String(text || "");
  const spanManager = createSpanManager(rawText);
  const symbolsSection = createSection("symbols", "P0");
  const exportsSection = createSection("exports", "P0");
  const outlineSection = createSection("outline", "P1");

  // Regex patterns covering Rust, Elixir, Ruby, generic C-style, JS/TS, class/struct/trait/protocol
  const SYMBOL_PATTERNS = [
    { re: /^[\t ]*(pub(\(crate\))?\s+)?(async\s+)?fn\s+(\w+)\s*[<(]/, nameGroup: 4, kind: "fn" },
    { re: /^[\t ]*def\s+(\w+)\s*[(\[]/, nameGroup: 1, kind: "fn" },
    { re: /^[\t ]*defp?\s+(\w+)\s*[\(\s]/, nameGroup: 1, kind: "fn" },
    { re: /^(\w+)\s*::/, nameGroup: 1, kind: "fn" },
    { re: /^[\t ]*(public|private|protected|static|async|export|override|virtual|inline|final|abstract|sealed|open|fun|func)?\s+[\w:<>*&\[\]]+\s+(\w+)\s*\(/, nameGroup: 2, kind: "fn" },
    { re: /^[\t ]*(export\s+)?(async\s+)?function\s+(\w+)\s*\(/, nameGroup: 3, kind: "fn" },
    { re: /^[\t ]*(public|private|abstract|sealed|data|open|final|export)?\s*(class|struct|interface|trait|enum|protocol|impl|object|module)\s+(\w+)/, nameGroup: 3, kind: "class" },
  ];

  const seenNames = new Set();
  const heuristicSymbolDeclarations = [];
  const heuristicStringLiterals = [];
  const STRING_LITERAL_RE = /["'`]([^"'`\n]{4,80})["'`]/g;
  const lines = rawText.split(/\r?\n/g);

  for (let i = 0; i < lines.length && symbolsSection.items.length < MAX_SYMBOL_DISCOVERY; i += 1) {
    const line = lines[i];
    for (const { re, nameGroup, kind } of SYMBOL_PATTERNS) {
      const match = re.exec(line);
      if (!match) continue;
      const name = (match[nameGroup] || "").trim();
      if (!name || seenNames.has(name)) break;
      seenNames.add(name);
      const spanId = spanManager.addLineSpan(i + 1, kind, line);
      pushSectionItem(symbolsSection, {
        text: kind + " " + name + " line=" + (i + 1),
        spanIds: [spanId],
        priority: "P0",
      });
      heuristicSymbolDeclarations.push({
        name: String(name),
        kind: String(kind === 'class' ? 'class' : 'function'),
        lineStart: i + 1,
        lineEnd: i + 1,
        signature: String(line.trim().slice(0, 140)),
        isExported: /^export\s/.test(line.trim()),
      });
      break;
    }
  }

  for (const match of rawText.matchAll(STRING_LITERAL_RE)) {
    const value = String(match[1] || '').trim();
    if (!value || /^[0-9]+$/.test(value) || /^[^a-zA-Z]+$/.test(value)) continue;
    const lineNum = rawText.slice(0, match.index).split('\n').length;
    heuristicStringLiterals.push({ value: value.slice(0, 80), lineStart: lineNum });
    if (heuristicStringLiterals.length >= MAX_QUERY_TOKENS_PER_FILE) break;
  }

  if (symbolsSection.items.length === 0) {
    lines.filter(Boolean).slice(0, 12).forEach((line, index) => {
      const spanId = spanManager.addLineSpan(index + 1, "line", line);
      pushSectionItem(outlineSection, {
        text: truncateText(line, 160),
        spanIds: [spanId],
        priority: index < 3 ? "P0" : "P1",
      });
    });
  }

  const MAX_EXPORTS_SECTION = 40;
  for (const sym of heuristicSymbolDeclarations) {
    if (!sym.isExported) continue;
    if (exportsSection.items.length >= MAX_EXPORTS_SECTION) break;
    pushSectionItem(exportsSection, {
      text: sym.signature ? `${sym.name} — ${sym.signature}` : sym.name,
      priority: "P0",
    });
  }

  const sections = [exportsSection, symbolsSection, outlineSection].filter((s) => {
    s.items = dedupeByText(s.items);
    return s.items.length > 0;
  });

  return {
    parserFamily: "heuristic",
    parseOk: sections.length > 0,
    fallbackReason: symbolsSection.items.length > 0
      ? "heuristic symbol extraction (no tree-sitter grammar for this language)"
      : "plain text fallback — no recognizable symbol patterns found",
    symbolDeclarations: heuristicSymbolDeclarations,
    stringLiteralsRaw: heuristicStringLiterals,
    sections,
    spanMap: spanManager.spans,
  };
}

function buildHeuristicFallbackFromLlmCompress(pathValue, text, fileType) {
  if (!llmCompress?.compress) return null;
  try {
    const result = llmCompress.compress(String(text || ""), llmCompress.getLang(pathValue), pathValue, "llm80");
    const rawText = String(text || "");
    const spanManager = createSpanManager(rawText);
    const section = createSection("fallback", "P0");
    result.output.split(/\r?\n/g).filter(Boolean).slice(0, 32).forEach((line, index) => {
      const spanId = spanManager.addLineSpan(Math.min(index + 1, spanManager.lineStarts.length), "fallback-line", line);
      pushSectionItem(section, { text: line, spanIds: [spanId], priority: index < 8 ? "P0" : "P1" });
    });
    return {
      parserFamily: "heuristic-llm-compress",
      parseOk: true,
      fallbackReason: "",
      sections: [section],
      spanMap: spanManager.spans,
    };
  } catch {
    return null;
  }
}

function detectFileType(filePath, text = "") {
  const ext = extensionOf(filePath);
  if (CODE_LANGUAGE_MAP[ext]) return { ...CODE_LANGUAGE_MAP[ext], extension: ext };
  if (NON_TREE_FILE_TYPES[ext]) return { ...NON_TREE_FILE_TYPES[ext], extension: ext };

  const rawText = String(text || "");
  if (/^\s*</.test(rawText)) {
    return { family: "markup", language: "xml", capsuleType: "dom-outline", parserFamily: "xml-parser", extension: ext || "xml" };
  }
  if (/^\s*[{[]/.test(rawText)) {
    return { family: "config", language: "json", capsuleType: "key-path", parserFamily: "tree-sitter", parserKey: "json", extension: ext || "json" };
  }
  return { family: "docs", language: "text", capsuleType: "outline-evidence", parserFamily: "heuristic", extension: ext || "txt" };
}

async function buildBaseCapsule(pathValue, text, fileType) {
  if (fileType.family === "code") {
    try {
      return await dispatchToTreeSitterWorker(pathValue, text, fileType);
    } catch {
      // Worker unavailable — fall back to inline sync parse
      return buildCodeCapsule(pathValue, text, fileType);
    }
  }
  if (fileType.family === "config") return buildConfigCapsule(pathValue, text, fileType);
  if (fileType.family === "sql") return buildSqlCapsule(pathValue, text, fileType);
  if (fileType.family === "markup") return buildMarkupCapsule(pathValue, text, fileType);
  if (fileType.family === "docs") return buildDocsCapsule(pathValue, text, fileType);
  return buildTextFallbackCapsule(pathValue, text, fileType);
}

function materializeCapsuleForMode(baseCapsule, fileInfo, mode, query = "", profile = {}) {
  const sections = [];
  const maxItems = MAX_RENDER_ITEMS[mode] || MAX_RENDER_ITEMS.compact;
  const maxSections = Math.max(1, Number(profile.maxSections) || (mode === "verbose" ? 8 : mode === "compact" ? 6 : mode === "dense" ? 4 : 2));
  const allowedPriorities = new Set(Array.isArray(profile.allowedPriorities) && profile.allowedPriorities.length ? profile.allowedPriorities : ["P0", "P1", "P2"]);
  const maxPrimaryItemsPerSection = Math.max(0, Number(profile.maxPrimaryItemsPerSection) || maxItems);
  const maxSecondaryItemsPerSection = Math.max(0, Number(profile.maxSecondaryItemsPerSection) || Math.min(maxItems, maxPrimaryItemsPerSection));
  const maxTotalItems = Math.max(1, Number(profile.maxTotalItems) || Number.MAX_SAFE_INTEGER);
  const itemTextLimit = Math.max(40, Number(profile.itemTextLimit) || (mode === "dense" ? 140 : 9999));
  const maxSpanIds = Math.max(0, Number(profile.maxSpanIds) || (mode === "dense" ? 1 : 3));
  const includeRawMetrics = profile.includeRawMetrics !== false;
  let totalItems = 0;

  for (const section of baseCapsule.sections) {
    if (sections.length >= maxSections || totalItems >= maxTotalItems) break;
    const sectionPriority = section.priority || "P1";
    if (!allowedPriorities.has(sectionPriority)) continue;
    const nextItems = [];
    // exports section is the entire purpose of ultra tier — never truncate it per-section.
    // It is bounded by maxTotalItems instead, which is the global budget.
    const isExportsSection = section.name === "exports";
    // A section containing P0 items earns the primary-items budget even if the
    // section itself is marked P1 — so high-priority call-sites / literals survive
    // tight medium-tier limits alongside lower-priority filler items.
    const hasPrimaryItems = section.items.some((item) => (item.priority || sectionPriority) === "P0");
    const maxItemsForSection = isExportsSection
      ? (maxTotalItems - totalItems)
      : (sectionPriority === "P0" || hasPrimaryItems ? maxPrimaryItemsPerSection : maxSecondaryItemsPerSection);
    if (maxItemsForSection <= 0) continue;
    // Sort items by priority so P0 items are always emitted before P1/P2 within a
    // section — prevents trivial helpers from consuming the budget ahead of key symbols.
    const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
    const sortedItems = section.items.slice().sort(
      (a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
    );
    let primaryItemsInSection = 0;
    let secondaryItemsInSection = 0;
    for (const item of sortedItems) {
      const itemPriority = item.priority || sectionPriority;
      if (!allowedPriorities.has(itemPriority)) continue;
      if (totalItems >= maxTotalItems) break;
      if (isExportsSection) {
        // Exports section is uncapped per-section — all exports must appear for correct
        // symbol discovery. Only the global maxTotalItems limits it.
        if (nextItems.length >= maxItemsForSection) break;
      } else {
        // P0 items are counted against the primary cap; P1/P2 against the secondary cap.
        // This prevents a section with one P0 item from consuming maxPrimary slots on P1 fillers.
        const isPrimary = itemPriority === "P0";
        if (isPrimary && primaryItemsInSection >= maxPrimaryItemsPerSection) break;
        if (!isPrimary && secondaryItemsInSection >= maxSecondaryItemsPerSection) continue;
        if (nextItems.length >= Math.min(maxItems, maxItemsForSection)) break;
        if (isPrimary) primaryItemsInSection += 1;
        else secondaryItemsInSection += 1;
      }
      nextItems.push({
        text: truncateText(item.text, itemTextLimit),
        spanIds: Array.isArray(item.spanIds) ? item.spanIds.slice(0, maxSpanIds) : [],
        priority: itemPriority,
      });
      totalItems += 1;
    }
    if (!nextItems.length) continue;
    sections.push({
      name: section.name,
      priority: section.priority || "P1",
      items: nextItems,
    });
  }

  if (mode === "emergency" && sections.length === 0) {
    sections.push({
      name: "summary",
      priority: "P0",
      items: [{
        text: `Emergency capsule for ${basename(fileInfo.path)}; use recovery for exact detail.`,
        spanIds: [],
        priority: "P0",
      }],
    });
  }

  return {
    version: WORKSPACE_RECORD_VERSION,
    path: fileInfo.path,
    fileType: `${fileInfo.family}/${fileInfo.language}`,
    family: fileInfo.family,
    language: fileInfo.language,
    capsuleType: fileInfo.capsuleType,
    parserFamily: baseCapsule.parserFamily,
    parseOk: Boolean(baseCapsule.parseOk),
    capsuleMode: mode,
    query: String(query || ""),
    rawBytes: fileInfo.rawBytes,
    rawTokenEstimate: fileInfo.rawTokenEstimate,
    includeRawMetrics,
    mustKeep: sections.filter((section) => section.priority === "P0").map((section) => section.name),
    sections,
    spanMap: baseCapsule.spanMap || {},
    totalItems,
    focused: Boolean(query),
    fallbackReason: baseCapsule.fallbackReason || "",
  };
}

function renderCapsuleText(capsule) {
  const capsuleTier = normalizeCapsuleTier(capsule.capsuleTier, "ultra");
  const lines = [];

  if (capsuleTier === "ultra") {
    lines.push(`CAP ${basename(capsule.path)} ${capsule.language} ${capsule.rawBytes}B ${capsule.rawTokenEstimate}T ${capsule.capsuleMode}`);
  } else {
    lines.push(`CAPSULE v${capsule.version} path=${capsule.path}`);
    lines.push(`type=${capsule.fileType} capsule=${capsule.capsuleType} mode=${capsule.capsuleMode} tier=${capsuleTier} parser=${capsule.parserFamily} parse_ok=${Boolean(capsule.parseOk)}`);
    if (capsule.includeRawMetrics !== false && Number.isFinite(Number(capsule.rawTokenEstimate))) {
      lines.push(`raw_bytes=${capsule.rawBytes} raw_tokens=${capsule.rawTokenEstimate}`);
    } else {
      lines.push(`raw_bytes=${capsule.rawBytes}`);
    }
  }

  if (capsule.query) lines.push(`focus_query=${JSON.stringify(capsule.query)}`);
  if (capsule.fallbackReason) lines.push(`fallback_reason=${truncateText(capsule.fallbackReason, 180)}`);
  for (const section of capsule.sections) {
    lines.push(`[${section.name}]`);
    for (const item of section.items) {
      const refs = Array.isArray(item.spanIds) && item.spanIds.length ? ` ${item.spanIds.map((id) => `@${id}`).join(" ")}` : "";
      lines.push(`- ${item.text}${refs}`);
    }
  }
  if (!capsule.sections.length) {
    lines.push("[summary]");
    lines.push("- empty capsule");
  }
  return lines.join("\n");
}

function normalizeCapsuleTier(tier, fallback = "ultra") {
  const normalized = String(tier || "").trim().toLowerCase();
  if (normalized === "ultra" || normalized === "medium" || normalized === "loose") return normalized;
  return fallback;
}

function classifyCapsuleScale(rawTokenEstimate) {
  const tokens = Math.max(0, Number(rawTokenEstimate || 0));
  if (tokens <= 80) return "tiny";
  if (tokens <= 240) return "small";
  if (tokens <= 1200) return "medium";
  return "large";
}

function buildCapsuleBudget(tokens, ratio, min, max) {
  const numeric = Math.max(0, Number(tokens || 0));
  if (!numeric) return Math.max(12, min);
  return Math.max(12, Math.min(max, Math.max(min, Math.floor(numeric * ratio))));
}

function buildCapsuleTierBudget(rawTokenEstimate, tier) {
  const tokens = Math.max(0, Number(rawTokenEstimate || 0));
  const scale = classifyCapsuleScale(tokens);
  const normalizedTier = normalizeCapsuleTier(tier, "ultra");
  if (normalizedTier === "loose") {
    if (scale === "tiny") return buildCapsuleBudget(tokens, 0.95, 28, 180);
    if (scale === "small") return buildCapsuleBudget(tokens, 0.88, 80, 260);
    if (scale === "medium") return buildCapsuleBudget(tokens, 0.42, 120, 640);
    return buildCapsuleBudget(tokens, 0.30, 180, 1600);
  }
  if (normalizedTier === "medium") {
    if (scale === "tiny") return buildCapsuleBudget(tokens, 0.78, 24, 120);
    if (scale === "small") return buildCapsuleBudget(tokens, 0.78, 60, 240);
    if (scale === "medium") return buildCapsuleBudget(tokens, 0.35, 120, 500);
    return buildCapsuleBudget(tokens, 0.22, 150, 900);
  }
  if (scale === "tiny") return buildCapsuleBudget(tokens, 0.60, 18, 84);
  if (scale === "small") return buildCapsuleBudget(tokens, 0.32, 32, 96);
  if (scale === "medium") return buildCapsuleBudget(tokens, 0.16, 48, 180);
  return buildCapsuleBudget(tokens, 0.10, 64, 220);
}

function buildCapsuleTierProfile(rawTokenEstimate, tier, mode) {
  const scale = classifyCapsuleScale(rawTokenEstimate);
  const normalizedTier = normalizeCapsuleTier(tier, "ultra");
  const normalizedMode = String(mode || "compact").trim().toLowerCase();
  const base = {
    allowedPriorities: ["P0", "P1", "P2"],
    maxSections: normalizedMode === "verbose" ? 8 : normalizedMode === "compact" ? 6 : normalizedMode === "dense" ? 4 : 2,
    maxPrimaryItemsPerSection: normalizedMode === "verbose" ? 14 : normalizedMode === "compact" ? 8 : normalizedMode === "dense" ? 4 : 2,
    maxSecondaryItemsPerSection: normalizedMode === "verbose" ? 10 : normalizedMode === "compact" ? 6 : normalizedMode === "dense" ? 3 : 1,
    maxTotalItems: normalizedMode === "verbose" ? 20 : normalizedMode === "compact" ? 12 : normalizedMode === "dense" ? 6 : 3,
    itemTextLimit: normalizedMode === "verbose" ? 220 : normalizedMode === "compact" ? 180 : normalizedMode === "dense" ? 120 : 90,
    maxSpanIds: normalizedMode === "verbose" ? 3 : normalizedMode === "compact" ? 2 : 1,
    includeRawMetrics: true,
  };

  if (normalizedTier === "loose") {
    if (scale === "tiny") {
      return {
        ...base,
        maxSections: Math.min(base.maxSections, 6),
        maxTotalItems: Math.min(base.maxTotalItems, 10),
      };
    }
    if (scale === "small") {
      const isDense = normalizedMode === "dense" || normalizedMode === "emergency";
      return {
        ...base,
        maxSections: isDense ? 4 : Math.min(base.maxSections, 6),
        // Sections are ordered exports → calls → symbols; per-section cap of 5 lets
        // call-sites fill their budget before symbols consume remaining slots.
        maxPrimaryItemsPerSection: isDense ? 5 : base.maxPrimaryItemsPerSection,
        // Override base.maxTotalItems (dense base=6) so call-sites + exports + symbols all fit.
        maxTotalItems: isDense ? 10 : Math.min(base.maxTotalItems, 12),
      };
    }
    if (scale === "medium") {
      const isDense = normalizedMode === "dense" || normalizedMode === "emergency";
      return {
        ...base,
        maxSections: isDense ? 5 : base.maxSections,
        maxPrimaryItemsPerSection: isDense ? 5 : base.maxPrimaryItemsPerSection,
        maxTotalItems: isDense ? 6 : base.maxTotalItems,
      };
    }
    return base;
  }

  if (normalizedTier === "medium") {
    const isDense = normalizedMode === "dense" || normalizedMode === "emergency";
    // For dense/emergency: use fixed values (not min-with-base) so emergency's tight
    // base caps don't override the tier-level overrides.
    const maxPrimary = isDense
      ? (scale === "tiny" ? 3 : scale === "small" ? 5 : scale === "medium" ? 5 : 4)
      : Math.min(base.maxPrimaryItemsPerSection, scale === "tiny" ? 3 : scale === "small" ? 4 : 5);
    return {
      ...base,
      maxSections: isDense
        ? (scale === "tiny" ? 4 : scale === "small" ? 4 : 5)
        : Math.min(base.maxSections, scale === "tiny" ? 4 : scale === "small" ? 4 : 5),
      maxPrimaryItemsPerSection: maxPrimary,
      // isDense at medium scale uses maxSecondary=1 so structural/top-level sections
      // don't consume slots that P0 leaf values (schema, calls) need.
      maxSecondaryItemsPerSection: isDense && scale === "medium"
        ? 1
        : Math.min(base.maxSecondaryItemsPerSection, scale === "tiny" ? 2 : 3),
      maxTotalItems: isDense
        ? (scale === "tiny" ? 4 : scale === "small" ? 10 : scale === "medium" ? 6 : 12)
        : Math.min(base.maxTotalItems, scale === "tiny" ? 4 : scale === "small" ? 12 : scale === "medium" ? 14 : 16),
      itemTextLimit: Math.min(base.itemTextLimit, scale === "large" ? 150 : 170),
      maxSpanIds: Math.min(base.maxSpanIds, scale === "small" ? 1 : 2),
    };
  }

  // Ultra tier: exports section is uncapped per-section (handled in materializeCapsuleForMode).
  // maxTotalItems must be large enough to fit all exports plus a symbols item.
  // Token budget is enforced by buildCapsuleTierBudget — this is just an item-count ceiling.
  const ultraMaxItems = scale === "tiny" ? 6 : scale === "small" ? 12 : scale === "medium" ? 20 : 40;
  return {
    ...base,
    allowedPriorities: scale === "tiny" ? ["P0", "P1"] : ["P0"],
    maxSections: Math.min(base.maxSections, scale === "tiny" ? 3 : 2),
    maxPrimaryItemsPerSection: 1,
    maxSecondaryItemsPerSection: scale === "tiny" ? 1 : 0,
    maxTotalItems: ultraMaxItems,
    itemTextLimit: Math.min(base.itemTextLimit, scale === "tiny" ? 110 : 90),
    maxSpanIds: 1,
    includeRawMetrics: scale === "tiny",
  };
}

function buildCapsuleModeOrder(rawTokenEstimate, tier) {
  const scale = classifyCapsuleScale(rawTokenEstimate);
  const normalizedTier = normalizeCapsuleTier(tier, "ultra");
  if (normalizedTier === "loose") {
    return scale === "tiny" ? ["verbose", "compact", "dense"] : ["verbose", "compact", "dense", "emergency"];
  }
  if (normalizedTier === "medium") {
    return ["compact", "dense", "emergency"];
  }
  return scale === "tiny" ? ["dense", "emergency"] : ["emergency", "dense"];
}

function buildBudgetedCapsule(pathValue, text, fileType, baseCapsule, query = "", options = {}) {
  const rawText = String(text || "");
  const rawBytes = Number.isFinite(Number(options.overrideRawBytes))
    ? Number(options.overrideRawBytes)
    : Buffer.byteLength(rawText, "utf8");
  const rawTokenEstimate = Number.isFinite(Number(options.overrideRawTokenEstimate))
    ? Number(options.overrideRawTokenEstimate)
    : estimateTextTokens(rawText);
  const capsuleTier = normalizeCapsuleTier(options.capsuleTier, "ultra");
  const budgetTokens = Number.isFinite(Number(options.budgetTokens))
    ? Number(options.budgetTokens)
    : buildCapsuleTierBudget(rawTokenEstimate, capsuleTier);

  const TINY_PASSTHROUGH_THRESHOLD = 150;
  if (rawTokenEstimate <= TINY_PASSTHROUGH_THRESHOLD) {
    const passthroughCapsule = {
      version: WORKSPACE_RECORD_VERSION,
      path: trimPath(pathValue),
      fileType: `${fileType.family}/${fileType.language}`,
      family: fileType.family,
      language: fileType.language,
      capsuleType: fileType.capsuleType,
      parserFamily: baseCapsule.parserFamily || "passthrough",
      parseOk: true,
      capsuleMode: "passthrough",
      capsuleTier,
      rawBytes,
      rawTokenEstimate,
      includeRawMetrics: true,
      sections: baseCapsule.sections || [],
      spanMap: baseCapsule.spanMap || {},
      totalItems: 0,
      focused: false,
      fallbackReason: "",
    };
    const rendered = `CAP ${basename(pathValue)} ${fileType.language} ${rawBytes}B passthrough\n${rawText}`;
    const capsuleTokenEstimate = estimateTextTokens(rendered);
    return {
      capsule: {
        ...passthroughCapsule,
        capsuleTokenEstimate,
        budgetTokens,
        budgetMet: true,
        recoveryEligible: Object.keys(baseCapsule.spanMap || {}).length > 0,
        capsuleBytes: Buffer.byteLength(rendered, "utf8"),
        compressionRatio: capsuleTokenEstimate > 0
          ? Number((rawTokenEstimate / capsuleTokenEstimate).toFixed(2))
          : null,
      },
      rendered,
      budgetTokens,
      budgetMet: true,
    };
  }

  const fileInfo = {
    path: trimPath(pathValue),
    family: fileType.family,
    language: fileType.language,
    capsuleType: fileType.capsuleType,
    rawBytes,
    rawTokenEstimate,
  };

  const modes = buildCapsuleModeOrder(rawTokenEstimate, capsuleTier);
  let selected = null;
  for (const mode of modes) {
    const capsule = materializeCapsuleForMode(
      baseCapsule,
      fileInfo,
      mode,
      query,
      buildCapsuleTierProfile(rawTokenEstimate, capsuleTier, mode),
    );
    capsule.capsuleTier = capsuleTier;
    const rendered = renderCapsuleText(capsule);
    const capsuleTokenEstimate = estimateTextTokens(rendered);
    selected = {
      capsule: {
        ...capsule,
        capsuleTokenEstimate,
      },
      rendered,
      budgetTokens,
      budgetMet: capsuleTokenEstimate <= budgetTokens,
    };
    if (selected.budgetMet && mode !== "emergency") break;
  }

  if (!selected) {
    const emergencyCapsule = materializeCapsuleForMode(
      baseCapsule,
      fileInfo,
      "emergency",
      query,
      buildCapsuleTierProfile(rawTokenEstimate, capsuleTier, "emergency"),
    );
    emergencyCapsule.capsuleTier = capsuleTier;
    const rendered = renderCapsuleText(emergencyCapsule);
    selected = {
      capsule: {
        ...emergencyCapsule,
        capsuleTokenEstimate: estimateTextTokens(rendered),
      },
      rendered,
      budgetTokens,
      budgetMet: false,
    };
  }

  selected.capsule.budgetTokens = selected.budgetTokens;
  selected.capsule.budgetMet = selected.budgetMet;
  selected.capsule.recoveryEligible = Object.keys(selected.capsule.spanMap || {}).length > 0;
  selected.capsule.capsuleBytes = Buffer.byteLength(selected.rendered, "utf8");
  selected.capsule.capsuleTier = capsuleTier;
  selected.capsule.compressionRatio = selected.capsule.capsuleTokenEstimate > 0
    ? Number((rawTokenEstimate / selected.capsule.capsuleTokenEstimate).toFixed(2))
    : null;
  return selected;
}

function buildClampedCapsule(pathValue, text, fileType, baseCapsule, query = "", options = {}) {
  const rawText = String(text || "");
  const rawTokenEstimate = Number.isFinite(Number(options.overrideRawTokenEstimate))
    ? Number(options.overrideRawTokenEstimate)
    : estimateTextTokens(rawText);
  function legacyTieredBudget(tokens) {
    const MIN_BUDGET = 160;
    if (tokens <= 500) return Math.max(MIN_BUDGET, Math.floor(tokens * 0.6));
    if (tokens <= 2000) return Math.max(MIN_BUDGET, Math.floor(tokens * 0.4));
    if (tokens <= 8000) return Math.max(MIN_BUDGET, Math.floor(tokens * 0.25));
    return Math.max(MIN_BUDGET, Math.floor(tokens * 0.15));
  }
  return buildBudgetedCapsule(pathValue, text, fileType, baseCapsule, query, {
    ...options,
    budgetTokens: legacyTieredBudget(rawTokenEstimate),
    capsuleTier: normalizeCapsuleTier(options.capsuleTier, "ultra"),
  });
}

function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function scoreItemForQuery(item, queryTokens) {
  const text = String(item.text || "");
  const haystack = `${text} ${(item.spanIds || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!haystack.includes(token)) continue;
    // Exact whole-word match scores 3x; substring match scores 1x
    const wordBoundary = new RegExp(
      `(?<![a-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`,
    );
    score += wordBoundary.test(haystack) ? 3 : 1;
  }
  return score;
}

function buildCapsuleVariants(pathValue, rawText, fileType, baseCapsule, options = {}) {
  const shared = {
    overrideRawBytes: Number(options.overrideRawBytes || 0) || undefined,
    overrideRawTokenEstimate: Number(options.overrideRawTokenEstimate || 0) || undefined,
  };
  return {
    ultra: buildBudgetedCapsule(pathValue, rawText, fileType, baseCapsule, "", {
      ...shared,
      capsuleTier: "ultra",
    }),
    medium: buildBudgetedCapsule(pathValue, rawText, fileType, baseCapsule, "", {
      ...shared,
      capsuleTier: "medium",
    }),
    loose: buildBudgetedCapsule(pathValue, rawText, fileType, baseCapsule, "", {
      ...shared,
      capsuleTier: "loose",
    }),
  };
}

function selectCapsuleVariant(record, tier) {
  const normalizedTier = normalizeCapsuleTier(tier, record?.defaultCapsuleTier || "ultra");
  const variants = record?.capsuleVariants;
  if (variants && typeof variants === "object" && variants[normalizedTier]) {
    return {
      tier: normalizedTier,
      cache: variants[normalizedTier],
    };
  }
  return {
    tier: normalizedTier,
    cache: record?.capsuleCache || null,
  };
}

function buildFocusedCapsule(record, query, tier = "ultra") {
  const queryText = String(query || "").trim();
  const selectedVariant = selectCapsuleVariant(record, tier);
  if (!queryText) return safeJsonClone(selectedVariant.cache || record?.capsuleCache || null);

  const baseCapsule = record?.capsuleBase || selectedVariant.cache?.capsule || record?.capsuleCache?.capsule || null;
  if (!baseCapsule) return safeJsonClone(selectedVariant.cache || record?.capsuleCache || null);
  const queryTokens = tokenizeQuery(queryText);
  if (!queryTokens.length) return safeJsonClone(selectedVariant.cache || record?.capsuleCache || null);

  const filteredSections = [];
  for (const section of baseCapsule.sections || []) {
    const matched = section.items
      .map((item) => ({ item, score: scoreItemForQuery(item, queryTokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.text.length - b.item.text.length)
      .slice(0, 8)
      .map((entry) => entry.item);
    if (!matched.length && section.priority !== "P0") continue;
    filteredSections.push({
      name: section.name,
      priority: section.priority,
      items: matched.length ? matched : section.items.slice(0, 2),
    });
  }

  const fallbackBase = {
    parserFamily: baseCapsule.parserFamily,
    parseOk: baseCapsule.parseOk,
    fallbackReason: baseCapsule.fallbackReason,
    sections: filteredSections.length ? filteredSections : (baseCapsule.sections || []).slice(0, 3),
    spanMap: baseCapsule.spanMap || {},
  };
  return buildClampedCapsule(
    record.path,
    "",
    record.fileTypeInfo,
    fallbackBase,
    queryText,
    {
      capsuleTier: normalizeCapsuleTier(tier, selectedVariant.tier || "ultra"),
      overrideRawBytes: Number(record.compressionStats?.rawBytes || record.originalSize || 0),
      overrideRawTokenEstimate: Number(
        selectedVariant.cache?.capsule?.rawTokenEstimate
        || record.capsuleCache?.capsule?.rawTokenEstimate
        || record.compressionStats?.rawTokenEstimate
        || 0
      ),
    },
  );
}

function buildTransportManifest(pathValue, manifest) {
  const lines = [
    TRANSPORT_ENVELOPE_VERSION,
    `path: ${pathValue}`,
    `content-encoding: ${manifest.contentEncoding}`,
    `raw-bytes: ${manifest.rawBytes}`,
    `compressed-bytes: ${manifest.compressedBytes}`,
    `chunk-size: ${manifest.chunkSize}`,
    `chunk-count: ${manifest.chunkCount}`,
    `span-count: ${manifest.spanCount}`,
    `digest: ${manifest.digest}`,
    "chunks:",
  ];
  for (const chunk of manifest.chunkIndex) {
    lines.push(`- id=${chunk.id} raw=${chunk.rawOffset}+${chunk.rawLength} compressed=${chunk.compressedBytes} digest=${chunk.digest}`);
  }
  return lines.join("\n");
}

function extractTransportEnvelope(meta) {
  if (!meta || typeof meta !== "object") return null;
  if (meta.transportEnvelope && typeof meta.transportEnvelope === "object") {
    return meta.transportEnvelope;
  }
  if (!Array.isArray(meta.chunks) || !meta.envelopeVersion) {
    return null;
  }
  return {
    envelopeVersion: meta.envelopeVersion,
    contentEncoding: meta.contentEncoding,
    rawBytes: meta.rawBytes,
    compressedBytes: meta.compressedBytes,
    chunkSize: meta.chunkSize,
    chunkCount: meta.chunkCount,
    spanCount: meta.spanCount,
    digest: meta.digest,
    chunkIndex: meta.chunkIndex,
    spanIndex: meta.spanIndex,
    chunks: meta.chunks,
    manifestText: typeof meta.manifestText === "string" ? meta.manifestText : "",
  };
}

function validateTransportSpanIndex(spanIndex, chunkCount, rawBytes) {
  if (!spanIndex || typeof spanIndex !== "object") return;

  for (const [spanId, span] of Object.entries(spanIndex)) {
    if (!span || typeof span !== "object") {
      throw new Error(`Transport envelope span "${spanId}" is invalid.`);
    }

    const startByte = finiteInteger(span.startByte, -1);
    const endByte = finiteInteger(span.endByte, -1);
    if (startByte < 0 || endByte < startByte || endByte > rawBytes) {
      throw new Error(`Transport envelope span "${spanId}" is out of range.`);
    }

    const chunkIds = Array.isArray(span.chunks) ? span.chunks : [];
    for (const chunkId of chunkIds) {
      const normalizedChunkId = finiteInteger(chunkId, -1);
      if (normalizedChunkId < 0 || normalizedChunkId >= chunkCount) {
        throw new Error(`Transport envelope span "${spanId}" references an invalid chunk.`);
      }
    }
  }
}

async function compressTransportChunk(rawBuffer) {
  const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer || "");
  if (HAS_ZSTD_TRANSPORT) {
    return zstdCompress(buffer);
  }

  if (!legacyBrotliCompress) {
    throw new Error("Brotli compression is unavailable in this runtime.");
  }

  return legacyBrotliCompress(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
    },
  });
}

async function decompressTransportChunk(compressedBuffer, encoding) {
  const normalizedEncoding = String(encoding || "").trim().toLowerCase();
  const buffer = Buffer.isBuffer(compressedBuffer) ? compressedBuffer : Buffer.from(compressedBuffer || "");

  if (normalizedEncoding === TRANSPORT_ENCODING_ZSTD) {
    if (!HAS_ZSTD_TRANSPORT) {
      throw new Error("Transport envelope uses zstd, but zstd is unavailable in this runtime.");
    }
    return zstdDecompress(buffer);
  }

  if (normalizedEncoding === TRANSPORT_ENCODING_BROTLI) {
    if (!legacyBrotliDecompress) {
      throw new Error("Transport envelope uses Brotli, but Brotli is unavailable in this runtime.");
    }
    return legacyBrotliDecompress(buffer);
  }

  throw new Error(`Unsupported transport content encoding "${encoding || ""}".`);
}

async function decodeTransportEnvelope(metaOrEnvelope, options = {}) {
  const envelope = extractTransportEnvelope(metaOrEnvelope);
  if (!envelope) {
    throw new Error("Transport envelope is missing.");
  }
  if (String(envelope.envelopeVersion || "") !== TRANSPORT_ENVELOPE_VERSION) {
    throw new Error(`Unsupported transport envelope version "${envelope.envelopeVersion || ""}".`);
  }
  const envelopeEncoding = String(envelope.contentEncoding || "");

  const maxDecompressedBytes = Math.max(1024, Math.min(finiteInteger(options.maxDecompressedBytes, MAX_TRANSPORT_DECOMPRESSED_BYTES), 64 * 1024 * 1024));
  const maxChunkCount = Math.max(1, Math.min(finiteInteger(options.maxChunkCount, MAX_TRANSPORT_CHUNKS), 4096));
  const maxChunkBytes = Math.max(512, Math.min(finiteInteger(options.maxChunkBytes, MAX_TRANSPORT_CHUNK_BYTES), 4 * 1024 * 1024));
  const chunks = Array.isArray(envelope.chunks) ? envelope.chunks : [];
  const chunkIndex = Array.isArray(envelope.chunkIndex) ? envelope.chunkIndex : [];

  if (chunks.length !== chunkIndex.length) {
    throw new Error("Transport envelope chunks and chunk index length mismatch.");
  }
  if (chunks.length > maxChunkCount) {
    throw new Error("Transport envelope exceeds maximum chunk count.");
  }

  const rawChunks = [];
  let totalRawBytes = 0;
  let expectedOffset = 0;

  for (let index = 0; index < chunkIndex.length; index += 1) {
    const chunkMeta = chunkIndex[index] || {};
    const compressedBuffer = Buffer.from(String(chunks[index] || ""), "base64");
    if (compressedBuffer.length > maxChunkBytes) {
      throw new Error(`Transport chunk ${index} exceeds maximum compressed size.`);
    }
    if (chunkMeta.digest && sha256Hex(compressedBuffer) !== String(chunkMeta.digest)) {
      throw new Error(`Transport chunk ${index} digest mismatch.`);
    }

    const rawBuffer = await decompressTransportChunk(compressedBuffer, envelopeEncoding);
    const rawLength = finiteInteger(chunkMeta.rawLength, rawBuffer.length);
    const rawOffset = finiteInteger(chunkMeta.rawOffset, expectedOffset);
    if (rawOffset !== expectedOffset) {
      throw new Error(`Transport chunk ${index} raw offset is not contiguous.`);
    }
    if (rawLength !== rawBuffer.length) {
      throw new Error(`Transport chunk ${index} raw length mismatch.`);
    }

    totalRawBytes += rawBuffer.length;
    if (totalRawBytes > maxDecompressedBytes) {
      throw new Error("Transport envelope exceeds maximum decompressed size.");
    }

    expectedOffset += rawBuffer.length;
    rawChunks.push(rawBuffer);
  }

  const rawBuffer = Buffer.concat(rawChunks);
  const declaredRawBytes = finiteInteger(envelope.rawBytes, rawBuffer.length);
  if (declaredRawBytes !== rawBuffer.length) {
    throw new Error("Transport envelope raw byte length mismatch.");
  }
  if (envelope.digest && sha256Hex(rawBuffer) !== String(envelope.digest)) {
    throw new Error("Transport envelope digest mismatch.");
  }

  validateTransportSpanIndex(envelope.spanIndex, chunkIndex.length, rawBuffer.length);
  return rawBuffer.toString("utf8");
}

async function buildTransportEnvelope(pathValue, rawText, spanMap, options = {}) {
  const chunkSize = Math.max(2048, Math.min(Number(options.chunkSize) || DEFAULT_CHUNK_SIZE, MAX_TRANSPORT_CHUNK_BYTES));
  const includeChunks = options.includeTransportChunks !== false;
  const rawBuffer = Buffer.from(String(rawText || ""), "utf8");
  const chunkIndex = [];
  const slices = [];

  for (let offset = 0, id = 0; offset < rawBuffer.length || (rawBuffer.length === 0 && id === 0); offset += chunkSize, id += 1) {
    const slice = rawBuffer.length === 0 ? Buffer.alloc(0) : rawBuffer.slice(offset, Math.min(rawBuffer.length, offset + chunkSize));
    slices.push({
      id,
      rawOffset: offset,
      slice,
    });
    if (rawBuffer.length === 0) break;
  }

  const compressedSlices = await mapWithConcurrency(
    slices,
    Number(options.transportChunkParallelism) || TRANSPORT_CHUNK_PARALLELISM,
    async (entry) => {
      const compressed = await compressTransportChunk(entry.slice);
      return {
        ...entry,
        compressed,
      };
    },
  );

  const chunks = includeChunks ? [] : null;
  for (const entry of compressedSlices) {
    const compressed = entry.compressed;
    chunkIndex.push({
      id: entry.id,
      rawOffset: entry.rawOffset,
      rawLength: entry.slice.length,
      compressedBytes: compressed.length,
      digest: sha256Hex(compressed),
    });
    if (includeChunks) {
      chunks.push(compressed.toString("base64"));
    }
  }

  const spanIndex = {};
  for (const [spanId, span] of Object.entries(spanMap || {})) {
    const chunkIds = chunkIndex
      .filter((chunk) => span.endByte > chunk.rawOffset && span.startByte < chunk.rawOffset + chunk.rawLength)
      .map((chunk) => chunk.id);
    spanIndex[spanId] = {
      startByte: span.startByte,
      endByte: span.endByte,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      chunks: chunkIds,
    };
  }

  const manifest = {
    envelopeVersion: TRANSPORT_ENVELOPE_VERSION,
    contentEncoding: TRANSPORT_CONTENT_ENCODING,
    rawBytes: rawBuffer.length,
    compressedBytes: chunkIndex.reduce((sum, chunk) => sum + chunk.compressedBytes, 0),
    chunkSize,
    chunkCount: chunkIndex.length,
    spanCount: Object.keys(spanIndex).length,
    digest: typeof options.rawDigest === "string" && options.rawDigest.length === 64
      ? options.rawDigest
      : sha256Hex(rawBuffer),
    chunkIndex,
    spanIndex,
  };

  const envelope = {
    ...manifest,
    manifestText: buildTransportManifest(pathValue, manifest),
  };
  if (includeChunks) {
    envelope.chunks = chunks;
  }
  return envelope;
}


function buildCompressionStats(record) {
  return {
    rawBytes: Number(record.rawStorage?.rawBytes || record.originalSize || 0),
    capsuleBytes: Number(record.capsuleCache?.capsule?.capsuleBytes || Buffer.byteLength(record.capsuleCache?.rendered || "", "utf8")),
    transportBytes: Number(record.transportEnvelope?.compressedBytes || 0),
    rawTokenEstimate: Number(record.capsuleCache?.capsule?.rawTokenEstimate || 0),
    capsuleTokenEstimate: Number(record.capsuleCache?.capsule?.capsuleTokenEstimate || 0),
    compressionRatio: Number(record.capsuleCache?.capsule?.compressionRatio || 0),
    budgetTokens: Number(record.capsuleCache?.capsule?.budgetTokens || 0),
    budgetMet: Boolean(record.capsuleCache?.capsule?.budgetMet),
    recoveryEligible: Boolean(record.capsuleCache?.capsule?.recoveryEligible),
  };
}

function buildInitialCapsuleCache(pathValue, rawText, fileType, baseCapsule, options = {}) {
  const rawBytes = Number.isFinite(Number(options.overrideRawBytes))
    ? Number(options.overrideRawBytes)
    : Buffer.byteLength(String(rawText || ""), "utf8");
  const rawTokenEstimate = Number.isFinite(Number(options.overrideRawTokenEstimate))
    ? Number(options.overrideRawTokenEstimate)
    : estimateTextTokens(rawText);
  const selectedSections = (baseCapsule.sections || [])
    .slice(0, 4)
    .map((section) => ({
      name: section.name,
      priority: section.priority,
      items: Array.isArray(section.items)
        ? section.items.slice(0, section.priority === "P0" ? 10 : 6)
        : [],
    }))
    .filter((section) => section.items.length > 0);
  const capsule = {
    path: trimPath(pathValue),
    family: fileType.family,
    language: fileType.language,
    capsuleType: fileType.capsuleType,
    parserFamily: baseCapsule.parserFamily,
    parseOk: baseCapsule.parseOk,
    fallbackReason: baseCapsule.fallbackReason || "",
    capsuleMode: "initial",
    rawBytes,
    rawTokenEstimate,
    sections: selectedSections,
    spanMap: baseCapsule.spanMap || {},
  };
  const rendered = renderCapsuleText(capsule);
  const capsuleTokenEstimate = estimateTextTokens(rendered);
  capsule.capsuleTokenEstimate = capsuleTokenEstimate;
  capsule.budgetTokens = Math.max(160, Math.floor(rawTokenEstimate * 0.4));
  capsule.budgetMet = capsuleTokenEstimate <= capsule.budgetTokens;
  capsule.recoveryEligible = Object.keys(capsule.spanMap || {}).length > 0;
  capsule.capsuleBytes = Buffer.byteLength(rendered, "utf8");
  capsule.compressionRatio = capsuleTokenEstimate > 0
    ? Number((rawTokenEstimate / capsuleTokenEstimate).toFixed(2))
    : null;
  return {
    rendered,
    capsule,
  };
}

function buildInitialTransportEnvelope(pathValue, rawStorage, spanMap = {}, options = {}) {
  const rawBytes = Number(options.originalSizeOverride || rawStorage?.rawBytes || 0);
  const spanIndex = spanMap && typeof spanMap === "object" ? spanMap : {};
  const manifest = {
    envelopeVersion: TRANSPORT_ENVELOPE_VERSION,
    contentEncoding: TRANSPORT_CONTENT_ENCODING,
    rawBytes,
    compressedBytes: 0,
    chunkSize: 0,
    chunkCount: 0,
    spanCount: Object.keys(spanIndex).length,
    digest: typeof rawStorage?.digest === "string" && rawStorage.digest.length === 64
      ? rawStorage.digest
      : sha256Hex(Buffer.from(String(options.rawText || ""), "utf8")),
    chunkIndex: [],
    spanIndex,
  };
  return {
    ...manifest,
    manifestText: buildTransportManifest(pathValue, manifest),
  };
}

function encodeRawStorage(rawText, options = {}) {
  const buffer = Buffer.from(String(rawText || ""), "utf8");
  // quality 4 for initial records (~90% ratio, ~15% encode time vs quality 9);
  // quality 9 for full records where storage density matters more.
  const quality = Number(options.quality) >= 1 && Number(options.quality) <= 11
    ? Number(options.quality)
    : 9;
  const compressed = zlib.brotliCompressSync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
    },
  });
  return {
    encoding: "brotli-base64",
    contentBase64: compressed.toString("base64"),
    rawBytes: buffer.length,
    digest: sha256Hex(buffer),
  };
}

function buildExternalRawStorage(rawText, options = {}) {
  const buffer = Buffer.from(String(rawText || ""), "utf8");
  return {
    encoding: "external-azure-blob",
    rawBytes: Number(options.rawBytes || buffer.length),
    digest: sha256Hex(buffer),
    ...(options.truncated ? { truncated: true } : {}),
  };
}

function decodeRawStorage(rawStorage) {
  if (!rawStorage || typeof rawStorage !== "object") return "";
  if (rawStorage.encoding === "external-azure-blob") return "";
  if (rawStorage.encoding === "brotli-base64") {
    return zlib.brotliDecompressSync(
      Buffer.from(String(rawStorage.contentBase64 || ""), "base64"),
    ).toString("utf8");
  }
  if (rawStorage.encoding === "deflate-base64") {
    return zlib.inflateSync(
      Buffer.from(String(rawStorage.contentBase64 || ""), "base64"),
    ).toString("utf8");
  }
  if (rawStorage.encoding === "utf8-base64") {
    return Buffer.from(String(rawStorage.contentBase64 || ""), "base64").toString("utf8");
  }
  return String(rawStorage.content || "");
}

function normalizeExternalStorage(storage = {}) {
  if (!storage || typeof storage !== "object") return null;
  const provider = String(storage.provider || "").trim().toLowerCase();
  if (provider !== "azure-blob") return null;
  const azureBlobUrl = String(storage.azureBlobUrl || "").trim();
  const blobPath = trimPath(storage.blobPath || "");
  return {
    provider: "azure-blob",
    azureBlobUrl,
    blobPath,
  };
}

function stripWorkspaceRecordPayload(record, options = {}) {
  if (!record || typeof record !== "object") return record;

  const shouldStripRaw = options.stripRaw !== false;
  const shouldStripTransportChunks = options.stripTransportChunks !== false;
  const storage = normalizeExternalStorage(options.storage || record.storage);
  if (storage) record.storage = storage;

  if (shouldStripRaw) {
    const rawBytes = Number(record.originalSize || record.rawStorage?.rawBytes || 0);
    const digest = String(record.rawStorage?.digest || "");
    const truncated = Boolean(record.rawStorage?.truncated);
    record.rawStorage = {
      encoding: storage ? "external-azure-blob" : String(record.rawStorage?.encoding || "external"),
      rawBytes,
      ...(digest ? { digest } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (shouldStripTransportChunks && record.transportEnvelope && typeof record.transportEnvelope === "object") {
    delete record.transportEnvelope.chunks;
  }

  return record;
}

async function buildWorkspaceFileRecord(pathValue, rawText, options = {}) {
  const normalizedPath = trimPath(pathValue);
  const normalizedText = String(rawText || "");
  const recordMode = String(options.recordMode || "full").trim().toLowerCase() === "initial" ? "initial" : "full";
  const defaultCapsuleTier = normalizeCapsuleTier(options.defaultCapsuleTier, "ultra");
  const externalStorage = normalizeExternalStorage(options.storage);
  const persistRawContent = !(externalStorage && options.persistRawContent === false);
  const persistTransportChunks = !(externalStorage && options.persistTransportChunks === false);
  const rawStorage = persistRawContent
    ? encodeRawStorage(normalizedText, { quality: recordMode === "initial" ? 4 : 9 })
    : buildExternalRawStorage(normalizedText, {
      rawBytes: Number(options.originalSizeOverride || Buffer.byteLength(normalizedText, "utf8")),
      truncated: Boolean(options.truncated),
    });
  const fileTypeInfo = detectFileType(normalizedPath, normalizedText);
  const baseCapsule = await buildBaseCapsule(normalizedPath, normalizedText, fileTypeInfo);
  const symbols = Array.isArray(baseCapsule.symbolDeclarations)
    ? baseCapsule.symbolDeclarations.slice(0, MAX_SYMBOL_DISCOVERY)
    : [];
  const capsuleVariants = buildCapsuleVariants(normalizedPath, normalizedText, fileTypeInfo, baseCapsule, {
    overrideRawBytes: Number(options.originalSizeOverride || rawStorage.rawBytes),
  });
  const clamped = capsuleVariants[defaultCapsuleTier] || capsuleVariants.ultra;
  const transportEnvelope = recordMode === "initial"
    ? buildInitialTransportEnvelope(normalizedPath, rawStorage, clamped.capsule?.spanMap || baseCapsule.spanMap, {
      originalSizeOverride: Number(options.originalSizeOverride || rawStorage.rawBytes),
      rawText: normalizedText,
    })
    : await buildTransportEnvelope(normalizedPath, normalizedText, baseCapsule.spanMap, {
      ...options,
      includeTransportChunks: persistTransportChunks,
      rawDigest: typeof rawStorage.digest === "string" ? rawStorage.digest : undefined,
    });
  const record = {
    formatVersion: WORKSPACE_RECORD_VERSION,
    path: normalizedPath,
    kind: "source",
    fileType: `${fileTypeInfo.family}/${fileTypeInfo.language}`,
    fileTypeInfo,
    parserFamily: clamped.capsule.parserFamily,
    parseOk: clamped.capsule.parseOk,
    capsuleMode: clamped.capsule.capsuleMode,
    defaultCapsuleTier,
    recordMode,
    rawStorage,
    capsuleBase: {
      sections: baseCapsule.sections || [],
      spanMap: baseCapsule.spanMap || {},
      parserFamily: baseCapsule.parserFamily,
      parseOk: baseCapsule.parseOk,
      fallbackReason: baseCapsule.fallbackReason || "",
    },
    capsuleCache: {
      query: "",
      rendered: clamped.rendered,
      capsule: clamped.capsule,
      updatedAt: new Date().toISOString(),
    },
    capsuleVariants: Object.fromEntries(
      Object.entries(capsuleVariants).map(([tier, variant]) => [tier, {
        query: "",
        rendered: variant.rendered,
        capsule: variant.capsule,
        updatedAt: new Date().toISOString(),
      }]),
    ),
    focusedCapsuleCache: {},
    spanIndex: clamped.capsule.spanMap || {},
    transportEnvelope,
    dependencies: (() => {
      const deps = [];
      const workspaceFilePaths = options.workspaceFilePaths || [];
      const imports = (baseCapsule.sections || []).find((s) => s.name === "imports");
      if (imports && Array.isArray(imports.items)) {
        for (const item of imports.items) {
          const source = item.metadata?.source;
          if (source) {
            const resolved = resolveWorkspacePath(normalizedPath, source, workspaceFilePaths);
            if (resolved && !deps.includes(resolved)) deps.push(resolved);
          }
        }
      }
      return deps;
    })(),
    symbols,
    callSites: Array.isArray(baseCapsule.callSitesRaw) ? baseCapsule.callSitesRaw : [],
    stringLiterals: Array.isArray(baseCapsule.stringLiteralsRaw) ? baseCapsule.stringLiteralsRaw : [],
    compressionStats: null,
    originalSize: Number(options.originalSizeOverride || rawStorage.rawBytes),
    compressedSize: transportEnvelope.compressedBytes || 0,
  };
  if (externalStorage) {
    record.storage = externalStorage;
  }
  record.compressionStats = buildCompressionStats(record);

  // Build resolved-imports section from workspace-resolved dependencies
  const resolvedImportPairs = [];
  const workspaceFilePaths = options.workspaceFilePaths || [];
  const importsSection = (baseCapsule.sections || []).find((s) => s.name === "imports");
  if (importsSection && Array.isArray(importsSection.items) && workspaceFilePaths.length > 0) {
    for (const item of importsSection.items) {
      const source = item.metadata?.source;
      if (!source) continue;
      const resolved = resolveWorkspacePath(normalizedPath, source, workspaceFilePaths);
      if (resolved) resolvedImportPairs.push({ source, resolved });
    }
  }
  if (resolvedImportPairs.length > 0) {
    const resolvedImportsSection = {
      name: 'resolved-imports',
      priority: 'P1',
      items: resolvedImportPairs.map(ri => ({ text: `'${ri.source}' → ${ri.resolved}`, priority: 'P1' })),
    };
    record.capsuleBase.sections.push(resolvedImportsSection);
    const cacheSections = record.capsuleCache?.capsule?.sections;
    if (Array.isArray(cacheSections) && cacheSections !== record.capsuleBase.sections) {
      cacheSections.push({ ...resolvedImportsSection, items: [...resolvedImportsSection.items] });
    }
  }

  if (externalStorage && (!persistRawContent || !persistTransportChunks)) {
    stripWorkspaceRecordPayload(record, {
      storage: externalStorage,
      stripRaw: !persistRawContent,
      stripTransportChunks: !persistTransportChunks,
    });
  }
  return record;
}

async function ensureWorkspaceFileRecord(meta, options = {}) {
  if (!meta || typeof meta !== "object") {
    throw new Error("Workspace record is invalid.");
  }

  if (
    Number(meta.formatVersion || 0) >= WORKSPACE_RECORD_VERSION
    && meta.rawStorage
    && meta.capsuleCache
    && meta.transportEnvelope
  ) {
    return meta;
  }

  let rawText = "";
  const pathValue = trimPath(meta.path || options.path || "");
  if (meta.rawStorage) {
    rawText = decodeRawStorage(meta.rawStorage);
  } else if (typeof meta.rawText === "string") {
    rawText = meta.rawText;
  } else if (extractTransportEnvelope(meta)) {
    rawText = await decodeTransportEnvelope(meta, options);
  } else if (meta.compressedBase64) {
    const unpacked = await legacyBrotliDecompress(Buffer.from(String(meta.compressedBase64 || ""), "base64"));
    rawText = unpacked.toString("utf8");
  }

  const upgraded = await buildWorkspaceFileRecord(pathValue, rawText, options);
  Object.assign(meta, upgraded);
  return meta;
}

function getFocusedCacheKey(query, tier = "ultra") {
  return sha256Hex(`${normalizeCapsuleTier(tier, "ultra")}::${String(query || "").trim().toLowerCase()}`).slice(0, 24);
}

/**
 * Computes line-range boundaries for chunking a large file.
 * Snaps each boundary to the nearest symbol lineEnd ≤ ideal boundary to avoid splitting inside a function.
 * @param {Array} symbols - record.symbols[] array, each {lineStart, lineEnd}
 * @param {number} totalLines - total line count of the file
 * @param {number} targetLines - target lines per chunk (e.g. 150)
 * @returns {Array<{start: number, end: number}>} array of 1-based inclusive line ranges
 */
function buildChunkBoundaries(symbols, totalLines, targetLines) {
  const safeTarget = Math.max(50, targetLines);
  const boundaries = [];
  let pos = 1;
  while (pos <= totalLines) {
    const idealEnd = Math.min(totalLines, pos + safeTarget - 1);
    let snappedEnd = idealEnd;
    if (Array.isArray(symbols) && symbols.length > 0) {
      let bestDiff = Infinity;
      for (const sym of symbols) {
        const le = Number(sym.lineEnd);
        if (!Number.isFinite(le) || le < pos || le > idealEnd) continue;
        const diff = idealEnd - le;
        if (diff < bestDiff) {
          bestDiff = diff;
          snappedEnd = le;
        }
      }
    }
    boundaries.push({ start: pos, end: snappedEnd });
    pos = snappedEnd + 1;
  }
  return boundaries;
}

async function buildWorkspaceFileView(meta, view = "original", options = {}) {
  const record = await ensureWorkspaceFileRecord(meta, options);
  const rawText = decodeRawStorage(record.rawStorage);
  const selectedCapsuleVariant = selectCapsuleVariant(record, options.tier || options.capsuleTier || options.variant);
  const selectedCapsuleCache = selectedCapsuleVariant.cache || record.capsuleCache || null;
  const base = {
    ok: true,
    path: record.path,
    originalSize: Number(record.originalSize || Buffer.byteLength(rawText, "utf8")),
    compressedSize: Number(record.compressedSize || 0),
    fileType: record.fileType,
    parserFamily: record.parserFamily,
    parseOk: Boolean(record.parseOk),
    capsuleMode: String(selectedCapsuleCache?.capsule?.capsuleMode || record.capsuleMode || ""),
    capsuleTier: selectedCapsuleVariant.tier,
    availableCapsuleTiers: ["ultra", "medium", "loose"],
    rawBytes: Number(record.compressionStats?.rawBytes || record.originalSize || 0),
    capsuleBytes: Number(selectedCapsuleCache?.capsule?.capsuleBytes || record.compressionStats?.capsuleBytes || 0),
    transportBytes: Number(record.compressionStats?.transportBytes || 0),
    compressionRatio: Number(selectedCapsuleCache?.capsule?.compressionRatio || record.compressionStats?.compressionRatio || 0),
  };

  const normalizedView = String(view || "original").trim().toLowerCase();
  if (normalizedView === "original" && record.storage?.provider === "azure-blob") {
    return {
      ...base,
      view: "original",
      content: "",
      encoding: "azure-blob-ref",
      storage: {
        provider: "azure-blob",
        azureBlobUrl: String(record.storage.azureBlobUrl || ""),
        blobPath: trimPath(record.storage.blobPath || ""),
        ...(options.readUrl ? { readUrl: String(options.readUrl || "") } : {}),
      },
    };
  }

  if (normalizedView === "compressed") {
    return {
      ...base,
      view: "compressed",
      content: String(record.compressedBase64 || ""),
      encoding: LEGACY_WORKSPACE_ENCODING,
    };
  }

  if (normalizedView === "transport") {
    return {
      ...base,
      view: "transport",
      content: String(record.transportEnvelope?.manifestText || ""),
      envelope: safeJsonClone(record.transportEnvelope),
      encoding: TRANSPORT_ENVELOPE_VERSION,
      envelopeVersion: TRANSPORT_ENVELOPE_VERSION,
      contentEncoding: TRANSPORT_CONTENT_ENCODING,
    };
  }

  if (normalizedView === "capsule") {
    return {
      ...base,
      view: "capsule",
      content: String(selectedCapsuleCache?.rendered || ""),
      capsule: safeJsonClone(selectedCapsuleCache?.capsule || null),
      encoding: "mesh-capsule-v2",
    };
  }

  if (normalizedView === "focused") {
    const query = String(options.query || options.focus || "").trim();
    if (!query) {
      return {
        ...base,
        view: "focused",
        query,
        content: String(selectedCapsuleCache?.rendered || ""),
        capsule: safeJsonClone(selectedCapsuleCache?.capsule || null),
        encoding: "mesh-capsule-v2",
      };
    }
    const cacheKey = getFocusedCacheKey(query, selectedCapsuleVariant.tier);
    if (!record.focusedCapsuleCache || typeof record.focusedCapsuleCache !== "object") {
      record.focusedCapsuleCache = {};
    }
    if (!record.focusedCapsuleCache[cacheKey]) {
      const focused = buildFocusedCapsule(record, query, selectedCapsuleVariant.tier);
      record.focusedCapsuleCache[cacheKey] = {
        query,
        tier: selectedCapsuleVariant.tier,
        rendered: focused?.rendered || selectedCapsuleCache?.rendered || "",
        capsule: focused?.capsule || safeJsonClone(selectedCapsuleCache?.capsule || null),
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...base,
      view: "focused",
      query,
      content: String(record.focusedCapsuleCache[cacheKey]?.rendered || ""),
      capsule: safeJsonClone(record.focusedCapsuleCache[cacheKey]?.capsule || null),
      encoding: "mesh-capsule-v2",
    };
  }

  if (normalizedView === "targeted") {
    const symbolName = String(options.symbolName || "").trim();
    const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Number.isFinite(Number(options.contextLines)) ? Number(options.contextLines) : 5));
    const symbols = Array.isArray(record.symbols) ? record.symbols : [];
    const sym = symbols.find((s) => s.name === symbolName);
    if (!sym) {
      return {
        ...base,
        view: "targeted",
        symbolName,
        lineRange: null,
        content: rawText,
        encoding: "plain-text",
        fallback: true,
      };
    }
    const lineStarts = buildLineStarts(rawText);
    const totalLines = lineStarts.length;
    const rangeStart = Math.max(1, sym.lineStart - contextLines);
    const rangeEnd = Math.min(totalLines, sym.lineEnd + contextLines);
    const content = sliceTextByLines(rawText, lineStarts, rangeStart, rangeEnd);
    return {
      ...base,
      view: "targeted",
      symbolName,
      lineRange: { start: rangeStart, end: rangeEnd },
      content,
      encoding: "plain-text",
      fallback: false,
    };
  }

  // Transparent chunking for large files (>LARGE_FILE_LINE_THRESHOLD lines)
  const lineStarts = buildLineStarts(rawText);
  const totalLines = lineStarts.length;

  if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
    if (!Array.isArray(record.chunkBoundaries) || record.chunkBoundaries.length === 0) {
      record.chunkBoundaries = buildChunkBoundaries(record.symbols || [], totalLines, CHUNK_TARGET_LINES);
    }
    const chunks = record.chunkBoundaries;
    const totalChunks = chunks.length;
    const requestedIndex = Number.isFinite(Number(options.chunkIndex))
      ? Math.max(0, Math.min(totalChunks - 1, Math.trunc(Number(options.chunkIndex))))
      : 0;
    const chunk = chunks[requestedIndex];
    const rawChunkContent = sliceTextByLines(rawText, lineStarts, chunk.start, chunk.end);
    const fileName = basename(record.path || "");
    const header = `## ${fileName} lines ${chunk.start}-${chunk.end} (chunk ${requestedIndex + 1}/${totalChunks})\n`;
    return {
      ...base,
      view: "original",
      content: header + rawChunkContent,
      encoding: "plain-text",
      chunked: true,
      chunkIndex: requestedIndex,
      totalChunks,
      lineRange: { start: chunk.start, end: chunk.end },
    };
  }

  return {
    ...base,
    view: "original",
    content: rawText,
    encoding: "plain-text",
  };
}

function sliceRawTextBySpan(rawText, span) {
  const buffer = Buffer.from(String(rawText || ""), "utf8");
  return buffer.slice(Math.max(0, span.startByte || 0), Math.max(0, span.endByte || 0)).toString("utf8");
}

async function recoverWorkspaceFileRecord(meta, request = {}, options = {}) {
  const record = await ensureWorkspaceFileRecord(meta, options);
  const rawText = typeof options.rawText === "string"
    ? options.rawText
    : decodeRawStorage(record.rawStorage);
  const lineStarts = buildLineStarts(rawText);
  const response = {
    ok: true,
    path: record.path,
    spans: [],
    ranges: [],
  };

  const spanIds = Array.isArray(request.spanIds) ? request.spanIds.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  for (const spanId of spanIds) {
    const span = record.spanIndex?.[spanId];
    if (!span) continue;
    response.spans.push({
      spanId,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      startByte: span.startByte,
      endByte: span.endByte,
      text: sliceRawTextBySpan(rawText, span),
    });
  }

  const ranges = Array.isArray(request.ranges) ? request.ranges : [];
  for (const range of ranges) {
    if (Number.isFinite(range.startByte) && Number.isFinite(range.endByte)) {
      response.ranges.push({
        startByte: Math.max(0, Math.trunc(range.startByte)),
        endByte: Math.max(Math.trunc(range.startByte), Math.trunc(range.endByte)),
        text: Buffer.from(rawText, "utf8")
          .slice(Math.max(0, Math.trunc(range.startByte)), Math.max(Math.trunc(range.startByte), Math.trunc(range.endByte)))
          .toString("utf8"),
      });
      continue;
    }
    if (Number.isFinite(range.lineStart)) {
      const lineStart = Math.max(1, Math.trunc(range.lineStart));
      const lineEnd = Math.max(lineStart, Math.trunc(range.lineEnd || lineStart));
      response.ranges.push({
        lineStart,
        lineEnd,
        text: sliceTextByLines(rawText, lineStarts, lineStart, lineEnd),
      });
    }
  }

  return response;
}

function suggestRecoverySpanIds(meta, query, limit = 4) {
  const record = meta && typeof meta === "object" ? meta : null;
  if (!record?.capsuleBase) return [];
  const queryTokens = tokenizeQuery(query);
  if (!queryTokens.length) return [];

  const ranked = [];
  for (const section of record.capsuleBase.sections || []) {
    for (const item of section.items || []) {
      const score = scoreItemForQuery(item, queryTokens);
      if (score <= 0) continue;
      for (const spanId of item.spanIds || []) {
        ranked.push({ spanId, score, text: item.text });
      }
    }
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, Math.max(1, Number(limit) || 4))
    .map((entry) => entry.spanId);
}

function serializeWorkspaceFileRecord(meta) {
  const cloned = safeJsonClone(meta);
  if (cloned?.storage?.provider === "azure-blob") {
    stripWorkspaceRecordPayload(cloned, {
      storage: cloned.storage,
      stripRaw: true,
      stripTransportChunks: true,
    });
  }
  return cloned;
}

const DEFAULT_WORKSPACE_TOKEN_BUDGET = 8000;
const MIN_FILE_TOKEN_BUDGET = 24;

/**
 * Allocates a total token budget across workspace file records proportional to importance.
 * @param {Array<Object>} fileRecords - Array of workspace file records with rawTokenEstimate, dependencies, recentlyReferenced.
 * @param {number} totalBudget - Total token budget for the workspace.
 * @returns {Array<Object>} File records augmented with `allocatedBudget`.
 */
function allocateWorkspaceBudget(fileRecords, totalBudget = DEFAULT_WORKSPACE_TOKEN_BUDGET) {
  if (!Array.isArray(fileRecords) || !fileRecords.length) return [];

  const scored = fileRecords.map((record) => {
    const rawTokens = record.rawTokenEstimate || estimateTextTokens(record.rawText || "");
    const depCount = Array.isArray(record.dependencies) ? record.dependencies.length : 0;
    const isReferenced = Boolean(record.recentlyReferenced);
    const importance = depCount * 2
      + (isReferenced ? 5 : 0)
      + Math.log2(Math.max(1, rawTokens));

    return { ...record, importance, rawTokens };
  });

  const totalImportance = scored.reduce((sum, r) => sum + r.importance, 0);
  if (totalImportance <= 0) {
    const equalShare = Math.max(MIN_FILE_TOKEN_BUDGET, Math.floor(totalBudget / scored.length));
    return scored.map((record) => ({ ...record, allocatedBudget: equalShare }));
  }

  return scored.map((record) => ({
    ...record,
    allocatedBudget: Math.max(MIN_FILE_TOKEN_BUDGET, Math.floor(totalBudget * record.importance / totalImportance)),
  }));
}

/**
 * Selects the best capsule tier for a file based on its allocated budget.
 * @param {Object} record - File record with capsuleVariants and allocatedBudget.
 * @returns {string} The selected tier name ('loose', 'medium', or 'ultra').
 */
function selectTierForBudget(record) {
  const budget = Number(record.allocatedBudget || 0);
  if (!record.capsuleVariants) return "ultra";

  for (const tier of ["loose", "medium", "ultra"]) {
    const variant = record.capsuleVariants[tier];
    if (variant && Number(variant.capsule?.capsuleTokenEstimate || 0) <= budget) {
      return tier;
    }
  }
  return "ultra";
}

/**
 * Format a symbol call chain into human-readable strings for AI context injection.
 *
 * @param {string} startFile - file path where the chain starts
 * @param {Array} callSites - callSites[] from the starting file record (must have resolvedFile/resolvedLine)
 * @param {Map} symbolMap - workspace-wide symbolMap from workspaceState.symbolMap
 * @param {number} [maxHops=3] - max chain depth
 * @returns {string[]} array of formatted chain strings, one per resolved call site
 */
function formatSymbolChain(startFile, callSites, symbolMap, maxHops = 3) {
  if (!Array.isArray(callSites) || !symbolMap) return [];
  const lines = [];

  for (const site of callSites) {
    if (!site.resolvedFile || !site.resolvedLine) continue;

    const startLabel = `${startFile}:L${site.callerLine}`;
    const chain = `${startLabel} \u2192 ${site.calleeName}() in ${site.resolvedFile}:L${site.resolvedLine}`;
    lines.push(chain);
    if (lines.length >= 20) break;
  }

  return lines;
}

/**
 * Build inverted index entries from a single file record's symbols and string literals.
 * Returns flat array of {token, file, lineStart, lineEnd, snippet, kind, kindBoost} for
 * insertion into workspaceState.queryIndex.
 *
 * @param {Object} fileRecord - workspace file record with symbols[] and stringLiterals[]
 * @returns {{ token: string, file: string, lineStart: number, lineEnd: number, snippet: string, kind: string, kindBoost: number }[]}
 */
function buildQueryIndexEntries(fileRecord) {
  const entries = [];
  if (!fileRecord?.path) return entries;
  const filePath = String(fileRecord.path);

  const tokenize = (text) => {
    return String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean)
      .filter((t) => t.length >= 3);
  };

  const FUNCTION_KINDS = new Set([
    'function_declaration', 'generator_function_declaration', 'function_definition',
    'method_declaration', 'method_definition', 'method', 'singleton_method',
    'function_item',
  ]);
  const CLASS_KINDS = new Set([
    'class_declaration', 'class_definition', 'class',
    'interface_declaration', 'trait_declaration', 'struct_item',
    'enum_declaration', 'enum_item', 'trait_item', 'impl_item',
    'class_specifier', 'struct_specifier',
  ]);
  const EXPORTED_KINDS = new Set(['exported']);

  for (const sym of (Array.isArray(fileRecord.symbols) ? fileRecord.symbols : [])) {
    if (!sym.name) continue;
    const kindBoost = CLASS_KINDS.has(sym.kind) || FUNCTION_KINDS.has(sym.kind) ? 40
      : EXPORTED_KINDS.has(sym.kind) ? 25 : 0;
    const snippet = String(sym.signature || sym.name).slice(0, 140);
    const tokensToIndex = new Set([
      ...tokenize(sym.name),
      ...tokenize(sym.signature || ''),
    ]);
    for (const token of tokensToIndex) {
      entries.push({
        token,
        file: filePath,
        lineStart: Number(sym.lineStart || 1),
        lineEnd: Number(sym.lineEnd || sym.lineStart || 1),
        snippet,
        kind: String(sym.kind || ''),
        kindBoost,
      });
    }
  }

  for (const lit of (Array.isArray(fileRecord.stringLiterals) ? fileRecord.stringLiterals : [])) {
    if (!lit.value) continue;
    const snippet = String(lit.value).slice(0, 80);
    const tokensToIndex = new Set(tokenize(lit.value));
    for (const token of tokensToIndex) {
      entries.push({
        token,
        file: filePath,
        lineStart: Number(lit.lineStart || 1),
        lineEnd: Number(lit.lineStart || 1),
        snippet,
        kind: 'string_literal',
        kindBoost: 15,
      });
    }
  }

  return entries;
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  LARGE_FILE_LINE_THRESHOLD,
  CHUNK_TARGET_LINES,
  MAX_CONTEXT_LINES,
  LEGACY_WORKSPACE_ENCODING,
  MAX_CALL_SITES_PER_FILE,
  MAX_QUERY_TOKENS_PER_FILE,
  buildQueryIndexEntries,
  extractCallSites,
  formatSymbolChain,
  MAX_TRANSPORT_CHUNKS,
  MAX_TRANSPORT_CHUNK_BYTES,
  MAX_TRANSPORT_DECOMPRESSED_BYTES,
  TRANSPORT_CONTENT_ENCODING,
  TRANSPORT_ENVELOPE_VERSION,
  WORKSPACE_RECORD_VERSION,
  basename,
  buildWorkspaceFileRecord,
  buildWorkspaceFileView,
  decodeRawStorage,
  decodeTransportEnvelope,
  detectFileType,
  encodeRawStorage,
  ensureWorkspaceFileRecord,
  estimateTextTokens,
  extractTransportEnvelope,
  getFocusedCacheKey,
  getTreeSitterWorkerPool,
  recoverWorkspaceFileRecord,
  allocateWorkspaceBudget,
  resolveWorkspacePath,
  selectTierForBudget,
  serializeWorkspaceFileRecord,
  sha256Hex,
  suggestRecoverySpanIds,
  validateTransportSpanIndex,
};
