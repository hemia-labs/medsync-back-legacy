'use strict';
// NC5 · Chat interno por negocio. Remitente y negocio vienen siempre de la sesión activa.
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const effectivePermissions = require('../../util/effectivePermissions');
const rules = require('../../domain/chat/chatRules');

class ChatError extends Error {
    constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

const select = (sql, replacements, transaction = null) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const PAGE_MAX = 50;

// Colegas que pueden escribir y recibir: activos, no bloqueados, con rol activo y del mismo negocio.
const ELIGIBLE = `FROM login l INNER JOIN rol r ON r.id_rol = l.id_rol AND r.active = 1
    WHERE l.id_business = :business AND l.active = 1 AND COALESCE(l.locked, 0) = 0 AND r.code <> 'super_admin'`;

function personName(row) {
    const name = String(row.name || '').replace(/\s+/g, ' ').trim();
    return name || 'Usuario sin nombre';
}

async function eligiblePeople(business, me) {
    const rows = await select(`SELECT l.id_login AS id, l.name ${ELIGIBLE} AND l.id_login <> :me`, { business, me });
    return rows.map(row => ({ id: row.id, name: personName(row), initials: rules.initials(personName(row)) }));
}

async function eligiblePerson(business, me, id) {
    if (!rules.loginId(id) || id === me) return null;
    const rows = await select(`SELECT l.id_login AS id, l.name ${ELIGIBLE} AND l.id_login = :id AND l.id_login <> :me LIMIT 1`, { business, me, id });
    return rows[0] ? { id: rows[0].id, name: personName(rows[0]) } : null;
}

// Para leer historial basta con que el colega sea (o haya sido) del mismo negocio.
async function businessPerson(business, id) {
    if (!rules.loginId(id)) return null;
    const rows = await select('SELECT id_login AS id, name, active FROM login WHERE id_business = :business AND id_login = :id LIMIT 1', { business, id });
    return rows[0] ? { id: rows[0].id, name: personName(rows[0]), active: Number(rows[0].active) === 1 } : null;
}

async function namesFor(business, ids) {
    if (!ids.length) return new Map();
    const rows = await select('SELECT id_login AS id, name FROM login WHERE id_business = :business AND id_login IN (:ids)', { business, ids });
    return new Map(rows.map(row => [row.id, personName(row)]));
}

async function permissionsOf(login) {
    return (await effectivePermissions.rows(login)).map(row => row.code);
}

function messageView(row, me, viewerPermissions, names) {
    const mine = row.id_sender === me;
    return {
        id: Number(row.id),
        messageId: row.public_id,
        clientRequestId: mine ? row.client_request_id : undefined,
        kind: row.kind,
        mine,
        sender: { id: row.id_sender, name: names.get(row.id_sender) || 'Usuario' },
        recipient: { id: row.id_recipient, name: names.get(row.id_recipient) || 'Usuario' },
        body: row.body || '',
        notice: row.kind === 'team_notice' ? rules.noticeView(row, { isSender: mine, permissions: viewerPermissions }) : null,
        sentAt: row.created_at,
        readAt: row.read_at
    };
}

const MESSAGE_COLUMNS = `id, public_id, id_business, id_sender, id_recipient, client_request_id, kind, body, context_kind, context_ref,
    reason_code, snap_patient_name, snap_patient_code, snap_professional_name, snap_attention_date, created_at, read_at`;

async function byRequest(business, me, requestId, transaction = null) {
    const rows = await select(`SELECT ${MESSAGE_COLUMNS}, payload_hash FROM chat_message
        WHERE id_business = :business AND id_sender = :me AND client_request_id = :requestId LIMIT 1`, { business, me, requestId }, transaction);
    return rows[0] || null;
}

// Inserta una sola vez por (negocio, remitente, clientRequestId). Repetir el mismo contenido devuelve el original.
async function insertOnce(business, me, values) {
    const payloadHash = rules.hash(values.payload);
    const { low, high } = rules.pair(me, values.recipient);
    try {
        await sequelize.query(`INSERT INTO chat_message (public_id, id_business, id_sender, id_recipient, pair_low, pair_high,
            client_request_id, payload_hash, kind, body, context_kind, context_ref, context_patient, reason_code,
            snap_patient_name, snap_patient_code, snap_professional_id, snap_professional_name, snap_attention_date, created_at)
            VALUES (:publicId, :business, :me, :recipient, :low, :high, :requestId, :payloadHash, :kind, :body, :contextKind, :contextRef,
            :contextPatient, :reason, :patientName, :patientCode, :professionalId, :professionalName, :attentionDate, NOW(3))`, {
            replacements: {
                publicId: crypto.randomUUID(), business, me, recipient: values.recipient, low, high, requestId: values.requestId, payloadHash,
                kind: values.kind, body: values.body || null, contextKind: values.contextKind || null, contextRef: values.contextRef || null,
                contextPatient: values.contextPatient || null, reason: values.reason || null, patientName: values.patientName || null,
                patientCode: values.patientCode || null, professionalId: values.professionalId || null,
                professionalName: values.professionalName || null, attentionDate: values.attentionDate || null
            },
            type: QueryTypes.INSERT
        });
        return { row: await byRequest(business, me, values.requestId), replayed: false };
    } catch (error) {
        const duplicate = error && (error.original?.code === 'ER_DUP_ENTRY' || error.parent?.code === 'ER_DUP_ENTRY' || error.name === 'SequelizeUniqueConstraintError');
        if (!duplicate) throw error;
        const existing = await byRequest(business, me, values.requestId);
        if (!existing || existing.payload_hash !== payloadHash) throw new ChatError('CHAT_REQUEST_CONFLICT', 409, 'Ese envío ya se registró con otro contenido.');
        return { row: existing, replayed: true };
    }
}

async function sendResult(business, me, inserted) {
    const names = await namesFor(business, [inserted.row.id_sender, inserted.row.id_recipient]);
    return { ...messageView(inserted.row, me, [], names), replayed: inserted.replayed };
}

const dateOnly = value => (value instanceof Date ? value.toISOString().slice(0, 10) : (value ? String(value).slice(0, 10) : null));
const fullName = row => [row.name, row.surname].map(value => String(value || '').trim()).filter(Boolean).join(' ') || 'Paciente';

// Nota formal firmada de NC5 (tabla de Notas). Solo se leen fecha de atención y firmante, nunca el contenido clínico.
async function signedNote(business, context) {
    if (!rules.loginId(context.noteId)) return null;
    try {
        const rows = await select(`SELECT v.note_id AS ref, v.id_person, p.code, p.name, p.surname,
                JSON_UNQUOTE(JSON_EXTRACT(v.payload, '$.date')) AS attention,
                (SELECT f.signer_name FROM evolution_note_signed_version f WHERE f.id_business = v.id_business AND f.id_person = v.id_person
                    AND f.note_id = v.note_id ORDER BY f.version ASC LIMIT 1) AS signer
            FROM evolution_note_signed_version v INNER JOIN person p ON p.id_person = v.id_person AND p.id_business = :business
            WHERE v.id_business = :business AND v.id_person = :patient AND v.note_id = :note ORDER BY v.version DESC LIMIT 1`,
        { business, patient: context.patientId, note: context.noteId });
        return rows[0] || null;
    } catch (error) {
        const code = error && ((error.original && error.original.code) || (error.parent && error.parent.code));
        if (code === 'ER_NO_SUCH_TABLE') throw new ChatError('CHAT_CONTEXT_UNAVAILABLE', 422, 'Las notas firmadas aún no están disponibles en este entorno.');
        throw error;
    }
}

async function trackedFollowUp(business, context) {
    if (!rules.loginId(context.tracingId)) return null;
    const rows = await select(`SELECT t.id_tracing AS ref, t.quote_date_now AS attention, p.id_person, p.code, p.name, p.surname, NULL AS signer
        FROM tracing t INNER JOIN person p ON p.id_person = t.id_person AND p.id_business = :business
        WHERE t.id_tracing = :tracing AND t.id_person = :patient AND t.id_business = :business AND t.status = 'active' LIMIT 1`,
    { business, tracing: context.tracingId, patient: context.patientId });
    return rows[0] || null;
}

// Valida la referencia que entrega Notas y compone los datos operativos permitidos. Nunca lee el texto clínico.
async function noticeContext(business, me, context, reasonCode) {
    const kind = context && rules.CONTEXT_KINDS.includes(context.kind) ? context.kind : null;
    if (!kind || !rules.loginId(context.patientId)) throw new ChatError('CHAT_CONTEXT_INVALID', 422, 'La referencia de la nota no es válida.');
    const reason = rules.reason(reasonCode);
    if (!reason) throw new ChatError('CHAT_REASON_INVALID', 422, 'Elige el motivo de la cita.');
    if (!(await effectivePermissions.hasPermission(me, 'px.tab.monitoring'))) {
        throw new ChatError('CHAT_CONTEXT_FORBIDDEN', 403, 'No tienes acceso a los seguimientos de este paciente.');
    }
    const found = kind === 'evolution_note' ? await signedNote(business, context) : await trackedFollowUp(business, context);
    if (!found) throw new ChatError('CHAT_CONTEXT_INVALID', 422, kind === 'evolution_note' ? 'La nota no está firmada o no pertenece a este consultorio.' : 'La nota no existe en este consultorio o fue cancelada.');
    let professional = { id: me, name: null };
    if (context.professionalId !== undefined && context.professionalId !== null && context.professionalId !== me) {
        professional = await businessPerson(business, context.professionalId);
        if (!professional || !professional.active) throw new ChatError('CHAT_CONTEXT_INVALID', 422, 'El profesional no pertenece a este consultorio.');
    } else if (found.signer) {
        // Por omisión, el profesional que firmó la nota.
        professional = { id: null, name: String(found.signer) };
    }
    if (!professional.name) professional.name = (await namesFor(business, [me])).get(me);
    return {
        contextKind: kind, contextRef: found.ref, contextPatient: found.id_person, reason,
        patientName: fullName(found), patientCode: found.code || null,
        professionalId: professional.id, professionalName: professional.name, attentionDate: dateOnly(found.attention)
    };
}

class ChatDao {
    async directory(business, me) {
        const [people, activity] = await Promise.all([
            eligiblePeople(business, me),
            select(`SELECT id_recipient AS id, COUNT(*) AS count, MAX(created_at) AS last FROM chat_message
                WHERE id_business = :business AND id_sender = :me GROUP BY id_recipient`, { business, me })
        ]);
        return { items: rules.orderDirectory(people, activity) };
    }

