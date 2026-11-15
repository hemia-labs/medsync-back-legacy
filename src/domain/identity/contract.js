'use strict';
const VERSION = 'nc1.identity.v1.1';
const names = { givenNames: 500, firstSurname: 500, secondSurname: 500 };
const enums = {
    firstSurnameStatus: ['present','absent_declared','unknown'], secondSurnameStatus: ['present','absent_declared','unknown'],
    biologicalSex: ['1','2','3'], genderIdentity: ['0','1','2','3','4','5','6','88'],
    indigenousSelfIdentification: ['yes','no','declined','unknown_to_patient'],
    afromexicanSelfIdentification: ['yes','no','declined','unknown_to_patient'], migrantStatus: ['none','national','international','returned']
};
const refs = { birthCountry:'sis.country', birthEntity:'sis.federal_entity', nationality:'renapo.nationality', originCountry:'sis.country' };
const residenceRefs = { country:'sis.country', entity:'inegi.state', municipality:'inegi.municipality', locality:'inegi.locality', postalCode:'sepomex.postal_code' };
const fail = (field, code = 'IDENTITY_INVALID', status = 400) => { throw Object.assign(new Error('Revisa el campo de identidad: ' + field), { status, code, field }); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const date = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !isNaN(Date.parse(x+'T00:00:00Z')) && new Date(x+'T00:00:00Z').toISOString().slice(0,10) === x;
const snake = x => x.replace(/[A-Z]/g, c => '_'+c.toLowerCase());
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
function text(x, field, max) { if (x !== null && (typeof x !== 'string' || !x.trim() || x.length > max)) fail(field); }
function reference(x, family, field) {
    if (x === null) return;
    if (!object(x) || !['code,family','code,family,releaseId'].includes(Object.keys(x).sort().join(','))) fail(field);
    if (x.family !== family || typeof x.code !== 'string' || !/^[\x21-\x7e]{1,32}$/.test(x.code)) fail(field);
    if ('releaseId' in x && (typeof x.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(x.releaseId))) fail(field);
    const patterns = { 'sis.establishments':/^[A-Z0-9]{11}$/, 'renapo.nationality':/^[A-Z]{3}$/, 'inegi.state':/^\d{2}$/, 'inegi.municipality':/^\d{5}$/, 'inegi.locality':/^\d{9}$/, 'sepomex.postal_code':/^\d{5}$/ };
    if (patterns[family] && !patterns[family].test(x.code)) fail(field);
    if ((family === 'sis.federal_entity' && ['00','88','99'].includes(x.code)) || (family === 'renapo.nationality' && x.code === 'NND') || (family.startsWith('inegi.') && (/^00/.test(x.code) || (x.code.length >= 5 && x.code.slice(2,5) === '000') || (x.code.length === 9 && x.code.slice(5) === '0000')))) fail(field,'CATALOG_SENTINEL_NOT_STORABLE');
}
function fields(kind) {
    if (kind === 'establishment') return ['displayName','cluesRef','active','validFrom','validTo'];
    return [...Object.keys(names),'firstSurnameStatus','secondSurnameStatus','birthDate','birthCountry','curp', ...(kind === 'patient' ? ['birthEntity','nationality','biologicalSex','genderIdentity','indigenousSelfIdentification','afromexicanSelfIdentification','migrantStatus','originCountry','affiliations','residence'] : ['authorizedPersonnelTypes'])];
}
function validate(kind, patch, current = {}, { creating = false } = {}) {
    if (!object(patch)) fail('identity');
    for (const k of Object.keys(patch)) if (!fields(kind).includes(k)) fail(k,'IDENTITY_READONLY_OR_UNKNOWN');
    const next = { ...current, ...patch };
    for (const [k,v] of Object.entries(patch)) {
        if (names[k]) text(v,k,names[k]);
        else if (enums[k] && v !== null && !enums[k].includes(v)) fail(k);
        else if (refs[k]) reference(v,refs[k],k);
        else if (['birthDate','validFrom','validTo'].includes(k) && v !== null && (!date(v) || (k === 'birthDate' && v > today()))) fail(k);
        else if (k === 'displayName') { text(v,k,250); if (v === null) fail(k); }
        else if (k === 'active' && typeof v !== 'boolean') fail(k);
        else if (k === 'cluesRef') reference(v,'sis.establishments',k);
        else if (k === 'curp' && v !== null) {
            if (!object(v) || Object.keys(v).some(k => !['value','kind','reason'].includes(k)) || !['real','generic'].includes(v.kind) || typeof v.value !== 'string' || !/^[A-Z0-9]{18}$/.test(v.value)) fail(k);
            if ((v.kind === 'generic') !== (v.value === 'XXXX999999XXXXXX99')) fail(k);
            if (v.kind === 'generic') { text(v.reason,'curp.reason',250); if (!v.reason) fail('curp.reason'); }
        } else if (['affiliations','authorizedPersonnelTypes'].includes(k) && v !== null) {
            if (!Array.isArray(v) || !v.length || v.length > 50) fail(k);
            const family = k === 'affiliations' ? 'sis.affiliation' : 'sis.personnel_type';
            v.forEach(x => { if (x === null) fail(k); reference(x,family,k); });
            if (new Set(v.map(x => x.code)).size !== v.length) fail(k);
        } else if (k === 'residence' && v !== null) {
            if (!object(v)) fail(k);
            // Nested PATCH: absent keys retain the previous residence values.
            next.residence = { ...(current.residence || {}), ...v };
            for (const [rk,rv] of Object.entries(v)) {
                if (residenceRefs[rk]) reference(rv,residenceRefs[rk],'residence.'+rk);
                else if (rk === 'addressText') text(rv,'residence.addressText',1000);
                else fail('residence.'+rk);
            }
        }
    }
    for (const k of ['firstSurname','secondSurname']) {
        const status = next[k+'Status'] || 'unknown';
        if (status === 'present' ? !next[k] : next[k] != null) fail(k);
    }
    if (creating && kind === 'patient' && !next.biologicalSex) fail('biologicalSex','BIOLOGICAL_SEX_REQUIRED');
    if (kind === 'establishment' && !next.displayName) fail('displayName');
    if (next.validFrom && next.validTo && next.validTo <= next.validFrom) fail('validTo');
    const r = next.residence || {};
    if (r.entity && r.municipality && !r.municipality.code.startsWith(r.entity.code)) fail('residence.municipality');
    if (r.municipality && r.locality && !r.locality.code.startsWith(r.municipality.code)) fail('residence.locality');
    return next;
}
function legacy(person) { return { givenNames: person.name || null, birthDate: person.birthday ? (person.birthday instanceof Date ? person.birthday.toISOString().slice(0,10) : String(person.birthday).slice(0,10)) : null, legacySurname: person.surname || null, firstSurname:null,secondSurname:null,firstSurnameStatus:'unknown',secondSurnameStatus:'unknown' }; }
function view(data, revision = 0, updatedAt = null) {
    const qualityIssues = [];
    const walk = (x,path) => { if (!x || typeof x !== 'object') return; if (x.family) qualityIssues.push({ field:path, code:'CATALOG_UNAVAILABLE',severity:'warning' }); else Object.entries(x).forEach(([k,v]) => walk(v,path ? path+'.'+k:k)); };
    walk(data,'');
    if (!revision) qualityIssues.push({field:'identity',code:'LEGACY_UNRESOLVED',severity:'warning'});
    if (data.curp) qualityIssues.push({field:'curp',code:'CURP_VALIDATION_PENDING',severity:'warning'});
    return { ...data, contractVersion:VERSION,revision,updatedAt,provenance:revision ? 'captured':'legacy_unresolved', qualityIssues,
        ...(data.curp ? {curp:{...data.curp,validationStatus:'unchecked'},curpSex:null}:{}), catalogValidation:'unverified' };
}
module.exports = { VERSION,names,enums,refs,residenceRefs,fields,validate,reference,date,today,snake,legacy,view,fail };
