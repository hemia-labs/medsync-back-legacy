const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_MAX_KEYS = 10000;
const buckets = new Map();

function clientIp(req) {
    return req.ip ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown';
}

function cleanup(now) {
    buckets.forEach((bucket, key) => {
        if (bucket.resetAt <= now) {
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

module.exports = function publicRateLimit(options = {}) {
    const windowMs = positiveNumber(options.windowMs, DEFAULT_WINDOW_MS);
    const maxRequests = positiveNumber(options.maxRequests, DEFAULT_MAX_REQUESTS);
    const maxKeys = positiveNumber(options.maxKeys, DEFAULT_MAX_KEYS);
    const keyPrefix = options.keyPrefix || 'public';

    return function publicRateLimitMiddleware(req, res, next) {
        const now = Date.now();
        cleanup(now);

        const key = `${keyPrefix}:${clientIp(req)}`;
        const current = buckets.get(key);
        if (!current && buckets.size >= maxKeys) {
            trimToMaxKeys(maxKeys);
        }

        const bucket = current && current.resetAt > now
            ? current
            : { count: 0, resetAt: now + windowMs };

        bucket.count += 1;
        buckets.set(key, bucket);

        res.setHeader('X-RateLimit-Limit', String(maxRequests));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(maxRequests - bucket.count, 0)));

        if (bucket.count > maxRequests) {
            res.status(429).send({
                status: 429,
                success: false,
                code: 'PUBLIC_RATE_LIMITED',
                data: null,
                message: 'Demasiadas solicitudes. Intenta de nuevo mas tarde.'
            });
            return;
        }

        next();
    };
};
