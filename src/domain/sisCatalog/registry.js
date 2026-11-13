'use strict';
// NC4/L2: interfaz lógica resolve/validateRef del contrato NC1 v1 §5, en memoria y sin DB.
// Regla central: 'unverified' nunca se trata como 'valid'.
const { classifyRef } = require('./catalogRef');

const TRANSITIONS = Object.freeze({ staged: ['verified', 'retired'], verified: ['retired'], retired: [] });
const out = (result, issues = [], extra = {}) => ({ result, issues, ...extra });
const issue = (code, message) => ({ code, message });

class CatalogRegistry {
    constructor() {
        this.releases = new Map();
        this.statuses = new Map();
    }

    add(release) {
        const id = release.manifest.releaseId;
        if (this.releases.has(id)) throw Object.assign(new Error('releaseId repetido: ' + id), { code: 'CATALOG_RELEASE_DUPLICATE' });
        this.releases.set(id, release);
        this.statuses.set(id, release.manifest.status);
        return this;
    }

    /** El contenido de un release es inmutable; solo cambia su estado: staged → verified → retired. */
    setStatus(releaseId, next) {
        const current = this.statuses.get(releaseId);
        if (!current) throw Object.assign(new Error('Release inexistente.'), { code: 'CATALOG_RELEASE_NOT_FOUND' });
        if (!TRANSITIONS[current].includes(next)) throw Object.assign(new Error(`Transición no permitida: ${current} → ${next}`), { code: 'CATALOG_STATUS_TRANSITION' });
        const release = this.releases.get(releaseId);
        if (next === 'verified' && release.manifest.provenance !== 'official') {
            throw Object.assign(new Error('Un fixture sintético no puede verificarse como release oficial.'), { code: 'CATALOG_SYNTHETIC_NOT_OFFICIAL' });
        }
        if (next === 'verified' && !release.manifest.validFrom) {
            throw Object.assign(new Error('Para verificar un release hace falta validFrom y su base de vigencia.'), { code: 'CATALOG_VALIDITY_REQUIRED' });
        }
        this.statuses.set(releaseId, next);
    }

    status(releaseId) { return this.statuses.get(releaseId) || null; }

    /** Ventana efectiva [from, to): validTo explícito o el inicio del siguiente release verificado/retirado de la familia. */
    window(releaseId) {
        const { manifest } = this.releases.get(releaseId);
        if (!manifest.validFrom) return null;
        if (manifest.validTo) return { from: manifest.validFrom, to: manifest.validTo };
        let to = null;
        for (const [id, other] of this.releases) {
            const st = this.statuses.get(id);
            if (id === releaseId || other.manifest.family !== manifest.family || st === 'staged' || !other.manifest.validFrom) continue;
            if (other.manifest.validFrom > manifest.validFrom && (to === null || other.manifest.validFrom < to)) to = other.manifest.validFrom;
        }
        return { from: manifest.validFrom, to };
    }

    /** Release oficial verificado vigente en una fecha civil YYYY-MM-DD. */
    releaseFor(family, date) {
        for (const [id, release] of this.releases) {
            if (release.manifest.family !== family || this.statuses.get(id) !== 'verified' || release.manifest.provenance !== 'official') continue;
            const w = this.window(id);
            if (w && w.from <= date && (w.to === null || date < w.to)) return release;
        }
        return null;
    }

    resolve(input) {
        const ref = classifyRef(input);
        if (ref.kind === 'invalid') return { status: 'invalid', issues: ref.issues };
        if (ref.kind === 'candidate') return { status: 'unverified', issues: [issue('CATALOG_REF_CANDIDATE', 'Referencia candidata sin release.')] };
        const release = this.releases.get(ref.value.releaseId);
        if (!release) return { status: 'not_found', issues: [issue('CATALOG_RELEASE_NOT_FOUND', 'Release no disponible.')] };
        if (release.manifest.family !== ref.value.family) return { status: 'invalid', issues: [issue('CATALOG_FAMILY_MISMATCH', 'El release pertenece a otra familia.')] };
        const entry = release.entries.get(ref.value.code);
        if (!entry) return { status: 'not_found', issues: [issue('CATALOG_CODE_NOT_FOUND', 'Código inexistente en ese release.')] };
        const m = release.manifest;
        return { status: 'found', issues: [], entry, release: { releaseId: m.releaseId, family: m.family, status: this.statuses.get(m.releaseId), provenance: m.provenance, sha256: m.sha256 } };
    }

