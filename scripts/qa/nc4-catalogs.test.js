'use strict';
// NC4/L2: pruebas de catálogos y descriptores. Sin DB ni red.
// Opcional: NC4_CATALOG_DIR=<carpeta con XLSX oficiales descargados> activa las pruebas contra archivos reales.
// El DDL se prueba contra MySQL aislado con scripts/qa/nc4-catalogs.docker.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { classifyRef, LIMITS } = require('../../src/domain/sisCatalog/catalogRef');
const { FAMILIES, contractFamilies, acceptedFamilies, readerAvailable } = require('../../src/domain/sisCatalog/families');
const { buildRelease, sha256 } = require('../../src/domain/sisCatalog/release');
const { CatalogRegistry } = require('../../src/domain/sisCatalog/registry');
const { readXlsx } = require('../../src/domain/sisCatalog/xlsxReader');
const { importXlsxRelease } = require('../../src/domain/sisCatalog/importer');
const { writeStagedRelease, readStagedRelease } = require('../../src/domain/sisCatalog/stagedRelease');
const D = require('../../src/domain/sisDescriptors');
const { validateDiagnosis, ageAt, parseAgeLimit } = require('../../src/domain/sisDescriptors/diagnosisRules');
const migration = require('../migrations/nc4-catalogs');

const CE = 'GIIS-B015-05-04', SB = 'GIIS-B016-05-04';
const VERIFIED_AT = '2026-11-13T12:00:00.000Z';

// ---------- utilidades ----------
function manifest(over = {}) {
    return {
        releaseId: 'rel-test-1', family: 'sis.federal_entity', sourceCatalogName: 'ENTIDAD FEDERATIVA',
        sourceUrl: null, sourceVersion: null, downloadedAt: '2026-11-13T00:00:00Z', sha256: 'a'.repeat(64),
        encoding: 'xlsx/utf-8', validFrom: '2026-01-01', validTo: null, validityBasis: 'publication_label',
        provenance: 'official', status: 'verified', verifiedAt: VERIFIED_AT, columnMapping: {}, ...over
    };
}
const staged = (over = {}) => manifest({ status: 'staged', verifiedAt: null, ...over });
const entity = (codes) => codes.map(code => ({ code, label: 'E' + code, attributes: {} }));
const clock = () => VERIFIED_AT;

function xlsx(sheets) {
    // Escritor ZIP mínimo para generar libros de prueba.
    const files = { 'xl/workbook.xml': `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` };
    sheets.forEach((s, i) => {
        const col = n => String.fromCharCode(65 + n);
        files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${s.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
            const ref = col(c) + (r + 1);
            return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;')}</t></is></c>`;
        }).join('')}</row>`).join('')}</sheetData></worksheet>`;
    });
    const locals = [], centrals = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text, 'utf8'), deflated = zlib.deflateRawSync(data), nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, deflated); centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + deflated.length;
    }
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const sbBook = () => xlsx([
    { name: 'SERVICIOS', rows: [['CATALOG_KEY', 'DESCRIPCION'], [10, 'ODONTOLOGÍA'], [12, 'ODONTOPEDIATRÍA']] },
    { name: 'POR_PERSONAL_SALUD_BUCAL', rows: [['', '', 'TIPO PERSONAL'], ['CATALOG_KEY', 'SERVICIOS_ATENCION', '13-  ODONTOLOGA (O)', '14-  ODONTOLOGA(O) ESPECIALISTA'], [10, 'ODONTOLOGÍA', 'X', ''], [12, 'ODONTOPEDIATRÍA', '', 'X']] }
]);
const sbMeta = (over = {}) => ({ releaseId: 'sb-test', family: 'sis.personnel_service_sb', sourceUrl: null, sourceVersion: null,
    downloadedAt: '2026-11-13T00:00:00Z', validFrom: null, validTo: null, validityBasis: 'unknown', provenance: 'synthetic', ...over });

// ---------- descriptores ----------
test('descriptores: 113 posiciones CE y 81 SB, consecutivas, 56 nombres compartidos', () => {
    assert.equal(D.getProfile(CE).fields.length, 113);
    assert.equal(D.getProfile(SB).fields.length, 81);
    assert.equal(D.header(CE).split('|').length, 113);
    const ce = new Set(D.getProfile(CE).fields.map(f => f.name));
    assert.equal(D.getProfile(SB).fields.filter(f => ce.has(f.name)).length, 56);
    assert.equal(D.getProfile(CE).guideSha256, 'b1a8fd9ce10709e0b4551db0ab24fc32e0feb1f5718a0e038ffff21e7306bc6f');
    assert.equal(D.getProfile(SB).guideSha256, '044a31ed6aaf4f59f469fd1190e19931b507b5600c00db232e6f45b25fae5bae');
});

