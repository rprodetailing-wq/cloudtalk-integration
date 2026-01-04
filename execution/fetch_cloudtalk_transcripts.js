require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Parse arguments
const args = process.argv.slice(2);
let callId = null;
let phone = null;
let limit = 10; // Number of recent calls to fetch

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--call-id') {
        callId = args[i + 1];
        i++;
    } else if (args[i] === '--phone') {
        phone = args[i + 1];
        i++;
    } else if (args[i] === '--limit') {
        limit = parseInt(args[i + 1]);
        i++;
    }
}

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;
const BASE_URL = 'https://my.cloudtalk.io/api'; // Official CloudTalk API endpoint

async function fetchTranscript() {
    if (!API_KEY || !API_SECRET) {
        console.error("Error: CLOUDTALK_API_KEY and CLOUDTALK_API_SECRET must be set in .env");
        process.exit(1);
    }

    const outputDir = path.join('.tmp', 'transcripts');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
        const auth = {
            username: API_KEY,
            password: API_SECRET
        };

        // If specific call ID provided, fetch that call
        if (callId) {
            console.log(`Fetching call ${callId}...`);
            const callResponse = await axios.get(`${BASE_URL}/calls/${callId}`, { auth });
            await processCall(callResponse.data, outputDir, auth);
            return;
        }

        // Otherwise fetch recent calls
        console.log(`Fetching recent ${limit} calls...`);
        const params = { per_page: limit };

        // If phone number specified, filter by it
        if (phone) {
            params.contact_phone = phone;
        }

        const callsResponse = await axios.get(`${BASE_URL}/calls.json`, {
            auth,
            params,
            headers: {
                'Accept': 'application/json'
            }
        });

        const calls = callsResponse.data.data || callsResponse.data;

        if (!Array.isArray(calls) || calls.length === 0) {
            console.log("No calls found.");
            return;
        }

        console.log(`Found ${calls.length} call(s). Processing...`);

        for (const call of calls) {
            await processCall(call, outputDir, auth);
        }

    } catch (error) {
        console.error("Error fetching from CloudTalk API:");
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, error.response.data);
        } else {
            console.error(error.message);
        }
        process.exit(1);
    }
}

async function processCall(call, outputDir, auth) {
    const callId = call.id;
    const phoneNumber = call.from || call.contact_phone || call.number || "unknown";
    const client = call.contact_name || call.name || "Unknown";
    const date = call.created_at || call.start_at || new Date().toISOString();

    console.log(`Processing Call ID: ${callId}, Phone: ${phoneNumber}`);

    let transcript = "";

    // Try to fetch transcription if available
    try {
        console.log(`  Fetching transcription for call ${callId}...`);
        const transcriptionResponse = await axios.get(
            `${BASE_URL}/conversation-intelligence/transcription/${callId}`,
            { auth }
        );

        if (transcriptionResponse.data && transcriptionResponse.data.text) {
            transcript = transcriptionResponse.data.text;
            console.log(`  ✓ Transcription fetched (${transcript.length} chars)`);
        } else if (transcriptionResponse.data && transcriptionResponse.data.segments) {
            // Sometimes transcripts are in segments
            transcript = transcriptionResponse.data.segments
                .map(seg => `${seg.speaker}: ${seg.text}`)
                .join('\n');
            console.log(`  ✓ Transcription assembled from segments`);
        }
    } catch (transcriptError) {
        if (transcriptError.response && transcriptError.response.status === 404) {
            console.log(`  ⚠ No transcription available for this call`);
            transcript = "[Transcription not available - ensure Conversation Intelligence is enabled]";
        } else {
            console.log(`  ⚠ Error fetching transcription:`, transcriptError.message);
            transcript = `[Error fetching transcription: ${transcriptError.message}]`;
        }
    }

    const data = {
        id: callId,
        phone_number: phoneNumber,
        client: client,
        date: date,
        transcript: transcript,
        raw_call_data: call // Include raw data for debugging
    };

    const filename = path.join(outputDir, `transcript_${callId}.json`);
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));

    console.log(`  ✓ Saved to ${filename}`);
}

fetchTranscript().catch(console.error);
