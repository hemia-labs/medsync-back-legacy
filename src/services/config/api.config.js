const axios =require('axios').default;
const config = require('../../config/http');


const Paypal = axios.create({baseURL: config.APP_PAYPAL_URL});

module.exports = {
    Paypal: Paypal
}