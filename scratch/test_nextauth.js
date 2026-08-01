const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_BASE_URL = 'https://thewestern.rdcw.xyz';
const BOT_USERNAME = 'TEST4455';
const BOT_PASSWORD = 'TEST4455@';

async function test() {
    console.log('1. Fetching CSRF Token...');
    try {
        const csrfRes = await axios.get(`${TARGET_BASE_URL}/api/auth/csrf`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const csrfToken = csrfRes.data.csrfToken;
        console.log('CSRF Token:', csrfToken);

        if (!csrfToken) {
            console.log('No CSRF token found.');
            return;
        }

        // Get cookies from the CSRF response to send with the callback request
        const csrfCookies = csrfRes.headers['set-cookie'];
        const csrfCookieStr = csrfCookies ? csrfCookies.map(c => c.split(';')[0]).join('; ') : '';
        console.log('CSRF Cookies:', csrfCookieStr);

        console.log('2. Performing NextAuth credentials sign-in...');
        
        // NextAuth callback request
        const loginRes = await axios.post(`${TARGET_BASE_URL}/api/auth/callback/credentials`, 
            new URLSearchParams({
                csrfToken: csrfToken,
                username: BOT_USERNAME,
                password: BOT_PASSWORD,
                callbackUrl: `${TARGET_BASE_URL}/`,
                json: 'true'
            }).toString(), 
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': csrfCookieStr
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            }
        );

        console.log('Login Response Status:', loginRes.status);
        console.log('Login Response Headers:', loginRes.headers);
        console.log('Login Response Set-Cookie:', loginRes.headers['set-cookie']);
        console.log('Login Response Data:', loginRes.data);

        // Combine cookies from login response
        const loginCookies = loginRes.headers['set-cookie'];
        const sessionCookieStr = loginCookies ? loginCookies.map(c => c.split(';')[0]).join('; ') : '';
        console.log('Session Cookies:', sessionCookieStr);

        if (!sessionCookieStr) {
            console.log('Failed to get session cookies.');
            return;
        }

        console.log('3. Fetching orders with session cookies...');
        const ordersUrl = `${TARGET_BASE_URL}/manager/orders?p={"pageIndex":0,"pageSize":200}&q=polarxsz`;
        const ordersRes = await axios.get(ordersUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Cookie': sessionCookieStr
            }
        });

        console.log('Orders page status:', ordersRes.status);
        console.log('Body length:', ordersRes.data.length);
        if (typeof ordersRes.data === 'string') {
            const $ = cheerio.load(ordersRes.data);
            const rows = $('table tbody tr, tr, .table-row, div[role="row"], .order-card');
            console.log('Found rows:', rows.length);
            rows.each((i, el) => {
                console.log(`Row ${i}:`, $(el).text().replace(/\s+/g, ' ').trim().substring(0, 100));
            });
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
