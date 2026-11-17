'use strict';
// NC4/L2: DDL de catálogos SIS. Acordado con Codex (contrato NC1 v1.1, CR-5/CR-6). Solo se aplica en QA aislada
// hasta la aceptación bilateral del SHA; no se ejecuta al importar este módulo.
// Orden: 1. nc4-catalogs (este archivo)  2. nc1-identity (Codex, sin FK)  3. nc1-identity-catalog-fk (Codex).
// L2-R1: un release solo cambia su estado; nada se borra; entradas y relaciones solo se cargan en staged;
//        verificar exige que los conteos coincidan con lo cargado; verified_at, una vez fijado, no cambia.
const { createHash } = require('node:crypto');
const { LIMITS } = require('../../src/domain/sisCatalog/catalogRef');
// Estructura contractual esperada (generada con describeTable en MySQL 8.4.13 y revisada; ver contractView).
const SCHEMA_SPEC = require('./nc4-catalogs.schema.json');

const REF = {
    family: `VARCHAR(${LIMITS.family}) CHARACTER SET ascii COLLATE ascii_bin`,
    releaseId: `VARCHAR(${LIMITS.releaseId}) CHARACTER SET ascii COLLATE ascii_bin`,
    code: `VARCHAR(${LIMITS.code}) CHARACTER SET ascii COLLATE ascii_bin`
};
const FAMILY_SQL_RE = "'^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'";
const RELEASE_SQL_RE = "'^[A-Za-z0-9][A-Za-z0-9._-]*$'";
const CODE_SQL_RE = "'^[!-~]+$'";