test('RC1: referidoPor es opcional en Consulta Externa (A104) y obligatorio en Salud Bucal (B74)', () => {
    const ce = D.getField(CE, 'referidoPor'), sb = D.getField(SB, 'referidoPor');
    assert.equal(ce.position, 104);
    assert.equal(ce.required, 'no');
    assert.equal(sb.position, 74);
    assert.equal(sb.required, 'yes');
});

test('R03: primeraVezDiagnostico2/3 y estudiosTeleconsulta difieren por perfil', () => {
    for (const name of ['primeraVezDiagnostico2', 'primeraVezDiagnostico3', 'estudiosTeleconsulta']) {
        assert.equal(D.getField(CE, name).required, 'no', name + ' CE');
        assert.equal(D.getField(SB, name).required, 'yes', name + ' SB');
    }
    assert.equal(D.validateList(CE, 'estudiosTeleconsulta', '3&8').result, 'valid');
    assert.equal(D.validateList(SB, 'estudiosTeleconsulta', '3&8').result, 'invalid');
    assert.equal(D.validateList(SB, 'estudiosTeleconsulta', '3&3').issues[0].code, 'LIST_DUPLICATE');
    assert.equal(D.validateList(SB, 'estudiosTeleconsulta', '-1').result, 'valid');
    assert.equal(D.validateList(SB, 'estudiosTeleconsulta', '1&2&3&4&5&6&7').result, 'valid');
});

test('R06: confidencialidad literal por perfil (nombrePrestador)', () => {
    assert.equal(D.getField(CE, 'nombrePrestador').confidential, true);
    assert.equal(D.getField(SB, 'nombrePrestador').confidential, false);
    assert.equal(D.getField(SB, 'primerApellidoPrestador').confidential, true);
});

test('R07: codigoCIEDiagnostico3 de SB toma longitud 4 de la regla, marcada como tal', () => {
    const f = D.getField(SB, 'codigoCIEDiagnostico3');
    assert.equal(f.maxLength, 4);
    assert.equal(f.lengthSource, 'rule_text');
    assert.equal(f.required, 'conditional');
});

// ---------- CatalogRef y familias ----------
test('CatalogRef: código string exacto, ceros iniciales y forma estricta (CR-1)', () => {
    const a = classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: '01' });
    const b = classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: '1' });
    assert.equal(a.kind, 'ref');
    assert.notEqual(a.value.code, b.value.code);
    assert.equal(classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: 1 }).kind, 'invalid');
    assert.equal(classifyRef({ family: 'sis.federal_entity', releaseId: null, code: '01' }).kind, 'invalid');
    assert.equal(classifyRef({ family: 'sis.federal_entity', code: '01' }).kind, 'candidate');
    assert.equal(classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: '01', label: 'x' }).kind, 'invalid');
    assert.equal(classifyRef({ family: 'SIS.Entity', releaseId: 'r1', code: '01' }).kind, 'invalid');
    assert.equal(classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: 'Ñ1' }).kind, 'invalid');
    assert.equal(classifyRef({ family: 'sis.federal_entity', releaseId: 'r1', code: 'X'.repeat(LIMITS.code + 1) }).kind, 'invalid');
});

test('familias v1.1: diez del contrato, cinco aceptadas sin lector y literal ESTABLECIMIENTO_DE_SALUD_SIS', () => {
    assert.equal(contractFamilies().length, 10);
    assert.deepEqual(acceptedFamilies().sort(), ['inegi.locality', 'inegi.municipality', 'inegi.state', 'renapo.nationality', 'sepomex.postal_code']);
    for (const key of acceptedFamilies()) assert.equal(readerAvailable(key), false, key);
    assert.equal(readerAvailable('sis.establishments'), true);
    assert.equal(FAMILIES['sis.establishments'].sourceCatalogName, 'ESTABLECIMIENTO_DE_SALUD_SIS');
    assert.notEqual(FAMILIES['renapo.nationality'].sourceCatalogName, FAMILIES['sis.country'].sourceCatalogName);
    assert.throws(() => importXlsxRelease(sbBook(), sbMeta({ family: 'renapo.nationality' })), /no tiene lector/);
});

// ---------- releases y registro ----------
test('release ausente → unverified (CATALOG_UNAVAILABLE), nunca valid', () => {
    const reg = new CatalogRegistry();
    const field = D.getField(SB, 'entidadNacimiento');
    const r = reg.validateRef({ family: 'sis.federal_entity', releaseId: 'nope', code: '01' }, { field });
    assert.equal(r.result, 'unverified');
    assert.equal(r.issues[0].code, 'CATALOG_UNAVAILABLE');
    assert.equal(reg.validateRef({ family: 'sis.federal_entity', code: '01' }, { field }).result, 'unverified');
});

