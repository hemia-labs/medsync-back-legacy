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
    try {
        return await bcrypt.compare(password, storedPassword);
    } catch (error) {
        console.error(error);
    }
}

module.exports={
    compare,
    encript
}