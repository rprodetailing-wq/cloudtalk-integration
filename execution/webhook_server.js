require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Helper: Transcribe Audio with Gemini
async function transcribeAudio(audioUrl) {
    if (!process.env.GOOGLE_API_KEY) {
        console.log("Skipping AI Transcription: No GOOGLE_API_KEY found.");
        return null;
    }

    try {
        console.log(`Downloading audio for transcription: ${audioUrl}`);
        const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data);
        const audioBase64 = audioBuffer.toString('base64');

        console.log(`Sending to Gemini 1.5 Flash...`);
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const result = await model.generateContent([
            "Transcribe this phone call recording exactly. Format it clearly with Speaker labels (e.g. Agent, Customer) if possible.",
            {
                inlineData: {
                    data: audioBase64,
                    mimeType: "audio/mp3"
                }
            }
        ]);
        const responseText = result.response.text();
        console.log(`✓ Gemini Transcription successful (${responseText.length} chars)`);
        return responseText;
    } catch (error) {
        console.error("Gemini Transcription failed:", error.message);
        return null;
    }
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

        if (transcription === '[object Object]') transcription = null;
        if (typeof phoneNumber === 'string') phoneNumber = phoneNumber.trim();
        if (typeof callId === 'number') callId = String(callId);

        console.log(`Call ID: ${callId}`);
        console.log(`Call UUID: ${callUuid}`);
        console.log(`Phone Number: ${phoneNumber}`);

        // Robustness: Fetch call details if phone missing or to get recording link
        if (callId !== 'unknown') {
            try {
                const API_KEY = process.env.CLOUDTALK_API_KEY;
                const API_SECRET = process.env.CLOUDTALK_API_SECRET;

                if (API_KEY && API_SECRET) {
                    const auth = { username: API_KEY, password: API_SECRET };
                    const callUrl = `https://my.cloudtalk.io/api/calls/index.json?call_id=${callId}`;
                    const callRes = await axios.get(callUrl, { auth });
                    const callList = callRes.data.responseData?.data;
                    const callData = callList && callList.length > 0 ? callList[0] : null;

                    if (callData) {
                        if (!phoneNumber || phoneNumber.length < 3) {
                            phoneNumber = callData.Contact?.contact_numbers?.[0] ||
                                callData.Cdr?.caller_number ||
                                callData.external_number ||
                                callData.b_number;
                            console.log(`✓ Fetched phone number from API: ${phoneNumber}`);
                        }

                        // Extract recording link
                        if (callData.Cdr?.recording_link) {
                            data.recording_link = callData.Cdr.recording_link;
                            console.log(`✓ Fetched recording link: ${data.recording_link}`);
                        }

                        if (!data.contacts) data.contacts = {};
                        if (callData.Contact?.name) data.contacts.name = callData.Contact.name;
                    }
                }
            } catch (err) {
                console.error(`Warning: Could not fetch call details: ${err.message}`);
            }
        }

        if (!phoneNumber) {
            console.error('No phone number found');
            return res.status(400).json({ error: 'Missing phone number' });
        }

        // Prepare transcript data
        const transcriptDir = path.join(__dirname, '..', '.tmp', 'transcripts');
        if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir, { recursive: true });

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

        // Strategy to get Transcript content:
        // 1. Webhook (already checked)
        // 2. CloudTalk API (Text)
        // 3. Gemini AI Transcription (Audio -> Text)
        // 4. Fallback to Recording Link

        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            console.log(`Transcript text missing. Starting retrieval strategy...`);

            const API_KEY = process.env.CLOUDTALK_API_KEY;
            const API_SECRET = process.env.CLOUDTALK_API_SECRET;

            if (API_KEY && API_SECRET) {
                const auth = { username: API_KEY, password: API_SECRET };
                let validUuid = callUuid;

                // 2. Try fetching UUID from Analytics to ask CloudTalk API for Text
                if (!validUuid && callId && callId !== 'unknown') {
                    try {
                        const analyticsUrl = `https://analytics-api.cloudtalk.io/api/calls/${callId}`;
                        const analyticsRes = await axios.get(analyticsUrl, { auth });
                        if (analyticsRes.data && analyticsRes.data.uuid) validUuid = analyticsRes.data.uuid;
                    } catch (err) { /* ignore */ }
                }

                // Try fetching Text from CloudTalk API
                let fetchedText = null;
                const idsToTry = [];
                if (validUuid) idsToTry.push(validUuid);
                // if (callId) idsToTry.push(callId); // Optimization: Don't try ID, we know 404s are common

                for (const targetId of idsToTry) {
                    const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${targetId}.json`;
                    // Brief retry
                    for (let i = 0; i < 2; i++) {
                        try {
                            const res = await axios.get(transUrl, { auth });
                            if (res.data && res.data.text) {
                                fetchedText = res.data.text;
                                console.log('✓ Fetched native CloudTalk transcript');
                                break;
                            }
                        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
                    }
                    if (fetchedText) break;
                }

                if (fetchedText) {
                    transcriptData.transcript = fetchedText;
                }
            }
        }

        // 3. Gemini AI Transcription (if still no text)
        if ((!transcriptData.transcript || transcriptData.transcript === 'null') && transcriptData.recording_link) {
            console.log("No native transcript. Attempting AI transcription...");
            const aiText = await transcribeAudio(transcriptData.recording_link);
            if (aiText) {
                transcriptData.transcript = `[AI Transcription (Gemini)]\n\n${aiText}`;
            }
        }

        // 4. Fallback to Recording Link
        if (!transcriptData.transcript || transcriptData.transcript === 'null') {
            if (transcriptData.recording_link) {
                console.log("Using Recording Link as fallback.");
                transcriptData.transcript = `[Transcript not available]\n\n**Backup Recording Link:** ${transcriptData.recording_link}`;
            } else {
                transcriptData.transcript = "[Transcript processing or not available]";
            }
        }

        const transcriptFile = path.join(transcriptDir, `transcript_${callId}.json`);
        fs.writeFileSync(transcriptFile, JSON.stringify(transcriptData, null, 2));
        console.log(`Transcript saved: ${transcriptFile}`);

        // Generate proposal
        const proposalDir = path.join(__dirname, '..', '.tmp', 'proposals');
        if (!fs.existsSync(proposalDir)) fs.mkdirSync(proposalDir, { recursive: true });

        const proposalContent = `# Call Proposal\n\n**Call ID:** ${callId}\n**Phone:** ${phoneNumber}\n**Date:** ${new Date().toLocaleDateString()}\n\n## Transcript Summary\n\n${transcriptData.transcript}\n\n## Next Steps\n\n- Follow up with customer\n- Document requirements\n- Prepare quote if needed`;

        const proposalFile = path.join(proposalDir, `proposal_${callId}.md`);
        fs.writeFileSync(proposalFile, proposalContent);

        // Spawn ClickUp Update
        console.log('Running ClickUp update...');
        const updateProcess = spawn('node', [
            path.join(__dirname, 'update_clickup_task.js'),
            '--transcript', transcriptFile,
            '--proposal', proposalFile
        ], {
            cwd: path.join(__dirname, '..'),
            env: process.env
        });

        updateProcess.stdout.on('data', d => console.log(`[ClickUp] ${d.toString().trim()}`));
        updateProcess.stderr.on('data', d => console.error(`[ClickUp Error] ${d.toString().trim()}`));

        res.json({ success: true, callId, phoneNumber });

    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.send('<h1>CloudTalk to ClickUp Webhook Server</h1><p>Running with AI Transcription Support (Gemini)</p>'));

app.listen(PORT, () => console.log(`\n🚀 Webhook server running on port ${PORT}`));
