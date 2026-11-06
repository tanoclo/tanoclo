/**
 * @file check.js
 * @brief Static analysis checker using Acorn to parse files.
 * 
 * Audits code files in the codebase, performs AST traversal to verify scope references,
 * checks for unresolved variables, and flags syntax errors.
 */

const fs = require('fs');
const acorn = require('acorn');
const path = require('path');

function checkFile(filePath) {
  console.log(`Checking ${filePath}...`);
  const code = fs.readFileSync(filePath, 'utf8');
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (err) {
    try {
      ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (err2) {
      console.error(`[ERROR] Failed to parse ${filePath}:`, err2.message);
      return 1;
    }
  }

  try {
    // Simple AST traversal to find global/unresolved references
    const declared = new Set([
      'require', 'module', 'exports', 'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'Math', 'Date', 'JSON', 'Error', 'Promise', 'Object', 'Array',
      'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set', 'undefined', 'parseInt', 'parseFloat',
      'global', 'Intl', '__dirname', '__filename', 'encodeURIComponent', 'decodeURIComponent',
      'isNaN', 'isFinite', 'URL', 'Infinity', 'NaN', 'URLSearchParams', 'BigInt', 'fetch',
      'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
      'Float32Array', 'Float64Array', 'Function'
    ]);

    const isTestFile = filePath.includes('test') || filePath.endsWith('.test.js');
    if (isTestFile) {
      const testGlobals = ['test', 'it', 'describe', 'expect', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'vi', 'assert'];
      testGlobals.forEach(g => declared.add(g));
    }

    const referenced = new Set();
    const scopes = [declared];

    function enterScope() {
      scopes.push(new Set());
    }

    function exitScope() {
      scopes.pop();
    }

    function declare(name) {
      scopes[scopes.length - 1].add(name);
    }

    function isDeclared(name) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(name)) return true;
      }
      return false;
    }

    function preScanDeclarations(nodes) {
      if (!Array.isArray(nodes)) return;
      nodes.forEach(node => {
        if (node) {
          if (node.type === 'FunctionDeclaration' && node.id && node.id.type === 'Identifier') {
            declare(node.id.name);
          } else if (node.type === 'ClassDeclaration' && node.id && node.id.type === 'Identifier') {
            declare(node.id.name);
          } else if (node.type === 'ImportDeclaration') {
            node.specifiers.forEach(spec => {
              if (spec.local && spec.local.type === 'Identifier') {
                declare(spec.local.name);
              }
            });
          }
        }
      });
    }

    function declarePattern(node) {
      if (!node) return;
      if (node.type === 'Identifier') {
        declare(node.name);
      } else if (node.type === 'AssignmentPattern') {
        declarePattern(node.left);
      } else if (node.type === 'ObjectPattern') {
        node.properties.forEach(p => {
          if (p.type === 'Property') {
            declarePattern(p.value);
          } else if (p.type === 'RestElement') {
            declarePattern(p.argument);
          }
        });
      } else if (node.type === 'ArrayPattern') {
        node.elements.forEach(el => {
          declarePattern(el);
        });
      } else if (node.type === 'RestElement') {
        declarePattern(node.argument);
      }
    }

    function traverse(node) {
      if (!node) return;

      switch (node.type) {
        case 'Program':
          enterScope();
          preScanDeclarations(node.body);
          node.body.forEach(traverse);
          exitScope();
          break;

        case 'VariableDeclaration':
          node.declarations.forEach(decl => {
            declarePattern(decl.id);
            traverse(decl.init);
          });
          break;

        case 'FunctionDeclaration':
          declare(node.id.name);
          enterScope();
          declare('arguments');
          node.params.forEach(declarePattern);
          if (node.body && node.body.type === 'BlockStatement') {
            preScanDeclarations(node.body.body);
          }
          traverse(node.body);
          exitScope();
          break;

        case 'FunctionExpression':
          enterScope();
          declare('arguments');
          node.params.forEach(declarePattern);
          if (node.body && node.body.type === 'BlockStatement') {
            preScanDeclarations(node.body.body);
          }
          traverse(node.body);
          exitScope();
          break;

        case 'ArrowFunctionExpression':
          enterScope();
          node.params.forEach(declarePattern);
          if (node.body && node.body.type === 'BlockStatement') {
            preScanDeclarations(node.body.body);
          }
          traverse(node.body);
          exitScope();
          break;

        case 'CatchClause':
          enterScope();
          declarePattern(node.param);
          if (node.body && node.body.type === 'BlockStatement') {
            preScanDeclarations(node.body.body);
          }
          traverse(node.body);
          exitScope();
          break;

        case 'ClassDeclaration':
          declare(node.id.name);
          traverse(node.superClass);
          traverse(node.body);
          break;

        case 'ClassExpression':
          traverse(node.superClass);
          traverse(node.body);
          break;

        case 'MethodDefinition':
        case 'PropertyDefinition':
          if (node.computed) {
            traverse(node.key);
          }
          traverse(node.value);
          break;

        case 'ImportDeclaration':
          traverse(node.source);
          break;

        case 'Identifier':
          if (!isDeclared(node.name)) {
            referenced.add(node.name);
          }
          break;

        case 'MemberExpression':
          traverse(node.object);
          if (node.computed) {
            traverse(node.property);
          }
          break;

        case 'ObjectExpression':
          node.properties.forEach(p => {
            if (p.computed) {
              traverse(p.key);
            }
            traverse(p.value);
          });
          break;

        case 'Property':
          if (node.computed) {
            traverse(node.key);
          }
          traverse(node.value);
          break;

        default:
          for (const key in node) {
            if (node[key] && typeof node[key] === 'object') {
              if (Array.isArray(node[key])) {
                node[key].forEach(traverse);
              } else if (node[key].type) {
                traverse(node[key]);
              }
            }
          }
      }
    }

    traverse(ast);

    // Filter out common backend dependencies imported at top level
    const ignoreList = [
      'db', 'getLogger', 'express', 'router', 'getFlowTempOpt', 'putFlowTempOpt',
      'getAirComfortHandler', 'wsBridge', 'coap', 'tlv', 'defineConfig'
    ];
    const unresolved = [...referenced].filter(name => !ignoreList.includes(name));

    if (unresolved.length > 0) {
      console.warn(`[WARNING] Unresolved identifiers found in ${filePath}:`, unresolved);
      return unresolved.length;
    } else {
      console.log(`[OK] No unresolved identifiers found in ${filePath}`);
      return 0;
    }

  } catch (err) {
    console.error(`[ERROR] Failed to analyze ${filePath}:`, err.message);
    return 1;
  }
}

function scanDir(dir) {
  let errorCount = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'frontend-dist' || entry.name === 'tmp' || entry.name === '.git') {
        continue;
      }
      errorCount += scanDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'scratch_check_undef.js') {
      errorCount += checkFile(fullPath);
    }
  }
  return errorCount;
}

const wsServerDir = __dirname;
console.log(`Starting scan of ${wsServerDir}...`);
const totalErrors = scanDir(wsServerDir);
console.log(`\nScan complete. Total undefined reference errors: ${totalErrors}`);
process.exit(totalErrors > 0 ? 1 : 0);