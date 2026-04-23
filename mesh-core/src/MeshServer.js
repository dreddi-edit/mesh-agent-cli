import zlib from 'zlib';
import { promisify } from 'util';
import * as htmlMinifier from 'html-minifier-terser';
import * as terser from 'terser';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * MESH COMPRESSION ENGINE (Server-Side)
 * 1. Type Detection & Aggressive Minification
 * 2. Brotli-X (Level 11) Ultra Compression
 */
export async function compressMeshPayload(rawText) {
    if (typeof rawText !== 'string') rawText = String(rawText);
    
    let minified = rawText;
    let type = 'text';

    try {
        if (rawText.includes('<') && rawText.includes('>')) {
            minified = await htmlMinifier.minify(rawText, {
                collapseWhitespace: true,
                removeComments: true,
                minifyCSS: true,
                minifyJS: true,
                removeAttributeQuotes: true
            });
            type = 'html';
        } else if (rawText.includes('function ') || rawText.includes('const ') || rawText.includes('=>') || rawText.includes('var ') || rawText.includes('let ')) {
            const result = await terser.minify(rawText, { compress: true, mangle: true });
            if (result.code) {
                minified = result.code;
                type = 'js';
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

/**
 * MESH DECOMPRESSION ENGINE
 */
export async function decompressMeshPayload(compressedBuffer) {
    const decompressedBuffer = await brotliDecompress(compressedBuffer);
    return decompressedBuffer.toString('utf-8');
}
