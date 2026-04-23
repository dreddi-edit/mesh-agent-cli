import { minify } from "terser";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";

const MINIFY_CONFIG = {
  mangle: {
    toplevel: true,
  },
  compress: {
    dead_code: true,
    drop_debugger: true,
    conditionals: true,
    evaluate: true,
    booleans: true,
    loops: true,
    unused: true,
    hoist_funs: true,
    keep_fargs: false,
    hoist_vars: true,
    if_return: true,
    join_vars: true,
    side_effects: true,
  },
  format: {
    comments: false,
  },
};

async function processDirectory(srcDir, destDir) {
  console.log(`Minifying ${srcDir} -> ${destDir}...`);
  const files = await glob("**/*.{js,cjs,mjs}", { cwd: srcDir, absolute: true });
  
  for (const file of files) {
    const relativePath = path.relative(srcDir, file);
    const destPath = path.join(destDir, relativePath);
    
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    
    const content = await fs.readFile(file, "utf8");
    try {
      const isESM = !file.endsWith('.cjs');
      const result = await minify(content, {
        ...MINIFY_CONFIG,
        module: isESM
      });
      if (result.code) {
        await fs.writeFile(destPath, result.code, "utf8");
      }
    } catch (err) {
      console.error(`Failed to minify ${file}:`, err);
      // Fallback: copy as is if minification fails
      await fs.copyFile(file, destPath);
    }
  }
}

async function main() {
  // 1. Minify dist/ (overwrite)
  await processDirectory("dist", "dist");
  
  // 2. Minify mesh-core/src/ -> mesh-core/lib/
  await processDirectory("mesh-core/src", "mesh-core/lib");
  
  console.log("Minification complete! ✅");
}

main().catch(console.error);
