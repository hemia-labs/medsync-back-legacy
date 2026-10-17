const LABELS = { blood_pressure: 'Presión arterial', heart_rate: 'Frecuencia cardiaca', respiratory_rate: 'Frecuencia respiratoria', temperature: 'Temperatura', oxygen_saturation: 'Saturación de oxígeno', weight: 'Peso', height: 'Talla', bmi: 'IMC' };

const vitalSignError = (key, value) => {
    if (value === '' || value === undefined || value === null || !LABELS[key]) return '';
    if (typeof value !== 'string' && typeof value !== 'number') return 'Ingresa un número igual o mayor que cero, sin letras.';
    const text = String(value).trim();
    if (key === 'blood_pressure') return /^\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?$/.test(text) ? '' : 'Usa sistólica/diastólica en mmHg, por ejemplo 120/80.';
    if (!/^\d+(?:[.,]\d+)?$/.test(text) || !Number.isFinite(Number(text.replace(',', '.')))) return 'Ingresa un número igual o mayor que cero, sin letras.';
    if (key === 'oxygen_saturation' && Number(text.replace(',', '.')) > 100) return 'La saturación debe estar entre 0 y 100 %.';
    return '';
};

const validateVitalSigns = snapshot => {
    const signs = snapshot && snapshot.vital_signs;
    if (signs == null) return '';
    if (typeof signs !== 'object' || Array.isArray(signs)) return 'Signos vitales: formato inválido.';
    for (const [key, value] of Object.entries(signs)) {
        const error = vitalSignError(key, value);
        if (error) return `${LABELS[key]}: ${error}`;
    }
    return '';
};

module.exports = { vitalSignError, validateVitalSigns };
