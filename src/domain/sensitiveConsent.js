const { createHash } = require('node:crypto');

const TYPE = 'SENSITIVE_DATA_CONSENT';
const REFUSAL = 'NO_FIRMADO_POR_NEGATIVA';
const EVENTS = ['REFUSAL_REGISTERED', 'REFUSAL_SUPERSEDED', 'SUPERSEDES_REFUSAL'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = value => value instanceof Date ? value.toISOString() : String(value || '');
const id = document => document.id_patient_document;
const byId = (a, b) => String(id(a)).localeCompare(String(id(b)));
const canonical = object => JSON.stringify(Object.keys(object).sort().map(key => [key, object[key]]));

function refusalEvidence(document, events) {
    const rows = events.filter(event => event.id_patient_document === id(document) && event.event_type === 'REFUSAL_REGISTERED')
        .sort((a, b) => time(a.created_at).localeCompare(time(b.created_at)) || a.id_patient_document_event.localeCompare(b.id_patient_document_event));
    return { latest: rows.at(-1), fingerprint: hash(rows.map(row => [row.id_patient_document_event, time(row.created_at), row.notes, row.created_by])) };
}

function eligible(refusal, signed, events) {
    if (!refusal || !signed || id(refusal) === id(signed)) return false;
    if ([refusal, signed].some(doc => doc.document_type !== TYPE || Number(doc.active) !== 1)) return false;
    if (refusal.id_business !== signed.id_business || refusal.id_person !== signed.id_person) return false;
    const { latest } = refusalEvidence(refusal, events);
    return refusal.status === REFUSAL && signed.status === 'FIRMADO' && Boolean(latest && signed.signed_at)
        && time(signed.signed_at) > time(latest.created_at);
}

function pairPayload(refusal, signed, events, actor, profile, request, reason, name = actor) {
    const evidence = refusalEvidence(refusal, events);
    return { v: 1, r: id(refusal), s: id(signed), q: request, a: actor, p: profile, d: name,
        e: evidence.latest.id_patient_document_event, t: time(evidence.latest.created_at),
        f: evidence.fingerprint, u: time(signed.signed_at), n: reason };
}

function parsePair(event) {
    try {
        const value = JSON.parse(event.notes);
        if (!value || Array.isArray(value) || value.v !== 1) return null;
        if (Object.keys(value).sort().join(',') !== 'a,d,e,f,n,p,q,r,s,t,u,v') return null;
        if (Object.entries(value).some(([key, item]) => key !== 'v' && (typeof item !== 'string' || !item.length))) return null;
        if (value.n.length < 10 || value.n.length > 500 || !/^[a-f0-9]{64}$/.test(value.f)) return null;
        return value;
    } catch (_) { return null; }
}

// Only a complete, matching authoritative event pair can affect current consent.
// Historical documents, statuses and history links are never rewritten here.
function resolve(documents, events) {
    const relevant = documents.filter(doc => doc.document_type === TYPE).sort(byId);
    const eventRows = events.filter(event => EVENTS.includes(event.event_type));
    const byDocument = new Map(relevant.map(doc => [id(doc), doc]));
    const pairs = [], diagnostics = [];
    for (const event of eventRows.filter(row => row.event_type === 'REFUSAL_SUPERSEDED')) {
        const payload = parsePair(event);
        const mirrors = payload ? eventRows.filter(row => row.event_type === 'SUPERSEDES_REFUSAL'
            && row.id_patient_document === payload.s && row.id_business === event.id_business
            && row.created_by === payload.a && canonical(parsePair(row) || {}) === canonical(payload)) : [];
        const refusal = payload && byDocument.get(payload.r), signed = payload && byDocument.get(payload.s);
        const requestEvents = payload ? eventRows.filter(row => parsePair(row)?.q === payload.q) : [];
        if (!payload || !refusal || !signed || event.id_patient_document !== payload.r
            || event.id_business !== refusal.id_business || event.created_by !== payload.a || mirrors.length !== 1
            || requestEvents.length !== 2
            || signed.responsible_doctor_user_id !== payload.a || signed.responsible_doctor_profile_id !== payload.p) {
            diagnostics.push({ document_id: event.id_patient_document, code: 'SUBSTITUTION_PAIR_INVALID' });
            continue;
        }
        const evidence = refusalEvidence(refusal, eventRows);
        const effective = eligible(refusal, signed, eventRows) && evidence.latest.id_patient_document_event === payload.e
            && evidence.fingerprint === payload.f && time(evidence.latest.created_at) === payload.t
            && time(signed.signed_at) === payload.u && time(event.created_at) >= payload.u && time(mirrors[0].created_at) >= payload.u;
        pairs.push({ ...payload, effective, created_at: time(event.created_at) });
    }
    for (const event of eventRows.filter(row => row.event_type === 'SUPERSEDES_REFUSAL')) {
        const payload = parsePair(event);
        if (!payload || !pairs.some(pair => pair.q === payload.q && pair.r === payload.r && pair.s === payload.s))
            diagnostics.push({ document_id: event.id_patient_document, code: 'SUBSTITUTION_PAIR_INVALID' });
    }
    const superseded = new Set(pairs.filter(pair => pair.effective).map(pair => pair.r));
    const priority = { [REFUSAL]: 1, FIRMADO: 2, PENDIENTE_FIRMA: 3, BORRADOR: 4 };
    const active = relevant.filter(doc => Number(doc.active) === 1 && doc.status !== 'CANCELADO' && !superseded.has(id(doc)))
        .sort((a, b) => (priority[a.status] || 5) - (priority[b.status] || 5)
            || time(b.created_at).localeCompare(time(a.created_at)) || byId(a, b));
    const document = active[0] || null;
    const token = hash({ v: 1, documents: relevant.map(doc => [id(doc), doc.id_business, doc.id_person, doc.active, doc.status,
        time(doc.signed_at), time(doc.created_at), doc.refusal_reason, doc.responsible_doctor_user_id, doc.responsible_doctor_profile_id]),
    events: [...eventRows].sort((a, b) => a.id_patient_document_event.localeCompare(b.id_patient_document_event))
        .map(row => [row.id_patient_document_event, row.id_patient_document, row.id_business, row.event_type, row.notes, time(row.created_at), row.created_by]) });
    return { document, status: document ? document.status : 'SIN_CONSENTIMIENTO', token, pairs, diagnostics,
        signedDocument: document && document.status === 'FIRMADO' ? document : null,
        refusalDocument: document && document.status === REFUSAL ? document : null,
        remainingRefusals: active.filter(doc => doc.status === REFUSAL) };
}

module.exports = { TYPE, REFUSAL, EVENTS, hash, time, eligible, refusalEvidence, pairPayload, parsePair, resolve };
