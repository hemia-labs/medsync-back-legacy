'use strict';
// NC4/L2: DDL de catálogos SIS. Acordado con Codex (contrato NC1 v1.1, CR-5/CR-6). Solo se aplica en QA aislada
// hasta la aceptación bilateral del SHA; no se ejecuta al importar este módulo.
// Orden: 1. nc4-catalogs (este archivo)  2. nc1-identity (Codex, sin FK)  3. nc1-identity-catalog-fk (Codex).
// L2-R1: un release solo cambia su estado; nada se borra; entradas y relaciones solo se cargan en staged;
//        verificar exige que los conteos coincidan con lo cargado; verified_at, una vez fijado, no cambia.
const { LIMITS } = require('../../src/domain/sisCatalog/catalogRef');

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
            IF OLD.verified_at IS NOT NULL AND NOT (OLD.verified_at <=> NEW.verified_at) THEN
                ${signal('verified_at no cambia una vez fijado')};
            END IF;
            IF OLD.status = 'staged' AND NEW.status = 'retired' AND NEW.verified_at IS NOT NULL THEN
                ${signal('Un release descartado no tiene verified_at')};
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

async function verifyTable(conn, table) {
    const [cols] = await conn.query(
        `SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS len, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS coll
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
    const names = cols.map(c => c.name);
    if (names.join(',') !== COLUMNS[table].join(',')) throw incompatible(`${table}: columnas ${names.join(',')} no coinciden con las esperadas.`);
    for (const [name, len] of Object.entries(REF_COLUMNS[table])) {
        const c = cols.find(x => x.name === name);
        if (Number(c.len) !== len || c.charset !== 'ascii' || c.coll !== 'ascii_bin') throw incompatible(`${table}.${name}: se esperaba VARCHAR(${len}) ascii_bin.`);
    }
}

/**
 * Instalación aditiva y reanudable. Crea lo que falta y aborta si un objeto existente difiere. No borra nada.
 * @param conn conexión mysql2/promise a la base destino (QA aislada hasta la aceptación bilateral)
 */
async function install(conn, { log = () => {} } = {}) {
    for (const [table, ddl] of tables) {
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
        if (Number(n) === 0) { await conn.query(ddl); log(`created ${table}`); } else log(`exists ${table}`);
        await verifyTable(conn, table);
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

module.exports = { REF, tables, triggers, triggerSql, COLUMNS, REF_COLUMNS, nc1ForeignKeyExample, install, status: 'agreed-qa-only' };
