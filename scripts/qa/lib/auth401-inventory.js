'use strict';
// Conservative source inventory, not a whole-program proof. Unknown status expressions
// and helper references require a file/node/count review. Never evaluate application code.
const acorn = require('acorn');
const { createHash } = require('node:crypto');
const AUTH = new Set(['AUTH_ACCESS_INVALID', 'AUTH_ACCESS_EXPIRED', 'AUTH_SESSION_INVALID']);
const HELPERS = new Set(['unauthorized', 'HttpNotAutorized']);
const STATUS = require('../../../src/util/httpStatusCode');

function name(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'Literal') return String(node.value);
    if (node.type === 'MemberExpression') return node.computed ? name(node.property) : node.property.name;
    return null;
}
function clean(node) {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, clean(value)]));
}
const signature = node => JSON.stringify(clean(node));
const fingerprint = node => createHash('sha256').update(signature(node)).digest('hex');
function property(node, key) {
    if (node?.type !== 'ObjectExpression' || node.properties.some(p => p.type !== 'Property' || p.computed || p.kind !== 'init')) return null;
    const matches = node.properties.filter(p => name(p.key) === key);
    return matches.length === 1 ? matches[0].value : null;
}
function codedData(node) { const code = property(node, 'code'); return code?.type === 'Literal' && AUTH.has(code.value); }
function codedEnvelope(node) { return codedData(property(node, 'data')) || codedData(node); }
function possibleStatus(node) {
    if (node?.type === 'Literal' && typeof node.value === 'number') return new Set([node.value]);
    if (node?.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'HttpStatus' && Number.isInteger(STATUS[name(node)])) return new Set([STATUS[name(node)]]);
    if (node?.type === 'ConditionalExpression') {
        const a = possibleStatus(node.consequent), b = possibleStatus(node.alternate);
        if (a && b) return new Set([...a, ...b]);
    }
    return null;
}

function inspect(file, text) {
    const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
    const parents = new Map(), nodes = [];
    function walk(node, parent) {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
        parents.set(node, parent); nodes.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc') continue;
            if (Array.isArray(value)) value.forEach(child => walk(child, node));
            else if (value && typeof value.type === 'string') walk(value, node);
        }
    }
    walk(ast, null);
    const candidates = [], covered = [];
    function cover(node) { covered.push(node); }
    function isCovered(node) { return covered.some(outer => node.start >= outer.start && node.end <= outer.end); }
    function enclosingFunction(node) {
        for (let current = node; current; current = parents.get(current)) {
            if (/FunctionExpression|FunctionDeclaration|ArrowFunctionExpression/.test(current.type)) return current;
        }
        return null;
    }
    function add(node, reason) {
        cover(node);
        const fn = enclosingFunction(node);
        const owner = fn && parents.get(fn);
        const scope = fn?.id?.name || name(owner?.key) || name(owner?.id) || '<anonymous/module>';
        candidates.push({ file, line: node.loc.start.line, scope, reason, snippet: text.slice(node.start, node.end), hash: fingerprint(node), context: fn ? fingerprint(fn) : null });
    }
    function chain(node) {
        let outer = node;
        while (parents.get(outer)?.type === 'MemberExpression' && parents.get(outer).object === outer && parents.get(parents.get(outer))?.type === 'CallExpression') outer = parents.get(parents.get(outer));
        return outer;
    }
    // Calls are checked as AST nodes, not lines: another call or a comment cannot
    // supply their code. A full emitted object is checked for ambiguous spreads/keys.
    for (const node of nodes) {
        if (node.type !== 'CallExpression') continue;
        const method = name(node.callee);
        if (HELPERS.has(method)) {
            const data = node.arguments[method === 'unauthorized' ? 1 : 2];
            // Legacy HttpNotAutorized nests datacontent; a code argument alone does
            // not prove the final data.code envelope. Its controls require review.
            if (method === 'unauthorized' && codedData(data)) cover(node); else add(node, 'authentication helper without a proven AUTH envelope');
        } else if (['status', 'sendStatus', 'writeHead', 'HttpError'].includes(method)) {
            // Only HTTP receivers for the generic name status (domain services also have status()).
            if (method === 'status' && node.callee.type === 'MemberExpression' && !['res', 'response', 'this'].includes(name(node.callee.object)) && node.callee.object.type !== 'CallExpression') continue;
            const values = possibleStatus(node.arguments[0]);
            if (values && !values.has(401)) continue;
            const outer = chain(node), arg = node.arguments[0];
            const payload = outer !== node && ['json', 'send'].includes(name(outer.callee)) ? outer.arguments[0] : null;
            // A transparent serializer preserves the exact status+body. Origins are inventoried separately.
            const transparent = arg?.type === 'MemberExpression' && name(arg) === 'status' && payload && signature(arg.object) === signature(payload);
            if (transparent || (values?.size === 1 && values.has(401) && codedEnvelope(payload))) cover(outer);
            else add(outer, values ? '401 HTTP emission without a literal AUTH code' : 'unresolved dynamic HTTP status/serializer');
        }
    }
    for (const node of nodes) {
        if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression' || name(node.left) !== 'statusCode') continue;
        const values = possibleStatus(node.right);
        if (!values || values.has(401)) add(node, 'HTTP statusCode assignment requires envelope review');
    }
    // Object status fields also cover thrown errors and responses returned to a controller.
    for (const node of nodes) {
        if (node.type !== 'ObjectExpression' || isCovered(node)) continue;
        const values = possibleStatus(property(node, 'status') || property(node, 'statusCode'));
        if (values?.has(401)) {
            if (codedEnvelope(node)) cover(node); else add(node, '401 object without a literal AUTH code');
        }
    }
    // Any remaining 401 origin or reference is unresolved. This deliberately rejects
    // aliases (including destructuring/computed names), assignments and status variables
    // instead of guessing scope, runtime values or data-flow through other functions.
    for (const node of nodes) {
        if (isCovered(node)) continue;
        const parent = parents.get(node);
        const marker = (node.type === 'Literal' && (node.value === 401 || node.value === '401' || HELPERS.has(node.value))) ||
            (node.type === 'MemberExpression' && (name(node) === 'UNAUTHORIZED' || HELPERS.has(name(node)))) ||
            (node.type === 'Identifier' && HELPERS.has(node.name) && parent?.type !== 'MemberExpression');
        if (!marker) continue;
        let owner = node;
        if (parent && ['VariableDeclarator', 'AssignmentExpression', 'AssignmentPattern', 'Property', 'BinaryExpression'].includes(parent.type)) owner = parent;
        add(owner, 'unresolved 401 origin/helper reference');
    }
    return candidates;
}

function scan(files, allow = []) {
    const findings = [], used = new Map(), inventory = [];
    for (const { file, text } of files) {
        let entries;
        try { entries = inspect(file, text); }
        catch (error) { findings.push(`${file}: cannot parse (${error.message})`); continue; }
        for (const entry of entries) {
            inventory.push(entry);
            const exception = allow.find(item => item.file === file && item.hash === entry.hash && item.context === entry.context);
            if (exception) used.set(exception, (used.get(exception) || 0) + 1);
            else findings.push(`${file}:${entry.line}: ${entry.reason}: ${entry.snippet.slice(0, 160)}`);
        }
    }
    // Cardinality is part of the gate itself, including duplicate matching nodes on one line.
    for (const item of allow) if ((used.get(item) || 0) !== item.count) findings.push(`${item.file}: stale or widened exception: ${item.reason}`);
    return { findings, used, inventory };
}
module.exports = { scan, inspect, fingerprint };
