const config = require('../config/config');
const https = require('https');

const serverKey = config.VUE_APP_FIREBASE_FCM_KEY;
const FCM_SEND_HOST = 'fcm.googleapis.com';
const FCM_SEND_PATH = '/fcm/send';

function sendFcmMessage(message) {
    return new Promise((resolve, reject) => {
        if(!serverKey) {
            reject(new Error('FIREBASE_FCM_KEY is not configured'));
            return;
        }

        const payload = JSON.stringify(message);
        const request = https.request({
            hostname: FCM_SEND_HOST,
            path: FCM_SEND_PATH,
            method: 'POST',
            headers: {
                Authorization: `key=${serverKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                if(response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(body);
                    return;
                }

                reject(new Error(`FCM request failed with status ${response.statusCode}`));
            });
        });

        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

async function sendMesage(){

    var message = { //this may vary according to the message type (single recipient, multicast, topic, et cetera)
        to: 'registration_token', 
        collapse_key: 'your_collapse_key',
        
        notification: {
            title: 'Title of your push notification', 
            body: 'Body of your push notification' 
        },
        
        data: {  //you can send only notification or only data(or include both)
            my_key: 'my value',
            my_another_key: 'my another value'
        }
    };

    try {
        const response = await sendFcmMessage(message);
        console.log("Successfully sent with response: ", response);
    } catch (err) {
        console.log("Something has gone wrong!");
    }
}


module.exports = {
    sendMesage,
    sendFcmMessage
}
