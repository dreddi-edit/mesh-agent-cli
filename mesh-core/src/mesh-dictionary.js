/**
 * MESH SHARED DICTIONARY (CDT - Compression Dictionary Transport)
 * This buffer is loaded synchronously on both the Browser (MeshClient) 
 * and Cloud Run Worker (MeshServer). It contains the absolute most common 
 * syntax, tokens, and phrasing used in AI prompts, code logic, and HTML.
 * This is the secret to hitting ~5% compressed sizes for tiny payloads.
 */

const commonKeywords = [
    "function", "const", "let", "var", "return", "import", "export", "from",
    "class", "extends", "constructor", "super", "this", "console.log",
    "async", "await", "Promise", "resolve", "reject", "try", "catch",
    "if", "else", "for", "while", "switch", "case", "break", "continue",
    "document.getElementById", "querySelector", "addEventListener",
    "<div>", "</div>", "<span", "</span>", "<script", "</script>", "class=", "id=",
    // Common AI prompts / Terminal syntax
    "Write a", "How do I", "Can you explain", "Give me an example of",
    "mesh connect --region", "brotli-x", "Initializing Mesh Secure Tunnel",
    "application/json", "Content-Type", "Authorization: Bearer"
].join(" ");

export const meshDictionary = Buffer.from(commonKeywords, 'utf-8');
