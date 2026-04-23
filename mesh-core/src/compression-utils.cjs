'use strict';
/**
 * MESH Compression — Self-contained text and span utilities.
 * Extracted from compression-core.cjs. No tree-sitter or capsule dependencies.
 */

const crypto = require('crypto');
const path   = require('path');

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeJsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finiteInteger(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.trunc(normalized) : fallback;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const limit = Math.max(1, Math.min(finiteInteger(concurrency, 1), source.length));
  const output = new Array(source.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= source.length) break;
      output[index] = await mapper(source[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return output;
}

function trimPath(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

function extensionOf(filePath) {
  const normalized = trimPath(filePath).toLowerCase();
  const ext = path.posix.extname(normalized);
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

function basename(filePath) {
  const normalized = trimPath(filePath);
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "item";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxLength = 140) {
  const normalized = String(value || "");
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(32, maxLength - 1))}…` : normalized;
}

function estimateTextTokens(value) {
  const text = String(value || "");
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
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
      return {
        line: mid + 1,
        column: charIndex - lineStart + 1,
      };
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

function sliceTextByLines(text, lineStarts, lineStart, lineEnd) {
  const startIndex = charIndexFromLineRange(text, lineStarts, lineStart);
  const safeEnd = Math.max(lineStart, lineEnd || lineStart);
  const endIndex = safeEnd >= lineStarts.length
    ? String(text || "").length
    : Math.max(startIndex, (lineStarts[safeEnd] || String(text || "").length) - 1);
  return String(text || "").slice(startIndex, endIndex);
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

  return {
    spans,
    lineStarts,
    addSpan,
    addMatchSpan,
    addLineSpan,
  };
}

module.exports = {
  sha256Hex,
  safeJsonClone,
  finiteInteger,
  mapWithConcurrency,
  trimPath,
  extensionOf,
  basename,
  slugify,
  normalizeWhitespace,
  truncateText,
  estimateTextTokens,
  buildLineStarts,
  locateLineFromCharIndex,
  byteOffsetFromCharIndex,
  charIndexFromLineRange,
  sliceTextByLines,
  dedupeByText,
  createSpanManager,
};
