'use strict';
const { CATALOG, fail } = require('./operations');
const GLOBAL_ALIASES = Object.freeze({ caries:'car', fractura:'fx', restos:'rr', resina:'res', amalgama:'a', sellador:'sel', corona:'cor', endodoncia:'endo', implante:'imp', extraccion:'ext', ausente:'aus', noerupcionado:'ne', sano:'ok', revisado:'ok', presente:'pres' });
const RESERVED = new Set([...CATALOG.map(item=>item.code),'ok','pres','note','nota','undo','help','ayuda','constructor','prototype','tostring']);
function normalizeAlias(value) {
    if (typeof value !== 'string') fail('Abreviatura inválida.');
    const key=value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if (!/^[a-z]{1,30}$/.test(key)) fail('Usa una palabra de hasta 30 letras, sin números ni comandos.');
    return key;
}
const validTarget = target => CATALOG.some(item=>item.code===target)||['ok','pres'].includes(target);
module.exports={GLOBAL_ALIASES,RESERVED,normalizeAlias,validTarget};