    async summary(business, me) {
        const [unread] = await select(`SELECT COUNT(*) AS unread FROM chat_message
            WHERE id_business = :business AND id_recipient = :me AND read_at IS NULL`, { business, me });
        const [last] = await select(`SELECT GREATEST(
            COALESCE((SELECT MAX(id) FROM chat_message WHERE id_business = :business AND id_sender = :me), 0),
            COALESCE((SELECT MAX(id) FROM chat_message WHERE id_business = :business AND id_recipient = :me), 0)) AS lastId`, { business, me });
        return { unread: Number(unread.unread) || 0, lastId: Number(last.lastId) || 0 };
    }

    async conversations(business, me) {
        const peers = await select(`SELECT peer, MAX(id) AS last_id, SUM(unread) AS unread FROM (
                SELECT id_recipient AS peer, id, 0 AS unread FROM chat_message WHERE id_business = :business AND id_sender = :me
                UNION ALL
                SELECT id_sender AS peer, id, read_at IS NULL AS unread FROM chat_message WHERE id_business = :business AND id_recipient = :me
            ) messages GROUP BY peer ORDER BY last_id DESC LIMIT 100`, { business, me });
        if (!peers.length) return { items: [] };
        const lastRows = await select(`SELECT ${MESSAGE_COLUMNS} FROM chat_message WHERE id_business = :business AND id IN (:ids)`,
            { business, ids: peers.map(row => row.last_id) });
        const lastById = new Map(lastRows.map(row => [Number(row.id), row]));
        const people = await select('SELECT id_login AS id, name, active FROM login WHERE id_business = :business AND id_login IN (:ids)',
            { business, ids: peers.map(row => row.peer) });
        const byId = new Map(people.map(row => [row.id, row]));
        return {
            items: peers.filter(row => byId.has(row.peer)).map(row => {
                const last = lastById.get(Number(row.last_id));
                const person = byId.get(row.peer);
                return {
                    peer: { id: row.peer, name: personName(person), initials: rules.initials(personName(person)), active: Number(person.active) === 1 },
                    lastMessage: last ? { id: Number(last.id), mine: last.id_sender === me, preview: rules.preview(last), sentAt: last.created_at } : null,
                    unread: Number(row.unread) || 0
                };
            })
        };
    }

