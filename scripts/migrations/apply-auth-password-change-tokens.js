'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const TABLE = 'auth_password_change_tokens';
const REQUIRED_COLUMNS = [
    'id', 'id_login', 'destination_email_fingerprint', 'code_hash', 'code_fingerprint',
    'pending_password_hash', 'source_password_fingerprint', 'status', 'attempts', 'max_attempts',
    'issued_at', 'expires_at', 'used_at', 'expired_at', 'locked_at', 'revoked_at',
    'requested_ip', 'requested_user_agent', 'created_at', 'updated_at'
];

async function main() {
    const expectedDatabase = value('--expect-database');
    if (!expectedDatabase || expectedDatabase !== config.DATABASEMYSQL) {
        throw new Error('Indica --expect-database con el nombre exacto de la base configurada.');
    }

    const connection = await mysql.createConnection({
        host: config.HOSTMYSQL,
        port: config.PORTMYSQL,
        user: config.USERMYSQL,
        password: config.PASSWORDMYSQL,
        database: config.DATABASEMYSQL,
        multipleStatements: false
    });

    try {
        const [tables] = await connection.query(
            'SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
            [TABLE]
        );
        if (tables.length) {
            const [columns] = await connection.query(`SHOW COLUMNS FROM \`${TABLE}\``);
            const existing = new Set(columns.map(column => column.Field));
            const missing = REQUIRED_COLUMNS.filter(column => !existing.has(column));
            if (missing.length) throw new Error(`La tabla existe con esquema incompleto. Faltan columnas: ${missing.join(', ')}.`);
            console.log('La tabla de confirmación de cambio de contraseña ya está instalada; no se hicieron cambios.');
            return;
        }

        if (!args.includes('--apply')) {
            console.log('Preflight correcto; no se hicieron cambios. Agrega --apply para crear la tabla.');
            return;
        }

        const sql = await fs.readFile(path.join(__dirname, 'sql/auth_password_change_tokens.sql'), 'utf8');
        await connection.query(sql);

        const [columns] = await connection.query(`SHOW COLUMNS FROM \`${TABLE}\``);
        const existing = new Set(columns.map(column => column.Field));
        const missing = REQUIRED_COLUMNS.filter(column => !existing.has(column));
        if (missing.length) throw new Error(`La migración terminó sin todas las columnas requeridas: ${missing.join(', ')}.`);
        console.log('Tabla de confirmación de cambio de contraseña instalada.');
    } finally {
        await connection.end();
    }
}

main().catch(error => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
