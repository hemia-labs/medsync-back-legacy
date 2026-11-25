'use strict';

const { importXlsxRelease } = require('../domain/sisCatalog/importer');
const { installRelease, manifest } = require('../domain/sisCatalog/installRelease');
const { sha256 } = require('../domain/sisCatalog/release');
const { getCluesSource } = require('../domain/sisCatalog/cluesSource');
const { today } = require('../domain/identity/contract');

const family = 'sis.establishments';
// The reviewed first shared import, also recorded in docs/nc1-catalogs/sources-reviewed-20261117.json.
const initialEntryCount = 15358;

function reject(code) {
    throw Object.assign(new Error(code), { code });
}

// NC4 has used both a file name (first manual import) and a monthly edition label.
function editionOf(label) {
    return /^(?:ESTABLECIMIENTO_DE_SALUD_SIS_)?(\d{4}(?:0[1-9]|1[0-2]))(?:\.xlsx)?$/i.exec(label || '')?.[1];
}

function reviewCurrent(history, release) {
    // installRelease supplies history in chronological order, including withdrawals.
    const current = history.filter(row => row.verified_at).at(-1);
    const prior = current && manifest(current);
    const date = release.manifest.validFrom;
    const known = history.find(row => row.sha256 === release.manifest.sha256);
    if (known) {
        if (known === current && prior.status === 'verified' && prior.provenance === 'official'
            && prior.validFrom <= date && (!prior.validTo || date < prior.validTo)) return known;
        reject('CLUES_HISTORICAL_OR_UNVERIFIED_FILE');
    }
    // A structurally valid workbook can still be a partial national catalog.
    if (release.entryCount < Number(current?.entry_count ?? initialEntryCount) * 0.9) reject('CLUES_COUNT_DROP_REVIEW');
    if (prior) {
        const edition = editionOf(prior.sourceVersion);
        if (!edition || release.manifest.sourceVersion < edition) reject('CLUES_EDITION_REVIEW');
        if (date <= prior.validFrom) reject('CLUES_EFFECTIVE_DATE_REVIEW');
    }
}

async function syncClues(conn, { getSource = getCluesSource, now = new Date() } = {}) {
    const source = await getSource();
    const sha = sha256(source.buffer);
    const check = {
        family, checkedAt: now.toISOString(), sourceUrl: source.sourceUrl,
        sourceVersion: source.sourceVersion, sha256: sha
    };
    try {
        if (typeof source.sourceVersion !== 'string' || editionOf(source.sourceVersion) !== source.sourceVersion) reject('CLUES_INVALID_EDITION');
        const { release, issues } = importXlsxRelease(source.buffer, {
            family, releaseId: 'clues-' + source.sourceVersion + '-' + sha.slice(0, 32),
            sourceUrl: source.sourceUrl, sourceVersion: source.sourceVersion,
            downloadedAt: check.checkedAt, validFrom: today(now), validTo: null,
            validityBasis: 'download_date', provenance: 'official'
        });
        check.entries = release.entryCount;
        if (issues.length || !release.entryCount || release.list().some(entry => !entry.label || entry.attributes.en_operacion !== '1')) {
            reject('CLUES_INVALID_ESTABLISHMENTS');
        }
        const result = await installRelease(conn, release, {
            verify: true, sourceSha256: sha, actor: 'nc4-weekly-clues', reviewCurrent
        });
        return { ...check, status: result.alreadyApplied ? 'unchanged' : 'installed', releaseId: result.releaseId };
    } catch (error) {
        error.check = check;
        throw error;
    }
}

async function main() {
    const config = require('../config/config');
    if (!config.DATABASEMYSQL || !config.HOSTMYSQL) reject('CLUES_DATABASE_NOT_CONFIGURED');
    const conn = await require('mysql2/promise').createConnection({
        host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL,
        password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, timezone: 'Z'
    });
    try {
        console.log(JSON.stringify(await syncClues(conn)));
    } finally {
        await conn.end();
    }
}

if (require.main === module) main().catch(error => {
    const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || '') ? error.code : 'CLUES_SYNC_FAILED';
    const temporary = ['CATALOG_IMPORT_BUSY', 'CLUES_SOURCE_UNAVAILABLE', 'ECONNREFUSED', 'ETIMEDOUT',
        'ECONNRESET', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code);
    console.error(JSON.stringify({ family, checkedAt: new Date().toISOString(), ...error.check,
        status: temporary ? 'unavailable' : 'review_required', code }));
    process.exitCode = temporary ? 75 : 1;
});

module.exports = { syncClues };