test('fixture sintético: no se verifica por ninguna ruta y no valida', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(staged({ releaseId: 'fx-1', provenance: 'synthetic' }), entity(['01'])));
    assert.throws(() => reg.setStatus('fx-1', 'verified'), { code: 'CATALOG_SYNTHETIC_NOT_OFFICIAL' });
    assert.equal(reg.status('fx-1'), 'staged');
    const r = reg.validateRef({ family: 'sis.federal_entity', releaseId: 'fx-1', code: '01' }, { field: D.getField(SB, 'entidadNacimiento') });
    assert.equal(r.result, 'unverified');
    assert.ok(r.issues.some(i => i.code === 'SYNTHETIC_RELEASE'));
});

test('release retirado tras verificarse: resoluble para histórico, unverified para validación nueva', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(manifest({ releaseId: 'old' }), entity(['01'])));
    reg.setStatus('old', 'retired');
    assert.equal(reg.verifiedAt('old'), VERIFIED_AT);
    const ref = { family: 'sis.federal_entity', releaseId: 'old', code: '01' }, field = D.getField(CE, 'entidadNacimiento');
    assert.equal(reg.resolve(ref).status, 'found');
    assert.equal(reg.validateRef(ref, { field }).result, 'unverified');
    assert.equal(reg.validateRef(ref, { field, historical: true }).result, 'valid');
    assert.throws(() => reg.setStatus('old', 'verified'), { code: 'CATALOG_STATUS_TRANSITION' });
});

test('vigencia: la fecha clínica elige el release', () => {
    const reg = new CatalogRegistry();
    reg.add(buildRelease(manifest({ releaseId: 'r2025', validFrom: '2025-01-01' }), entity(['01', '02'])));
    reg.add(buildRelease(manifest({ releaseId: 'r2026', validFrom: '2026-06-01', sha256: 'b'.repeat(64) }), entity(['01'])));
    assert.equal(reg.releaseFor('sis.federal_entity', '2026-05-31').manifest.releaseId, 'r2025');
    assert.equal(reg.releaseFor('sis.federal_entity', '2026-06-01').manifest.releaseId, 'r2026');
    assert.equal(reg.releaseFor('sis.federal_entity', '2024-12-31'), null);
    const field = D.getField(CE, 'entidadNacimiento');
    const r = reg.validateRef({ family: 'sis.federal_entity', releaseId: 'r2025', code: '02' }, { field, clinicalDate: '2026-07-01' });
    assert.equal(r.result, 'unverified');
    assert.equal(r.issues[0].code, 'RELEASE_NOT_EFFECTIVE');
});

test('código inexistente → invalid; centinela 88 no se guarda como dato; familia equivocada → invalid', () => {
    const reg = new CatalogRegistry().add(buildRelease(manifest(), entity(['01', '88'])));
    const field = D.getField(SB, 'entidadNacimiento');
    assert.equal(reg.validateRef({ family: 'sis.federal_entity', releaseId: 'rel-test-1', code: '33' }, { field }).result, 'invalid');
    const sentinel = reg.validateRef({ family: 'sis.federal_entity', releaseId: 'rel-test-1', code: '88' }, { field });
    assert.equal(sentinel.issues[0].code, 'CATALOG_SENTINEL_NOT_STORABLE');
    assert.equal(reg.validateRef({ family: 'sis.federal_entity', releaseId: 'rel-test-1', code: '88' }, { field, allowSentinel: true }).result, 'valid');
    assert.equal(reg.validateRef({ family: 'sis.country', releaseId: 'rel-test-1', code: '01' }, { field }).issues[0].code, 'CATALOG_FAMILY_MISMATCH');
    assert.equal(reg.validateRef({ family: 'sis.federal_entity', releaseId: 'rel-test-1', code: '01' }, { field }).result, 'valid');
});

test('release: códigos duplicados, patrón de familia, atributos y hash del archivo', () => {
    assert.throws(() => buildRelease(manifest(), entity(['01', '01'])), { code: 'CATALOG_CODE_DUPLICATE' });
    assert.throws(() => buildRelease(manifest({ family: 'sis.establishments' }), [{ code: 'abc', label: '' }]), { code: 'CATALOG_CODE_INVALID' });
    assert.throws(() => buildRelease(manifest(), entity(['01']), { sourceBuffer: Buffer.from('otro') }), { code: 'CATALOG_SHA_MISMATCH' });
    assert.throws(() => buildRelease(manifest(), [{ code: '01', attributes: { n: 1 } }]), { code: 'CATALOG_ATTRIBUTE_INVALID' });
    assert.throws(() => buildRelease(manifest({ extra: true }), entity(['01'])), /desconocidos/);
});

