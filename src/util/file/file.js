const {v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const allowedImageTypes = ['jpeg', 'jpg', 'png', 'webp'];
const maxImageBytes = Number(process.env.MAX_IMAGE_UPLOAD_BYTES || 5 * 1024 * 1024);

const base64Toimg=(base64) => {
    if (!base64 || typeof base64 !== 'string') {
        return null;
    }

    const match = base64.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!match) {
        return null;
    }

    let xtension = match[1].toLowerCase();
    if (xtension === 'jpeg') {
        xtension = 'jpg';
    }

    if (!allowedImageTypes.includes(xtension)) {
        return null;
    }

    const base64Image = match[2];
    const buffer = Buffer.from(base64Image, 'base64');

    if (!buffer.length || buffer.length > maxImageBytes) {
        return null;
    }

    const filename = uuidv4() + "." + xtension;
    const pathfile = path.join('src', 'tempFolder', filename);

    fs.writeFileSync(pathfile, buffer);

    return {path : pathfile, id : uuidv4()+'.'+xtension};
};


const formDataToimg=(formData) => {
    // let array = base64.split(';base64,');
    // if(!array || array.length < 1){
    //     return null;
    // }
    // let xtension = array[0].split('/').pop();
    // let base64Image = base64.split(';base64,').pop();
    const pathfile = 'src/tempFolder/'+uuidv4() + ".";// + xtension;
    // fs.writeFile(pathfile,base64Image,'base64',function(err){
    //     return null;
    // })

    return {path : pathfile, id : uuidv4()+'.'};
};

const deleteFile=(pathfile) => {
    if (!pathfile || !fs.existsSync(pathfile)) {
        return false;
    }

    fs.unlinkSync(pathfile);
    return true;
};

const readFileWithPath=(pathfile)=>{
    let result = null;
    if( fs.existsSync(pathfile) ){
        result = require(pathfile);
    }
    return result;
}


module.exports = {
    base64Toimg,
    formDataToimg,
    deleteFile,
    readFileWithPath
};
