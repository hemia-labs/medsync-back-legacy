
const setHeaders = (response, res) => {
    const headers = response.data.headers;
    if(headers){
        Object.keys(headers).forEach(key => {
            if(headers[key]) res.setHeader(key, headers[key]);
        });
        delete response.data.headers;
    }
}


const getHeaders = (request) => {
    const headers = request.headers;
    const _res = {};
    if(headers){
        Object.keys(headers).forEach(key => {
            if(headers[key]){
                _res[key] = headers[key];
            }
        });
    }
    return _res;
}

module.exports = {
    setHeaders,
    getHeaders
}