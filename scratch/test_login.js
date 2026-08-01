const axios = require('axios');

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
        console.log('Login Response Data:', loginRes.data);
        console.log('Response Headers:', loginRes.headers);
        console.log('Set-Cookie headers:', loginRes.headers['set-cookie']);
    } catch (err) {
        console.error('Error occurred:', err.message);
        if (err.response) {
            console.error('Response Status:', err.response.status);
            console.error('Response Data:', err.response.data);
        }
    }
}

test();
