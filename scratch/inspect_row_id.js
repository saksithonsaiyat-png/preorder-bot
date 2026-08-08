const puppeteer = require('puppeteer');
const path = require('path');

const dbPath = path.resolve(__dirname, '../checkorder.db');
let targetCookies = null;

try {
    const { DatabaseSync } = require('node:sqlite');
    const nativeDb = new DatabaseSync(dbPath);
    const row = nativeDb.prepare("SELECT value FROM system_settings WHERE key = 'target_cookies'").get();
    if (row) targetCookies = row.value;
} catch (e) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);
    db.get("SELECT value FROM system_settings WHERE key = 'target_cookies'", [], (err, row) => {
        if (row) targetCookies = row.value;
    });
}

const TARGET_BASE_URL = 'https://thewestern.rdcw.xyz';

async function run() {
    await new Promise(r => setTimeout(r, 1000));
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        console.log('Navigating to signin page...');
        await page.goto(`${TARGET_BASE_URL}/auth/signin`, { waitUntil: 'networkidle2', timeout: 25000 });
        
        const needsLogin = await page.evaluate(() => {
            return document.querySelector('input[type="text"]') !== null;
        });
        
        if (needsLogin) {
            console.log('Logging in...');
            await page.type('input[type="text"]', 'TEST4455');
            await page.type('input[type="password"]', 'TEST4455@');
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
            ]);
            console.log('Login complete.');
        } else {
            console.log('Already logged in.');
        }

        console.log('Navigating to orders page...');
        const res = await page.goto(`${TARGET_BASE_URL}/manager/orders?page=1&ps=10`, { waitUntil: 'networkidle2' });
        console.log('Response status code:', res ? res.status() : 'none');
        console.log('Current page URL:', page.url());

        // Capture screenshot
        const screenshotPath = path.resolve(__dirname, 'debug_screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('Screenshot saved to:', screenshotPath);

        const pageHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 1000));
        console.log('Body HTML preview:', pageHTML);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await browser.close();
    }
}

run();