    /**
     * @param {object} input CatalogRef o candidata
     * @param {{ field: { name, catalogFamily }, clinicalDate?: string, historical?: boolean, allowSynthetic?: boolean, allowSentinel?: boolean }} ctx
     */
    validateRef(input, ctx) {
        const field = ctx && ctx.field;
        if (!field || !field.catalogFamily) return out('invalid', [issue('FIELD_HAS_NO_CATALOG', 'El campo del descriptor no usa catálogo.')]);
        const ref = classifyRef(input);
        if (ref.kind === 'invalid') return out('invalid', ref.issues);
        if (ref.value.family !== field.catalogFamily) return out('invalid', [issue('CATALOG_FAMILY_MISMATCH', `${field.name} usa ${field.catalogFamily}.`)]);
        const resolved = this.resolve(input);
        if (resolved.status === 'unverified') return out('unverified', resolved.issues);
        if (resolved.status === 'invalid') return out('invalid', resolved.issues);
        if (resolved.status === 'not_found') {
            return resolved.issues[0].code === 'CATALOG_RELEASE_NOT_FOUND'
                ? out('unverified', [issue('CATALOG_UNAVAILABLE', 'Sin el release no se puede validar.')])
                : out('invalid', resolved.issues);
        }
        const { entry, release } = resolved;
        const issues = [];
        if (release.provenance !== 'official' && !ctx.allowSynthetic) issues.push(issue('SYNTHETIC_RELEASE', 'Un fixture no acredita validación oficial.'));
        if (release.status === 'staged') issues.push(issue('RELEASE_NOT_VERIFIED', 'Release en revisión.'));
        if (release.status === 'retired' && !ctx.historical) issues.push(issue('RELEASE_RETIRED', 'Release retirado: solo resoluble para históricos.'));
        if (ctx.clinicalDate && !ctx.historical && release.status === 'verified') {
            const w = this.window(release.releaseId);
            if (!w || ctx.clinicalDate < w.from || (w.to !== null && ctx.clinicalDate >= w.to)) {
                issues.push(issue('RELEASE_NOT_EFFECTIVE', 'El release no está vigente en la fecha clínica.'));
            }
        }
        if (issues.length) return out('unverified', issues, { entry });
        if (entry.sentinel && !ctx.allowSentinel) return out('invalid', [issue('CATALOG_SENTINEL_NOT_STORABLE', `${entry.code} es una excepción de salida, no un dato.`)], { entry });
        return out('valid', [], { entry, ref: ref.value });
    }

    /** CLUES: coincidencia exacta en el release SIS vigente para la fecha. */
    resolveClues(raw, date) {
        const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{11}$/.test(code)) return out('invalid', [issue('CLUES_FORMAT', 'La CLUES tiene 11 caracteres A–Z y 0–9.')]);
        const release = this.releaseFor('sis.establishments', date);
        if (!release) return out('unverified', [issue('CATALOG_UNAVAILABLE', 'No hay release SIS de establecimientos vigente para la fecha.')], { candidate: { family: 'sis.establishments', code } });
        const entry = release.entries.get(code);
        const ref = { family: 'sis.establishments', releaseId: release.manifest.releaseId, code };
        if (!entry) return out('invalid', [issue('CLUES_NOT_IN_SIS_RELEASE', 'La CLUES no está en el catálogo SIS vigente (no existe o no está en operación).')], { candidate: { family: ref.family, code } });
        if (entry.attributes.en_operacion !== '1') return out('invalid', [issue('CLUES_NOT_OPERATING', 'en_operacion distinto de 1.')], { ref, entry });
        return out('valid', [], { ref, entry });
    }

    /** Relación permitida tipo de personal ↔ servicio. null si el release no existe. */
    allowsPair(releaseId, left, right) {
        const release = this.releases.get(releaseId);
        if (!release) return null;
        return release.pairs.has(`${left}\u0000${right}`);
    }
}

module.exports = { CatalogRegistry, TRANSITIONS };
