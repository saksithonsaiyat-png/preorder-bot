const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const serverPath = path.join(__dirname, '..', 'server.js');
let serverContent = fs.readFileSync(serverPath, 'utf8');

// Replace scraper call with Promise.resolve() to bypass live scraping during layout validation
const targetCall = 'fetchTargetOrdersForUser(username).finally';
const replacementCall = 'Promise.resolve().finally';

if (serverContent.includes(targetCall)) {
    serverContent = serverContent.replace(targetCall, replacementCall);
    fs.writeFileSync(serverPath, serverContent, 'utf8');
    console.log('Temporarily mocked scraper in server.js.');
} else {
    console.error('Target scraper call not found in server.js!');
}
