require('../../../config/env');

const nodemailer = require('nodemailer');

function booleanEnv(value) {
    return ['true', '1', 'yes'].includes(String(value || '').toLowerCase());
}

function safeConfigError(message) {
    const error = new Error(message);
    error.code = 'EMAIL_SMTP_CONFIG_INVALID';
    error.safe = true;
    return error;
}

function smtpConfig() {
    return {
        host: String(process.env.SMTP_HOST || '').trim(),
        port: Number(process.env.SMTP_PORT || 587),
        secure: booleanEnv(process.env.SMTP_SECURE),
        user: String(process.env.SMTP_USER || '').trim(),
        password: String(process.env.SMTP_PASSWORD || process.env.SMTP_PASS || ''),
        from: String(process.env.EMAIL_FROM || '').trim(),
        replyTo: String(process.env.EMAIL_REPLY_TO || '').trim()
    };
}

function validateConfig(config) {
    if (!config.host) {
        throw safeConfigError('SMTP_HOST no esta configurado.');
    }
    if (!Number.isFinite(config.port) || config.port <= 0) {
        throw safeConfigError('SMTP_PORT no tiene un valor valido.');
    }
    if (!config.from) {
        throw safeConfigError('EMAIL_FROM no esta configurado.');
    }
    if (!config.user || !config.password) {
        throw safeConfigError('SMTP_USER y SMTP_PASSWORD o SMTP_PASS deben estar configurados.');
    }
}

class NodemailerProvider {
    initialize() { validateConfig(this.config); }
    constructor() {
        this.config = smtpConfig();
    }

    createTransporter() {
        validateConfig(this.config);
        return nodemailer.createTransport({
            host: this.config.host,
            port: this.config.port,
            secure: this.config.secure,
            auth: {
                user: this.config.user,
                pass: this.config.password
            }
        });
    }

    async send({ to, subject, html, text }) {
        const transporter = this.createTransporter();
        const message = {
            from: this.config.from,
            to,
            subject,
            html,
            text
        };

        if (this.config.replyTo) {
            message.replyTo = this.config.replyTo;
        }

        const result = await transporter.sendMail(message);
        return {
            success: Boolean(result && result.messageId),
            provider: 'smtp',
            messageId: result && result.messageId ? result.messageId : null
        };
    }

    async verify() {
        const transporter = this.createTransporter();
        return transporter.verify();
    }
}

module.exports = NodemailerProvider;
