'use strict';
const { randomUUID } = require('node:crypto');
const { build, projectVisual, VERSIONS } = require('../../domain/pulse/rules');
const { PulseCache } = require('./cache');
const { cursorCodec } = require('./cursor');
const { instant } = require('../../domain/pulse/time');
class PulseService {
    constructor({ repository, access, history, secret, now = Date.now, onMetric = () => {} }) { this.repository = repository; this.access = access; this.historyStore = history; this.now = now; this.onMetric = onMetric; this.epoch = randomUUID(); this.sequence = 0; this.cache = new PulseCache({ now, onMetric }); this.cursor = cursorCodec(secret, now); }
    invalidate(business) { this.cache.invalidate(String(business)); }
    async canonical(business, force = false) {
        return this.cache.get(String(business), async ({ asOf, generation, previous }) => {
            let loaded;
            try { loaded = await this.repository.read(business, asOf); } catch (error) { this.onMetric('calculationFailed'); throw error; }
            const sequence = ++this.sequence;
            const snapshot = build(loaded.input, { asOf, generation, id: `${this.epoch}:${sequence}`, epoch: this.epoch, sequence, timeZone: loaded.zone.name, timeZoneSource: loaded.zone.source }, previous);
            if (snapshot) { for (const sourceId of ['preparation','preparationSigning','activity']) if (loaded.failures?.[sourceId]) snapshot.errors.push({ sourceId, code: 'SOURCE_UNAVAILABLE', retryable: true }); snapshot.visual = projectVisual(snapshot); }
            this.onMetric('calculated', { elapsedMs: loaded.metrics.elapsedMs, queries: loaded.metrics.queries, partial: snapshot?.quality.evaluated !== 3 });
            if (!snapshot) this.onMetric('calculationFailed');
            return { snapshot, metrics: loaded.metrics };
        }, { force });
    }
    decorate(canonical, authorization, refreshPending) {
        const data = structuredClone(canonical); data.context = { businessId: authorization.business, scope: 'business', authorizationRevision: authorization.revision }; data.snapshot.refreshPending = refreshPending; data.snapshot.serverNow = new Date(this.now()).toISOString();
        const action = id => authorization.canDetail(id) ? { key: `review-${id}`, label: { 'PUL-OP01': 'Revisar seguimientos vencidos', 'PUL-OP02': 'Revisar firmas vencidas', 'PUL-OP03': 'Revisar estados de agenda' }[id], target: { routeName: 'pulse-incidents', query: { indicatorId: id, returnKey: 'pulse' } } } : null;
        for (const d of data.dimensions) if (d.numerator) d.action = action(d.id);
        for (const i of data.incidents) { i.action = action(i.indicatorId); if (i.action) data.actions[i.action.key] = i.action; }
        for (const i of data.preparation.items) {
            const permission = i.id === 'prescription-readiness' ? 'prescriptions.config' : i.id === 'document-signing-readiness' ? 'admin.users' : 'admin.config';
            if (i.ready === false && authorization.codes.has(permission)) i.action = { key: `prepare-${i.id}`, label: 'Revisar configuracion', target: { routeName: 'admin', query: { section: i.id === 'prescription-readiness' ? 'prescriptions' : i.id === 'document-signing-readiness' ? 'doctor-identity' : 'agenda' } } };
        }
        return data;
    }
    async snapshot(principal, force = false) {
        const before = await this.access.authorize(principal), result = await this.canonical(before.business, force);
        const after = await this.access.authorize(principal);
        if (before.business !== after.business || before.revision !== after.revision) throw Object.assign(Error('PULSE_AUTHORIZATION_CHANGED'), { status: 403 });
        return this.decorate(result.snapshot, after, result.refreshPending);
    }
    async appointmentResult(principal, recordId) {
        const before = await this.access.authorize(principal);
        if (!before.canDetail('PUL-OP03')) throw Object.assign(Error('PULSE_DETAIL_FORBIDDEN'), { status: 403 });
        const status = await this.repository.appointmentResult(before.business, recordId);
        const observedAt = new Date(this.now()).toISOString();
        const after = await this.access.authorize(principal);
        if (after.business !== before.business || after.revision !== before.revision || !after.canDetail('PUL-OP03')) throw Object.assign(Error('PULSE_AUTHORIZATION_CHANGED'), { status: 403 });
        return { contractVersion: VERSIONS.contractVersion, context: { businessId: before.business, authorizationRevision: before.revision }, recordId, observedAt,
            status: ['completed','cancelled','no_show','rescheduled','confirmed','pending_confirmation'].includes(status) ? status : 'unavailable' };
    }
    async incidents(principal, indicator, cursor, limit, kind = 'pending') {
        const authorization = await this.access.authorize(principal);
        if (!authorization.canDetail(indicator)) throw Object.assign(Error('PULSE_DETAIL_FORBIDDEN'), { status: 403 });
        const context = { business: authorization.business, revision: authorization.revision, indicator, rules: VERSIONS.rulesVersion };
        const last = cursor && kind === 'pending' ? this.cursor.decode(cursor, context) : null, asOf = last?.asOf || this.now();
        const result = await this.repository.incidents(context.business, indicator, asOf, last, limit, kind);
        const after = await this.access.authorize(principal);
        if (after.revision !== authorization.revision || !after.canDetail(indicator)) throw Object.assign(Error('PULSE_DETAIL_FORBIDDEN'), { status: 403 });
        const more = result.rows.length > limit, rows = result.rows.slice(0, limit), end = rows.at(-1);
        return { contractVersion: VERSIONS.contractVersion, items: rows.map(r => ({ recordId: r.recordId, patientId: r.patientId, patientLabel: r.patientLabel, documentId: r.documentId, appointmentDate: r.appointmentDate, doctorProfileId: r.doctorProfileId, startTime: r.startTime || null, doctorLabel: r.doctorLabel || null, kind, invalidReason: kind === 'invalid' ? r.invalidReason || 'unknown' : null, rescue: kind === 'pending' && Number(r.rescue) === 1, indicatorId: indicator, severity: Number(r.priority) ? 'priority' : 'attention', timeBasis: indicator === 'PUL-OP01' ? 'business_civil_date' : 'utc_instant', dueDate: indicator === 'PUL-OP01' && r.dueAt ? String(r.dueAt).slice(0,10) : null, overdueSince: indicator === 'PUL-OP01' || !Number.isFinite(instant(r.dueAt)) ? null : new Date(instant(r.dueAt)).toISOString(), oldestAgeDays: kind === 'invalid' || r.ageDays === null ? null : Number(r.ageDays), action: indicator !== 'PUL-OP03' && !r.patientId ? null : { key: 'open-record', label: 'Revisar registro', target: { routeName: indicator === 'PUL-OP03' ? 'Citas' : 'ShowPx', ...(indicator === 'PUL-OP03' ? {} : { params: { id: r.patientId } }), query: { recordId: r.recordId, ...(indicator === 'PUL-OP02' ? { documentId: r.documentId } : indicator === 'PUL-OP03' ? { date: r.appointmentDate, doctorProfileId: r.doctorProfileId || '' } : {}), indicatorId: indicator, returnKey: 'pulse' } } } })), totalKnown: result.totalKnown, nextCursor: more && kind === 'pending' ? this.cursor.encode({ ...context, ...end, asOf }) : null, truncated: kind === 'invalid' && more, asOf: new Date(asOf).toISOString(), timeZone: result.zone, indicatorId: indicator, rulesVersion: VERSIONS.rulesVersion, consistency: 'keyset-current-records-fixed-clock; records may change; refresh to reconcile' };
    }
    async history(principal, days) { const before = await this.access.authorize(principal); const data = await this.historyStore.read(before.business, days, this.now()); const after = await this.access.authorize(principal); if (before.revision !== after.revision) throw Object.assign(Error('PULSE_AUTHORIZATION_CHANGED'), { status: 403 }); return { contractVersion: VERSIONS.contractVersion, ...data }; }
}
module.exports = { PulseService };
