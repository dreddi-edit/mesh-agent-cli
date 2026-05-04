import zlib from 'zlib';
import { promisify } from 'util';
import path from 'path';
import * as htmlMinifier from 'html-minifier-terser';
import * as terser from 'terser';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * MESH COMPRESSION ENGINE (Server-Side)
 * 1. Type Detection & Aggressive Minification
 * 2. Brotli-X (Level 11) Ultra Compression
 */
export async function compressMeshPayload(rawText, options = {}) {
    if (typeof rawText !== 'string') rawText = String(rawText);
    
    let minified = rawText;
    let type = detectPayloadType(options);

    try {
        if (type === 'html') {
            minified = await htmlMinifier.minify(rawText, {
                collapseWhitespace: true,
                removeComments: true,
                minifyCSS: true,
                minifyJS: true,
                removeAttributeQuotes: true
            });
        } else if (type === 'js') {
            const result = await terser.minify(rawText, { compress: true, mangle: true });
            if (result.code) {
                minified = result.code;
            }
        }
    } catch (err) {
        console.warn(`[MESH] Minification failed, falling back to raw.`);
        minified = rawText; 
    }

    // Apply Brotli Level 11 Max Compression
    const compressedBuffer = await brotliCompress(Buffer.from(minified, 'utf-8'), {
        params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11, // Max quality
        }
    });

    const originalSize = Buffer.byteLength(rawText, 'utf8');
    const compressedSize = compressedBuffer.length;

    return {
        buffer: compressedBuffer,
        originalSize,
        compressedSize,
        ratio: (originalSize / compressedSize).toFixed(2),
        type
    };
}

function detectPayloadType(options) {
    const mimeType = String(options.mimeType || options.contentType || '').split(';')[0].trim().toLowerCase();
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return 'html';
    if (mimeType === 'application/javascript' || mimeType === 'text/javascript' || mimeType === 'application/ecmascript') return 'js';

    const filePath = String(options.filePath || options.filename || options.path || '');
    const ext = path.extname(filePath).toLowerCase();
    if (['.html', '.htm', '.xhtml'].includes(ext)) return 'html';
    if (['.js', '.mjs', '.cjs'].includes(ext)) return 'js';
    return 'text';
}

/**
 * MESH DECOMPRESSION ENGINE
 */
export async function decompressMeshPayload(compressedBuffer) {
    const decompressedBuffer = await brotliDecompress(compressedBuffer);
    return decompressedBuffer.toString('utf-8');
}
