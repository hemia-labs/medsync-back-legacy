const responseData = require('../util/responsedata');
const AuthCookieConfig = require('../config/authCookie.config');

const PHONE_MIN_LENGTH = 7;
const PHONE_MAX_LENGTH = 15;
const OTP_MIN_LENGTH = 4;
const OTP_MAX_LENGTH = 12;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const ALLOWED_FIELDS = {
    login: ['param', 'pwd', 'refresh', 'secretkey', 'timestamp', 'signature'],
    sendOtp: ['phone'],
    validateOtp: ['telephone', 'phone', 'code'],
    resetPassword: ['phone', 'telephone', 'otp', 'code', 'password', 'confirmPassword'],
    requestPasswordChangeCode: ['currentPassword', 'newPassword', 'confirmPassword'],
    confirmPasswordChange: ['code'],
    refreshToken: ['id_refresh_token', 'refresh_token']
};

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizePassword(value) {
    return typeof value === 'string' ? value : '';
}

function normalizePhone(value) {
    return normalizeString(String(value === undefined || value === null ? '' : value)).replace(/\D/g, '');
}

function isValidPhone(phone) {
    return /^\d+$/.test(phone) && phone.length >= PHONE_MIN_LENGTH && phone.length <= PHONE_MAX_LENGTH;
}

function normalizeOtp(value) {
    return normalizeString(String(value === undefined || value === null ? '' : value));
}

function isValidOtp(code) {
    return /^[A-Za-z0-9]+$/.test(code) && code.length >= OTP_MIN_LENGTH && code.length <= OTP_MAX_LENGTH;
}

function normalizeBoolean(value) {
    if (value === true || value === false) {
        return value;
    }

    const normalized = normalizeString(String(value)).toLowerCase();
    return ['1', 'true', 'yes', 'si'].includes(normalized);
}

function hasUnexpectedFields(body, allowedFields) {
    return Object.keys(body || {}).filter((field) => !allowedFields.includes(field));
}

function passwordPolicyError(password) {
    if (!password) {
        return 'La contrasena es requerida.';
    }

    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        return `La contrasena debe tener entre ${PASSWORD_MIN_LENGTH} y ${PASSWORD_MAX_LENGTH} caracteres.`;
    }

    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return 'La contrasena debe incluir al menos una letra y un numero.';
    }

    return null;
}

function reject(res, message) {
    const response = responseData.bad_request(message);
    res.status(response.status).send(response);
}

function hasD2BrowserCookieAuth() {
    return AuthCookieConfig.getAuthCookieConfig().isCookieAuthEnabled;
}

function validateAuthPayload(type) {
    return (req, res, next) => {
        const body = req.body || {};
        const allowedFields = ALLOWED_FIELDS[type] || [];
        const unexpectedFields = hasUnexpectedFields(body, allowedFields);

        if (unexpectedFields.length > 0) {
            reject(res, `Campos no permitidos: ${unexpectedFields.join(', ')}.`);
            return;
        }

        if (type === 'login') {
            const phone = normalizePhone(body.param);
            const pwd = typeof body.pwd === 'string' ? body.pwd : '';

            if (!isValidPhone(phone)) {
                reject(res, 'El telefono es requerido y debe contener entre 7 y 15 digitos.');
                return;
            }

            if (!pwd || pwd.length > 1024) {
                reject(res, 'La contrasena es requerida.');
                return;
            }

            req.body = {
                ...body,
                param: phone,
                pwd,
                refresh: normalizeBoolean(body.refresh)
            };
            req.authIdentity = { phone };
            next();
            return;
        }

        if (type === 'sendOtp') {
            const phone = normalizePhone(body.phone);

            if (!isValidPhone(phone)) {
                reject(res, 'El telefono es requerido y debe contener entre 7 y 15 digitos.');
                return;
            }

            req.body = { phone };
            req.authIdentity = { phone };
            next();
            return;
        }

        if (type === 'validateOtp') {
            const phone = normalizePhone(body.telephone || body.phone);
            const code = normalizeOtp(body.code);

            if (!isValidPhone(phone)) {
                reject(res, 'El telefono es requerido y debe contener entre 7 y 15 digitos.');
                return;
            }

            if (!isValidOtp(code)) {
                reject(res, 'El codigo de recuperacion tiene un formato invalido.');
                return;
            }

            req.body = { telephone: phone, code };
            req.authIdentity = { phone };
            next();
            return;
        }

        if (type === 'resetPassword') {
            const phone = normalizePhone(body.phone || body.telephone);
            const otp = normalizeOtp(body.otp || body.code);
            const identityMode = require('../services/registration/identityAuth').enabled();
            const password = identityMode && typeof body.password === 'string' ? body.password : normalizeString(body.password);
            const confirmPassword = body.confirmPassword === undefined ? null : identityMode ? body.confirmPassword : normalizeString(body.confirmPassword);

            if (!isValidPhone(phone)) {
                reject(res, 'El telefono es requerido y debe contener entre 7 y 15 digitos.');
                return;
            }

            if (!isValidOtp(otp)) {
                reject(res, 'El codigo de recuperacion tiene un formato invalido.');
                return;
            }

            if (confirmPassword !== null && password !== confirmPassword) {
                reject(res, 'La confirmacion de contrasena no coincide.');
                return;
            }

            let passwordError = passwordPolicyError(password);
            if (identityMode) {
                try { require('../services/security/registrationPassword.service').normalizePassword(password); passwordError = null; }
                catch (_) { /* The DAO applies the exact policy of the stored hash version. */ }
            }
            if (passwordError) {
                reject(res, passwordError);
                return;
            }

            req.body = { phone, otp, password };
            req.authIdentity = { phone };
            next();
            return;
        }

        if (type === 'requestPasswordChangeCode') {
            const currentPassword = normalizePassword(body.currentPassword);
            const newPassword = normalizePassword(body.newPassword);
            const confirmPassword = normalizePassword(body.confirmPassword);

            if (!currentPassword.trim()) {
                reject(res, 'La contrasena actual es requerida.');
                return;
            }

            if (newPassword !== confirmPassword) {
                reject(res, 'La confirmacion de contrasena no coincide.');
                return;
            }

            const passwordError = passwordPolicyError(newPassword);
            if (passwordError) {
                reject(res, passwordError);
                return;
            }

            if (newPassword === currentPassword) {
                reject(res, 'Elige una contrasena diferente de la actual.');
                return;
            }

            req.body = { currentPassword, newPassword, confirmPassword };
            req.authIdentity = { loginId: req.tokenDecode && req.tokenDecode.id_login };
            next();
            return;
        }

        if (type === 'confirmPasswordChange') {
            const code = normalizeOtp(body.code);

            if (!isValidOtp(code)) {
                reject(res, 'El codigo de verificacion tiene un formato invalido.');
                return;
            }

            req.body = { code };
            req.authIdentity = { loginId: req.tokenDecode && req.tokenDecode.id_login };
            next();
            return;
        }

        if (type === 'refreshToken') {
            if (hasD2BrowserCookieAuth()) {
                req.body = {};
                next();
                return;
            }

            const refreshToken = normalizeString(body.id_refresh_token || body.refresh_token);

            if (!refreshToken || refreshToken.length > 255) {
                reject(res, 'Refresh token requerido.');
                return;
            }

            req.body = { id_refresh_token: refreshToken };
            next();
            return;
        }

        next();
    };
}

module.exports = {
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    isValidPhone,
    normalizePhone,
    validateAuthPayload
};
