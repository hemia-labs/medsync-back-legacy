'use strict';
function text(value, max) {
    return typeof value === 'string' && value.isWellFormed() && value.trim() && [...value.trim()].length <= max ? value.trim() : null;
}
// Keep the historical full name for old clients; never guess where surnames begin.
// NC1 identidad simple: users may send first_surname / second_surname. Then `last_name` is derived (joined),
// at least one surname is required (as «Apellidos» was), and an empty surname stays null (pending).
// Older clients that send last_name keep working; a changed last_name drops the structured surnames, because
// the new text cannot be split safely. The result always carries first_surname/second_surname (null = unknown).
function userNames(input, current = null) {
    const structured = Object.hasOwn(input, 'first_surname') || Object.hasOwn(input, 'second_surname');
    const separated = structured || Object.hasOwn(input, 'first_name') || Object.hasOwn(input, 'last_name');
    const keep = { first_surname: current?.first_surname ?? null, second_surname: current?.second_surname ?? null };
    if (!separated && current && (input.name === undefined || input.name === current.name)) {
        if (!text(current.name, 500)) return null;
        return { name: current.name, first_name: current.first_name ?? current.name, last_name: current.last_name ?? '', ...keep };
    }
    if (structured) {
        const first = text(input.first_name === undefined ? current?.first_name : input.first_name, 200);
        const pick = key => (input[key] === undefined ? current?.[key] : input[key]);
        const blank = value => value == null || (typeof value === 'string' && !value.trim());
        const surnames = ['first_surname', 'second_surname'].map(key => (blank(pick(key)) ? null : text(pick(key), 200)));
        // A non-blank value that is not valid text (type, encoding, length) is rejected, not silently dropped.
        if (['first_surname', 'second_surname'].some((key, i) => !blank(pick(key)) && surnames[i] === null)) return null;
        const last = surnames.filter(Boolean).join(' ');
        if (!first || !last || [...first, ' ', ...last].length > 200) return null;
        // Clients may also send last_name (so a server without this change still works); it must be the same join.
        if (Object.hasOwn(input, 'last_name') && text(input.last_name, 200) !== last) return null;
        return { first_name: first, last_name: last, name: first + ' ' + last, first_surname: surnames[0], second_surname: surnames[1] };
    }
    if (separated) {
        const first = text(input.first_name === undefined ? current?.first_name : input.first_name, 200);
        const last = text(input.last_name === undefined ? current?.last_name : input.last_name, 200);
        if (!first || !last || [...first, ' ', ...last].length > 200) return null;
        const sameLast = current && last === current.last_name;
        return { first_name: first, last_name: last, name: first + ' ' + last, ...(sameLast ? keep : { first_surname: null, second_surname: null }) };
    }
    const name = text(input.name === undefined ? current?.name : input.name, 500);
    if (!name) return null;
    const sameName = current?.name === name;
    return { name, first_name: sameName ? current.first_name || name : name, last_name: sameName ? current.last_name || '' : '',
        ...(sameName ? keep : { first_surname: null, second_surname: null }) };
}
module.exports = { userNames };
