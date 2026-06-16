const response = require('./responsedata');

/**
 * Implementa la respuesta HttpRequest
 */
 class HttpResponseHelper {

    /**
     * Genera un Objeto HttpResponse de tipo success
     * @param {Number} statusCode 
     * @param {Any} dataContent 
     * @param {String} message 
     * @author Ing. Cristian Eduardo Mendez Iglesias
     * @author Ing. Marco Antonio Saraos Hernandez
     * @author Ing. Humberto Trinidad Dominguez
     * @returns 
     */
HttpSuccess = (statusCode = 200, dataContent = null, message = "")  =>{
    const data = response.success(dataContent, message);
    const status = statusCode;
    return {
        data,
        status
    }
}

/**
 * Genera un Objeto HttpResponse de tipo BadRequest
 * @param {Number} statusCode 
 * @param {string} message 
 * @param {any} datacontent 
 * @author Ing. Cristian Eduardo Mendez Iglesias
 * @author Ing. Marco Antonio Saraos Hernandez
 * @author Ing. Humberto Trinidad Dominguez
 * @returns 
 */
HttpNotSucces = (statusCode = 404, message = "",  datacontent = null) => {
    const data = response.notSuccess(message,datacontent);
    const status = statusCode;

    return {
        data,
        status
    }
}


/**
 * Genera un Objeto HttpResponse de tipo BadRequest
 * @param {Number} statusCode 
 * @param {string} message 
 * @param {any} datacontent 
 * @author Ing. Cristian Eduardo Mendez Iglesias
 * @author Ing. Marco Antonio Saraos Hernandez
 * @author Ing. Humberto Trinidad Dominguez
 * @returns 
 */
HttpNotAutorized = (statusCode = 401, message = "",  datacontent = null) => {
    const data = response.notSuccess(message,datacontent);
    const status = statusCode;

    return {
        data,
        status
    }
}

/**
 * Genera un Objeto HttpResponse de tipo Error
 * @param {Number} statusCode 
 * @param {String} message 
 * @author Ing. Cristian Eduardo Mendez Iglesias
 * @author Ing. Marco Antonio Saraos Hernandez
 * @author Ing. Humberto Trinidad Dominguez
 * @returns
 */
HttpError = (statusCode = 500, message = "") => {
    const data = response.error(message);
    const status = statusCode;
    return {
        data,
        status
    }
}


/**
 * Genera un Objeto HttpResponse de tipo BadRequest
 * @param {Number} statusCode 
 * @param {String} message 
 * @author Ing. Cristian Eduardo Mendez Iglesias
 * @author Ing. Marco Antonio Saraos Hernandez
 * @author Ing. Humberto Trinidad Dominguez
 * @returns
 */
HttpBadRequest = (statusCode = 400, message = "", datacontent = "") => {
    const data = response.bad_request(message, datacontent);
    const status = statusCode;
    return {
        data,
        status
    }
}

}

module.exports = HttpResponseHelper;