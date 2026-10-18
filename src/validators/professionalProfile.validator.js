const PROFESSIONAL_PHONE_MESSAGE = 'El teléfono profesional debe contener de 10 a 15 dígitos. Puedes usar + al inicio, espacios, paréntesis o guiones, o dejar el campo vacío.';

function validateProfessionalPhone(value) {
    if(value === undefined || value === null || value === '') return { isValid: true, value: '' };
    if(typeof value !== 'string') return { isValid: false, message: PROFESSIONAL_PHONE_MESSAGE };
    const phone = value.trim();
    if(!phone) return { isValid: true, value: '' };
    const digits = phone.replace(/\D/g, '');
    if(!/^\+?[\d\s().-]+$/.test(phone) || digits.length < 10 || digits.length > 15 || phone.length > 100) {
        return { isValid: false, message: PROFESSIONAL_PHONE_MESSAGE };
    }
    return { isValid: true, value: (phone.startsWith('+') ? '+' : '') + digits };
}

module.exports = { validateProfessionalPhone };
