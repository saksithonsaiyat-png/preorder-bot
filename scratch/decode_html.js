const fs = require('fs');
const path = require('path');

function decodeFile(inputName, outputName) {
    const inputPath = path.join(__dirname, '..', inputName);
    const outputPath = path.join(__dirname, outputName);
    if (!fs.existsSync(inputPath)) {
        console.error('File not found:', inputPath);
        return;
    }
    const content = fs.readFileSync(inputPath, 'utf8');
    const decoded = content
        .replace(/</g, '[')
        .replace(/>/g, ']');
    fs.writeFileSync(outputPath, decoded, 'utf8');
    console.log(`Successfully decoded ${inputName} to scratch/${outputName}`);
}

decodeFile('index.html', 'index_decoded.txt');
decodeFile('admin.html', 'admin_decoded.txt');
