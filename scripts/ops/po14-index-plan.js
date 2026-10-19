'use strict';
// Offline only. Prints a review plan; never opens a connection or executes DDL.
const candidates = require('./po14-index-candidates.json');
function render() {
    const lines = ['-- PO14 CANDIDATES ONLY. No statements below execute DDL.',
        '-- Verify SHOW INDEX/EXPLAIN on isolated QA, equivalent leading indexes, disk headroom, write cost and rollback first.',
        '-- Choose candidates individually; the prescription indexes are alternatives until measured.',
        '-- ALGORITHM=INPLACE/LOCK=NONE request online DDL, but metadata locks and resource use remain possible.'];
    for (const candidate of candidates) {
        const columns = candidate.columns.map(column => {
            const [name, direction] = column.split(' ');
            return '`' + name + '`' + (direction ? ' ' + direction : '');
        }).join(', ');
        lines.push('', `-- ${candidate.priority}: ${candidate.purpose}`,
            `-- ALTER TABLE \`${candidate.table}\` ADD INDEX \`${candidate.name}\` (${columns}), ALGORITHM=INPLACE, LOCK=NONE;`,
            `-- Rollback only if this new index was actually added and is no longer needed:`,
            `-- ALTER TABLE \`${candidate.table}\` DROP INDEX \`${candidate.name}\`, ALGORITHM=INPLACE, LOCK=NONE;`);
    }
    return lines.join('\n') + '\n';
}
if (require.main === module) process.stdout.write(render());
module.exports = { render, candidates };
