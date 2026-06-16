'use strict'
const HttpStatus = require('./httpStatusCode');

function success(data_res, message_res) {
    let response = {
        status: HttpStatus.OK,
        data: data_res,
        message: message_res
    }
    return response;
}

function notSuccess(message_res, data = null) {
    let response = {
        status: HttpStatus.NOT_FOUND,
        data: data,
        message: message_res
    }
    return response;
}

function error(message_res) {
    let response = {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        data: null,
        message: message_res
    }
    return response;
}

function bad_request(message_res, data = null) {
    let response = {
        status: HttpStatus.BAD_REQUEST,
        data: data,
        message: message_res
    }
    return response;
}

function unauthorized(message_res, data = null) {
    let response = {
        status: HttpStatus.UNAUTHORIZED,
        data: data,
        message: message_res
    }
    return response;
}

function forbidden(message_res, data = null) {
    let response = {
        status: HttpStatus.FORBIDDEN,
        data: data,
        message: message_res
    }
    return response;
}



module.exports = {
    success,
    notSuccess,
    error,
    bad_request,
    unauthorized,
    forbidden
}