const tables = [
    ['sis_catalog_release', `CREATE TABLE sis_catalog_release (
        release_id ${REF.releaseId} NOT NULL,
        family ${REF.family} NOT NULL,
        source_catalog_name VARCHAR(250) COLLATE utf8mb4_unicode_ci NOT NULL,
        source_url VARCHAR(1000) COLLATE utf8mb4_unicode_ci NULL,
        source_version VARCHAR(100) COLLATE utf8mb4_unicode_ci NULL,
        downloaded_at DATETIME(3) NOT NULL,
        sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        encoding VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        valid_from DATE NULL,
        valid_to DATE NULL,
        validity_basis VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        provenance VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        verified_at DATETIME(3) NULL,
        column_mapping_json JSON NOT NULL,
        entry_count INT UNSIGNED NOT NULL,
        relation_count INT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        created_by VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
        status_changed_at DATETIME(3) NULL,
        status_changed_by VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
        PRIMARY KEY (release_id),
        UNIQUE KEY ux_sis_release_family_id (family, release_id),
        UNIQUE KEY ux_sis_release_family_sha (family, sha256),
        KEY idx_sis_release_lookup (family, status, valid_from),
        CONSTRAINT chk_sis_release_family CHECK (REGEXP_LIKE(family, ${FAMILY_SQL_RE}, 'c')),
        CONSTRAINT chk_sis_release_id CHECK (REGEXP_LIKE(release_id, ${RELEASE_SQL_RE}, 'c')),
        CONSTRAINT chk_sis_release_hashes CHECK (REGEXP_LIKE(sha256, '^[a-f0-9]{64}$', 'c') AND REGEXP_LIKE(content_sha256, '^[a-f0-9]{64}$', 'c')),
        CONSTRAINT chk_sis_release_provenance CHECK (provenance IN ('official','synthetic')),
        CONSTRAINT chk_sis_release_status CHECK (status IN ('staged','verified','retired')),
        CONSTRAINT chk_sis_release_basis CHECK (validity_basis IN ('official','publication_label','download_date','unknown')),
        CONSTRAINT chk_sis_release_basis_date CHECK ((valid_from IS NULL) = (validity_basis = 'unknown')),
        CONSTRAINT chk_sis_release_window CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to > valid_from)),
        CONSTRAINT chk_sis_release_state CHECK ((status = 'staged' AND verified_at IS NULL) OR (status = 'verified' AND verified_at IS NOT NULL) OR status = 'retired'),
        CONSTRAINT chk_sis_release_verified CHECK (verified_at IS NULL OR (provenance = 'official' AND valid_from IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
    ['sis_catalog_entry', `CREATE TABLE sis_catalog_entry (
        family ${REF.family} NOT NULL,
        release_id ${REF.releaseId} NOT NULL,
        code ${REF.code} NOT NULL,
        label VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL,
        attributes_json JSON NOT NULL,
        is_sentinel TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (family, release_id, code),
        KEY idx_sis_entry_code (family, code),
        CONSTRAINT chk_sis_entry_code CHECK (REGEXP_LIKE(code, ${CODE_SQL_RE}, 'c')),
        CONSTRAINT fk_sis_entry_release FOREIGN KEY (family, release_id)
            REFERENCES sis_catalog_release (family, release_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
    ['sis_catalog_relation', `CREATE TABLE sis_catalog_relation (
        family ${REF.family} NOT NULL,
        release_id ${REF.releaseId} NOT NULL,
        left_family ${REF.family} NOT NULL,
        left_code ${REF.code} NOT NULL,
        right_code ${REF.code} NOT NULL,
        PRIMARY KEY (family, release_id, left_code, right_code),
        CONSTRAINT chk_sis_relation_codes CHECK (REGEXP_LIKE(left_code, ${CODE_SQL_RE}, 'c') AND REGEXP_LIKE(left_family, ${FAMILY_SQL_RE}, 'c')),
        CONSTRAINT fk_sis_relation_entry FOREIGN KEY (family, release_id, right_code)
            REFERENCES sis_catalog_entry (family, release_id, code) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`]
];

const COLUMNS = Object.freeze({
    sis_catalog_release: ['release_id', 'family', 'source_catalog_name', 'source_url', 'source_version', 'downloaded_at', 'sha256', 'content_sha256',
        'encoding', 'valid_from', 'valid_to', 'validity_basis', 'provenance', 'status', 'verified_at', 'column_mapping_json', 'entry_count',
        'relation_count', 'created_at', 'created_by', 'status_changed_at', 'status_changed_by'],
    sis_catalog_entry: ['family', 'release_id', 'code', 'label', 'attributes_json', 'is_sentinel'],
    sis_catalog_relation: ['family', 'release_id', 'left_family', 'left_code', 'right_code']
});
// Columnas que forman CatalogRef: deben coincidir byte a byte con las columnas de NC1 (CR-5).
const REF_COLUMNS = Object.freeze({
    sis_catalog_release: { family: LIMITS.family, release_id: LIMITS.releaseId },
    sis_catalog_entry: { family: LIMITS.family, release_id: LIMITS.releaseId, code: LIMITS.code },
    sis_catalog_relation: { family: LIMITS.family, release_id: LIMITS.releaseId, left_family: LIMITS.family, left_code: LIMITS.code, right_code: LIMITS.code }
});

const signal = message => `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`;
const parentStaged = (table) => `BEGIN
            DECLARE parent_status VARCHAR(10) DEFAULT NULL;
            SELECT status INTO parent_status FROM sis_catalog_release WHERE family = NEW.family AND release_id = NEW.release_id;
            IF parent_status IS NULL OR parent_status <> 'staged' THEN
                ${signal(`${table}: solo se carga en un release staged`)};
            END IF;
        END`;

const triggers = [
    { name: 'trg_sis_release_insert', timing: 'BEFORE', event: 'INSERT', table: 'sis_catalog_release', body: `BEGIN
            IF NEW.status <> 'staged' OR NEW.verified_at IS NOT NULL THEN
                ${signal('Un release nace staged y sin verified_at')};
            END IF;
        END` },
    { name: 'trg_sis_release_update', timing: 'BEFORE', event: 'UPDATE', table: 'sis_catalog_release', body: `BEGIN
            DECLARE loaded_entries INT UNSIGNED DEFAULT 0;
            DECLARE loaded_relations INT UNSIGNED DEFAULT 0;
            IF NOT (OLD.release_id <=> NEW.release_id AND OLD.family <=> NEW.family
                AND OLD.source_catalog_name <=> NEW.source_catalog_name AND OLD.source_url <=> NEW.source_url
                AND OLD.source_version <=> NEW.source_version AND OLD.downloaded_at <=> NEW.downloaded_at
                AND OLD.sha256 <=> NEW.sha256 AND OLD.content_sha256 <=> NEW.content_sha256 AND OLD.encoding <=> NEW.encoding
                AND OLD.valid_from <=> NEW.valid_from AND OLD.valid_to <=> NEW.valid_to AND OLD.validity_basis <=> NEW.validity_basis
                AND OLD.provenance <=> NEW.provenance AND OLD.column_mapping_json <=> NEW.column_mapping_json
                AND OLD.entry_count <=> NEW.entry_count AND OLD.relation_count <=> NEW.relation_count
                AND OLD.created_at <=> NEW.created_at AND OLD.created_by <=> NEW.created_by) THEN
                ${signal('Solo cambia el estado de un release')};
            END IF;
            IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'staged' AND NEW.status IN ('verified','retired'))
                OR (OLD.status = 'verified' AND NEW.status = 'retired')) THEN
                ${signal('Transicion de estado no permitida')};
            END IF;
            IF OLD.status = 'staged' AND NEW.status = 'verified' THEN
                IF OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL THEN
                    ${signal('verified_at se fija solo al verificar')};
                END IF;
            ELSEIF NOT (OLD.verified_at <=> NEW.verified_at) THEN
                ${signal('verified_at solo cambia de staged a verified')};
            END IF;
            IF OLD.status = 'staged' AND NEW.status = 'verified' THEN
                SELECT COUNT(*) INTO loaded_entries FROM sis_catalog_entry WHERE family = NEW.family AND release_id = NEW.release_id;
                SELECT COUNT(*) INTO loaded_relations FROM sis_catalog_relation WHERE family = NEW.family AND release_id = NEW.release_id;
                IF loaded_entries <> NEW.entry_count OR loaded_relations <> NEW.relation_count THEN
                    ${signal('Los conteos cargados no coinciden con el manifiesto')};
                END IF;
            END IF;
        END` },
    { name: 'trg_sis_release_delete', timing: 'BEFORE', event: 'DELETE', table: 'sis_catalog_release', body: `BEGIN
            ${signal('Un release no se borra; se retira')};
        END` },
    { name: 'trg_sis_entry_insert', timing: 'BEFORE', event: 'INSERT', table: 'sis_catalog_entry', body: parentStaged('sis_catalog_entry') },
    { name: 'trg_sis_entry_update', timing: 'BEFORE', event: 'UPDATE', table: 'sis_catalog_entry', body: `BEGIN
            ${signal('sis_catalog_entry es inmutable')};
        END` },
    { name: 'trg_sis_entry_delete', timing: 'BEFORE', event: 'DELETE', table: 'sis_catalog_entry', body: `BEGIN
            ${signal('sis_catalog_entry es inmutable')};
        END` },
    { name: 'trg_sis_relation_insert', timing: 'BEFORE', event: 'INSERT', table: 'sis_catalog_relation', body: parentStaged('sis_catalog_relation') },
    { name: 'trg_sis_relation_update', timing: 'BEFORE', event: 'UPDATE', table: 'sis_catalog_relation', body: `BEGIN
            ${signal('sis_catalog_relation es inmutable')};
        END` },
    { name: 'trg_sis_relation_delete', timing: 'BEFORE', event: 'DELETE', table: 'sis_catalog_relation', body: `BEGIN
            ${signal('sis_catalog_relation es inmutable')};
        END` }
];
const triggerSql = t => `CREATE TRIGGER ${t.name} ${t.timing} ${t.event} ON ${t.table} FOR EACH ROW ${t.body}`;

// Ejemplo para NC1 (lo implementa Codex en su migración 3). MATCH SIMPLE: una candidata con release_id NULL no se valida
// por FK; el CHECK de forma de Codex debe rechazar los nulos parciales (familia sin código, código sin familia).
const nc1ForeignKeyExample = `ALTER TABLE care_establishment
    ADD CONSTRAINT chk_care_establishment_clues_family CHECK (clues_family IS NULL OR clues_family = 'sis.establishments'),
    ADD CONSTRAINT fk_care_establishment_clues FOREIGN KEY (clues_family, clues_release_id, clues_code)
        REFERENCES sis_catalog_entry (family, release_id, code) ON DELETE RESTRICT ON UPDATE RESTRICT`;

const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();
const incompatible = message => Object.assign(new Error(message), { code: 'CATALOG_DDL_INCOMPATIBLE' });
const sha = text => createHash('sha256').update(text).digest('hex');

// L2-R8: registro de lo que instaló este módulo. Una tabla existente sin registro, o cuya estructura cambió
// desde que se registró, se rechaza: el instalador nunca adopta ni repara en silencio.
const SCHEMA_LOG = `CREATE TABLE IF NOT EXISTS sis_catalog_schema_log (
        object_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        definition_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        structure_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (object_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/**
 * Estructura completa de una tabla según information_schema: motor, colación, columnas (tipo, nulabilidad,
 * charset, colación, default, extra), índices, FK con sus reglas y CHECK con su cláusula y si está forzado.
 */
async function describeTable(conn, table) {
    const p = [table];
    const [[t]] = await conn.query('SELECT ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', p);
    const [columns] = await conn.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation, COLUMN_DEFAULT AS dflt, EXTRA AS extra FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, p);
    const [stats] = await conn.query(`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, p);
    const [fks] = await conn.query(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol,
        r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, p);
    const [checks] = await conn.query(`SELECT c.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS clause, t.ENFORCED AS enforced FROM information_schema.CHECK_CONSTRAINTS c
        JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND t.CONSTRAINT_TYPE = 'CHECK'
        WHERE c.CONSTRAINT_SCHEMA = DATABASE() AND t.TABLE_NAME = ? ORDER BY c.CONSTRAINT_NAME`, p);
    const indexes = {}, foreignKeys = {}, checkMap = {};
    for (const s of stats) { indexes[s.name] = indexes[s.name] || { unique: Number(s.nonUnique) === 0, columns: [] }; indexes[s.name].columns.push(s.col); }
    for (const f of fks) {
        foreignKeys[f.name] = foreignKeys[f.name] || { refTable: f.refTable, onUpdate: f.onUpdate, onDelete: f.onDelete, columns: [], refColumns: [] };
        foreignKeys[f.name].columns.push(f.col); foreignKeys[f.name].refColumns.push(f.refCol);
    }
    for (const c of checks) checkMap[c.name] = { clause: c.clause, enforced: c.enforced };
    return {
        engine: t.engine, collation: t.collation,
        columns: columns.map(c => [c.name, c.type, c.nullable, c.charset, c.collation, c.dflt === null ? null : String(c.dflt), c.extra]),
        indexes, foreignKeys, checks: checkMap
    };
}

// Contrato estático: todo salvo el texto de las cláusulas CHECK, que el servidor reescribe según la versión.
const contractView = d => ({ ...d, checks: Object.fromEntries(Object.entries(d.checks).map(([name, c]) => [name, { enforced: c.enforced }])) });

function diff(expected, actual, path = '') {
    if (JSON.stringify(expected) === JSON.stringify(actual)) return null;
    if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected)) {
        for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
            const d = diff(expected[key], actual[key], path ? `${path}.${key}` : key);
            if (d) return d;
        }
    }
    return `${path || 'raíz'}: se esperaba ${JSON.stringify(expected)} y hay ${JSON.stringify(actual)}`;
}

