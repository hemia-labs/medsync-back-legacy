const Api = require('./api.config');
const HttpStatus = require('../../util/httpstatus');

/**
 * Realiza una petición de tipo get a la url indicada
 * @param {String} url url 
 * @author Marco Antonio Saraos Hernandez
 * @author Cristian Eduardo Mendez Iglesias
 * @author Humberto Trinidad Dominguez
 * @returns Object
 */
 async function get(url, headers) {
    let response = null;
        let success = {success: false};
        try {
            
            let result = await Api.Product.get(url, headers);
            if(result && result.status == HttpStatus.SUCCESS) {
                success.success = true;
                response = result.data;
                response = {...response, ...success}
            }
        } catch (error) {
            response = error.response.data;
            response = {...response, ...success}
        }
        return response;
}

/**
 * Realiza una petición de tipo post a la url indicando su carga util
 * @param {String} url url a enviar
 * @param {any} payload Carga Util
 * @author Marco Antonio Saraos Hernandez
 * @author Cristian Eduardo Mendez Iglesias
 * @author Humberto Trinidad Dominguez
 * @returns Object
 */
 async function post(url, payload, headers)
 { 
     let response = null;
     let success = {success: false};
     try {
         let result = await Api.Product.post(url, payload, headers);
         if(result && result.status == HttpStatus.SUCCESS) {
             success.success = true;
             response = result.data;
             response = {...response, ...success}
         }
     } catch (error) {
         response = error.response.data;
         response = {...response, ...success}
     }
     return response;
 }

 /**
 * Realiza una petición de tipo put a la url indicando su carga util
 * @param {String} url url a enviar
 * @param {any} payload Carga Util
 * @author Marco Antonio Saraos Hernandez
 * @author Cristian Eduardo Mendez Iglesias
 * @author Humberto Trinidad Dominguez
 * @returns 
 */
  async function put(url, payload)
  { 
      let response = null;
      let success = {success: false};
      try {
          let result = await Api.Product.put(url, payload, headers);
          if(result && result.status == HttpStatus.SUCCESS) {
              success.success = true;
              response = result.data;
              response = {...response, ...success}
          }
      } catch (error) {
          response = error.response.data;
          response = {...response, ...success}
      }
      return response;
  }

module.exports = {
    get,
    post,
    put
}
