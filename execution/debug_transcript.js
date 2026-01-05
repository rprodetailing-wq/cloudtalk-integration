require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;
const CALL_ID = '1096543238'; // The successful call from the log

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function testTranscript(callId) {
    try {
        console.log(`Testing transcript for Call ID: ${callId}`);
        // Try with .json suffix which is often required by CloudTalk
        const url = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${callId}.json`;
        console.log(`GET ${url}`);

        const res = await axios.get(url, { auth });
        console.log(`✅ Success! Status: ${res.status}`);
        console.log('Data:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log(`❌ Failed: ${err.message}`);
        if (err.response) {
            console.log(`   Status: ${err.response.status}`);
            console.log(`   Body: ${JSON.stringify(err.response.data)}`);
        }
    }
}

async function testCallDetails(callId) {
    try {
        console.log(`\nChecking Call Details for recording URL...`);
        const url = `https://my.cloudtalk.io/api/calls/index.json?call_id=${callId}`;
        const res = await axios.get(url, { auth });
        const callData = res.data.responseData?.data?.[0];
        if (callData) {
            console.log('Call Object Keys:', Object.keys(callData));
            // Check for anything looking like a transcript or recording
            console.log('Recording Link:', callData.recording_url || callData.Cdr?.recording_url);
        } else {
            console.log('Call not found in index.');
        }
    } catch (err) {
        console.log(`Error checking details: ${err.message}`);
    }
}

async function run() {
    await testTranscript(CALL_ID);
    await testCallDetails(CALL_ID);
}

run();
