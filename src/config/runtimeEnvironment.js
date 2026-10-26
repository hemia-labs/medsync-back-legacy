'use strict';

const normalize = value => String(value || '').trim().toLowerCase();

// A production label always wins, including over an explicit runtime override.
// Keep this module dependency-free: security and cookie config both consume it.
function getRuntimeEnv(env = process.env, runtimeOverride) {
    const labels = [runtimeOverride, env.APP_ENV, env.ENVIRONMENT, env.NODE_ENV].map(normalize);
    if(labels.some(label => label === 'production' || label === 'prod')) return 'production';
    return labels.find(Boolean) || 'development';
}

function isProductionLike(env = process.env, runtimeOverride) {
    return getRuntimeEnv(env, runtimeOverride) === 'production';
}

module.exports = { getRuntimeEnv, isProductionLike };
