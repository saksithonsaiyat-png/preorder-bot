const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

// We use the databaseSync or sqlite3 fallback similar to database.js
const dbPath = path.resolve(__dirname, '../checkorder.db');
let targetCookies = null;

try {
    const { DatabaseSync } = require('node:sqlite');
    const nativeDb = new DatabaseSync(dbPath);
    const stmt = nativeDb.prepare("SELECT value FROM system_settings WHERE key = 'target_cookies'");
    const row = stmt.get();
    if (row) targetCookies = row.value;
} catch (e) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);
    db.get("SELECT value FROM system_settings WHERE key = 'target_cookies'", [], (err, row) => {
        if (row) targetCookies = row.value;
    });
}

const TARGET_BASE_URL = 'https://thewestern.rdcw.xyz';

async function runTest() {
    // Wait a bit to ensure async db read finishes if using sqlite3
    await new Promise(r => setTimeout(r, 1000));
    
    if (!targetCookies) {
        console.error('No target_cookies found in database. Please make sure the bot has logged in at least once.');
        return;
    }

    console.log('Using Cookies:', targetCookies.substring(0, 50) + '...');

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': targetCookies
    };

    // Test different URL structures to see what works
    const testUrls = [
        // 1. Current query style (using JSON p param)
        `${TARGET_BASE_URL}/manager/orders?p=${encodeURIComponent(JSON.stringify({ pageIndex: 0, pageSize: 5 }))}&q=polarxsz`,
        // 2. New query style (using page and ps params) - page 1
        `${TARGET_BASE_URL}/manager/orders?page=1&ps=5&q=polarxsz`,
        // 3. New query style - page 2
        `${TARGET_BASE_URL}/manager/orders?page=2&ps=5&q=polarxsz`
    ];

    for (let i = 0; i < testUrls.length; i++) {
        const url = testUrls[i];
        console.log(`\n--- Test ${i + 1} ---`);
        console.log(`URL: ${url}`);
        try {
            const res = await axios.get(url, { headers, timeout: 10000 });
            const $ = cheerio.load(res.data);
            const rows = $('table tbody tr, .table-row, div[role="row"], .order-card');
            
            // Filter header rows
            const dataRows = [];
            rows.each((index, el) => {
                if ($(el).find('th').length > 0) return;
                const cells = $(el).find('td, div.cell, .table-col');
                if (cells.length >= 5) {
                    dataRows.push($(el).text().replace(/\s+/g, ' ').trim().substring(0, 100));
                }
            });

            console.log(`Total rows parsed: ${dataRows.length}`);
            dataRows.slice(0, 3).forEach((text, index) => {
                console.log(`  Row ${index + 1}: ${text}`);
            });
        } catch (err) {
            console.error(`Error fetching URL: ${err.message}`);
        }
    }
}

runTest();
