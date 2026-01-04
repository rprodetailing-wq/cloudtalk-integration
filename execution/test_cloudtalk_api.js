require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;

console.log("Testing CloudTalk API...");
console.log(`Key: ${API_KEY?.substring(0, 10)}...`);
console.log(`Secret: ${API_SECRET?.substring(0, 10)}...`);

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function test() {
    const endpoints = [
        'https://my.cloudtalk.io/api/calls',
        'https://api.cloudtalk.io/v1/calls',
        'https://api.cloudtalk.io/api/v1/calls',
        'https://pbx.cloudtalk.io/api/v1/calls'
    ];

    for (const url of endpoints) {
        try {
            console.log(`\nTrying: ${url}`);
            const response = await axios.get(url, {
                auth,
                params: { per_page: 1 },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            });
            console.log(`✓ SUCCESS with ${url}`);
            console.log(`Response type:`, typeof response.data);
            console.log(`Response keys:`, Object.keys(response.data));
            if (response.data.data && Array.isArray(response.data.data)) {
                console.log(`Found ${response.data.data.length} calls`);
                if (response.data.data[0]) {
                    console.log(`First call keys:`, Object.keys(response.data.data[0]));
                }
            }
            return;
        } catch (error) {
            console.log(`✗ Failed: ${error.response?.status || error.message}`);
            if (error.response?.data) {
                const data = typeof error.response.data === 'string'
                    ? error.response.data.substring(0, 200)
                    : JSON.stringify(error.response.data).substring(0, 200);
                console.log(`  Response:`, data);
            }
        }
    }
}

test().catch(console.error);
