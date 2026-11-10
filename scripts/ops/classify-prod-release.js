'use strict';

const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base || '') || /^0+$/.test(base)) {
    throw new Error('A valid previous main commit is required.');
}
git('merge-base', '--is-ancestor', base, 'HEAD');

const { version: previous, ...previousPackage } = JSON.parse(git('show', base + ':package.json'));
const { version: current, ...currentPackage } = JSON.parse(git('show', 'HEAD:package.json'));
if (previous === current) {
    console.log('release=false');
} else {
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const before = semver.exec(previous);
    const after = semver.exec(current);
    const component = after && before && after.slice(1).findIndex((value, i) => value !== before[i + 1]);
    if (!before || !after || component < 0 || BigInt(after[component + 1]) <= BigInt(before[component + 1])) {
        throw new Error('The version must advance to a stable SemVer.');
    }
    if (!isDeepStrictEqual(previousPackage, currentPackage)) {
        throw new Error('The version PR must only change the package version.');
    }
    const modified = new Set(['CHANGELOG.md', 'package-lock.json', 'package.json']);
    const changes = git('diff', '--name-status', '--no-renames', '-z', base, 'HEAD').split('\0');
    changes.pop();
    let consumed = false;
    for (let i = 0; i < changes.length; i += 2) {
        const [status, file] = changes.slice(i, i + 2);
        if (status === 'M' && modified.delete(file)) continue;
        if (status === 'D' && /^\.changeset\/(?!README\.md$)[A-Za-z0-9_-]+\.md$/.test(file)) {
            consumed = true;
            continue;
        }
        throw new Error('A stable release commit must contain version changes only.');
    }
    const lock = JSON.parse(git('show', 'HEAD:package-lock.json'));
    if (modified.size || !consumed || lock.version !== current || lock.packages?.['']?.version !== current ||
        !git('show', 'HEAD:CHANGELOG.md').split(/\r?\n/).includes('## ' + current)) {
        throw new Error('The version PR must consume a Changeset and update the changelog and manifests.');
    }
    console.log('release=true\ntag=v' + current);
}
