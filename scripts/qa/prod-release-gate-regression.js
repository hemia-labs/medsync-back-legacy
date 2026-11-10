'use strict';

const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const repo = mkdtempSync(join(tmpdir(), 'medsync-prod-release-'));
const classifier = resolve(__dirname, '../ops/classify-prod-release.js');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (file, data) => writeFileSync(join(repo, file), data);
const commit = () => {
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
};
const version = (value) => {
    write('package.json', JSON.stringify({ name: 'medsync', version: value }));
    write('package-lock.json', JSON.stringify({ version: value, packages: { '': { version: value } } }));
    write('CHANGELOG.md', '# Changelog\n\n## ' + value + '\n\nFix.\n');
};
const classify = (base) => spawnSync(process.execPath, [classifier, base], { cwd: repo, encoding: 'utf8' });

try {
    git('init', '-q');
    git('config', 'user.name', 'MedSync Test');
    git('config', 'user.email', 'medsync@example.test');
    mkdirSync(join(repo, '.changeset'));
    version('0.0.2');
    const initial = commit();
    write('.changeset/send-mail.md', 'Pending release');
    write('app.js', 'Functional change');
    const functional = commit();
    assert.equal(classify(initial).stdout.trim(), 'release=false');

    version('0.0.3');
    rmSync(join(repo, '.changeset/send-mail.md'));
    const stable = commit();
    assert.equal(classify(functional).stdout.trim(), 'release=true\ntag=v0.0.3');
    assert.notEqual(classify(initial).status, 0, 'mixed code and version must be refused');
    assert.notEqual(classify(stable.slice(0, -1)).status, 0, 'invalid push base must be refused');
    console.log('PASS production release only accepts a reviewed version-only diff');
} finally {
    rmSync(repo, { recursive: true, force: true });
}
