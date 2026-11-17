const HttpResponseHelper = require('../util/httpResponse');
const HttpStatus = require('../util/httpStatusCode');

const httpResponseHelper = new HttpResponseHelper();

const validatePayload = (validator) => {
    return (req, res, next) => {
        const result = validator(req);

        if (result && result.isValid === false) {
            const response = result.data === undefined
                ? httpResponseHelper.HttpBadRequest(HttpStatus.BAD_REQUEST, result.message)
                : httpResponseHelper.HttpBadRequest(HttpStatus.BAD_REQUEST, result.message, result.data);
            res.status(response.status).send(response.data);
            return;
        }

        next();
    };
};

module.exports = validatePayload;
