require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;

console.log("Testing CloudTalk API plan access...");
console.log(`Key: ${API_KEY?.substring(0, 15)}...`);

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function testPlanAccess() {
    // Test if API access is available on this plan
    const testEndpoints = [
        'https://my.cloudtalk.io/api/calls.json',
        'https://my.cloudtalk.io/api/v1/calls.json',
        'https://my.cloudtalk.io/api/numbers.json',
        'https://my.cloudtalk.io/api/account.json'
    ];

    console.log("\nTesting API access...\n");

    for (const url of testEndpoints) {
        try {
            console.log(`Trying: ${url}`);
            const response = await axios.get(url, {
                auth,
                params: { per_page: 1 },
                headers: {
                    'Accept': 'application/json'
                },
                timeout: 5000
            });
            console.log(`✓ SUCCESS! API is accessible`);
            console.log(`  Endpoint: ${url}`);
            console.log(`  Response keys:`, Object.keys(response.data));
            if (response.data.data) {
                console.log(`  Data found:`, Array.isArray(response.data.data) ? `${response.data.data.length} items` : 'object');
            }
            return { success: true, endpoint: url };
        } catch (error) {
            if (error.response?.status === 403 || error.response?.status === 402) {
                console.log(`✗ PLAN ERROR: ${error.response.status}`);
                console.log(`  Your plan may not include API access.`);
                console.log(`  CloudTalk requires Essential plan or higher for API access.`);
                return { success: false, planIssue: true };
            } else if (error.response?.status === 404) {
                console.log(`✗ 404 Not Found`);
            } else if (error.response?.status === 401) {
                console.log(`✗ 401 Unauthorized - Check API credentials`);
                return { success: false, authIssue: true };
            } else {
                console.log(`✗ Failed: ${error.response?.status || error.message}`);
            }

            if (error.response?.data) {
                const data = typeof error.response.data === 'string'
                    ? error.response.data.substring(0, 150)
                    : JSON.stringify(error.response.data).substring(0, 150);
                console.log(`  Details:`, data);
            }
        }
    }

    console.log("\n❌ No working endpoint found.");
    console.log("\nPossible issues:");
    console.log("1. Your plan may not include API access (requires Essential or higher)");
    console.log("2. API credentials may be incorrect");
    console.log("3. API access may need to be enabled in CloudTalk settings");

    return { success: false };
}

testPlanAccess().catch(console.error);
