const { QueryTypes } = require('sequelize');
const { v4: uuid } = require('uuid');
const { createHash } = require('node:crypto');
const { RegistrationError } = require('../../services/registration/errors');
const { AccountLegalService } = require('../../services/registration/accountLegal.service');
const sequelize = require('../../db/Sequelize.connection');
const { DOCUMENT_SCOPES, isDocumentKey, validateDraft, validatePublish, validateAcceptance, meaningfulDocumentContent } = require('../../validators/saasLegal.validator');

const eq = (column, parameter) => `${column} COLLATE utf8mb4_unicode_ci = ${parameter} COLLATE utf8mb4_unicode_ci`;
const ok = (data, message = 'Consulta completada.') => ({ status: 200, success: true, data, message });
const fail = (status, code, message, data = null) => ({ status, success: false, code, data, message });
const badFields = errors => fail(400, 'LEGAL_VALIDATION_FAILED', 'Revisa los campos señalados.', { fieldErrors: errors });
const unavailable = () => fail(500, 'LEGAL_SERVICE_UNAVAILABLE', 'No se pudo consultar o guardar la información legal. Tus cambios no se confirmaron; reintenta.');
const iso = value => {
    if(!value) return null;
    const raw = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const asBoolean = value => value === true || Number(value) === 1;
const usesCentralPolicy = key => key === 'terms_conditions' || key === 'privacy_notice';
const localLicenseKey = 'license_agreement';
const centralRequired = () => fail(409, 'LEGAL_CENTRAL_REQUIRED', 'Los términos y el aviso de privacidad se administran en Hemia Legal.');
const versionDto = row => row ? ({ id_version: row.id_version, version_number: Number(row.version_number), title: row.title,
    description: row.description || '', content_html: row.content_html, content_hash: row.content_hash,
    acceptance_scope: row.acceptance_scope, required: asBoolean(row.required), published_at: iso(row.published_at) }) : null;
const acceptanceDto = row => row ? ({ id_acceptance: row.id_acceptance, id_version: row.id_version, id_business: row.id_business,
    acceptance_scope: row.acceptance_scope, accepted_at: iso(row.accepted_at), accepted_by_id: row.accepted_by_id,
    accepted_by_name: row.accepted_by_name, content_hash: row.content_hash }) : null;
const legalHash = (key, data) => createHash('sha256').update(JSON.stringify({ document_key: key, title: data.title,
    description: data.description || '', content_html: data.content_html, acceptance_scope: DOCUMENT_SCOPES[key], required: Boolean(data.required) })).digest('hex');

class SaasLegalDao {
    constructor(database = sequelize, central) { this.db = database; this.central = central || new AccountLegalService(database); }
    query(sql, replacements = {}, transaction = null, type = QueryTypes.SELECT) { return this.db.query(sql, { replacements, transaction, type }); }
    async actor(context, transaction = null, lock = false, superAdmin = false) {
        if(!context || !context.id_login || (!superAdmin && (!context.id_business || context.rol === 'super_admin'))) return null;
        const rows = await this.query(`SELECT l.id_login,l.id_business,l.name,r.code AS role FROM login l
            INNER JOIN rol r ON ${eq('r.id_rol', 'l.id_rol')} AND r.active=1
            WHERE ${eq('l.id_login', ':actor')} AND l.active=1
              ${superAdmin ? '' : 'AND ' + eq('l.id_business', ':business')}
            LIMIT 1${lock ? ' FOR UPDATE' : ''}`, { actor: context.id_login, business: context.id_business || null }, transaction);
        const actor = rows[0];
        if(!actor || (superAdmin && actor.role !== 'super_admin') || (!superAdmin && actor.role === 'super_admin')) return null;
        return { ...actor, id_session: context.id_session };
    }
    async head(key, transaction = null, lock = false) {
        return (await this.query(`SELECT * FROM saas_legal_documents WHERE document_key=:key LIMIT 1${lock ? ' FOR UPDATE' : ''}`, { key }, transaction))[0] || null;
    }
    async versions(idDocument, transaction = null) {
        return this.query('SELECT * FROM saas_legal_versions WHERE id_document=:document ORDER BY version_number DESC', { document: idDocument }, transaction);
    }
    async adminDocument(key, transaction = null) {
        const row = await this.head(key, transaction);
        if(!row) return null;
        const versions = await this.versions(row.id_document, transaction);
        const current = versions.find(version => version.id_version === row.current_version_id);
        return { id_document: row.id_document, document_key: row.document_key,
            draft: { title: row.draft_title, description: row.draft_description || '', content_html: row.draft_content_html || '',
                required: asBoolean(row.draft_required), acceptance_scope: DOCUMENT_SCOPES[key], revision: Number(row.draft_revision) },
            current_version: versionDto(current), versions: versions.map(version => {
                const dto = versionDto(version); delete dto.content_html; return dto;
            }) };
    }
    async transaction(run) {
        let transaction;
        try {
            transaction = await this.db.transaction();
            const result = await run(transaction);
            if(result.success) await transaction.commit(); else await transaction.rollback();
            return result;
        } catch(_) {
            if(transaction && !transaction.finished) { try { await transaction.rollback(); } catch(_) { /* Preserve safe response. */ } }
            return unavailable();
        }
    }
    async publicDocument(key) {
        if(!usesCentralPolicy(key)) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'Este documento legal no está publicado.');
        try {
            if(this.central.configured()) {
                const document = await this.central.publicCurrent(key);
                return document ? ok({ document }) : fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'Este documento legal no está publicado.');
            }
            const head = await this.head(key);
            if(!head || !head.current_version_id) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'Este documento legal no está publicado.');
            const current = (await this.versions(head.id_document)).find(version => version.id_version === head.current_version_id);
            if(!current) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'Este documento legal no está publicado.');
            return ok({ document: { id_document: head.id_document, document_key: key, title: current.title,
                description: current.description || '', current_version: versionDto(current) } });
        } catch(_) { return fail(503, 'LEGAL_SERVICE_UNAVAILABLE', 'No se pudo consultar el documento publicado. Reintenta.'); }
    }
    async notice(context) {
        try {
            const actor = await this.actor(context);
            if(!actor) return fail(403, 'LEGAL_CONTEXT_FORBIDDEN', 'No hay una cuenta activa en el consultorio.');
            const centralConfigured = this.central.configured();
            const local = await this.query(`SELECT d.document_key,v.required FROM saas_legal_documents d
                INNER JOIN saas_legal_versions v ON v.id_version=d.current_version_id AND v.id_document=d.id_document
                WHERE d.document_key=:key AND NOT EXISTS (
                    SELECT 1 FROM saas_legal_acceptances a WHERE a.id_version=v.id_version
                    AND ${eq('a.id_business', ':business')}
                    AND a.subject_key='business'
                )`, { key: localLicenseKey, business: actor.id_business });
            const syncPending = centralConfigured && await this.central.syncPending(actor);
            let centralCount = 0, pendingUnknown = false;
            if(centralConfigured) {
                try {
                    const pending = await this.central.pending(actor);
                    if(!syncPending) centralCount = pending.pendingDocuments.length;
                } catch(_) { pendingUnknown = true; }
            }
            return ok({ pending_count: local.filter(row => asBoolean(row.required)).length + centralCount,
                business_pending: local.length > 0,
                central_sync_pending: syncPending, pending_unknown: pendingUnknown });
        } catch(_) { return unavailable(); }
    }
    async current(context) {
        try {
            const actor = await this.actor(context);
            if(!actor) return fail(403, 'LEGAL_CONTEXT_FORBIDDEN', 'No hay una cuenta activa en el consultorio para consultar estos documentos.');
            const centralConfigured = this.central.configured();
            const syncPending = centralConfigured && await this.central.syncPending(actor);
            const documents = [];
            const head = await this.head(localLicenseKey);
            if(head) {
                // Resolve the captured version even if publication advances the head.
                const [current] = head.current_version_id ? await this.query(`SELECT v.* FROM saas_legal_versions v
                    WHERE v.id_version=:version AND v.id_document=:document`, { version: head.current_version_id, document: head.id_document }) : [];
                const [acceptance] = current ? await this.query(`SELECT * FROM saas_legal_acceptances WHERE id_version=:version
                    AND ${eq('id_business', ':business')} AND subject_key=:subject`,
                { version: current.id_version, business: actor.id_business, subject: 'business' }) : [];
                documents.push({ id_document: head.id_document, document_key: localLicenseKey, title: current ? current.title : head.draft_title,
                    description: current ? current.description || '' : '', acceptance_scope: 'business', required: current ? asBoolean(current.required) : false,
                    current_version: versionDto(current), accepted: acceptanceDto(acceptance),
                    can_accept: Boolean(current && !acceptance && ['admin', 'business_admin'].includes(actor.role)),
                    pending: Boolean(current && !acceptance) });
            }
            let centralAvailable = true;
            if(centralConfigured) {
                try { documents.push(...(await this.central.current(actor)).map(doc => syncPending
                    ? {...doc, pending:false, sync_pending:true} : doc)); }
                catch(_) { centralAvailable = false; }
            }
            return ok({ documents, pending_count: documents.filter(document => document.required && document.pending).length,
                central_available: centralAvailable, central_sync_pending: syncPending,
                pending_unknown: !centralAvailable });
        } catch(_) { return unavailable(); }
    }
    async history(context, cursor) {
        try {
            const actor = await this.actor(context);
            if(!actor) return fail(403, 'LEGAL_CONTEXT_FORBIDDEN', 'No hay una cuenta activa en el consultorio para consultar las aceptaciones.');
            const centralConfigured = this.central.configured();
            const syncPending = centralConfigured && await this.central.syncPending(actor);
            const rows = cursor ? [] : await this.query(`SELECT a.*,v.id_document,v.version_number,v.title,v.description,v.content_html,v.required,
                    v.published_at,d.document_key FROM saas_legal_acceptances a
                INNER JOIN saas_legal_versions v ON v.id_version=a.id_version
                INNER JOIN saas_legal_documents d ON d.id_document=v.id_document
                WHERE ${eq('a.id_business', ':business')} AND (a.subject_key=:subject OR a.subject_key='business')
                ORDER BY a.accepted_at DESC,a.id_acceptance`, { business: context.id_business, subject: 'user:' + actor.id_login });
            const acceptances = rows.map(row => ({ ...acceptanceDto(row), id_document: row.id_document, document_key: row.document_key,
                title: row.title, version_number: Number(row.version_number), version: versionDto(row), source: 'local' }));
            let centralAvailable = true, nextCursor = null;
            if(centralConfigured) {
                try {
                    const history = await this.central.history(actor, cursor);
                    for(const item of history.items) for(const doc of item.documents)
                        acceptances.push({...this.central.receipt(item, doc, actor), history_cursor: cursor || null});
                    nextCursor = history.nextCursor;
                } catch(_) { centralAvailable = false; }
            }
            acceptances.sort((a,b) => Date.parse(b.accepted_at) - Date.parse(a.accepted_at));
            return ok({ acceptances, central_available: centralAvailable, central_next_cursor: nextCursor,
                central_sync_pending: syncPending });
        } catch(_) { return unavailable(); }
    }
    async centralDocument(context, versionId, cursor) {
        try {
            const actor = await this.actor(context);
            if(!actor) return fail(403, 'LEGAL_CONTEXT_FORBIDDEN', 'No hay una cuenta activa en el consultorio.');
            if(!this.central.configured()) return fail(503, 'LEGAL_SERVICE_UNAVAILABLE', 'Legal central no está configurado.');
            return ok({version: await this.central.document(actor, versionId, cursor)});
        } catch(_) { return fail(503, 'LEGAL_SERVICE_UNAVAILABLE', 'No se pudo consultar esta versión en Legal central. El comprobante se conserva.'); }
    }
    async centralContext(context) {
        try {
            const actor=await this.actor(context);
            if(!actor)return fail(403,'LEGAL_CONTEXT_FORBIDDEN','No hay una cuenta activa en el consultorio.');
            if(!this.central.configured())return fail(503,'LEGAL_SERVICE_UNAVAILABLE','Legal central no está configurado.');
            if(await this.central.syncPending(actor))return fail(409,'LEGAL_SYNC_PENDING','Tus confirmaciones ya están pendientes de sincronizar. Actualiza los documentos.');
            return ok(await this.central.review(actor));
        }catch(error) {
            if(error instanceof RegistrationError)return fail(error.status,error.code,'No se pudo preparar la revisión. Actualiza los documentos y reintenta.');
            return fail(503,'LEGAL_SERVICE_UNAVAILABLE','No se pudo cargar la revisión en Legal central. Reintenta.');
        }
    }
    async acceptCentral(context,source) {
        return this.transaction(async transaction=>{
            try {
                const actor=await this.actor(context,transaction,true);
                if(!actor)return fail(403,'LEGAL_CONTEXT_FORBIDDEN','No hay una cuenta activa en el consultorio.');
                if(!this.central.configured())return fail(503,'LEGAL_SERVICE_UNAVAILABLE','Legal central no está configurado.');
                const data=await this.central.enqueue(actor,source,transaction);
                return {...ok(data,data.queued?'Confirmaciones guardadas. La sincronización está pendiente.':'Legal central ya recibió estas confirmaciones.'),status:data.queued?202:200};
            }catch(error) {
                if(error instanceof RegistrationError)return fail(error.status,error.code,'No se pudieron confirmar los documentos. Actualiza la revisión o reintenta el envío.');
                throw error;
            }
        });
    }
    async accept(context, source) {
        const validation = validateAcceptance(source);
        if (!validation.isValid) return badFields(validation.fieldErrors);
        return this.transaction(transaction => this.acceptInTransaction(context, source, transaction));
    }
    async acceptInTransaction(context, source, transaction) {
        if (!transaction) throw Error('LEGAL_TRANSACTION_REQUIRED');
        const validation = validateAcceptance(source);
        if(!validation.isValid) return badFields(validation.fieldErrors);

        const versions = await this.query('SELECT * FROM saas_legal_versions WHERE id_version=:version LIMIT 1', { version: source.id_version }, transaction);
        const version = versions[0];
        if(!version) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'La versión seleccionada no está publicada.');
        const head = (await this.query('SELECT * FROM saas_legal_documents WHERE id_document=:document LIMIT 1 FOR UPDATE', { document: version.id_document }, transaction))[0];
        if(!head || !isDocumentKey(head.document_key)) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'El documento legal no está disponible.');
        const actor = await this.actor(context, transaction, true);
        if(!actor) return fail(403, 'LEGAL_CONTEXT_FORBIDDEN', 'La cuenta ya no pertenece al consultorio activo.');
        if(usesCentralPolicy(head.document_key)) return centralRequired();
        if(head.current_version_id !== version.id_version) return fail(409, 'LEGAL_VERSION_STALE', 'Este documento tiene una nueva versión. Consúltala antes de aceptar.');
        const scope = DOCUMENT_SCOPES[head.document_key];
        if(scope === 'business' && !['admin', 'business_admin'].includes(actor.role)) return fail(403, 'LEGAL_ADMIN_REQUIRED', 'El contrato del consultorio debe aceptarlo su administrador.');
        const values = { version: version.id_version, business: context.id_business, subject: scope === 'business' ? 'business' : 'user:' + actor.id_login };
        const existing = await this.query(`SELECT * FROM saas_legal_acceptances WHERE id_version=:version
            AND ${eq('id_business', ':business')} AND subject_key=:subject LIMIT 1 FOR UPDATE`, values, transaction);
        if(existing[0]) return ok({ acceptance: acceptanceDto(existing[0]), already_accepted: true }, 'Esta versión ya estaba aceptada.');
        await this.query(`INSERT INTO saas_legal_acceptances (id_acceptance,id_version,id_business,subject_key,acceptance_scope,
                accepted_by_id,accepted_by_name,accepted_at,content_hash)
            VALUES (:id,:version,:business,:subject,:scope,:actor,:name,UTC_TIMESTAMP(6),:hash)`,
        { ...values, id: uuid(), scope, actor: actor.id_login, name: actor.name || 'Usuario del consultorio', hash: version.content_hash }, transaction, QueryTypes.INSERT);
        const acceptance = (await this.query(`SELECT * FROM saas_legal_acceptances WHERE id_version=:version
            AND ${eq('id_business', ':business')} AND subject_key=:subject LIMIT 1`, values, transaction))[0];
        if(!acceptance) throw Error('Acceptance readback unavailable');
        return ok({ acceptance: acceptanceDto(acceptance), already_accepted: false }, 'Aceptación registrada para esta versión.');

    }
    async adminList(context) {
        try {
            if(!await this.actor(context, null, false, true)) return fail(403, 'LEGAL_ADMIN_FORBIDDEN', 'Sólo Super Admin puede administrar estos documentos.');
            const license = await this.adminDocument(localLicenseKey);
            return ok({ documents: license ? [license] : [] });
        } catch(_) { return unavailable(); }
    }
    async saveDraft(context, key, source) {
        const validation = validateDraft(key, source);
        if(!validation.isValid) return badFields(validation.fieldErrors);
        return this.transaction(async transaction => {
            if(!await this.actor(context, transaction, false, true)) return fail(403, 'LEGAL_ADMIN_FORBIDDEN', 'Sólo Super Admin puede editar estos documentos.');
            if(usesCentralPolicy(key)) return centralRequired();
            const head = await this.head(key, transaction, true);
            if(!head) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'El documento legal no está disponible.');
            if(Number(head.draft_revision) !== validation.data.expected_revision) return fail(409, 'LEGAL_DRAFT_CONFLICT', 'El borrador cambió. Vuelve a consultarlo antes de guardar.');
            await this.query(`UPDATE saas_legal_documents SET draft_title=:title,draft_description=:description,
                draft_content_html=:content_html,draft_required=:required,draft_revision=draft_revision+1,
                updated_at=UTC_TIMESTAMP(6),updated_by=:actor WHERE id_document=:document`,
            { ...validation.data, required: validation.data.required ? 1 : 0, actor: context.id_login, document: head.id_document }, transaction, QueryTypes.UPDATE);
            return ok({ document: await this.adminDocument(key, transaction) }, 'Borrador guardado. Aún no está publicado.');
        });
    }
    async publish(context, key, source) {
        if(!isDocumentKey(key)) return badFields({ document_key: 'Selecciona un documento legal disponible.' });
        const revision = validatePublish(source);
        if(!revision.isValid) return badFields(revision.fieldErrors);
        return this.transaction(async transaction => {
            if(!await this.actor(context, transaction, false, true)) return fail(403, 'LEGAL_ADMIN_FORBIDDEN', 'Sólo Super Admin puede publicar estos documentos.');
            if(usesCentralPolicy(key)) return centralRequired();
            const head = await this.head(key, transaction, true);
            if(!head) return fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'El documento legal no está disponible.');
            if(Number(head.draft_revision) !== revision.expected_revision) return fail(409, 'LEGAL_DRAFT_CONFLICT', 'El borrador cambió. Vuelve a consultarlo antes de publicar.');
            const validation = validateDraft(key, { title: head.draft_title, description: head.draft_description,
                content_html: head.draft_content_html, required: asBoolean(head.draft_required), expected_revision: revision.expected_revision });
            if(!validation.isValid) return badFields(validation.fieldErrors);
            if(!meaningfulDocumentContent(validation.data.content_html)) return badFields({ content_html: 'Agrega y revisa el texto legal antes de publicar; el borrador está vacío.' });
            const versions = await this.versions(head.id_document, transaction), hash = legalHash(key, validation.data);
            if(versions.some(version => version.id_version === head.current_version_id && version.content_hash === hash)) return fail(409, 'LEGAL_ALREADY_PUBLISHED', 'El borrador coincide con la versión publicada. No se creó otra versión.');
            const values = { ...validation.data, id: uuid(), document: head.id_document, number: versions.reduce((maximum, version) => Math.max(maximum, Number(version.version_number)), 0) + 1,
                hash, scope: DOCUMENT_SCOPES[key], required: validation.data.required ? 1 : 0, actor: context.id_login };
            await this.query(`INSERT INTO saas_legal_versions (id_version,id_document,version_number,title,description,content_html,
                content_hash,acceptance_scope,required,published_at,published_by)
                VALUES (:id,:document,:number,:title,:description,:content_html,:hash,:scope,:required,UTC_TIMESTAMP(6),:actor)`, values, transaction, QueryTypes.INSERT);
            await this.query(`UPDATE saas_legal_documents SET current_version_id=:id,draft_revision=draft_revision+1,
                updated_at=UTC_TIMESTAMP(6),updated_by=:actor WHERE id_document=:document`, values, transaction, QueryTypes.UPDATE);
            return ok({ document: await this.adminDocument(key, transaction) }, 'Versión publicada. Las aceptaciones anteriores conservan su versión original.');
        });
    }
    async adminVersion(context, key, idVersion) {
        try {
            if(!await this.actor(context, null, false, true)) return fail(403, 'LEGAL_ADMIN_FORBIDDEN', 'Sólo Super Admin puede consultar estas versiones.');
            const head = isDocumentKey(key) && await this.head(key);
            const version = head && (await this.versions(head.id_document)).find(item => item.id_version === idVersion);
            return version ? ok({ version: versionDto(version) }) : fail(404, 'LEGAL_DOCUMENT_NOT_FOUND', 'La versión no pertenece a este documento.');
        } catch(_) { return unavailable(); }
    }
}
module.exports = new SaasLegalDao();
module.exports.SaasLegalDao = SaasLegalDao;
