const { RATE_LIMIT_ERROR } = require('../util/authSecurityMessages');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_KEYS = 20000;
const buckets = new Map();

const LIMITS = {
    login: {
        endpoint: 'login',
        ip: Number(process.env.AUTH_LOGIN_IP_LIMIT || 20),
        identity: Number(process.env.AUTH_LOGIN_PHONE_FAILED_LIMIT || 5),
        identityMode: 'failure'
    },
    sendOtp: {
        endpoint: 'sendOtp',
        ip: Number(process.env.AUTH_SEND_OTP_IP_LIMIT || 10),
        identity: Number(process.env.AUTH_SEND_OTP_PHONE_LIMIT || 3),
        identityMode: 'request'
    },
    validateOtp: {
        endpoint: 'validateOtp',
        ip: Number(process.env.AUTH_VALIDATE_OTP_IP_LIMIT || 30),
        identity: Number(process.env.AUTH_VALIDATE_OTP_PHONE_LIMIT || 5),
        identityMode: 'request'
    },
    resetPassword: {
        endpoint: 'resetPassword',
        ip: Number(process.env.AUTH_RESET_PASSWORD_IP_LIMIT || 20),
        identity: Number(process.env.AUTH_RESET_PASSWORD_PHONE_LIMIT || 5),
        identityMode: 'request'
    }
};

function now() {
    return Date.now();
}

function getClientIp(req) {
    return req.ip ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown';
}

function cleanup(currentTime) {
    buckets.forEach((bucket, key) => {
        if (bucket.resetAt <= currentTime && (!bucket.lockedUntil || bucket.lockedUntil <= currentTime)) {
            buckets.delete(key);
        }
    });
}

function trimToMaxKeys(maxKeys) {
    while (buckets.size >= maxKeys) {
        const oldestKey = buckets.keys().next().value;
        if (!oldestKey) {
            return;
        }
        buckets.delete(oldestKey);
    }
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function getBucket(key, currentTime, windowMs, maxKeys) {
    cleanup(currentTime);

    const current = buckets.get(key);
    if (!current && buckets.size >= maxKeys) {
        trimToMaxKeys(maxKeys);
    }

    if (current && current.resetAt > currentTime) {
        return current;
    }

    const bucket = {
        count: 0,
        resetAt: currentTime + windowMs,
        lockedUntil: null
    };
    buckets.set(key, bucket);
    return bucket;
}

function increment(key, limit, options) {
    if (!key || !Number.isFinite(limit) || limit <= 0) {
        return { limited: false, remaining: limit };
    }

    const currentTime = now();
    const bucket = getBucket(key, currentTime, options.windowMs, options.maxKeys);

    if (bucket.lockedUntil && bucket.lockedUntil > currentTime) {
        return {
            limited: true,
            retryAfterSeconds: Math.ceil((bucket.lockedUntil - currentTime) / 1000),
            remaining: 0
        };
    }

    bucket.count += 1;

    if (bucket.count > limit) {
        bucket.lockedUntil = currentTime + options.lockMs;
        return {
            limited: true,
            retryAfterSeconds: Math.ceil(options.lockMs / 1000),
            remaining: 0
        };
    }

    return {
        limited: false,
        remaining: Math.max(limit - bucket.count, 0)
    };
}

function checkLocked(key, options) {
    if (!key) {
        return { limited: false };
    }

    const currentTime = now();
    const bucket = getBucket(key, currentTime, options.windowMs, options.maxKeys);

    if (bucket.lockedUntil && bucket.lockedUntil > currentTime) {
        return {
            limited: true,
            retryAfterSeconds: Math.ceil((bucket.lockedUntil - currentTime) / 1000),
            remaining: 0
        };
    }

    return { limited: false };
}

function reset(key) {
    if (key) {
        buckets.delete(key);
    }
}

function sendLimited(res, retryAfterSeconds) {
    if (retryAfterSeconds) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
    }

    res.status(429).send({
        status: 429,
        success: false,
        code: 'AUTH_RATE_LIMITED',
        data: null,
        message: RATE_LIMIT_ERROR
    });
}

function authRateLimit(type) {
    return (req, res, next) => {
        const config = LIMITS[type];
        if (!config) {
            next();
            return;
        }

        const options = {
            windowMs: positiveNumber(process.env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
            lockMs: positiveNumber(process.env.AUTH_LOCKOUT_MS, DEFAULT_LOCK_MS),
            maxKeys: positiveNumber(process.env.AUTH_RATE_LIMIT_MAX_KEYS, DEFAULT_MAX_KEYS)
        };

        const endpoint = config.endpoint;
        const ip = getClientIp(req);
        const phone = req.authIdentity && req.authIdentity.phone ? req.authIdentity.phone : null;
        const ipKey = `auth:${endpoint}:ip:${ip}`;
        const identityKey = phone ? `auth:${endpoint}:identity:${phone}` : null;

        const ipResult = increment(ipKey, config.ip, options);
        if (ipResult.limited) {
            sendLimited(res, ipResult.retryAfterSeconds);
            return;
        }

        if (identityKey && config.identityMode === 'request') {
            const identityResult = increment(identityKey, config.identity, options);
            if (identityResult.limited) {
                sendLimited(res, identityResult.retryAfterSeconds);
                return;
            }
        } else if (identityKey && config.identityMode === 'failure') {
            const identityLocked = checkLocked(identityKey, options);
            if (identityLocked.limited) {
                sendLimited(res, identityLocked.retryAfterSeconds);
                return;
            }
        }

        req.authRateLimit = {
            recordFailure: () => {
                if (identityKey && config.identityMode === 'failure') {
                    return increment(identityKey, config.identity, options);
                }
                return { limited: false };
            },
            recordSuccess: () => {
                if (identityKey && config.identityMode === 'failure') {
                    reset(identityKey);
                }
            },
            identityKey,
            ipKey,
            endpoint
        };

        next();
    };
}

module.exports = authRateLimit;
module.exports._private = {
    buckets,
    reset
};
