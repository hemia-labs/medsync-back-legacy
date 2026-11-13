'use strict';
// NC4/L2: interfaz lógica resolve/validateRef del contrato NC1 v1.1 §5, en memoria y sin DB.
// Regla central: 'unverified' nunca se trata como 'valid'.
// L2-R3: add/setStatus aplican las mismas invariantes que buildRelease.
// L2-R6: solo un release con evidencia de verificación (verifiedAt) delimita ventanas; empates y solapes se rechazan.
const { classifyRef } = require('./catalogRef');
const { assertStatusInvariants, isRelease } = require('./release');

const TRANSITIONS = Object.freeze({ staged: ['verified', 'retired'], verified: ['retired'], retired: [] });
const out = (result, issues = [], extra = {}) => ({ result, issues, ...extra });
const issue = (code, message) => ({ code, message });
const error = (message, code) => Object.assign(new Error(message), { code });

class CatalogRegistry {
    /** @param {{ now?: () => string }} [options] reloj inyectable para verifiedAt */
    constructor({ now = () => new Date().toISOString() } = {}) {
        this.releases = new Map();
        this.state = new Map();
        this.now = now;
    }

    add(release) {
        if (!isRelease(release)) throw error('Solo se registran releases construidos con buildRelease.', 'CATALOG_RELEASE_INVALID');
        const id = release.manifest.releaseId;
        if (this.releases.has(id)) throw error('releaseId repetido: ' + id, 'CATALOG_RELEASE_DUPLICATE');
        const st = { status: release.manifest.status, verifiedAt: release.manifest.verifiedAt };
        assertStatusInvariants(release.manifest, st.status, st.verifiedAt);
        this.releases.set(id, release);
        this.state.set(id, st);
        try { this.assertNoWindowConflict(release.manifest.family); } catch (e) { this.releases.delete(id); this.state.delete(id); throw e; }
        return this;
    }

    /** El contenido de un release es inmutable; solo cambia su estado: staged → verified → retired, o staged → retired (descartado). */
    setStatus(releaseId, next) {
        const current = this.state.get(releaseId);
        if (!current) throw error('Release inexistente.', 'CATALOG_RELEASE_NOT_FOUND');
        if (!TRANSITIONS[current.status].includes(next)) throw error(`Transición no permitida: ${current.status} → ${next}`, 'CATALOG_STATUS_TRANSITION');
        const release = this.releases.get(releaseId);
        const proposed = { status: next, verifiedAt: next === 'verified' ? this.now() : current.verifiedAt };
        assertStatusInvariants(release.manifest, proposed.status, proposed.verifiedAt);
        this.state.set(releaseId, proposed);
        try { this.assertNoWindowConflict(release.manifest.family); } catch (e) { this.state.set(releaseId, current); throw e; }
    }

    status(releaseId) { const st = this.state.get(releaseId); return st ? st.status : null; }
    verifiedAt(releaseId) { const st = this.state.get(releaseId); return st ? st.verifiedAt : null; }

    /** Releases de la familia que estuvieron verificados (verified o retirados tras verificarse), por validFrom. */
    verifiedLineage(family) {
        return [...this.releases.values()]
            .filter(r => r.manifest.family === family && this.state.get(r.manifest.releaseId).verifiedAt !== null)
            .sort((a, b) => (a.manifest.validFrom < b.manifest.validFrom ? -1 : a.manifest.validFrom > b.manifest.validFrom ? 1 : 0));
    }

    assertNoWindowConflict(family) {
        const lineage = this.verifiedLineage(family);
        for (let i = 1; i < lineage.length; i++) {
            const prev = lineage[i - 1].manifest, cur = lineage[i].manifest;
            if (prev.validFrom === cur.validFrom) throw error(`Dos releases verificados de ${family} empiezan el ${cur.validFrom}.`, 'CATALOG_WINDOW_CONFLICT');
            if (prev.validTo && prev.validTo > cur.validFrom) throw error(`${prev.releaseId} (hasta ${prev.validTo}) se solapa con ${cur.releaseId} (desde ${cur.validFrom}).`, 'CATALOG_WINDOW_OVERLAP');
        }
    }

