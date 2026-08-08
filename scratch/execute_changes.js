const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// Regex matches the remaining orphaned tags and duplicate note section at the bottom of the order list
const regex = /<\/div>\s*<!-- Team Note Remarks Section -->[\s\S]*?<\/template>/;

// Support both CRLF and LF by replacing CRLF temporarily
let tempContent = content.replace(/\r\n/g, '\n');

if (regex.test(tempContent)) {
    content = tempContent.replace(regex, '');
    console.log('Orphaned duplicate remarks block removed successfully.');
} else {
    console.error('Orphaned duplicate remarks block NOT found!');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