// ---------- L2-R2: encapsulación ----------
test('L2-R2: el release no expone colecciones mutables ni referencias compartidas', () => {
    const source = [{ code: '01', label: 'A', attributes: { ABREVIATURA: 'AS' } }];
    const mapping = { attributes: ['ABREVIATURA'] };
    const release = buildRelease(manifest({ columnMapping: mapping }), source);
    const reg = new CatalogRegistry().add(release);
    assert.equal(release.entries, undefined);
    assert.equal(release.pairs instanceof Function, true);
    // Mutar los objetos de entrada después de construir no altera el release.
    source[0].attributes.ABREVIATURA = 'XX';
    source.push({ code: '02', label: 'B' });
    mapping.attributes.push('INYECTADO');
    assert.equal(release.get('01').attributes.ABREVIATURA, 'AS');
    assert.equal(release.has('02'), false);
    assert.deepEqual([...release.manifest.columnMapping.attributes], ['ABREVIATURA']);
    // Las copias devueltas tampoco permiten inyectar contenido.
    const list = release.list();
    list.push({ code: '02' });
    assert.equal(release.entryCount, 1);
    assert.throws(() => { release.get('01').attributes.ABREVIATURA = 'ZZ'; }, TypeError);
    assert.throws(() => { release.manifest.columnMapping.attributes.push('X'); }, TypeError);
    assert.throws(() => { release.get = () => ({ code: '02' }); }, TypeError);
    const ref = { family: 'sis.federal_entity', releaseId: 'rel-test-1', code: '02' };
    assert.equal(reg.resolve(ref).status, 'not_found');
});

test('L2-R2: pares de relación inmutables; allowsPair no cambia por referencias externas', () => {
    const { release } = importXlsxRelease(sbBook(), sbMeta());
    const reg = new CatalogRegistry().add(release);
    const pairs = release.pairs();
    pairs.push({ left: '13', right: '12' });
    assert.throws(() => { pairs[0].left = '23'; }, TypeError);
    assert.equal(reg.allowsPair('sb-test', '13', '12'), false);
    assert.equal(reg.allowsPair('sb-test', '14', '12'), true);
    assert.equal(release.relationCount, 2);
});

// ---------- L2-R3: invariantes en todas las rutas ----------
test('L2-R3: buildRelease y add aplican las mismas guardas que setStatus', () => {
    assert.throws(() => buildRelease(manifest({ validFrom: null, validityBasis: 'unknown' }), entity(['01'])), { code: 'CATALOG_VALIDITY_REQUIRED' });
    assert.throws(() => buildRelease(manifest({ provenance: 'synthetic' }), entity(['01'])), { code: 'CATALOG_SYNTHETIC_NOT_OFFICIAL' });
    assert.throws(() => buildRelease(manifest({ verifiedAt: null }), entity(['01'])), { code: 'CATALOG_STATUS_INVARIANT' });
    assert.throws(() => buildRelease(staged({ verifiedAt: VERIFIED_AT }), entity(['01'])), { code: 'CATALOG_STATUS_INVARIANT' });
    assert.throws(() => buildRelease(manifest({ validityBasis: 'unknown' }), entity(['01'])), /coherentes/);
    // Un objeto con forma de release pero no construido por buildRelease no se registra.
    const real = buildRelease(manifest(), entity(['01']));
    const forged = { ...real, manifest: { ...real.manifest, validFrom: null } };
    assert.throws(() => new CatalogRegistry().add(forged), { code: 'CATALOG_RELEASE_INVALID' });
});

test('L2-R3: staged → verified exige fecha y base conocida; el estado no cambia si falla', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(staged({ releaseId: 'nodate', validFrom: null, validityBasis: 'unknown' }), entity(['01'])));
    assert.throws(() => reg.setStatus('nodate', 'verified'), { code: 'CATALOG_VALIDITY_REQUIRED' });
    assert.equal(reg.status('nodate'), 'staged');
    assert.equal(reg.verifiedAt('nodate'), null);
    reg.add(buildRelease(staged({ releaseId: 'dated', sha256: 'b'.repeat(64) }), entity(['01'])));
    reg.setStatus('dated', 'verified');
    assert.equal(reg.verifiedAt('dated'), VERIFIED_AT);
});

// ---------- L2-R6: ventanas ----------
test('L2-R6: un release descartado (staged → retired) no corta la vigencia del verificado', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(manifest({ releaseId: 'v1', validFrom: '2026-01-01' }), entity(['01'])));
    reg.add(buildRelease(staged({ releaseId: 'discarded', validFrom: '2026-06-01', sha256: 'b'.repeat(64) }), entity(['01'])));
    reg.setStatus('discarded', 'retired');
    assert.equal(reg.verifiedAt('discarded'), null);
    assert.deepEqual(reg.window('v1'), { from: '2026-01-01', to: null });
    assert.equal(reg.releaseFor('sis.federal_entity', '2026-07-01').manifest.releaseId, 'v1');
    const r = reg.validateRef({ family: 'sis.federal_entity', releaseId: 'discarded', code: '01' }, { field: D.getField(CE, 'entidadNacimiento'), historical: true });
    assert.equal(r.result, 'unverified');
    assert.ok(r.issues.some(i => i.code === 'RELEASE_NOT_VERIFIED'));
});

