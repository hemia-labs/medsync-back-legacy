'use strict';
function text(value, max) {
    return typeof value === 'string' && value.isWellFormed() && value.trim() && [...value.trim()].length <= max ? value.trim() : null;
}
// Keep the historical full name for old clients; never guess where surnames begin.
function userNames(input, current = null) {
    const separated = Object.hasOwn(input, 'first_name') || Object.hasOwn(input, 'last_name');
    if (!separated && current && (input.name === undefined || input.name === current.name)) {
        if (!text(current.name, 500)) return null;
        return { name: current.name, first_name: current.first_name ?? current.name, last_name: current.last_name ?? '' };
    }
    if (separated) {
        const first = text(input.first_name === undefined ? current?.first_name : input.first_name, 200);
        const last = text(input.last_name === undefined ? current?.last_name : input.last_name, 200);
        if (!first || !last || [...first, ' ', ...last].length > 200) return null;
        return { first_name: first, last_name: last, name: first + ' ' + last };
    }
    const name = text(input.name === undefined ? current?.name : input.name, 500);
    if (!name) return null;
    return { name, first_name: current?.name === name ? current.first_name || name : name, last_name: current?.name === name ? current.last_name || '' : '' };
}
module.exports = { userNames };
