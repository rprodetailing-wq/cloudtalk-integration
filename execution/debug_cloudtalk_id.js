require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;
const CALL_ID = '1096541908'; // The ID from the log
const PHONE = '0766695835'; // From debug output, let's try searching by phone too possibly

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function testEndpoint(url, desc) {
    try {
        console.log(`Testing ${desc}: ${url}`);
        const res = await axios.get(url, { auth });
        console.log(`✅ Success! Status: ${res.status}`);
        // Log truncated response to see structure
        const json = JSON.stringify(res.data, null, 2);
        console.log('Response Preview:', json.substring(0, 1000));

        // Detailed check for our ID
        const data = res.data.responseData?.data || res.data.data;
        if (Array.isArray(data)) {
            const found = data.find(c => c.Cdr?.id == CALL_ID || c.id == CALL_ID);
            if (found) {
                console.log(`🎯 FOUND THE CALL!`);
                console.log(`  Details:`, JSON.stringify(found, null, 2));
            } else {
                console.log(`  (Call ID ${CALL_ID} not found in this list)`);
            }
        }
    } catch (err) {
        console.log(`❌ Failed (${desc}): ${err.message} (Status: ${err.response?.status})`);
    }
}

async function run() {
    // await testEndpoint(`https://my.cloudtalk.io/api/calls/${CALL_ID}.json`, 'Current Implementation');
    await testEndpoint(`https://my.cloudtalk.io/api/calls/index.json?call_id=${CALL_ID}`, 'Filter by call_id');
    // await testEndpoint(`https://my.cloudtalk.io/api/calls/index.json?id=${CALL_ID}`, 'Filter by id');
}

run();
