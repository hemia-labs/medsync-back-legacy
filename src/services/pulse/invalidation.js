'use strict';
// Local notifications only; other processes reconcile via TTL <=30s.
const listeners = new Set();
function invalidate(business) { if (!business) return; for (const fn of listeners) { try { fn(String(business)); } catch (_) { /* Never turn a saved operation into an error because of a cache listener. */ } } }
function afterCommit(transaction, business) { if (transaction) transaction.afterCommit(() => invalidate(business)); else invalidate(business); }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
module.exports = { invalidate, afterCommit, subscribe };