test('L2-R6: dos verificados con la misma fecha de inicio se rechazan sin cambiar el estado', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(manifest({ releaseId: 'a', validFrom: '2026-01-01' }), entity(['01'])));
    assert.throws(() => reg.add(buildRelease(manifest({ releaseId: 'b', validFrom: '2026-01-01', sha256: 'b'.repeat(64) }), entity(['01']))), { code: 'CATALOG_WINDOW_CONFLICT' });
    assert.equal(reg.status('b'), null);
    reg.add(buildRelease(staged({ releaseId: 'c', validFrom: '2026-01-01', sha256: 'c'.repeat(64) }), entity(['01'])));
    assert.throws(() => reg.setStatus('c', 'verified'), { code: 'CATALOG_WINDOW_CONFLICT' });
    assert.equal(reg.status('c'), 'staged');
    assert.equal(reg.verifiedAt('c'), null);
});

test('L2-R6: validTo posterior al inicio del siguiente se rechaza; validTo anterior deja un hueco explícito', () => {
    const reg = new CatalogRegistry({ now: clock });
    reg.add(buildRelease(manifest({ releaseId: 'next', validFrom: '2026-06-01' }), entity(['01'])));
    assert.throws(() => reg.add(buildRelease(manifest({ releaseId: 'long', validFrom: '2026-01-01', validTo: '2026-07-01', sha256: 'b'.repeat(64) }), entity(['01']))), { code: 'CATALOG_WINDOW_OVERLAP' });
    reg.add(buildRelease(manifest({ releaseId: 'short', validFrom: '2026-01-01', validTo: '2026-03-01', sha256: 'c'.repeat(64) }), entity(['01'])));
    assert.deepEqual(reg.window('short'), { from: '2026-01-01', to: '2026-03-01' });
    assert.equal(reg.releaseFor('sis.federal_entity', '2026-04-15'), null);
    assert.equal(reg.releaseFor('sis.federal_entity', '2026-06-01').manifest.releaseId, 'next');
});

// ---------- CLUES ----------
test('CLUES: formato, ausente del release SIS, no operativa, válida y sin release vigente', () => {
    const reg = new CatalogRegistry().add(buildRelease(manifest({ family: 'sis.establishments', releaseId: 'clues-2609', sourceCatalogName: 'ESTABLECIMIENTO_DE_SALUD_SIS' }), [
        { code: 'ASSSA000013', label: 'A', attributes: { en_operacion: '1', tipo_unidad: '1' } },
        { code: 'ASSSA000999', label: 'B', attributes: { en_operacion: '0' } }
    ]));
    assert.equal(reg.resolveClues('ASSSA00001', '2026-11-13').issues[0].code, 'CLUES_FORMAT');
    assert.equal(reg.resolveClues('ASSSA000014', '2026-11-13').issues[0].code, 'CLUES_NOT_IN_SIS_RELEASE');
    assert.equal(reg.resolveClues('ASSSA000999', '2026-11-13').issues[0].code, 'CLUES_NOT_OPERATING');
    const ok = reg.resolveClues(' asssa000013 ', '2026-11-13');
    assert.equal(ok.result, 'valid');
    assert.deepEqual(ok.ref, { family: 'sis.establishments', releaseId: 'clues-2609', code: 'ASSSA000013' });
    assert.equal(reg.resolveClues('ASSSA000013', '2025-12-31').result, 'unverified');
});

// ---------- diagnósticos por posición (R04) ----------
const dx = (attributes) => ({ code: 'X000', attributes: { LETRA: 'A', LSEX: 'NO', LINF: 'NO', LSUP: 'NO', TIPO_PERSONAL_1VEZ_CE: 'NO', TIPO_PERSONAL_SUBSEC_CE: 'NO', VALIDO_SB: 'NO', ...attributes } });
const person = { biologicalSex: '1', birthDate: '1990-05-10', clinicalDate: '2026-11-13' };

test('R04: CE diagnóstico 1 usa 1VEZ o SUBSEC según relacionTemporal; SB usa VALIDO_SB', () => {
    const e = dx({ TIPO_PERSONAL_1VEZ_CE: '2,4', TIPO_PERSONAL_SUBSEC_CE: '4', VALIDO_SB: '13,14' });
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', e, { ...person, personnelType: '2', temporalRelation: '0' }).result, 'valid');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', e, { ...person, personnelType: '2', temporalRelation: '1' }).result, 'invalid');
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico1', e, { ...person, personnelType: '13' }).result, 'valid');
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico1', e, { ...person, personnelType: '23' }).issues[0].column, 'VALIDO_SB');
});

