-- Additive schema. Three empty drafts only: no legal copy or publication.
CREATE TABLE IF NOT EXISTS saas_legal_documents (
    id_document varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    document_key varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    acceptance_scope enum('user','business') NOT NULL,
    draft_title varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    draft_description varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
    draft_content_html mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
    draft_required tinyint(1) NOT NULL DEFAULT 1,
    draft_revision int unsigned NOT NULL DEFAULT 1,
    current_version_id varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at datetime(6) DEFAULT NULL,
    updated_by varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    PRIMARY KEY (id_document),
    UNIQUE KEY uq_saas_legal_document_key (document_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS saas_legal_versions (
    id_version varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_document varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    version_number int unsigned NOT NULL,
    title varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    description varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
    content_html mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
    content_hash char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    acceptance_scope enum('user','business') NOT NULL,
    required tinyint(1) NOT NULL,
    published_at datetime(6) NOT NULL,
    published_by varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    PRIMARY KEY (id_version),
    UNIQUE KEY uq_saas_legal_document_version (id_document,version_number),
    CONSTRAINT fk_saas_legal_version_document FOREIGN KEY (id_document) REFERENCES saas_legal_documents(id_document)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS saas_legal_acceptances (
    id_acceptance varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_version varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    id_business varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    subject_key varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    acceptance_scope enum('user','business') NOT NULL,
    accepted_by_id varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    accepted_by_name varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
    accepted_at datetime(6) NOT NULL,
    content_hash char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    PRIMARY KEY (id_acceptance),
    UNIQUE KEY uq_saas_legal_version_subject (id_version,id_business,subject_key),
    KEY idx_saas_legal_acceptance_history (id_business,subject_key,accepted_at),
    CONSTRAINT fk_saas_legal_acceptance_version FOREIGN KEY (id_version) REFERENCES saas_legal_versions(id_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO saas_legal_documents (id_document,document_key,acceptance_scope,draft_title,draft_content_html)
VALUES ('SAAS_LEGAL_TERMS','terms_conditions','user','Términos y condiciones',''),
       ('SAAS_LEGAL_PRIVACY','privacy_notice','user','Aviso de privacidad',''),
       ('SAAS_LEGAL_LICENSE','license_agreement','business','Contrato de licencia','');

-- Recreating only these guards is idempotent and never changes stored records.
DROP TRIGGER IF EXISTS saas_legal_versions_no_update;
CREATE TRIGGER saas_legal_versions_no_update BEFORE UPDATE ON saas_legal_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Published SaaS legal versions are immutable';
DROP TRIGGER IF EXISTS saas_legal_versions_no_delete;
CREATE TRIGGER saas_legal_versions_no_delete BEFORE DELETE ON saas_legal_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Published SaaS legal versions are immutable';
DROP TRIGGER IF EXISTS saas_legal_acceptances_no_update;
CREATE TRIGGER saas_legal_acceptances_no_update BEFORE UPDATE ON saas_legal_acceptances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SaaS legal acceptances are immutable';
DROP TRIGGER IF EXISTS saas_legal_acceptances_no_delete;
CREATE TRIGGER saas_legal_acceptances_no_delete BEFORE DELETE ON saas_legal_acceptances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SaaS legal acceptances are immutable';
