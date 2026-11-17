'use strict';
const C = require('./contract');
// Legacy forms use day-first dates; identity storage always uses ISO civil dates.
function normalizeBirthday(value) {
    if (typeof value !== 'string') C.fail('birthday');
    const match = value.match(/^(\d{2})([-/])(\d{2})\2(\d{4})$/);
    const iso = match ? `${match[4]}-${match[3]}-${match[1]}` : value;
    if (!C.date(iso) || iso > C.today()) C.fail('birthday');
    return iso;
}
function normalizePatient(body) {
    return {...body, person:{...body.person, birthday:normalizeBirthday(body.person && body.person.birthday)}};
}
module.exports = {normalizeBirthday, normalizePatient};