test('R04: LETRA MT/CP en diagnósticos 2 y 3 con reglas distintas por perfil', () => {
    const mt = dx({ LETRA: 'MT' }), cp = dx({ LETRA: 'CP' });
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', mt, { ...person, personnelType: '10' }).result, 'valid');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', mt, { ...person, personnelType: '2' }).result, 'invalid');
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico2', mt, { ...person, personnelType: '13', firstTime: '0' }).issues[0].code, 'DIAGNOSIS_LETTER_FORBIDDEN');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico3', cp, { ...person, personnelType: '4' }).result, 'valid');
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico3', cp, { ...person, personnelType: '13', firstTime: '0' }).result, 'valid');
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico3', cp, { ...person, personnelType: '13', firstTime: '1' }).result, 'invalid');
    // La regla de LETRA no se hereda al diagnóstico 1.
    assert.equal(validateDiagnosis(SB, 'codigoCIEDiagnostico1', dx({ LETRA: 'MT', VALIDO_SB: '13' }), { ...person, personnelType: '13' }).result, 'valid');
});

test('sexo y edad: intersexual omite LSEX; límites en años, meses y días', () => {
    const female = dx({ LSEX: 'MUJER', TIPO_PERSONAL_1VEZ_CE: '2' });
    const ctx = { ...person, personnelType: '2', temporalRelation: '0' };
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', female, ctx).issues[0].code, 'DIAGNOSIS_SEX_RESTRICTION');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', female, { ...ctx, biologicalSex: '3' }).result, 'valid');
    const infant = dx({ LINF: '028D', LSUP: '011M', TIPO_PERSONAL_1VEZ_CE: '2' });
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', infant, { ...ctx, birthDate: '2026-10-16' }).result, 'valid');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', infant, { ...ctx, birthDate: '2026-10-17' }).issues[0].code, 'DIAGNOSIS_AGE_BELOW');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico1', infant, { ...ctx, birthDate: '2025-11-13' }).issues[0].code, 'DIAGNOSIS_AGE_ABOVE');
    assert.deepEqual(ageAt('2024-02-29', '2025-02-28'), { years: 0, months: 11, days: 365, hoursMin: 8760, hoursMax: 8783 });
    assert.throws(() => parseAgeLimit('9A'), { code: 'DIAGNOSIS_AGE_LIMIT_FORMAT' });
});

// ---------- L2-R5: fechas ----------
test('L2-R5: fechas inválidas, imposibles o nacimiento posterior nunca dan valid', () => {
    const limited = dx({ LINF: '001A', LSUP: '120A' });
    const ctx = { ...person, personnelType: '2' };
    for (const birthDate of ['bad', '2025-02-29', '2025-13-01', '1990-5-10', '', undefined]) {
        const r = validateDiagnosis(CE, 'codigoCIEDiagnostico2', limited, { ...ctx, birthDate });
        assert.equal(r.result, 'invalid', String(birthDate));
        assert.equal(r.issues[0].code, 'DIAGNOSIS_DATE_INVALID');
    }
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', limited, { ...ctx, clinicalDate: '2026-02-30' }).issues[0].code, 'DIAGNOSIS_DATE_INVALID');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', limited, { ...ctx, birthDate: '2026-11-14' }).issues[0].code, 'DIAGNOSIS_BIRTH_AFTER_CLINICAL_DATE');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', limited, { ...ctx, biologicalSex: '9' }).issues[0].code, 'DIAGNOSIS_SEX_INVALID');
    assert.throws(() => ageAt('bad', '2026-11-13'), { code: 'AGE_DATE_INVALID' });
});

test('L2-R5: límites en horas con fecha civil dan valid, invalid o unverified, nunca un valid falso', () => {
    const ctx = { ...person, personnelType: '2' };
    // 000H como mínimo: siempre se cumple.
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', dx({ LINF: '000H' }), { ...ctx, birthDate: '2026-11-13' }).result, 'valid');
    // Nacido el mismo día: tiene entre 0 y 23 horas; un mínimo de 006H no puede decidirse.
    const sameDay = validateDiagnosis(CE, 'codigoCIEDiagnostico2', dx({ LINF: '006H' }), { ...ctx, birthDate: '2026-11-13' });
    assert.equal(sameDay.result, 'unverified');
    assert.equal(sameDay.issues[0].code, 'DIAGNOSIS_AGE_HOURS_UNDETERMINED');
    // Un día de edad (24–47 h) sí cumple 006H y viola un máximo de 012H.
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', dx({ LINF: '006H' }), { ...ctx, birthDate: '2026-11-12' }).result, 'valid');
    assert.equal(validateDiagnosis(CE, 'codigoCIEDiagnostico2', dx({ LSUP: '012H' }), { ...ctx, birthDate: '2026-11-12' }).issues[0].code, 'DIAGNOSIS_AGE_ABOVE');
    // Una violación determinada prevalece sobre una indeterminada.
    const both = validateDiagnosis(CE, 'codigoCIEDiagnostico2', dx({ LINF: '006H', LSEX: 'MUJER' }), { ...ctx, birthDate: '2026-11-13' });
    assert.equal(both.result, 'invalid');
});

