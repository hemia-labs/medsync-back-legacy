'use strict';
const {createHash}=require('node:crypto');
const {fail}=require('./contract');
// JSON objects are order-independent; omitted fields and explicit null remain different requests.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operation(business,key,identity,expectedRevision) {
    // Older clients can still create without the header; only keyed requests have the replay guarantee.
    if(key===undefined)return null;
    if(typeof key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))fail('Idempotency-Key','IDEMPOTENCY_KEY_INVALID');
    return {
        id:'ce_'+digest(['medsync.establishment.create.v1',business,key]).slice(0,40),
        hash:digest(canonical({identity,expectedRevision}))
    };
}
module.exports={operation};
