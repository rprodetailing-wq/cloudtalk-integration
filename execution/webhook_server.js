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
        let callUuid = normalizeKey(data, 'call_uuid') || normalizeKey(data, 'callUuid') || null;

        // Check if transcription is invalid (CloudTalk object bug)
        if (transcription === '[object Object]') {
            console.log('Transcription is [object Object], marking as null to fetch from API.');
            transcription = null;
        }

        // Clean up extracted values
        if (typeof phoneNumber === 'string') phoneNumber = phoneNumber.trim();
        if (typeof callId === 'number') callId = String(callId);

        console.log(`Call ID: ${callId}`);
        console.log(`Call UUID: ${callUuid}`);
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

                        // Extract recording link
                        if (callData.Cdr?.recording_link) {
                            data.recording_link = callData.Cdr.recording_link;
                            console.log(`✓ Fetched recording link: ${data.recording_link}`);
                        }

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
            uuid: callUuid,
            phone_number: phoneNumber,
            client: data.contacts?.name || 'Unknown',
            date: new Date().toISOString(),
            transcript: typeof transcription === 'string' ? transcription : JSON.stringify(transcription),
            recording_link: data.recording_link || null,
            raw: data
        };

        // If transcript is empty/missing, try fetching from API with retries
        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            console.log(`Transcript missing in webhook. Fetching from API...`);

            const axios = require('axios');
            const API_KEY = process.env.CLOUDTALK_API_KEY;
            const API_SECRET = process.env.CLOUDTALK_API_SECRET;

            if (API_KEY && API_SECRET) {
                const auth = { username: API_KEY, password: API_SECRET };

                // Strategy: 
                // 1. Try UUID from Webhook
                // 2. If no UUID, try fetching UUID from Analytics API using Call ID
                // 3. Try fetching transcript using UUID (preferred) or ID

                let validUuid = callUuid;

                // Step 2: Fetch UUID from Analytics API if missing
                if (!validUuid && callId && callId !== 'unknown') {
                    console.log(`UUID missing. Fetching from Analytics API for Call ID ${callId}...`);
                    try {
                        const analyticsUrl = `https://analytics-api.cloudtalk.io/api/calls/${callId}`;
                        const analyticsRes = await axios.get(analyticsUrl, { auth });
                        if (analyticsRes.data && analyticsRes.data.uuid) {
                            validUuid = analyticsRes.data.uuid;
                            console.log(`✓ Fetched UUID from Analytics API: ${validUuid}`);
                        } else {
                            console.log("⚠ Analytics API returned no UUID.");
                        }
                    } catch (err) {
                        console.error(`Warning: Failed to fetch UUID from Analytics API: ${err.message}`);
                    }
                }

                const idsToTry = [];
                if (validUuid) idsToTry.push(validUuid);
                if (callId && callId !== 'unknown') idsToTry.push(callId);

                let fetchedText = null;

                for (const targetId of idsToTry) {
                    if (!targetId || fetchedText) continue;

                    console.log(`Trying to fetch transcript for ID/UUID: ${targetId}`);
                    const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${targetId}.json`;

                    // Retry logic: number of attempts per ID
                    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                    let attempts = 0;
                    const maxAttempts = 12; // 12 attempts per ID (Total ~2 mins if needed)

                    while (attempts < maxAttempts) {
                        attempts++;
                        try {
                            const res = await axios.get(transUrl, { auth });
                            if (res.data && res.data.text) {
                                fetchedText = res.data.text;
                                console.log(`✓ Fetched transcript using ${targetId} (${fetchedText.length} chars)`);
                                break;
                            } else {
                                console.log(`⚠ API returned no text for ${targetId}`);
                            }
                        } catch (err) {
                            if (err.response && err.response.status === 404) {
                                console.log(`✗ Not found (404) for ${targetId} attempt ${attempts}. Waiting 10s...`);
                            } else {
                                console.error(`✗ API Error for ${targetId}: ${err.message}`);
                            }
                        }
                        if (attempts < maxAttempts) await wait(10000);
                    }
                    if (fetchedText) break;
                }

                if (fetchedText) {
                    transcriptData.transcript = fetchedText;
                }
            } else {
                console.log("⚠ Cannot fetch from API: Missing Credentials");
            }
        }

        // Final Fallback: If still no transcript, check for recording link
        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            if (transcriptData.recording_link) {
                console.log("Using Recording Link as fallback for transcript.");
                transcriptData.transcript = `[Transcript not found via API]\n\n**Backup Recording Link:** ${transcriptData.recording_link}`;
            } else {
                transcriptData.transcript = "[Transcript processing or not available]";
                console.log("Giving up on transcript fetch. No recording link available.");
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