// ---------- XLSX, importador y staging (L2-R4) ----------
test('XLSX: texto con ceros, número literal e importación staged con relaciones', () => {
    const book = sbBook();
    const read = readXlsx(book);
    assert.deepEqual(read.sheets, ['SERVICIOS', 'POR_PERSONAL_SALUD_BUCAL']);
    assert.deepEqual(read.rows[1].map(c => [c.value, c.type]), [['10', 'n'], ['ODONTOLOGÍA', 'inlineStr']]);
    const { release, issues } = importXlsxRelease(book, sbMeta());
    assert.equal(release.manifest.status, 'staged');
    assert.equal(release.manifest.verifiedAt, null);
    assert.equal(release.manifest.sha256, sha256(book));
    assert.equal(release.manifest.columnMapping.relationLeftFamily, 'sis.personnel_type');
    assert.equal(issues[0].code, 'NUMERIC_CODE_CELLS');
    const reg = new CatalogRegistry().add(release);
    assert.equal(reg.allowsPair('sb-test', '14', '12'), true);
    assert.equal(reg.allowsPair('sb-test', '13', '12'), false);
    assert.equal(reg.allowsPair('missing', '13', '10'), null);
    const entityBook = xlsx([{ name: 'ENTIDAD_FEDERATIVA', rows: [['CATALOG_KEY', 'ENTIDAD_FEDERATIVA', 'ABREVIATURA'], ['00', 'NO ESPECIFICADO', 'NE'], ['01', 'AGUASCALIENTES', 'AS']] }]);
    const ent = importXlsxRelease(entityBook, sbMeta({ releaseId: 'ent-test', family: 'sis.federal_entity' }));
    assert.deepEqual(ent.release.codes(), ['00', '01']);
    assert.equal(ent.release.get('00').sentinel, true);
    assert.throws(() => readXlsx(Buffer.from('no es zip')), { code: 'XLSX_INVALID' });
});

