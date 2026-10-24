const bcrypt = require('bcryptjs');

const BCRYPT_SALT_ROUNDS = 10;

async function encript(password) {
    try {
        return await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    } catch (error) {
        console.error(error);
    }
}

async function compare(password, storedPassword) {
    if (typeof storedPassword === 'string' && storedPassword.startsWith('scrypt-v1$')) {
        return require('../services/security/registrationPassword.service').verify(password, storedPassword);
    }
    try {
        // Login historically trims input. Preserve that behavior only for bcrypt;
        // scrypt credentials preserve spaces and use their versioned NFC policy.
        return await bcrypt.compare(typeof password === 'string' ? password.trim() : password, storedPassword);
    } catch (error) {
        console.error(error);
    }
}

module.exports={
    compare,
    encript
}
