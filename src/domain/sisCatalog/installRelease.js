'use strict';
// Explicit operational import into the existing NC4 schema; never invoked by API startup.
const { isRelease, buildRelease, canonical } = require('./release');
const { CatalogRegistry } = require('./registry');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const dt = v => v && (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const day = v => v && (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
function manifest(row) {
    return { releaseId: row.release_id, family: row.family, sourceCatalogName: row.source_catalog_name,
        sourceUrl: row.source_url, sourceVersion: row.source_version, downloadedAt: dt(row.downloaded_at), sha256: row.sha256,
        encoding: row.encoding, validFrom: day(row.valid_from), validTo: day(row.valid_to), validityBasis: row.validity_basis,
        provenance: row.provenance, status: row.status, verifiedAt: dt(row.verified_at),
        columnMapping: typeof row.column_mapping_json === 'string' ? JSON.parse(row.column_mapping_json) : row.column_mapping_json };
}
async function installRelease(conn, release, { verify = false, sourceSha256, actor = 'nc1-catalog-import', reviewCurrent } = {}) {
    if (!isRelease(release) || release.manifest.status !== 'staged') fail('CATALOG_STAGE_REQUIRED');
    if (sourceSha256 !== release.manifest.sha256) fail('CATALOG_SOURCE_HASH_MISMATCH');
    const m = release.manifest, lock = 'nc4-import-' + m.family;
    const [[got]] = await conn.query('SELECT GET_LOCK(?,10) AS acquired', [lock]);
    if (Number(got.acquired) !== 1) fail('CATALOG_IMPORT_BUSY');
    try {
        await conn.beginTransaction();
        const [existing] = await conn.query('SELECT * FROM sis_catalog_release WHERE family=? ORDER BY valid_from,release_id FOR UPDATE', [m.family]);
        // A scheduled publisher must evaluate the current edition under the same lock as manual imports.
        if (reviewCurrent) {
            const current = reviewCurrent(existing, release);
            if (current) {
                await conn.commit();
                return { releaseId: current.release_id, entries: Number(current.entry_count), alreadyApplied: true, status: current.status };
            }
        }
        const same = existing.find(r => r.release_id === m.releaseId);
        if (same) {
            if (same.sha256 !== m.sha256 || same.content_sha256 !== release.contentSha256 || Number(same.entry_count) !== release.entryCount || same.status === 'retired') fail('CATALOG_IMPORT_CONFLICT');
            if (canonical({...manifest(same),status:'staged',verifiedAt:null}) !== canonical(m)) fail('CATALOG_IMPORT_CONFLICT');
            if (verify && same.status !== 'verified') fail('CATALOG_IMPORT_INCOMPLETE');
            await conn.commit(); return { releaseId: m.releaseId, alreadyApplied: true, status: same.status };
        }
        const verifiedAt = verify ? new Date().toISOString() : null;
        const registry = new CatalogRegistry();
        existing.forEach(r => registry.add(buildRelease(manifest(r), [])));
        registry.add(buildRelease({ ...m, status: verify ? 'verified' : 'staged', verifiedAt }, []));
        const values = [m.releaseId,m.family,m.sourceCatalogName,m.sourceUrl,m.sourceVersion,new Date(m.downloadedAt),m.sha256,release.contentSha256,m.encoding,m.validFrom,m.validTo,m.validityBasis,m.provenance,'staged',null,JSON.stringify(m.columnMapping),release.entryCount,release.relationCount,actor];
        await conn.query(`INSERT INTO sis_catalog_release (release_id,family,source_catalog_name,source_url,source_version,downloaded_at,sha256,content_sha256,encoding,valid_from,valid_to,validity_basis,provenance,status,verified_at,column_mapping_json,entry_count,relation_count,created_by) VALUES (${values.map(() => '?').join(',')})`, values);
        const entries = release.list();
        for (let i=0; i<entries.length; i+=500) {
            const batch=entries.slice(i,i+500).map(e=>[m.family,m.releaseId,e.code,e.label,JSON.stringify(e.attributes),e.sentinel?1:0]);
            await conn.query('INSERT INTO sis_catalog_entry (family,release_id,code,label,attributes_json,is_sentinel) VALUES ?', [batch]);
        }
        const pairs = release.pairs();
        for (let i = 0; i < pairs.length; i += 500) {
            const batch = pairs.slice(i, i + 500).map(pair => [
                m.family, m.releaseId, m.columnMapping.relationLeftFamily, pair.left, pair.right
            ]);
            await conn.query('INSERT INTO sis_catalog_relation (family,release_id,left_family,left_code,right_code) VALUES ?', [batch]);
        }
        if (verify) await conn.query("UPDATE sis_catalog_release SET status='verified',verified_at=?,status_changed_at=UTC_TIMESTAMP(3),status_changed_by=? WHERE release_id=?", [new Date(verifiedAt),actor,m.releaseId]);
        await conn.commit();
        return { releaseId:m.releaseId,entries:release.entryCount,status:verify?'verified':'staged',alreadyApplied:false };
    } catch(error) { await conn.rollback(); throw error; }
    finally { await conn.query('SELECT RELEASE_LOCK(?)',[lock]); }
}
module.exports = { installRelease, manifest };