    async messages(business, me, peerId, { after, before, limit } = {}) {
        const peer = await businessPerson(business, peerId);
        if (!peer || peer.id === me) throw new ChatError('CHAT_RECIPIENT_INVALID', 422, 'Esa persona no pertenece a este consultorio.');
        const { low, high } = rules.pair(me, peer.id);
        const size = Math.min(Math.max(Number.parseInt(limit, 10) || PAGE_MAX, 1), PAGE_MAX);
        const afterId = Number.parseInt(after, 10), beforeId = Number.parseInt(before, 10);
        let rows;
        if (Number.isSafeInteger(afterId) && afterId >= 0) {
            rows = await select(`SELECT ${MESSAGE_COLUMNS} FROM chat_message WHERE id_business = :business AND pair_low = :low AND pair_high = :high
                AND id > :afterId ORDER BY id ASC LIMIT ${size}`, { business, low, high, afterId });
        } else {
            rows = (await select(`SELECT ${MESSAGE_COLUMNS} FROM chat_message WHERE id_business = :business AND pair_low = :low AND pair_high = :high
                ${Number.isSafeInteger(beforeId) && beforeId > 0 ? 'AND id < :beforeId' : ''} ORDER BY id DESC LIMIT ${size}`,
            { business, low, high, beforeId })).reverse();
        }
        const [read] = await select(`SELECT MAX(id) AS readUpTo FROM chat_message WHERE id_business = :business
            AND id_sender = :me AND id_recipient = :peer AND read_at IS NOT NULL`, { business, me, peer: peer.id });
        const permissions = await permissionsOf(me);
        const names = new Map([[me, (await namesFor(business, [me])).get(me)], [peer.id, peer.name]]);
        return {
            peer: { id: peer.id, name: peer.name, initials: rules.initials(peer.name), active: peer.active, canWrite: peer.active && Boolean(await eligiblePerson(business, me, peer.id)) },
            items: rows.map(row => messageView(row, me, permissions, names)),
            readUpTo: Number(read.readUpTo) || 0,
            hasMore: rows.length === size
        };
    }

