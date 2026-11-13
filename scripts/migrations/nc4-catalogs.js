'use strict';
// NC4/L2: DDL PROPUESTO para catálogos SIS. NO APLICAR hasta el acuse de Codex en
// docs/normative-compliance/BITACORA.md (longitudes, colación y orden con NC1).
// Importar este módulo no conecta a la DB. Orden propuesto:
//   1. nc4-catalogs (este archivo)  2. nc1-identity (Codex, sin FK a catálogos)  3. nc1-identity-catalog-fk (Codex).
// Las columnas de CatalogRef usan ascii_bin en ambos lados: comparación exacta (ceros, mayúsculas) y FK compatibles.
const { LIMITS } = require('../../src/domain/sisCatalog/catalogRef');

const REF = {
    family: `VARCHAR(${LIMITS.family}) CHARACTER SET ascii COLLATE ascii_bin`,
    releaseId: `VARCHAR(${LIMITS.releaseId}) CHARACTER SET ascii COLLATE ascii_bin`,
    code: `VARCHAR(${LIMITS.code}) CHARACTER SET ascii COLLATE ascii_bin`
};

const tables = [
    ['sis_catalog_release', `CREATE TABLE IF NOT EXISTS sis_catalog_release (
        release_id ${REF.releaseId} NOT NULL,
        family ${REF.family} NOT NULL,
        source_catalog_name VARCHAR(250) COLLATE utf8mb4_unicode_ci NOT NULL,
        source_url VARCHAR(1000) COLLATE utf8mb4_unicode_ci NULL,
        source_version VARCHAR(100) COLLATE utf8mb4_unicode_ci NULL,
        downloaded_at DATETIME(3) NOT NULL,
        sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        encoding VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        valid_from DATE NULL,
        valid_to DATE NULL,
        validity_basis VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        provenance VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        column_mapping_json JSON NOT NULL,
        entry_count INT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        created_by VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
        status_changed_at DATETIME(3) NULL,
        status_changed_by VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
        PRIMARY KEY (release_id),
        UNIQUE KEY ux_sis_release_family_id (family, release_id),
        UNIQUE KEY ux_sis_release_family_sha (family, sha256),
        KEY idx_sis_release_lookup (family, status, valid_from),
        CONSTRAINT chk_sis_release_provenance CHECK (provenance IN ('official','synthetic')),
        CONSTRAINT chk_sis_release_status CHECK (status IN ('staged','verified','retired')),
        CONSTRAINT chk_sis_release_basis CHECK (validity_basis IN ('official','publication_label','download_date','unknown')),
        CONSTRAINT chk_sis_release_window CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
        CONSTRAINT chk_sis_release_verified CHECK (status <> 'verified' OR (provenance = 'official' AND valid_from IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
    ['sis_catalog_entry', `CREATE TABLE IF NOT EXISTS sis_catalog_entry (
        family ${REF.family} NOT NULL,
        release_id ${REF.releaseId} NOT NULL,
        code ${REF.code} NOT NULL,
        label VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL,
        attributes_json JSON NOT NULL,
        is_sentinel TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (family, release_id, code),
        KEY idx_sis_entry_code (family, code),
        CONSTRAINT fk_sis_entry_release FOREIGN KEY (family, release_id)
            REFERENCES sis_catalog_release (family, release_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
    ['sis_catalog_relation', `CREATE TABLE IF NOT EXISTS sis_catalog_relation (
        family ${REF.family} NOT NULL,
        release_id ${REF.releaseId} NOT NULL,
        left_family ${REF.family} NOT NULL,
        left_code ${REF.code} NOT NULL,
        right_code ${REF.code} NOT NULL,
        PRIMARY KEY (family, release_id, left_code, right_code),
        CONSTRAINT fk_sis_relation_entry FOREIGN KEY (family, release_id, right_code)
            REFERENCES sis_catalog_entry (family, release_id, code) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`]
];

// Inmutabilidad: el contenido de un release y sus entradas no cambia; solo status/status_changed_*.
const triggers = [
    ['trg_sis_entry_no_update', `CREATE TRIGGER trg_sis_entry_no_update BEFORE UPDATE ON sis_catalog_entry FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sis_catalog_entry es inmutable'`],
    ['trg_sis_entry_no_delete', `CREATE TRIGGER trg_sis_entry_no_delete BEFORE DELETE ON sis_catalog_entry FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sis_catalog_entry es inmutable'`],
    ['trg_sis_release_content', `CREATE TRIGGER trg_sis_release_content BEFORE UPDATE ON sis_catalog_release FOR EACH ROW
        BEGIN
            IF NOT (OLD.release_id <=> NEW.release_id AND OLD.family <=> NEW.family AND OLD.sha256 <=> NEW.sha256
                AND OLD.valid_from <=> NEW.valid_from AND OLD.valid_to <=> NEW.valid_to AND OLD.entry_count <=> NEW.entry_count
                AND OLD.provenance <=> NEW.provenance) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Solo cambia el estado de un release';
            END IF;
            IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'staged' AND NEW.status IN ('verified','retired'))
                OR (OLD.status = 'verified' AND NEW.status = 'retired')) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Transicion de estado no permitida';
            END IF;
        END`]
];

// Ejemplo para NC1 (lo implementa Codex en su migración 3). MATCH SIMPLE: una candidata con release_id NULL no se valida por FK.
const nc1ForeignKeyExample = `ALTER TABLE care_establishment
    ADD CONSTRAINT chk_care_establishment_clues_family CHECK (clues_family IS NULL OR clues_family = 'sis.establishments'),
    ADD CONSTRAINT fk_care_establishment_clues FOREIGN KEY (clues_family, clues_release_id, clues_code)
        REFERENCES sis_catalog_entry (family, release_id, code) ON DELETE RESTRICT ON UPDATE RESTRICT`;

module.exports = { REF, tables, triggers, nc1ForeignKeyExample, status: 'proposed-not-applied' };
