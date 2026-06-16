require('../../config/env');

const NodemailerProvider = require('./providers/nodemailer.provider');

function normalizeProviderName() {
    return String(process.env.EMAIL_PROVIDER || 'smtp').trim().toLowerCase();
}

function normalizeError(error, fallbackCode = 'EMAIL_SEND_FAILED') {
    return {
        success: false,
        provider: normalizeProviderName(),
        code: error && error.code ? error.code : fallbackCode,
        message: error && error.safe ? error.message : 'No se pudo enviar el correo.'
    };
}

function isTestEnvironment() {
    return String(process.env.NODE_ENV || process.env.APP_ENV || process.env.ENVIRONMENT || '').toLowerCase() === 'test';
}

class EmailService {
    provider() {
        const provider = normalizeProviderName();

        if (provider === 'disabled') {
            return null;
        }

        if (provider === 'smtp') {
            return new NodemailerProvider();
        }

        const error = new Error('EMAIL_PROVIDER no esta soportado.');
        error.code = 'EMAIL_PROVIDER_UNSUPPORTED';
        error.safe = true;
        throw error;
    }

    async sendTransactionalEmail(message) {
        try {
            const provider = this.provider();

            if (!provider) {
                if (isTestEnvironment()) {
                    return {
                        success: true,
                        provider: 'disabled',
                        messageId: 'disabled-provider-test'
                    };
                }

                return {
                    success: false,
                    provider: 'disabled',
                    code: 'EMAIL_PROVIDER_DISABLED',
                    message: 'El proveedor de correo esta deshabilitado.'
                };
            }

            return await provider.send(message);
        } catch (error) {
            return normalizeError(error);
        }
    }
}

module.exports = new EmailService();
