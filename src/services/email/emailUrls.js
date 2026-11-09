'use strict';

const { getRuntimeEnv } = require('../../config/runtimeEnvironment');

function isEmailUrl(value, { allowLocalApp = false } = {}) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false;
    try {
        const url = new URL(value);
        if (!url.hostname || url.username || url.password) return false;
        if (url.protocol === 'https:') return true;
        return allowLocalApp && getRuntimeEnv() === 'development' && url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && url.origin === new URL(process.env.PUBLIC_APP_URL).origin;
    } catch (_) { return false; }
}

module.exports = { isEmailUrl };
