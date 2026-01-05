require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.WEBHOOK_PORT || 3000;
const LOG_DIR = path.join(__dirname, '..', '.tmp', 'webhook_logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Log incoming webhooks
function logWebhook(data, source) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(LOG_DIR, `webhook_${timestamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify({ source, timestamp: new Date().toISOString(), data }, null, 2));
    console.log(`Logged webhook to: ${logFile}`);
    return logFile;
}

// CloudTalk webhook endpoint
app.post('/cloudtalk/transcription', async (req, res) => {
    console.log('\n=== CloudTalk Transcription Webhook Received ===');
    console.log('Timestamp:', new Date().toISOString());

    try {
        const data = req.body;

        // Log the raw webhook
        console.log('RAW WEBHOOK BODY:', JSON.stringify(data, null, 2));
        const logFile = logWebhook(data, 'cloudtalk');

        // Extract key fields with robust key matching (handling trimming issues)
        const normalizeKey = (obj, target) => {
            const key = Object.keys(obj).find(k => k.trim() === target);
            return key ? obj[key] : undefined;
        };

        let phoneNumber = normalizeKey(data, 'external_number') || normalizeKey(data, 'externalNumber') || null;
        let transcription = normalizeKey(data, 'transcription') || null;
        let callId = normalizeKey(data, 'call_id') || normalizeKey(data, 'callId') || 'unknown';

        // Check if transcription is invalid (CloudTalk object bug)
        if (transcription === '[object Object]') {
            console.log('Transcription is [object Object], marking as null to fetch from API.');
            transcription = null;
        }

        // Clean up extracted values
        if (typeof phoneNumber === 'string') phoneNumber = phoneNumber.trim();
        if (typeof callId === 'number') callId = String(callId);

        console.log(`Call ID: ${callId}`);
        console.log(`Phone Number: ${phoneNumber}`);
        console.log(`Transcription length: ${transcription ? String(transcription).length : 0} chars`);

        // Robustness: If phone number is missing/invalid but we have a Call ID, fetch call details from API
        if ((!phoneNumber || phoneNumber.length < 3) && callId !== 'unknown') {
            console.log(`Phone number invalid/missing (${phoneNumber}). Attempting to fetch call details for ID ${callId}...`);
            try {
                const axios = require('axios');
                const API_KEY = process.env.CLOUDTALK_API_KEY;
                const API_SECRET = process.env.CLOUDTALK_API_SECRET;

                if (API_KEY && API_SECRET) {
                    const auth = { username: API_KEY, password: API_SECRET };
                    // Use index.json with filter because /calls/{id}.json is unreliable
                    const callUrl = `https://my.cloudtalk.io/api/calls/index.json?call_id=${callId}`;

                    const callRes = await axios.get(callUrl, { auth });
                    // API returns { responseData: { data: [ ... ] } }
                    const callList = callRes.data.responseData?.data;
                    const callData = callList && callList.length > 0 ? callList[0] : null;

                    if (callData) {
                        // Extract phone from various possible locations in the complex object
                        phoneNumber = callData.Contact?.contact_numbers?.[0] ||
                            callData.Cdr?.caller_number ||
                            callData.external_number ||
                            callData.b_number;

                        console.log(`✓ Fetched phone number from API: ${phoneNumber}`);

                        // Also might have client name
                        if (!data.contacts) data.contacts = {};
                        if (callData.Contact?.name) data.contacts.name = callData.Contact.name;
                    } else {
                        console.log(`Warning: Call ID ${callId} not found in API list.`);
                    }
                }
            } catch (err) {
                console.error(`Warning: Could not fetch call details: ${err.message}`);
            }
        }

        if (!phoneNumber) {
            console.error('No phone number found in webhook data or API');
            return res.status(400).json({ error: 'Missing phone number' });
        }

        // Prepare transcript file for update script
        const transcriptDir = path.join(__dirname, '..', '.tmp', 'transcripts');
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }

        const transcriptData = {
            id: callId,
            phone_number: phoneNumber,
            client: data.contacts?.name || 'Unknown',
            date: new Date().toISOString(),
            transcript: typeof transcription === 'string' ? transcription : JSON.stringify(transcription),
            raw: data
        };

        // If transcript is empty/missing, try fetching from API with retries
        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            console.log(`Transcript missing in webhook. Fetching from API for call ${callId}...`);

            const axios = require('axios');
            const API_KEY = process.env.CLOUDTALK_API_KEY;
            const API_SECRET = process.env.CLOUDTALK_API_SECRET;

            if (API_KEY && API_SECRET) {
                const auth = { username: API_KEY, password: API_SECRET };
                const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${callId}.json`;

                // Retry logic: 12 attempts with 10s delay (Total ~2 minutes wait)
                const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                let attempts = 0;
                const maxAttempts = 12;

                while (attempts < maxAttempts) {
                    attempts++;
                    try {
                        console.log(`Attempt ${attempts}/${maxAttempts} to fetch transcript...`);
                        const res = await axios.get(transUrl, { auth });

                        if (res.data && res.data.text) {
                            transcriptData.transcript = res.data.text;
                            console.log(`✓ Fetched transcript from API (${transcriptData.transcript.length} chars)`);
                            break; // Success
                        } else {
                            console.log(`⚠ API returned no text: ${JSON.stringify(res.data)}`);
                        }
                    } catch (err) {
                        if (err.response && err.response.status === 404) {
                            console.log(`✗ Transcript not found (404) on attempt ${attempts}. Waiting 10s...`);
                        } else {
                            console.error(`✗ API Error: ${err.message}`);
                        }
                    }

                    if (attempts < maxAttempts) {
                        await wait(10000); // Wait 10 seconds between retries
                    }
                }

                if (!transcriptData.transcript || transcriptData.transcript === 'null') {
                    transcriptData.transcript = "[Transcript processing or not available]";
                    console.log("Giving up on transcript fetch.");
                }

            } else {
                console.log("⚠ Cannot fetch from API: Missing Credentials");
                transcriptData.transcript = "[Transcript processing or not available]";
            }
        }

        const transcriptFile = path.join(transcriptDir, `transcript_${callId}.json`);
        fs.writeFileSync(transcriptFile, JSON.stringify(transcriptData, null, 2));
        console.log(`Transcript saved: ${transcriptFile}`);

        // Generate proposal
        const proposalDir = path.join(__dirname, '..', '.tmp', 'proposals');
        if (!fs.existsSync(proposalDir)) {
            fs.mkdirSync(proposalDir, { recursive: true });
        }

        const proposalContent = `# Call Proposal\n\n**Call ID:** ${callId}\n**Phone:** ${phoneNumber}\n**Date:** ${new Date().toLocaleDateString()}\n\n## Transcript Summary\n\n${transcriptData.transcript}\n\n## Next Steps\n\n- Follow up with customer\n- Document requirements\n- Prepare quote if needed`;

        const proposalFile = path.join(proposalDir, `proposal_${callId}.md`);
        fs.writeFileSync(proposalFile, proposalContent);
        console.log(`Proposal saved: ${proposalFile}`);

        // Run ClickUp update script
        console.log('Running ClickUp update...');

        const updateProcess = spawn('node', [
            path.join(__dirname, 'update_clickup_task.js'),
            '--transcript', transcriptFile,
            '--proposal', proposalFile
        ], {
            cwd: path.join(__dirname, '..'),
            env: process.env
        });

        let output = '';
        updateProcess.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`[ClickUp] ${data.toString().trim()}`);
        });

        updateProcess.stderr.on('data', (data) => {
            output += data.toString();
            console.error(`[ClickUp Error] ${data.toString().trim()}`);
        });

        updateProcess.on('close', (code) => {
            console.log(`ClickUp update finished with code: ${code}`);

            // Log result
            const resultFile = path.join(LOG_DIR, `result_${callId}_${Date.now()}.txt`);
            fs.writeFileSync(resultFile, output);
        });

        res.json({
            success: true,
            message: 'Webhook received and processing started',
            callId,
            phoneNumber
        });

    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint
app.get('/', (req, res) => {
    res.send(`
        <h1>CloudTalk to ClickUp Webhook Server</h1>
        <p>Status: Running</p>
        <p>Webhook URL: POST /cloudtalk/transcription</p>
        <p>Health Check: GET /health</p>
    `);
});

app.listen(PORT, () => {
    console.log(`\n🚀 Webhook server running on port ${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST http://localhost:${PORT}/cloudtalk/transcription`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`\nTo expose publicly, use ngrok:`);
    console.log(`  npx ngrok http ${PORT}`);
});
