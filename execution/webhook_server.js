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
        const logFile = logWebhook(data, 'cloudtalk');

        // Extract key fields
        const phoneNumber = data.external_number || data.externalNumber || null;
        const transcription = data.transcription || null;
        const callId = data.call_id || data.callId || 'unknown';

        console.log(`Call ID: ${callId}`);
        console.log(`Phone Number: ${phoneNumber}`);
        console.log(`Transcription length: ${transcription ? String(transcription).length : 0} chars`);

        if (!phoneNumber) {
            console.error('No phone number found in webhook data');
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

        // If transcript is empty/missing, try fetching from API
        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            console.log(`Transcript missing in webhook. Fetching from API for call ${callId}...`);
            try {
                const axios = require('axios');
                const API_KEY = process.env.CLOUDTALK_API_KEY;
                const API_SECRET = process.env.CLOUDTALK_API_SECRET;

                if (API_KEY && API_SECRET) {
                    const auth = { username: API_KEY, password: API_SECRET };
                    // Try fetching from conversation-intelligence endpoint
                    const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${callId}`;

                    const res = await axios.get(transUrl, { auth });

                    if (res.data && res.data.text) {
                        transcriptData.transcript = res.data.text;
                        console.log(`✓ Fetched transcript from API (${transcriptData.transcript.length} chars)`);
                    } else {
                        console.log(`⚠ API returned no text: ${JSON.stringify(res.data)}`);
                        transcriptData.transcript = "[No transcript available from API]";
                    }
                } else {
                    console.log("⚠ Cannot fetch from API: Missing Credentials");
                }
            } catch (err) {
                console.error(`✗ Failed to fetch transcript from API: ${err.message}`);
                transcriptData.transcript = "[Failed to fetch transcript]";
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
