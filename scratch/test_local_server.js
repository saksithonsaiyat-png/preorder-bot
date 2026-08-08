const axios = require('axios');

async function testLocal() {
    try {
        console.log('1. Checking queue for valid mock user: polarxsz...');
        // We set TARGET_BASE_URL to localhost mock inside the server if we run it with env.
        // But since it's querying live URL by default, it might hit real site.
        // Let's call our local mock orders endpoint directly to verify mock fallback behavior!
        const mockRes1 = await axios.get('http://localhost:8080/api/target-mock/orders?username=polarxsz');
        console.log('Mock polarxsz response length:', mockRes1.data.data.length);
        console.log('Mock polarxsz product name example:', mockRes1.data.data[0]?.product_name);

        console.log('\n2. Checking queue for non-existent user: Mewwwwww...');
        const mockRes2 = await axios.get('http://localhost:8080/api/target-mock/orders?username=Mewwwwww');
        console.log('Mock Mewwwwww response data:', JSON.stringify(mockRes2.data, null, 2));

        console.log('\n3. Triggering check-queue endpoint for Mewwwwww...');
        const res = await axios.get('http://localhost:8080/api/check-queue?username=Mewwwwww');
        console.log('API check-queue Mewwwwww response:', JSON.stringify(res.data, null, 2));

    } catch (err) {
        console.error('Error:', err.message);
        if (err.response) {
            console.error('Response data:', err.response.data);
        }
    }
}

testLocal();
