'use strict';
class RegistrationError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const invalidSession = () => Object.assign(new RegistrationError('AUTH_SESSION_INVALID'), {
    status: 401,
    code: 'AUTH_SESSION_INVALID'
});
module.exports = { RegistrationError, invalidSession };