async function verifyTable(conn, table, recorded) {
    const actual = await describeTable(conn, table);
    const problem = diff(SCHEMA_SPEC[table], contractView(actual));
    if (problem) throw incompatible(`${table} no cumple el contrato: ${problem}`);
    const structure = sha(JSON.stringify(actual));
    if (recorded && recorded.structure_sha !== structure) throw incompatible(`${table} cambió desde su instalación (estructura o cláusulas CHECK).`);
    return structure;
}

/**
 * Instalación aditiva y reanudable. Crea lo que falta, registra su estructura y aborta si un objeto existente
 * no tiene registro o difiere del contrato o de lo registrado. No borra ni repara nada.
 * @param conn conexión mysql2/promise a la base destino (QA aislada hasta la aceptación bilateral)
 */
async function install(conn, { log = () => {} } = {}) {
    await conn.query(SCHEMA_LOG);
    for (const [table, ddl] of tables) {
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
        const [records] = await conn.query('SELECT definition_sha, structure_sha FROM sis_catalog_schema_log WHERE object_name = ?', [table]);
        const recorded = records[0];
        if (Number(n) === 0) {
            if (recorded) throw incompatible(`${table} figura como instalada pero no existe.`);
            await conn.query(ddl);
            const structure = await verifyTable(conn, table, null);
            await conn.query('INSERT INTO sis_catalog_schema_log (object_name, definition_sha, structure_sha) VALUES (?,?,?)', [table, sha(normalize(ddl)), structure]);
            log(`created ${table}`);
            continue;
        }
        if (!recorded) throw incompatible(`${table} existe sin registro de instalación; requiere conciliación manual.`);
        if (recorded.definition_sha !== sha(normalize(ddl))) throw incompatible(`${table} se instaló con otra versión del DDL.`);
        await verifyTable(conn, table, recorded);
        log(`exists ${table}`);
    }
    for (const t of triggers) {
        const [rows] = await conn.query(
            `SELECT EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS body
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`, [t.name]);
        if (!rows.length) { await conn.query(triggerSql(t)); log(`created ${t.name}`); continue; }
        const r = rows[0];
        if (r.tbl !== t.table || r.timing !== t.timing || r.event !== t.event || normalize(r.body) !== normalize(t.body)) {
            throw incompatible(`El trigger ${t.name} existe con otra definición.`);
        }
        log(`exists ${t.name}`);
    }
}

module.exports = {
    REF, tables, triggers, triggerSql, COLUMNS, REF_COLUMNS, SCHEMA_SPEC, nc1ForeignKeyExample,
    install, describeTable, contractView, status: 'agreed-qa-only'
};
