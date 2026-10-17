const fs = require('node:fs');
const path = require('node:path');

// Workspace schema exports are a local documentation convenience. A standalone
// repository checkout must not fail after applying DDL because that sibling
// directory is absent. Migration inputs live inside scripts/migrations/sql.
function schemaExportDirectory(workspace, directory) {
    const root = path.join(workspace, 'u575589445_orrico');
    try {
        if (!fs.statSync(root).isDirectory()) return null;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const target = path.join(root, directory);
    fs.mkdirSync(target, { recursive: true });
    return target;
}

module.exports = { schemaExportDirectory };