    async markRead(business, me, peerId, upToId) {
        const upTo = Number.parseInt(upToId, 10);
        if (!rules.loginId(peerId) || !Number.isSafeInteger(upTo) || upTo < 1) throw new ChatError('CHAT_READ_INVALID', 422, 'Solicitud de lectura no válida.');
        const [, meta] = await sequelize.query(`UPDATE chat_message SET read_at = NOW(3) WHERE id_business = :business
            AND id_recipient = :me AND id_sender = :peer AND read_at IS NULL AND id <= :upTo`, {
            replacements: { business, me, peer: peerId, upTo }, type: QueryTypes.UPDATE
        });
        return { marked: Number(meta) || 0, ...(await this.summary(business, me)) };
    }

    async sendText(business, me, input = {}) {
        const requestId = rules.requestId(input.clientRequestId);
        if (!requestId) throw new ChatError('CHAT_REQUEST_INVALID', 422, 'Falta el identificador del envío.');
        const body = rules.body(input.body);
        if (!body) throw new ChatError('CHAT_BODY_INVALID', 422, `Escribe un mensaje de hasta ${rules.BODY_MAX} caracteres.`);
        const recipient = await eligiblePerson(business, me, input.recipientId);
        if (!recipient) throw new ChatError('CHAT_RECIPIENT_INVALID', 422, 'Elige a un colega activo de este consultorio.');
        const inserted = await insertOnce(business, me, {
            recipient: recipient.id, requestId, kind: 'text', body, payload: { kind: 'text', recipient: recipient.id, body }
        });
        return sendResult(business, me, inserted);
    }