    /** Ventana efectiva [from, to): validTo explícito o el inicio del siguiente release con evidencia de verificación. */
    window(releaseId) {
        const release = this.releases.get(releaseId);
        if (!release || !release.manifest.validFrom || this.state.get(releaseId).verifiedAt === null) return null;
        const lineage = this.verifiedLineage(release.manifest.family);
        const next = lineage[lineage.indexOf(release) + 1];
        return { from: release.manifest.validFrom, to: release.manifest.validTo || (next ? next.manifest.validFrom : null) };
    }

    /** Release oficial vigente en una fecha civil. Con historical también devuelve uno retirado tras verificarse. */
    releaseFor(family, date, { historical = false } = {}) {
        for (const release of this.verifiedLineage(family)) {
            const id = release.manifest.releaseId;
            if (this.state.get(id).status !== 'verified' && !historical) continue;
            const w = this.window(id);
            if (w.from <= date && (w.to === null || date < w.to)) return release;
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
        const entry = release.get(ref.value.code);
        if (!entry) return { status: 'not_found', issues: [issue('CATALOG_CODE_NOT_FOUND', 'Código inexistente en ese release.')] };
        const m = release.manifest, st = this.state.get(m.releaseId);
        return { status: 'found', issues: [], entry, release: { releaseId: m.releaseId, family: m.family, status: st.status, verifiedAt: st.verifiedAt, provenance: m.provenance, sha256: m.sha256 } };
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
        if (release.verifiedAt === null) issues.push(issue('RELEASE_NOT_VERIFIED', release.status === 'retired' ? 'Release descartado sin verificar.' : 'Release en revisión.'));
        if (release.status === 'retired' && !ctx.historical) issues.push(issue('RELEASE_RETIRED', 'Release retirado: solo resoluble para históricos.'));
        if (ctx.clinicalDate && release.verifiedAt !== null) {
            const w = this.window(release.releaseId);
            if (!w || ctx.clinicalDate < w.from || (w.to !== null && ctx.clinicalDate >= w.to)) {
                issues.push(issue('RELEASE_NOT_EFFECTIVE', 'El release no está vigente en la fecha clínica.'));
            }
        }
        if (issues.length) return out('unverified', issues, { entry });
        if (entry.sentinel && !ctx.allowSentinel) return out('invalid', [issue('CATALOG_SENTINEL_NOT_STORABLE', `${entry.code} es una excepción de salida, no un dato.`)], { entry });
        return out('valid', [], { entry, ref: ref.value });
    }

    /** CLUES: coincidencia exacta en el release SIS vigente para la fecha (contrato v1.1 §4). */
    resolveClues(raw, date) {
        const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{11}$/.test(code)) return out('invalid', [issue('CLUES_FORMAT', 'La CLUES tiene 11 caracteres A–Z y 0–9.')]);
        const release = this.releaseFor('sis.establishments', date);
        if (!release) return out('unverified', [issue('CATALOG_UNAVAILABLE', 'No hay release SIS de establecimientos vigente para la fecha.')], { candidate: { family: 'sis.establishments', code } });
        const entry = release.get(code);
        const ref = { family: 'sis.establishments', releaseId: release.manifest.releaseId, code };
        if (!entry) return out('invalid', [issue('CLUES_NOT_IN_SIS_RELEASE', 'La CLUES no está en el catálogo SIS vigente (no existe o no está en operación).')], { candidate: { family: ref.family, code } });
        if (entry.attributes.en_operacion !== '1') return out('invalid', [issue('CLUES_NOT_OPERATING', 'en_operacion distinto de 1.')], { ref, entry });
        return out('valid', [], { ref, entry });
    }

    /** Relación permitida tipo de personal ↔ servicio. null si el release no existe. */
    allowsPair(releaseId, left, right) {
        const release = this.releases.get(releaseId);
        return release ? release.hasPair(left, right) : null;
    }
}

module.exports = { CatalogRegistry, TRANSITIONS };
