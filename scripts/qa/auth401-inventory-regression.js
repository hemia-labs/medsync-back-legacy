'use strict';
// No application imports, database, sockets or credentials.
const assert = require('node:assert/strict');
let { scan } = require('./lib/auth401-inventory');
const legacy = process.argv.includes('--legacy');
if (legacy) {
    const { execFileSync } = require('node:child_process');
    const source = execFileSync('git', ['show', '3ab30894:scripts/qa/nc1-auth-s1-s3-regression.js'], { cwd: require('node:path').resolve(__dirname, '../..'), encoding: 'utf8' });
    scan = new Function('require', '__dirname', source.split('// ---------------------------------------------------------------- HTTP helper')[0] + '\nreturn scan;')(require, __dirname);
}
let total = 0, failed = 0;
function test(name, work) { total++; try { work(); console.log('PASS ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
const file = 'src/review-synthetic-route.js';
const scanText = text => scan([{ file, text }]);
const bad = [
    ['sendStatus', 'res.sendStatus(401);'],
    ['statusCode assignment', 'res.statusCode = 401; res.end();'],
    ['dynamic status', 'const deniedStatus = 401; res.status(deniedStatus).json({ data: null });'],
    ['helper alias', "const deny = responseData.unauthorized; return deny('Sin acceso.');"],
    ['numeric HttpError', "return this.HttpError(401, 'Sin acceso.');"],
    ['unrelated code', "res.status(401).json({ data: null }); const unrelated = { code: 'AUTH_ACCESS_INVALID' };"],
    ['comment code', "res.status(401).json({ data: null }); // code: 'AUTH_ACCESS_INVALID'"],
    ['destructured alias', "const { unauthorized: deny } = responseData; deny('x');"],
    ['computed alias', "const deny = responseData['unauthorized']; deny('x');"],
    ['status alias', 'const { UNAUTHORIZED: denied } = HttpStatus; res.status(denied).end();'],
    ['external dynamic status', 'res.status(await getStatus()).json({ data: null });'],
    ['multiline uncoded', 'res.status(\n401\n).json({ data: null });'],
    ['unrelated nested code', "res.status(401).json({ data: null, example: { code: 'AUTH_ACCESS_INVALID' } });"],
    ['overridden code', "res.status(401).json({ data: { code: 'AUTH_ACCESS_INVALID', ...override } });"],
    ['duplicate code', "res.status(401).json({ data: { code: 'AUTH_ACCESS_INVALID', code: null } });"],
    ['nested uncoded emitter', "res.status(401).json({ data: { code: 'AUTH_ACCESS_INVALID' }, x: responseData.unauthorized('x') });"]
];
for (const [label, text] of bad) test('reject ' + label, () => assert.ok(scanText(text).findings.length > 0, 'uncoded/unresolved emission was accepted'));
const good = [
    'res.status(401).json({\n status: 401,\n data: { code: "AUTH_ACCESS_INVALID" }\n});',
    'return responseData.unauthorized(\n"x",\n{ code: "AUTH_SESSION_INVALID" }\n);',
    'throw Object.assign(Error("x"), { status: 401, code: "AUTH_SESSION_INVALID" });',
    '// res.sendStatus(401) is a comment\nconst example = "res.sendStatus(401)";',
    'res.status(result.status).send(result);',
    'res.status(ready ? 200 : 503).json({ ready });'
];
for (const [index, text] of good.entries()) test('accept syntax-bound positive ' + (index + 1), () => assert.deepEqual(scanText(text).findings, []));

if (!legacy) {
    const source = "function refresh(req, res) { return responseData.unauthorized('control'); }";
    const [{ hash, context }] = scanText(source).inventory;
    const allow = [{ file, hash, context, count: 1, reason: 'synthetic auth control' }];
    test('exact exception accepted', () => assert.deepEqual(scan([{ file, text: source }], allow).findings, []));
    test('same-line second emitter rejected', () => assert.ok(scan([{ file, text: source + " res.sendStatus(401);" }], allow).findings.length));
    test('duplicate exact function increases count', () => assert.ok(scan([{ file, text: source + source }], allow).findings.length));
    test('same exception in another file rejected', () => assert.ok(scan([{ file: 'src/other.js', text: source }], allow).findings.length));
    test('changed enclosing auth control rejected', () => assert.ok(scan([{ file, text: source.replace("'control'", "'other'") }], allow).findings.length));
    test('removed exception rejected', () => assert.ok(scan([], allow).findings.length));
    test('parse failure fails closed', () => assert.ok(scanText('function {').findings.length));
}
console.log(`${failed ? 'FAIL' : 'PASS'} inventory syntax: ${total - failed}/${total}${legacy ? ' (delivered scanner 3ab30894)' : ''}`);
process.exitCode = failed ? 1 : 0;
