require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;
const BASE_URL = 'https://my.cloudtalk.io/api';

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function testRecordingAccess() {
    try {
        console.log("Fetching last call...");
        const callsRes = await axios.get(`${BASE_URL}/calls.json?per_page=5`, { auth });
        const calls = callsRes.data.data;

        if (!calls || calls.length === 0) {
            console.log("No calls found to test.");
            return;
        }

        // Find a call with a recording link
        const callWithRecording = calls.find(c => c.recording_link || (c.Cdr && c.Cdr.recording_link));

        if (!callWithRecording) {
            console.log("No calls with recording links found in the last 5 calls.");
            return;
        }

        const link = callWithRecording.recording_link || callWithRecording.Cdr.recording_link;
        console.log(`\nFound Recording Link: ${link}`);

        // Test 1: Direct Access (No Auth) - Checks if it's a signed public URL
        try {
            console.log("Test 1: GET without Auth...");
            const res1 = await axios.get(link, { 
                maxRedirects: 5,
                validateStatus: null // Capture all codes
            });
            console.log(`  Status: ${res1.status}`);
            console.log(`  Content-Type: ${res1.headers['content-type']}`);
            if (res1.status === 200) console.log("  SUCCESS! Link is public/signed.");
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }

        // Test 2: Access with Basic Auth (API Key)
        try {
            console.log("Test 2: GET with Basic Auth...");
            const res2 = await axios.get(link, { 
                auth,
                maxRedirects: 5,
                validateStatus: null 
            });
            console.log(`  Status: ${res2.status}`);
            console.log(`  Content-Type: ${res2.headers['content-type']}`);
             if (res2.status === 200) console.log("  SUCCESS! Link works with API Key.");
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }

        // Test 3: /calls/{id}/recording.mp3 Endpoint (Guessing standard conventions)
        try {
            const mp3Endpoint = `${BASE_URL}/calls/${callWithRecording.id}/recording.mp3`;
            console.log(`Test 3: Guessing Endpoint ${mp3Endpoint}...`);
            const res3 = await axios.get(mp3Endpoint, { 
                auth,
                validateStatus: null 
            });
             console.log(`  Status: ${res3.status}`);
             if (res3.status === 200) console.log("  SUCCESS! /recording.mp3 endpoint exists.");
        } catch (e) {
             console.log(`  Error: ${e.message}`);
        }

         // Test 4: /calls/{id}/recording Endpoint 
         try {
            const recEndpoint = `${BASE_URL}/calls/${callWithRecording.id}/recording`;
            console.log(`Test 4: Guessing Endpoint ${recEndpoint}...`);
            const res4 = await axios.get(recEndpoint, { 
                auth,
                validateStatus: null 
            });
             console.log(`  Status: ${res4.status}`);
             if (res4.status === 200) console.log("  SUCCESS! /recording endpoint exists.");
        } catch (e) {
             console.log(`  Error: ${e.message}`);
        }

    } catch (error) {
        console.error("Fatal Error:", error.message);
        if (error.response) console.error("Response:", error.response.data);
    }
}

testRecordingAccess();
