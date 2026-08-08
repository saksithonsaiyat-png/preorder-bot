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
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        if (targetCookies) {
            await page.setExtraHTTPHeaders({ 'Cookie': targetCookies });
        }

        await page.goto(`${TARGET_BASE_URL}/manager/orders?page=1&ps=100`, { waitUntil: 'networkidle2' });
        
        // Wait 3 seconds to ensure everything is rendered
        await new Promise(r => setTimeout(r, 3000));

        const html = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));
            return rows.map((r, i) => ({
                index: i,
                outerHTML: r.outerHTML,
                cellsCount: r.querySelectorAll('td').length
            }));
        });

        console.log(`Parsed ${html.length} rows inside table tbody:`);
        html.slice(0, 5).forEach((r) => {
            console.log(`\n--- Row ${r.index} (cellsCount=${r.cellsCount}) ---`);
            console.log(r.outerHTML);
        });

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await browser.close();
    }
}

run();
