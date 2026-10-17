function date(value, optional = false) {
    const text = String(value || '').trim();
    if (optional && (!text || /^(?:00[-/]00[-/]0000|0000[-/]00[-/]00|null)$/i.test(text))) return null;
    let normalized = text;
    const local = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(text);
    if (local) normalized = `${local[3]}-${local[2]}-${local[1]}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error('Indica una fecha valida.');
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) throw new Error('Indica una fecha valida.');
    return normalized;
}

function text(value, max, required = false) {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('El contenido debe ser texto.');
    const normalized = String(value || '').trim();
    if ((required && !normalized) || normalized.length > max) throw new Error(`Revisa los campos requeridos y su longitud maxima (${max}).`);
    return normalized;
}

function content(row) {
    if (!row || typeof row !== 'object') throw new Error('Indica el seguimiento.');
    const result = {
        quote_date_now: date(row.quote_date_now),
        treatment_now: text(row.treatment_now, 500, true),
        quote_date_after: date(row.quote_date_after, true),
        treatment_after: text(row.treatment_after, 500),
        note: text(row.note, 5000)
    };
    // Absent means preserve a historical relation during correction; null means free text.
    if (Object.prototype.hasOwnProperty.call(row, 'id_patient_treatment')) {
        result.id_patient_treatment = text(row.id_patient_treatment, 50) || null;
    }
    return result;
}

function rows(body, correcting = false) {
    if (!Array.isArray(body.tracing) || !body.tracing.length || body.tracing.length > 50) throw new Error('Envia entre 1 y 50 seguimientos.');
    const ids = new Set();
    return body.tracing.map(row => {
        const result = content(row);
        if (!correcting && row.id_tracing) {
            result.id_tracing = text(row.id_tracing, 50, true);
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.id_tracing)) {
                throw new Error('El identificador del nuevo seguimiento no es valido.');
            }
            if (ids.has(result.id_tracing)) throw new Error('No repitas el mismo seguimiento.');
            ids.add(result.id_tracing);
        }
        if (correcting) {
            result.id_tracing = text(row.id_tracing, 50, true);
            if (ids.has(result.id_tracing)) throw new Error('No repitas el mismo seguimiento.');
            ids.add(result.id_tracing);
            result.revision = revision(row.revision);
            result.change_reason = text(row.change_reason || body.change_reason, 1000, true);
        }
        return result;
    });
}

function revision(value) {
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('Abre de nuevo el seguimiento para obtener su revision actual.');
    return Number(value);
}

module.exports = { date, text, content, rows, revision };
