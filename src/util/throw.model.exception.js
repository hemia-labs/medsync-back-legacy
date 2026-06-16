exports.throwModelException = (object) => {
    let response = [];
    if(typeof object !== 'object') {
        throw new Error('Invalid input');
    }
     let keys = Object.keys(object);

     if(keys) {
        response = [];
         for(key of keys) {
           let message = object[key].message;
           let path = object[key].path;
           if(message) {
               //response.push({path: path, message: message});
               response.push(message);
           }
         }
     }
     return response;
}

