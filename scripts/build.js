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
const DIST_PATH = join(__dirname, '../output/');

// ===================================================================
// POST-BUILD CONFIGURATION - Enable/disable post-build features
// ===================================================================
const POST_BUILD_CONFIG = {
    // Applied after bundle, before obfuscate
    removeConsoleLogs: true,
    replaceNameCalls: true,
    removeNonAsciiCharacters: true,
    normalizeWhitespace: true,
    // Applied after obfuscate
};

// Helper function to generate a random integer
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ===================================================================
// POST-BUILD PROCESSING FUNCTIONS
// ===================================================================

// Remove console.log statements
function removeConsoleLogs(code) {
    if (!POST_BUILD_CONFIG.removeConsoleLogs) return code;

    let result = code;
    let removedCount = 0;

    // More robust approach that handles nested parentheses and complex expressions
    // This regex matches console.method and then we manually parse the parentheses
    const consoleStartRegex = /console\.(log|error|warn|info|debug)\s*\(/g;

    let match;
    const replacements = [];

    while ((match = consoleStartRegex.exec(code)) !== null) {
        const startPos = match.index;
        const openParenPos = match.index + match[0].length - 1; // Position of opening parenthesis

        // Find the matching closing parenthesis
        let parenCount = 1;
        let pos = openParenPos + 1;
        let inString = false;
        let stringChar = '';
        let escaped = false;

        while (pos < code.length && parenCount > 0) {
            const char = code[pos];

            if (escaped) {
                escaped = false;
            } else if (char === '\\' && inString) {
                escaped = true;
            } else if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                stringChar = char;
            } else if (inString && char === stringChar) {
                inString = false;
                stringChar = '';
            } else if (!inString) {
                if (char === '(') {
                    parenCount++;
                } else if (char === ')') {
                    parenCount--;
                }
            }

            pos++;
        }

        if (parenCount === 0) {
            // Found complete console.method(...) call
            let endPos = pos;

            // Check if there's a semicolon immediately after
            while (endPos < code.length && /\s/.test(code[endPos])) {
                endPos++;
            }
            if (endPos < code.length && code[endPos] === ';') {
                endPos++;
            }

            const fullMatch = code.substring(startPos, endPos);
            replacements.push({
                start: startPos,
                end: endPos,
                original: fullMatch
            });
            removedCount++;
        }
    }

    // Apply replacements in reverse order to maintain correct positions
    replacements.sort((a, b) => b.start - a.start);

    for (const replacement of replacements) {
        // Replace with void 0 and preserve semicolon if it was there
        const hasTrailingSemicolon = replacement.original.trim().endsWith(';');
        const newCode = hasTrailingSemicolon ? 'void 0;' : 'void 0';

        result = result.substring(0, replacement.start) +
                newCode +
                result.substring(replacement.end);
    }

    console.log(`✅ Removed ${removedCount} console logs`);
    return result;
}

// Replace __name calls with random hex strings (if we build with wrangler)
function replaceNameCalls(code) {
    if (!POST_BUILD_CONFIG.replaceNameCalls) return code;

    const nameCallRegex = /__name\(([^,]+),\s*"([^"]+)"\)/g;
    const matches = [...code.matchAll(nameCallRegex)];

    if (matches.length === 0) {
        console.log('✅ No __name calls found');
        return code;
    }

    let newCode = code;
    const replacements = [];

    matches.forEach(match => {
        const randomHexString = Array.from({length: 4}, () =>
            Math.floor(Math.random() * 16).toString(16)).join('');
        const newCall = match[0].replace(/__name\(([^,]+),\s*"([^"]+)"\)/, `__name($1, "${randomHexString}")`);
        replacements.push({ original: match[0], new: newCall });
    });

    replacements.forEach(replacement => {
        newCode = newCode.replace(replacement.original, replacement.new);
    });

    console.log(`✅ Replaced ${matches.length} __name calls`);
    return newCode;
}

// Remove non-ASCII characters and Unicode escape sequences
function removeNonAsciiCharacters(code) {
    if (!POST_BUILD_CONFIG.removeNonAsciiCharacters) return code;

    // Remove non-ASCII characters and Unicode escape sequences
    const cleaned = code.replace(/[^\x00-\x7F]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]{1,6}\}/g, '');
    console.log('✅ Removed non-ASCII characters and Unicode escapes');
    return cleaned;
}

// Normalize whitespace while preserving strings, comments, and regex
function normalizeWhitespace(code) {
    if (!POST_BUILD_CONFIG.normalizeWhitespace) return code;

    // Complex regex pattern to match strings, regex, comments, and whitespace
    const pattern = /((?<string>"(?:\\"|[^"])*"|'(?:\\'|[^'])*')|(?<regex>\/(?:\\\/|[^\/\r\n])+?\/(?:[gmiuy]+)?)|(?<block_comment>\/\*.*?\*\/)|(?<line_comment>\/\/[^\r\n]*)|(?<space>[ \t]+))/gs;

    const cleaned = code.replace(pattern, (match) => {
        // Check if this is whitespace (last capture group)
        if (match.match(/^[ \t]+$/)) {
            return ' '; // Collapse spaces/tabs to single space
        } else {
            return match; // Preserve other matched elements
        }
    });

    // Replace multiple newlines with a single newline
    const normalized = cleaned.replace(/[\r\n]+/g, '\n');

    console.log('✅ Normalized whitespace sequences');
    return normalized;
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
    console.clear();
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
    console.log(`📊 Bundle size: ${Math.round(code.outputFiles[0].text.length / 1024)}KB`);

    const minifiedCode = await jsMinify(code.outputFiles[0].text, {
        module: true,
        output: {
            comments: false
        }
    });

    console.log('✅ Worker minified successfuly!');
    console.log(`📊 Minified size: ${Math.round(minifiedCode.code.length / 1024)}KB`);

    // Applied after bundle, before obfuscate
    let processedCode = minifiedCode.code;
    console.log(`📊 After minify: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = removeConsoleLogs(processedCode);
    console.log(`📊 After removeConsoleLogs: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = replaceNameCalls(processedCode);
    console.log(`📊 After replaceNameCalls: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = removeNonAsciiCharacters(processedCode);
    console.log(`📊 After removeNonAsciiCharacters: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = normalizeWhitespace(processedCode);
    console.log(`📊 After normalizeWhitespace: ${Math.round(processedCode.length / 1024)}KB`);

    const obfuscatedCode = await customObfuscate(processedCode);

    // Applied after obfuscate
    let finalCode = obfuscatedCode;
    // Add after obfuscate stuff here

    const worker = `// @ts-nocheck\n${finalCode}`;

    console.log('✅ Worker obfuscated successfuly!');
    console.log(`📊 Final size: ${Math.round(worker.length / 1024)}KB`);

    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync('./output/worker.js', worker, 'utf8');

    const zip = new JSZip();
    zip.file('_worker.js', worker);
    zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE'
    }).then(nodebuffer => writeFileSync('./output/worker.zip', nodebuffer));

    console.log('✅ Done!');
}

buildWorker().catch(err => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});
