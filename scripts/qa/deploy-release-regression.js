'use strict';
// Run the actual release script in disposable directories with fake external
// commands. No SSH, package installation, PM2 service or network is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\','/').replace(/^([A-Z]):/i, (_, drive) => '/' + drive.toLowerCase()) : value;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'medsync-deploy-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o700 }); };
try {
    for (const phase of ['install-failure', 'start-failure', 'readiness-failure', 'success']) {
        const root = path.join(scratch, phase), candidate = path.join(root, 'releases/100-1'), bin = path.join(root, 'fake-bin');
        write(path.join(root, 'ecosystem.config.cjs'), 'legacy-release');
        write(path.join(root, '.env'), 'SYNTHETIC_PREVIOUS=1');
        write(path.join(root, 'src/tempFolder/kept'), 'persistent-temp');
        write(path.join(root, 'logs/kept'), 'persistent-logs');
        write(path.join(candidate, 'ecosystem.config.cjs'), 'candidate');
        write(path.join(candidate, '.env'), 'SYNTHETIC_CANDIDATE=1');
        write(path.join(candidate, 'src/index.js'), 'candidate');
        write(path.join(root, 'nvm/nvm.sh'), 'nvm() { return 0; }\n');
        write(path.join(bin, 'npm'), '#!/usr/bin/env bash\n[[ "$QA_PHASE" != install-failure ]]\n');
        write(path.join(bin, 'pm2'), '#!/usr/bin/env bash\nprintf "%s:%s\\n" "$PWD" "$*" >> "$QA_RECORD"\n[[ "$1" != start || "$QA_PHASE" != start-failure || "$APP_RELEASE_ID" != 100-1 ]]\n');
        write(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
        write(path.join(bin, 'curl'), '#!/usr/bin/env bash\n[[ "$QA_PHASE" != readiness-failure ]] || exit 22\nprintf \'{"ready":true,"release":"%s"}\' "$APP_RELEASE_ID"\n');
        if (process.platform === 'win32') {
            // Windows lacks symlink privilege; junctions exercise directory switching.
            // Linux CI runs native ln/mv without these filesystem adapters.
            const adapter = path.join(root, 'junction.cjs');
            write(adapter, `const fs=require('fs');const norm=s=>s.replace(/^\\/([a-z])\\//i,(_,d)=>d.toUpperCase()+':/');const args=process.argv.slice(2);if(args[0]==='link')fs.symlinkSync(norm(args[2]),norm(args[3]),'junction');else{const target=norm(args[3]);if(fs.existsSync(target))fs.unlinkSync(target);fs.renameSync(norm(args[2]),target);}`);
            write(path.join(bin, 'ln'), '#!/usr/bin/env bash\nnode "$QA_JUNCTION" link "$@"\n');
            write(path.join(bin, 'mv'), '#!/usr/bin/env bash\nif [[ "$1" == -Tf ]]; then node "$QA_JUNCTION" move "$@"; else /usr/bin/mv "$@"; fi\n');
        }
        const result = spawnSync(bash, ['-c', 'export PATH="$QA_BIN:$PATH"; bash "$QA_SCRIPT"'], {
            encoding: 'utf8', timeout: 20000,
            env: { ...process.env, MSYS: 'winsymlinks:nativestrict', VPS_APP_DIR: shellPath(root), RELEASE_ID: '100-1', APP_PORT: '1',
                NVM_DIR: shellPath(path.join(root, 'nvm')), QA_BIN: shellPath(bin), QA_SCRIPT: shellPath(path.resolve(__dirname, '../ops/activate-release.sh')),
                QA_JUNCTION: shellPath(path.join(root, 'junction.cjs')), QA_PHASE: phase, QA_RECORD: shellPath(path.join(root, 'pm2-record')) }
        });
        assert.equal(result.status, phase === 'success' ? 0 : 1, result.stdout + result.stderr);
        assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SYNTHETIC_PREVIOUS=1');
        assert.equal(fs.readFileSync(path.join(root, 'src/tempFolder/kept'), 'utf8'), 'persistent-temp');
        if (phase === 'install-failure') {
            assert.equal(fs.existsSync(path.join(root, 'current')), false);
            assert.equal(fs.existsSync(path.join(root, 'pm2-record')), false, 'Installation failure cannot restart the active app');
        } else {
            const commands = fs.readFileSync(path.join(root, 'pm2-record'), 'utf8').trim().split('\n');
            const starts = commands.filter(line => line.endsWith(':start ecosystem.config.cjs --update-env'));
            assert.equal(starts[0], shellPath(candidate) + ':start ecosystem.config.cjs --update-env');
            assert.equal(starts.length, phase === 'success' ? 1 : 2);
            if (phase !== 'success') assert.equal(starts[1], shellPath(root) + ':start ecosystem.config.cjs --update-env');
            for (const start of starts) {
                const index = commands.indexOf(start);
                assert.equal(commands[index - 1], start.split(':start ')[0] + ':delete medsync-back-legacy');
            }
            assert.ok(commands.every(line => !line.includes('startOrReload')), 'Never reuse stale PM2 script/cwd');
            assert.ok(fs.existsSync(path.join(root, 'current')), result.stdout + result.stderr);
            assert.equal(fs.realpathSync(path.join(root, 'current')), fs.realpathSync(phase === 'success' ? candidate : root));
            assert.equal(fs.readFileSync(path.join(root, 'shared/logs/kept'), 'utf8'), 'persistent-logs');
            assert.equal(fs.readFileSync(path.join(candidate, 'src/tempFolder/kept'), 'utf8'), 'persistent-temp');
        }
    }
    const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8');
    assert.match(workflow, /needs: isolated-regressions/);
    assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /npm run qa:isolated/);
    for (const match of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
    assert.doesNotMatch(workflow, /rm -rf|pm2 logs|appleboy/);
    const upload = fs.readFileSync(path.resolve(__dirname, '../ops/upload-release.sh'), 'utf8');
    assert.match(upload, /StrictHostKeyChecking=yes/);
    assert.match(upload, /VPS_KNOWN_HOSTS/);
    assert.doesNotMatch(upload, /ssh-keyscan|curl/);
    if (process.platform === 'win32') console.log('Windows junction adapter used; native Linux atomic rename remains a CI check.');
    console.log('PASS deploy: failed install/start/readiness preserve or restore previous release; successful switch and persistent files; CI/ref/SHA guards. Mock commands only.');
} finally {
    // Delete only the newly-created fixture directory, never application paths.
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('medsync-deploy-'));
    fs.rmSync(resolved, { recursive: true, force: true });
}
