'use strict';
const { QueryTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const { VERSIONS, comparable } = require('../../domain/pulse/rules');
const { DAY, wall, date, sqlTime } = require('../../domain/pulse/time');
const { REQUIRED } = require('./access');
const { joins } = require('../../util/effectivePermissions');
const { isBusinessOperational } = require('../../util/businessOperational');
function aggregate(snapshot) {
    return { measurementKind: 'daily18', policyVersion: 'pulse-applicability-0.2', rulesVersion: snapshot.rulesVersion, catalogVersion: snapshot.catalogVersion, timeZone: snapshot.snapshot.timeZone, coreMask: snapshot.quality.coreMask, quality: { evaluated: snapshot.quality.evaluated, expected: 3, classification: snapshot.quality.classification }, operational: snapshot.operational.category, preparation: snapshot.preparation.state, dimensions: snapshot.dimensions.map(d => ({ id: d.id, numerator: d.numerator, denominator: d.denominator, rate: d.rate, category: d.category, exclusions: d.exclusions })) };
}
class PulseHistory {
    constructor(db) { this.db = db; }
    query(sql, replacements, type = QueryTypes.SELECT) { return this.db.query(sql, { replacements, type }); }
    async enabled(business, now) {
        const rows = await this.query(`SELECT b.active,b.subscription_status,b.trial_ends_at FROM business b WHERE b.id_business=:business AND EXISTS(
         SELECT l.id_login FROM login l JOIN rol r ON r.id_rol=l.id_rol AND r.active=1 AND r.code<>'super_admin' ${joins()}
         WHERE l.id_business=b.id_business AND l.active=1 AND cp.is_active=1 AND cp.code IN(:permissions)
         AND COALESCE(bp.active,pr.active,0)=1 GROUP BY l.id_login HAVING COUNT(DISTINCT cp.code)=4)`, { business, permissions: [...REQUIRED] });
        return Boolean(rows[0] && isBusinessOperational(rows[0], new Date(now)).allowed);
    }
    async candidates(now, limit = 25) {
        return this.query(`SELECT b.id_business,ac.timezone FROM business b JOIN appointment_config ac ON ac.id_business=b.id_business AND ac.active=1 AND ac.doctor_profile_id IS NULL
         WHERE b.active=1 AND (b.subscription_status='active' OR (b.subscription_status='trial' AND b.trial_ends_at>=:now))
         AND ac.id_appointment_config=(SELECT newest.id_appointment_config FROM appointment_config newest WHERE newest.id_business=b.id_business AND newest.active=1 AND newest.doctor_profile_id IS NULL ORDER BY newest.created_at DESC,newest.id_appointment_config LIMIT 1)
         AND TIME(CONVERT_TZ(:now,'+00:00',ac.timezone))>='18:00:00' AND TIME(CONVERT_TZ(:now,'+00:00',ac.timezone))<'18:05:00'
         AND NOT EXISTS(SELECT 1 FROM business_pulse_captures c WHERE c.id_business=b.id_business AND c.local_date=DATE(CONVERT_TZ(:now,'+00:00',ac.timezone)) AND c.cut_kind='daily18'
          AND (c.state IN('valid','gap') OR c.lease_until>:now))
         AND EXISTS(SELECT l.id_login FROM login l JOIN rol r ON r.id_rol=l.id_rol AND r.active=1 AND r.code<>'super_admin' ${joins()}
          WHERE l.id_business=b.id_business AND l.active=1 AND cp.is_active=1 AND cp.code IN(:permissions) AND COALESCE(bp.active,pr.active,0)=1 GROUP BY l.id_login HAVING COUNT(DISTINCT cp.code)=4)
         ORDER BY b.id_business LIMIT :limit`, { now: sqlTime(now), permissions: [...REQUIRED], limit });
    }
    async claim(business, zone, now) {
        const localDate = date(now, zone), cut = wall(localDate, '18:00:00', zone);
        if (!cut || now < cut || now >= cut + 300000 || !await this.enabled(business, now)) return null;
        const owner = randomUUID(), values = { business, localDate, owner, now: sqlTime(now), lease: sqlTime(now + 30000), expires: sqlTime(now + 30 * DAY), zone, rules: VERSIONS.rulesVersion, catalog: VERSIONS.catalogVersion };
        await this.query(`INSERT IGNORE INTO business_pulse_captures(id_business,local_date,cut_kind,state,lease_owner,lease_until,expires_at,time_zone,rules_version,catalog_version)
         VALUES(:business,:localDate,'daily18','claimed',:owner,:lease,:expires,:zone,:rules,:catalog)`, values, QueryTypes.INSERT);
        await this.query(`UPDATE business_pulse_captures SET lease_owner=:owner,lease_until=:lease,state='claimed'
         WHERE id_business=:business AND local_date=:localDate AND cut_kind='daily18' AND state IN('claimed','partial') AND (lease_until IS NULL OR lease_until<=:now)
         AND time_zone=:zone AND rules_version=:rules AND catalog_version=:catalog`, values, QueryTypes.UPDATE);
        const rows = await this.query("SELECT lease_owner FROM business_pulse_captures WHERE id_business=:business AND local_date=:localDate AND cut_kind='daily18'", values);
        return rows[0]?.lease_owner === owner ? { business, localDate, owner, zone, cut } : null;
    }
    async complete(claim, snapshot, now) {
        const captured = Date.parse(snapshot.snapshot.calculatedAt);
        if (now >= claim.cut + 300000 || captured < claim.cut || captured >= claim.cut + 300000 || snapshot.snapshot.timeZone !== claim.zone || !await this.enabled(claim.business, now)) return false;
        const data = aggregate(snapshot), valid = snapshot.quality.evaluated === 3 && snapshot.snapshot.timeZoneSource === 'configured';
        const [, affected] = await this.query(`UPDATE business_pulse_captures SET state=:state,aggregate_json=:json,captured_at=:captured,expires_at=:expires,lease_until=:retryAfter
         WHERE id_business=:business AND local_date=:localDate AND cut_kind='daily18' AND state='claimed' AND lease_owner=:owner AND lease_until>:now`, { ...claim, state: valid ? 'valid' : 'partial', json: JSON.stringify(data), captured: sqlTime(captured), expires: sqlTime(captured + 30 * DAY), now: sqlTime(now), retryAfter: valid ? null : sqlTime(now + 60000) }, QueryTypes.UPDATE);
        return affected > 0;
    }
    async purge(now) { const [, result] = await this.db.query('DELETE FROM business_pulse_captures WHERE expires_at<=:now ORDER BY expires_at LIMIT 100', { replacements: { now: sqlTime(now) } }); return Number(result?.affectedRows || 0); }
    async read(business, days, now) {
        const configs = await this.query('SELECT timezone FROM appointment_config WHERE id_business=:business AND active=1 AND doctor_profile_id IS NULL ORDER BY created_at DESC,id_appointment_config LIMIT 1', { business });
        const zone = require('../../domain/pulse/time').timeZone(configs[0]?.timezone), today = date(now, zone.name), from = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * DAY).toISOString().slice(0, 10);
        const rows = await this.query(`SELECT local_date,state,captured_at,time_zone,rules_version,catalog_version,aggregate_json,reason_code
         FROM business_pulse_captures WHERE id_business=:business AND expires_at>:now AND local_date>=:from AND local_date<=:today
         ORDER BY local_date`, { business, now: sqlTime(now), from, today });
        const series = rows.map(r => { const data = typeof r.aggregate_json === 'string' ? JSON.parse(r.aggregate_json) : r.aggregate_json; return { localDate: String(r.local_date).slice(0, 10), capturedAt: r.captured_at ? new Date(r.captured_at).toISOString() : null, state: r.state, timeZone: r.time_zone, rulesVersion: r.rules_version, catalogVersion: r.catalog_version, quality: data?.quality || null, coreMask: data?.coreMask || [], dimensions: data?.dimensions || [], measurement: data, reason: r.reason_code || (r.state === 'claimed' ? 'CAPTURE_NOT_COMPLETED' : r.state === 'partial' ? 'PARTIAL_COVERAGE' : null) }; });
        for (let i = 0; i < series.length; i++) series[i].comparableToPrevious = i > 0 && series[i].state === 'valid' && series[i - 1].state === 'valid' && comparable(series[i].measurement, series[i - 1].measurement);
        for (const point of series) delete point.measurement;
        const present = new Set(series.map(p => p.localDate)), missingDates = Array.from({ length: days }, (_, i) => new Date(Date.parse(from + 'T00:00:00Z') + i * DAY).toISOString().slice(0, 10)).filter(d => !present.has(d));
        return { label: 'Medicion diaria a las 18:00', retentionDays: 30, window: '[18:00,18:05)', observation: { from, to: today, timeZone: zone.name, timeZoneSource: zone.source }, series, missingDates, gaps: 'Dias sin captura no representan cero ni prueban que Pulso estuviera habilitado; no se reconstruye el pasado.', liveComparable: false };
    }
}
module.exports = { PulseHistory, aggregate };
