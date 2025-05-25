import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { sync } from 'glob';
import { minify as jsMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier';
import JSZip from "jszip";
import { default as JsConfuser } from 'js-confuser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const ASSET_PATH = join(__dirname, '../src/assets');
const DIST_PATH = join(__dirname, '../dist/');

// Helper function to generate a random integer
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Custom obfuscation function using js-confuser
async function customObfuscate(sourceCode) {
  // Define encryption keys
  const BASE_KEY = 128; // Use 256*256 base if you want to keep Unicode
  const SHIFT_KEY = getRandomInt(1, BASE_KEY);
  const XOR_KEY = getRandomInt(1, BASE_KEY);
  console.log("Using XOR_KEY: " + XOR_KEY + " with SHIFT_KEY: " + SHIFT_KEY + " with BASE_KEY: " + BASE_KEY);

  // Load sensitive words from file
  const sensitiveWords = readFileSync(join(__dirname, '../sensitive_words_auto.txt'), 'utf-8')
    .split('\n')
    .map(word => word.trim())
    .filter(word => word.length > 0); // Remove empty lines

  // Define obfuscation options
  const options = {
    // REQUIRED
    target: 'browser',

    // ANTISIG, always ON
    stringConcealing: (str) => {
      return sensitiveWords.some(word => str.toLowerCase().includes(word));
    },
    renameVariables: true,
    renameGlobals: true,
    renameLabels: true,
    identifierGenerator: "mangled", // Takes the least space

    // Custom string encoding for obfuscation
    customStringEncodings: [
      {
        code: `
          function {fnName}(str) {
            return str.split('')
              .map(char => {
                var code = char.charCodeAt(0);
                code = (code - ${SHIFT_KEY} + ${BASE_KEY}) % ${BASE_KEY};
                code = code ^ ${XOR_KEY};
                return String.fromCharCode(code);
              })
              .join('');
          }`,
        encode: (str) => {
          return str
            .split('')
            .map((char) => {
              var code = char.charCodeAt(0);
              code = code ^ XOR_KEY;
              code = (code + SHIFT_KEY) % BASE_KEY;
              return String.fromCharCode(code);
            })
            .join('');
        },
      },
    ],

    // FAST optimizations
    movedDeclarations: true,
    objectExtraction: true,
    compact: true,
    hexadecimalNumbers: true,
    astScrambler: true,
    calculator: false, // No need for our job
    deadCode: false, // No need for our job

    // OPTIONAL (disabled for performance or compatibility reasons)
    dispatcher: false,
    duplicateLiteralsRemoval: false,
    flatten: false,
    preserveFunctionLength: false, // Enable if code breaks
    stringSplitting: false, // No need for our job

    // SLOW (disabled due to performance constraints on Cloudflare's free plan)
    globalConcealing: false,
    opaquePredicates: false,
    shuffle: false,
    variableMasking: false,
    stringCompression: false,

    // BUGGY (causes issues with Cloudflare or triggers antivirus)
    controlFlowFlattening: false, // Bugs out
    minify: false, // Conflicts with CSS
    rgf: false, // Bugs out

    // OTHER (security locks, disabled for performance)
    lock: {
      antiDebug: false,  // Slow
      integrity: false,  // Slow
      selfDefending: false,  // Slow
      tamperProtection: false,  // Bugs out
    },
  };

  // Obfuscate the code
  const result = await JsConfuser.obfuscate(sourceCode, options);
  return result.code;
}

async function processHtmlPages() {
    const indexFiles = sync('**/index.html', { cwd: ASSET_PATH });
    const result = {};

    for (const relativeIndexPath of indexFiles) {
        const dir = pathDirname(relativeIndexPath);
        const base = (file) => join(ASSET_PATH, dir, file);

        const indexHtml = readFileSync(base('index.html'), 'utf8');
        const styleCode = readFileSync(base('style.css'), 'utf8');
        const scriptCode = readFileSync(base('script.js'), 'utf8');

        const finalScriptCode = await jsMinify(scriptCode);
        const finalHtml = indexHtml
            .replace(/__STYLE__/g, `<style>${styleCode}</style>`)
            .replace(/__SCRIPT__/g, finalScriptCode.code);

        const minifiedHtml = htmlMinify(finalHtml, {
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            minifyCSS: true
        });

        result[dir] = JSON.stringify(minifiedHtml);
    }

    console.log('✅ Assets bundled successfuly!');
    return result;
}

async function buildWorker() {

    const htmls = await processHtmlPages();
    const faviconBuffer = readFileSync('./src/assets/favicon.ico');
    const faviconBase64 = faviconBuffer.toString('base64');

    const code = await build({
        entryPoints: [join(__dirname, '../src/worker.js')],
        bundle: true,
        format: 'esm',
        write: false,
        external: ['cloudflare:sockets'],
        platform: 'browser',
        target: 'es2020',
        define: {
            __PANEL_HTML_CONTENT__: htmls['panel'] ?? '""',
            __LOGIN_HTML_CONTENT__: htmls['login'] ?? '""',
            __ERROR_HTML_CONTENT__: htmls['error'] ?? '""',
            __SECRETS_HTML_CONTENT__: htmls['secrets'] ?? '""',
            __ICON__: JSON.stringify(faviconBase64)
        }
    });

    console.log('✅ Worker built successfuly!');

    const minifiedCode = await jsMinify(code.outputFiles[0].text, {
        module: true,
        output: {
            comments: false
        }
    });

    console.log('✅ Worker minified successfuly!');

    const finalCode = await customObfuscate(minifiedCode.code);
    const worker = `// @ts-nocheck\n${finalCode}`;

    console.log('✅ Worker obfuscated successfuly!');

    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync('./dist/worker.js', worker, 'utf8');

    const zip = new JSZip();
    zip.file('_worker.js', worker);
    zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE'
    }).then(nodebuffer => writeFileSync('./dist/worker.zip', nodebuffer));

    console.log('✅ Done!');
}

buildWorker().catch(err => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});