test('L2-R4: staging guarda relaciones y reconstruye el release con los mismos pares y hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc4-stage-'));
    try {
        const { release, issues } = importXlsxRelease(sbBook(), sbMeta());
        const files = writeStagedRelease(dir, release, issues);
        assert.ok(fs.existsSync(files.relations));
        assert.equal(fs.readFileSync(files.relations, 'utf8').trim().split('\n').length, 2);
        const back = readStagedRelease(dir, 'sb-test');
        assert.equal(back.release.contentSha256, release.contentSha256);
        assert.equal(back.release.relationCount, 2);
        assert.deepEqual(back.issues.map(i => i.code), ['NUMERIC_CODE_CELLS']);
        const reg = new CatalogRegistry().add(back.release);
        assert.equal(reg.allowsPair('sb-test', '14', '12'), true);
        assert.equal(reg.allowsPair('sb-test', '13', '12'), false);
        assert.equal(reg.allowsPair('sb-test', '13', '10'), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('L2-R4: staging no sobrescribe un release existente y detecta artefactos alterados', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc4-stage-'));
    try {
        const { release } = importXlsxRelease(sbBook(), sbMeta());
        const files = writeStagedRelease(dir, release);
        const before = fs.readFileSync(files.entries, 'utf8');
        assert.throws(() => writeStagedRelease(dir, release), { code: 'CATALOG_STAGE_EXISTS' });
        assert.equal(fs.readFileSync(files.entries, 'utf8'), before);
        fs.appendFileSync(files.relations, JSON.stringify({ left: '13', right: '12' }) + '\n');
        assert.throws(() => readStagedRelease(dir, 'sb-test'), { code: 'CATALOG_STAGE_CORRUPT' });
        fs.rmSync(files.relations);
        assert.throws(() => readStagedRelease(dir, 'sb-test'), { code: 'CATALOG_STAGE_CORRUPT' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- DDL (estático; la prueba real es nc4-catalogs.docker.sh) ----------
test('DDL: columnas CatalogRef ascii_bin con las longitudes del contrato', () => {
    assert.equal(migration.status, 'agreed-qa-only');
    assert.match(migration.REF.family, new RegExp(`VARCHAR\\(${LIMITS.family}\\) CHARACTER SET ascii COLLATE ascii_bin`));
    assert.match(migration.REF.code, new RegExp(`VARCHAR\\(${LIMITS.code}\\) CHARACTER SET ascii COLLATE ascii_bin`));
    assert.deepEqual(migration.tables.map(([name]) => name), ['sis_catalog_release', 'sis_catalog_entry', 'sis_catalog_relation']);
    assert.match(migration.nc1ForeignKeyExample, /REFERENCES sis_catalog_entry \(family, release_id, code\)/);
});

test('L2-R1 (estático): triggers cubren INSERT/UPDATE/DELETE de las tres tablas y el release compara todo su contenido', () => {
    const covered = new Set(migration.triggers.map(t => `${t.table}:${t.event}`));
    for (const table of ['sis_catalog_release', 'sis_catalog_entry', 'sis_catalog_relation']) {
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) assert.ok(covered.has(`${table}:${event}`), `${table} ${event}`);
    }
    const update = migration.triggers.find(t => t.name === 'trg_sis_release_update').body;
    const mutable = ['status', 'verified_at', 'status_changed_at', 'status_changed_by'];
    for (const column of migration.COLUMNS.sis_catalog_release.filter(c => !mutable.includes(c))) {
        assert.ok(update.includes(`OLD.${column} <=> NEW.${column}`), column);
    }
});

// ---------- archivos oficiales (opcional) ----------
const dir = process.env.NC4_CATALOG_DIR;
const file = name => path.join(dir || '', name);
const official = (name, family, extra = {}) => importXlsxRelease(fs.readFileSync(file(name)), {
    releaseId: family.replace(/\./g, '-') + '-official-test', family, sourceUrl: 'https://gobi.salud.gob.mx/', sourceVersion: null,
    downloadedAt: '2026-11-13T00:00:00Z', validFrom: null, validTo: null, validityBasis: 'unknown', provenance: 'official', ...extra
}).release;

test('oficial: AFILIACION 2026 coincide con los códigos de derechohabiencia de ambas guías', { skip: !dir }, () => {
    assert.deepEqual(official('AFILIACION_2026.xlsx', 'sis.affiliation').list().map(e => e.code).sort((a, b) => a - b),
        ['0', '1', '2', '3', '4', '5', '6', '8', '9', '11', '14', '15', '99']);
});

test('oficial: ENTIDAD FEDERATIVA conserva 00 y marca 00/88/99 como centinelas; abreviatura CURP', { skip: !dir }, () => {
    const r = official('ENTIDAD_FEDERATIVA_201602.xlsx', 'sis.federal_entity');
    assert.equal(r.get('09').attributes.ABREVIATURA, 'DF');
    assert.deepEqual(r.list().filter(e => e.sentinel).map(e => e.code), ['00', '88', '99']);
    assert.equal(r.get('88').attributes.ABREVIATURA, 'NA'); // la CURP de una persona extranjera usa NE: no mapear por abreviatura.
});

test('oficial: TIPO PERSONAL publicado llega a 30; los códigos 31–34 citados por CE 2026 no existen aún', { skip: !dir }, () => {
    const r = official('TIPO_PERSONAL-SIS_2024.xlsx', 'sis.personnel_type');
    assert.equal(r.entryCount, 30);
    for (const code of ['31', '32', '33', '34']) assert.equal(r.has(code), false);
    for (const code of ['12', '13', '14', '23']) assert.equal(r.has(code), true);
});

test('oficial: SIS-SB relaciona odontopediatría solo con el tipo 14 y sobrevive a staging', { skip: !dir }, () => {
    const r = official('SIS-SB.xlsx', 'sis.personnel_service_sb');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc4-stage-'));
    try {
        writeStagedRelease(tmp, r);
        const back = readStagedRelease(tmp, r.manifest.releaseId).release;
        const reg = new CatalogRegistry().add(back);
        assert.equal(back.relationCount, 6);
        assert.equal(reg.allowsPair(back.manifest.releaseId, '14', '12'), true);
        assert.equal(reg.allowsPair(back.manifest.releaseId, '13', '12'), false);
        assert.equal(reg.allowsPair(back.manifest.releaseId, '23', '10'), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('oficial: ESTABLECIMIENTO_DE_SALUD_SIS solo trae unidades en operación; CLUES de 11 caracteres', { skip: !dir }, () => {
    const r = official('ESTABLECIMIENTO_DE_SALUD_SIS_202609.xlsx', 'sis.establishments', { validFrom: '2026-10-27', validityBasis: 'publication_label' });
    assert.equal(r.manifest.sourceCatalogName, 'ESTABLECIMIENTO_DE_SALUD_SIS');
    assert.ok(r.entryCount > 15000);
    assert.ok(r.list().every(e => e.attributes.en_operacion === '1'));
    const reg = new CatalogRegistry().add(r);
    reg.setStatus(r.manifest.releaseId, 'verified');
    assert.equal(reg.resolveClues('ASSSA000013', '2026-11-13').result, 'valid');
});

test('oficial: DIAGNOSTICO_SIS con LETRA MT/CP, VALIDO_SB y límites de edad legibles', { skip: !dir }, () => {
    const r = official('DIAGNOSTICOS_SIS_240424.xlsx', 'sis.diagnosis');
    const all = r.list();
    assert.ok(all.some(e => e.attributes.LETRA === 'MT') && all.some(e => e.attributes.LETRA === 'CP'));
    assert.ok(r.has('R69X'));
    for (const e of all) { parseAgeLimit(e.attributes.LINF); parseAgeLimit(e.attributes.LSUP); }
    assert.deepEqual([...new Set(all.map(e => e.attributes.VALIDO_SB))].sort(), ['12,13,14,23', '14', 'NO']);
});
