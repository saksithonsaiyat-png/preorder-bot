const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_BASE_URL = 'https://thewestern.rdcw.xyz';
const BOT_USERNAME = 'TEST4455';
const BOT_PASSWORD = 'TEST4455@';

async function test() {
    console.log('Logging in...');
    try {
        const loginRes = await axios.post(`${TARGET_BASE_URL}/api/login`, {
            username: BOT_USERNAME,
            password: BOT_PASSWORD
        }, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        console.log('Login Response Success:', loginRes.data.success);
        const token = loginRes.data.token;
        console.log('Token received:', token ? 'Yes' : 'No');

        // Let's call the orders page
        console.log('Fetching orders page...');
        const ordersUrl = `${TARGET_BASE_URL}/manager/orders?p={"pageIndex":0,"pageSize":200}&q=polarxsz`;
        const ordersRes = await axios.get(ordersUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Authorization': `Bearer ${token}`,
                'Cookie': `session_id=${token}`
            }
        });

        console.log('Orders page response type:', typeof ordersRes.data);
        if (typeof ordersRes.data === 'string') {
            const $ = cheerio.load(ordersRes.data);
            const rows = $('table tbody tr, tr, .table-row, div[role="row"], .order-card');
            console.log('Found rows:', rows.length);
            
            // Print some row content if found
            rows.each((i, el) => {
                console.log(`Row ${i}:`, $(el).text().replace(/\s+/g, ' ').trim().substring(0, 100));
            });
        } else {
            console.log('Response is JSON:', ordersRes.data);
        }
    } catch (err) {
        console.error('Error occurred:', err.message);
        if (err.response) {
            console.error('Response Status:', err.response.status);
            console.error('Response Data:', err.response.data);
        }
    }
}

test();