    async previewNotice(business, me, input = {}) {
        const recipient = await eligiblePerson(business, me, input.recipientId);
        if (!recipient) throw new ChatError('CHAT_RECIPIENT_INVALID', 422, 'Elige a un colega activo de este consultorio.');
        const composed = await noticeContext(business, me, input.context, input.reason);
        const permissions = await permissionsOf(recipient.id);
        const row = { kind: 'team_notice', context_ref: composed.contextRef, reason_code: composed.reason, snap_patient_name: composed.patientName,
            snap_patient_code: composed.patientCode, snap_professional_name: composed.professionalName, snap_attention_date: composed.attentionDate };
        return { recipient, notice: rules.noticeView(row, { isSender: false, permissions }) };
    }

    async sendNotice(business, me, input = {}) {
        const requestId = rules.requestId(input.clientRequestId);
        if (!requestId) throw new ChatError('CHAT_REQUEST_INVALID', 422, 'Falta el identificador del envío.');
        const comment = rules.comment(input.comment);
        if (comment === null) throw new ChatError('CHAT_BODY_INVALID', 422, `El comentario admite hasta ${rules.COMMENT_MAX} caracteres.`);
        const recipient = await eligiblePerson(business, me, input.recipientId);
        if (!recipient) throw new ChatError('CHAT_RECIPIENT_INVALID', 422, 'Elige a un colega activo de este consultorio.');
        const composed = await noticeContext(business, me, input.context, input.reason);
        const inserted = await insertOnce(business, me, {
            recipient: recipient.id, requestId, kind: 'team_notice', body: comment || null, ...composed,
            payload: { kind: 'team_notice', recipient: recipient.id, context: composed.contextKind, ref: composed.contextRef, patient: composed.contextPatient,
                professional: composed.professionalId, reason: composed.reason, comment: comment || '' }
        });
        return sendResult(business, me, inserted);
    }

    async request(business, me, requestId) {
        if (!rules.requestId(requestId)) throw new ChatError('CHAT_REQUEST_INVALID', 422, 'Identificador de envío no válido.');
        const row = await byRequest(business, me, requestId);
        if (!row) return { found: false };
        const names = await namesFor(business, [row.id_sender, row.id_recipient]);
        return { found: true, message: messageView(row, me, [], names) };
    }

    async noticesForTracing(business, me, tracingId) { return this.noticesForContext(business, me, 'tracing', tracingId); }

    async noticesForContext(business, me, kind, ref) {
        if (!rules.CONTEXT_KINDS.includes(kind) || !rules.loginId(ref)) throw new ChatError('CHAT_CONTEXT_INVALID', 422, 'Referencia no válida.');
        const rows = await select(`SELECT public_id, id_sender, id_recipient, reason_code, created_at, read_at FROM chat_message
            WHERE id_business = :business AND context_kind = :kind AND context_ref = :ref ORDER BY id ASC LIMIT 100`, { business, kind, ref });
        const names = await namesFor(business, [...new Set(rows.flatMap(row => [row.id_sender, row.id_recipient]))]);
        return {
            items: rows.map(row => ({
                id: row.public_id, sender: { id: row.id_sender, name: names.get(row.id_sender) || 'Usuario' },
                recipient: { id: row.id_recipient, name: names.get(row.id_recipient) || 'Usuario' },
                reason: { code: row.reason_code, label: rules.REASONS[row.reason_code] || 'Otro' }, sentAt: row.created_at, readAt: row.read_at
            }))
        };
    }
}

module.exports = new ChatDao();
module.exports.ChatError = ChatError;
