'use strict';
// Runtime adapter for the existing NC4 tables. No network, DDL or automatic imports.
const C = require('./contract');
const FAMILIES = Object.freeze([...new Set([...Object.values(C.refs), ...Object.values(C.residenceRefs), 'sis.affiliation', 'sis.personnel_type', 'sis.establishments'])]);
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const civil = value => value instanceof Date ? value.toISOString().slice(0, 10) : value && String(value).slice(0, 10);
const unavailable = code => ({ result: 'unverified', code: code || 'CATALOG_UNAVAILABLE' });
const invalid = code => ({ result: 'invalid', code });
const sourceOf = r => ({releaseId:r.release_id,sourceVersion:r.source_version,sourceUrl:r.source_url,sha256:r.sha256,
    validFrom:civil(r.valid_from),validityBasis:r.validity_basis});
const clueAttributes = entry => {
    const raw=json(entry.attributes_json)||{};
    // Only the eight columns imported from the SIS source; never infer a business address or local name.
    return {clues:entry.code,nombre_unidad:entry.label,...Object.fromEntries(
        ['en_operacion','id_entidad_federativa','tipo_unidad','tip_abreviacion','sub_abreviacion','institucion'].map(k=>[k,raw[k]??null]))};
};
function references(data, path = '', result = []) {
    if (!data || typeof data !== 'object') return result;
    if (data.family) result.push({ field: path, ref: data });
    else for (const [key, value] of Object.entries(data)) references(value, path ? path + '.' + key : key, result);
    return result;
}
function createCatalogs(db) {
    const query = (sql, replacements, transaction) => db.query(sql, { replacements, transaction, type: 'SELECT' });
    function request(transaction, lockReleases=false) {
        const cache = new Map();
        const releases = family => {
            if (!cache.has(family)) cache.set(family, query('SELECT * FROM sis_catalog_release WHERE family=:family ORDER BY valid_from,release_id'+(lockReleases?' FOR SHARE':''), { family }, transaction));
            return cache.get(family);
        };
        const effective = (rows, row, date) => {
            const next = rows.filter(r => r.verified_at && civil(r.valid_from) > civil(row.valid_from))[0];
            const end = civil(row.valid_to) || (next && civil(next.valid_from));
            return row.verified_at && row.provenance === 'official' && row.status === 'verified' && civil(row.valid_from) <= date && (!end || date < end);
        };
        async function check(ref, date = C.today()) {
            if (!ref.releaseId) return unavailable('CATALOG_REF_CANDIDATE');
            const rows = await releases(ref.family), release = rows.find(r => r.release_id === ref.releaseId);
            // A missing source does not authenticate the caller's claim of a version.
            if (!release) {
                const [other] = await query('SELECT family FROM sis_catalog_release WHERE release_id=:releaseId', {releaseId:ref.releaseId}, transaction);
                return other ? invalid('CATALOG_FAMILY_MISMATCH') : unavailable();
            }
            const [entry] = await query('SELECT * FROM sis_catalog_entry WHERE family=:family AND release_id=:releaseId AND code=:code', ref, transaction);
            if (!entry) return invalid(ref.family === 'sis.establishments' ? 'CLUES_NOT_IN_SIS_RELEASE' : 'CATALOG_CODE_NOT_FOUND');
            if (Number(entry.is_sentinel)) return invalid('CATALOG_SENTINEL_NOT_STORABLE');
            const attributes = json(entry.attributes_json) || {};
            const metadata = {label:entry.label,source:sourceOf(release),...(ref.family==='sis.establishments'?{attributes:clueAttributes(entry)}:{})};
            if (ref.family === 'sis.establishments' && attributes.en_operacion !== '1') return {...invalid('CLUES_NOT_OPERATING'),...metadata};
            return { ...(effective(rows, release, date) ? { result: 'valid', code: null } : unavailable('RELEASE_NOT_EFFECTIVE')), ...metadata };
        }
        return { releases, effective, check };
    }
    function missing(error) { return ['ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR'].includes(error && (error.original || error.parent || error).code); }
    // PAIS_2021_Rev_20241101: 142 = MÉXICO. Only a resolved official country can establish a conflict;
    // missing/manual countries stay unverified, and an absent country is never inferred from INEGI.
    async function residenceConflict(data, client) {
        const r = data && data.residence;
        if (!r || !r.country || !(r.entity || r.municipality || r.locality)) return false;
        const country = await client.check(r.country);
        return country.result === 'valid' && r.country.code !== '142';
    }
    async function validate(patch, transaction, merged = patch, {freshClues=false} = {}) {
        // New versioned CLUES assignments must still be current at write time. The shared range lock keeps
        // release activation stable through commit; unrelated edits can retain a historical reference.
        const client = request(transaction, freshClues && Boolean(transaction));
        for (const { field, ref } of references(patch)) {
            let result;
            try { result = await client.check(ref); } catch (error) {
                if (missing(error)) { if(freshClues&&field==='cluesRef')C.fail(field,'CATALOG_UNAVAILABLE',503); continue; }
                throw error;
            }
            if (result.result === 'invalid') C.fail(field.replace(/\.\d+$/, ''), result.code);
            if (freshClues&&field==='cluesRef'&&result.result!=='valid') {
                C.fail(field,result.code==='RELEASE_NOT_EFFECTIVE'?'CATALOG_RELEASE_CHANGED':'CATALOG_UNAVAILABLE',result.code==='RELEASE_NOT_EFFECTIVE'?409:503);
            }
        }
        // Nested PATCH is checked against the merged residence, but unrelated historic edits remain possible.
        if (patch.residence) {
            try { if (await residenceConflict(merged, client)) C.fail('residence.country', 'RESIDENCE_COUNTRY_GEO_MISMATCH'); }
            catch (error) { if (!missing(error)) throw error; }
        }
    }
    async function view(data, revision, updatedAt, transaction) {
        const result = C.view(data, revision, updatedAt), client = request(transaction), checks = [];
        if ('cluesRef' in data || 'displayName' in data) result.catalogAttributes = null;
        result.qualityIssues = result.qualityIssues.filter(i => i.code !== 'CATALOG_UNAVAILABLE');
        for (const { field, ref } of references(data)) {
            let value;
            try { value = await client.check(ref); } catch (error) { if (!missing(error)) throw error; value = unavailable(); }
            checks.push({ field, ...value });
            if(field==='cluesRef')result.catalogAttributes=value.attributes||null;
            if (value.result !== 'valid') result.qualityIssues.push({ field, code: value.code, severity: 'warning' });
        }
        let conflict = false;
        try { conflict = await residenceConflict(data, client); } catch (error) { if (!missing(error)) throw error; }
        if (conflict) result.qualityIssues.push({field:'residence.country',code:'RESIDENCE_COUNTRY_GEO_MISMATCH',severity:'warning'});
        result.catalogChecks = checks;
        result.catalogValidation = !conflict && checks.length && checks.every(c => c.result === 'valid') ? 'verified' : 'unverified';
        return result;
    }
    async function search(family, input = {}) {
        if (!FAMILIES.includes(family)) C.fail('family', 'CATALOG_FAMILY_INVALID');
        if (Object.keys(input).some(k => !['q', 'parent', 'offset', 'code', 'releaseId', 'exactCode'].includes(k))) C.fail('query');
        if(input.exactCode!==undefined) {
            if(family!=='sis.establishments'||Object.keys(input).length!==1)C.fail('query');
            C.reference({family,code:input.exactCode},family,'exactCode');
        }
        const q = input.q || '', parent = input.parent || '', offset = input.offset === undefined ? 0 : Number(input.offset);
        if (typeof q !== 'string' || q.length > 100 || typeof parent !== 'string' || !/^\d{0,5}$/.test(parent) || !Number.isInteger(offset) || offset < 0 || offset > 10000) C.fail('query');
        if (parent && !((family === 'inegi.municipality' && /^\d{2}$/.test(parent)) || (family === 'inegi.locality' && /^\d{5}$/.test(parent)))) C.fail('parent');
        const client = request();
        try {
            if (input.code !== undefined) {
                const ref = { family, code: input.code, ...(input.releaseId ? { releaseId: input.releaseId } : {}) };
                C.reference(ref, family, 'code');
                return { check: await client.check(ref) };
            }
            const rows = await client.releases(family), release = rows.find(r => client.effective(rows, r, C.today()));
            if (!release) return { available: false, items: [], hasMore: false, ...(input.exactCode!==undefined?{item:null}:{}) };
            if(input.exactCode!==undefined) {
                const ref={family,releaseId:release.release_id,code:input.exactCode},check=await client.check(ref);
                return {available:true,source:sourceOf(release),item:check.attributes?{ref,label:check.label,attributes:check.attributes,check}:null};
            }
            // Literal substring, never user SQL/wildcards: %, _ and the escape character are escaped. LIKE follows the
            // label collation (accent/case-insensitive); MySQL LOCATE stays accent-sensitive. The parent is digits only
            // (validated above), so its prefix LIKE uses the primary-key range. Bound every page.
            const like = '%' + q.replace(/[!%_]/g, '!$&') + '%';
            const entries = await query(`SELECT code,label,attributes_json FROM sis_catalog_entry
                WHERE family=:family AND release_id=:releaseId AND is_sentinel=0
                AND (family<>'sis.establishments' OR JSON_UNQUOTE(JSON_EXTRACT(attributes_json,'$.en_operacion'))='1')
                AND (:q = '' OR label LIKE :like ESCAPE '!' OR CONVERT(code USING utf8mb4) LIKE :like ESCAPE '!')
                AND (:parent = '' OR code LIKE CONCAT(:parent,'%'))
                ORDER BY code LIMIT 31 OFFSET :offset`, { family, releaseId: release.release_id, q, like, parent, offset });
            return { available: true, source: sourceOf(release),
                items: entries.slice(0, 30).map(e => ({ ref: { family, releaseId: release.release_id, code: e.code }, label: e.label })), hasMore: entries.length > 30 };
        } catch (error) { if (missing(error)) return { available: false, items: [], hasMore: false }; throw error; }
    }
    return { validate, view, search };
}
module.exports = { createCatalogs, references, FAMILIES };
