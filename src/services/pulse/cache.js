'use strict';
class PulseCache {
    constructor({ maxEntries = 100, maxBytes = 16 * 1048576, now = Date.now, onMetric = () => {} } = {}) { this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.now = now; this.onMetric = onMetric; this.entries = new Map(); this.pending = new Map(); this.generations = new Map(); this.bytes = 0; this.revision = 0; }
    generation(key) { return this.generations.get(key) || 0; }
    invalidate(key) { if (!key) return; if (this.entries.has(key) || this.pending.has(key)) this.generations.set(key, ++this.revision); const entry = this.entries.get(key); if (entry) entry.expires = 0; this.onMetric('invalidated'); }
    remove(key) { const old = this.entries.get(key); if (old) this.bytes -= old.bytes; this.entries.delete(key); if (!this.pending.has(key)) this.generations.delete(key); }
    async get(key, loader, { force = false } = {}) {
        const now = this.now(), old = this.entries.get(key);
        if (old && old.expires > now && (!force || now - old.calculated < 5000)) {
            this.entries.delete(key); this.entries.set(key, old); this.onMetric('hit');
            return { snapshot: old.snapshot, refreshPending: force, metrics: { cache: 'hit', queries: 0 } };
        }
        if (this.pending.has(key)) { this.onMetric('coalesced'); return this.pending.get(key); }
        if (this.pending.size >= this.maxEntries) { this.onMetric('busy'); throw Object.assign(Error('PULSE_BUSY'), { status: 503 }); }
        const promise = Promise.resolve().then(async () => {
            try {
                for (let attempt = 0; attempt < 2; attempt++) {
                    const generation = this.generation(key), asOf = this.now();
                    const result = await loader({ asOf, generation, previous: this.entries.get(key)?.snapshot || null });
                    if (generation !== this.generation(key) || (result.snapshot && Date.parse(result.snapshot.snapshot.validUntil) <= this.now())) continue;
                    if (!result.snapshot) throw Object.assign(Error('PULSE_UNAVAILABLE'), { status: 503 });
                    const snapshot = result.snapshot, bytes = Buffer.byteLength(JSON.stringify(snapshot));
                    this.remove(key);
                    if (bytes <= this.maxBytes) {
                        this.entries.set(key, { snapshot, bytes, calculated: asOf, expires: Math.min(Date.parse(snapshot.snapshot.validUntil), asOf + (snapshot.quality.evaluated === 3 && !snapshot.errors?.length ? 30000 : 5000)) }); this.bytes += bytes;
                        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
                    }
                    this.onMetric('miss'); return { ...result, refreshPending: false };
                }
                this.onMetric('changedDuringRead'); throw Object.assign(Error('PULSE_CHANGED_DURING_READ'), { status: 503 });
            } finally { this.pending.delete(key); if (!this.entries.has(key)) this.generations.delete(key); }
        });
        this.pending.set(key, promise); return promise;
    }
}
module.exports = { PulseCache };
