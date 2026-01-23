require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const OpenAI = require('openai');

// Polyfill for OpenAI SDK in older Node environments
try {
    if (!globalThis.File) {
        const { File } = require('node:buffer');
        if (File) globalThis.File = File;
    }
} catch (e) {
    console.warn('Failed to polyfill global.File:', e.message);
}

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

// Helper: Transcribe Audio with OpenAI Whisper
async function transcribeAudio(callId) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("Skipping AI Transcription: No OPENAI_API_KEY found.");
        return null;
    }

    const tempAudioPath = path.join(__dirname, '..', '.tmp', `audio_temp_${callId}_${Date.now()}.mp3`);

    // CloudTalk credentials
    const API_KEY = process.env.CLOUDTALK_API_KEY;
    const API_SECRET = process.env.CLOUDTALK_API_SECRET;
    if (!API_KEY || !API_SECRET) {
        console.warn("Missing CloudTalk credentials for recording fetch.");
        return null;
    }
    const auth = { username: API_KEY, password: API_SECRET };

    // Potential Endpoints - Iterate to find which one works
    const candidates = [
        `https://my.cloudtalk.io/api/calls/${callId}/recording.mp3`,
        `https://my.cloudtalk.io/api/calls/${callId}/recording`,
        `https://api.cloudtalk.io/v1/calls/${callId}/recording`,
        `https://my.cloudtalk.io/api/recordings/${callId}.mp3`
    ];

    let downloaded = false;

    console.log(`Attempting to fetch recording for Call ID: ${callId}`);

    for (const url of candidates) {
        try {
            console.log(`Trying ${url}...`);
            const response = await axios.get(url, {
                responseType: 'stream',
                auth,
                validateStatus: status => status === 200
            });

            // Validate content type to avoid downloading HTML 404 pages that return 200 (if any)
            const contentType = response.headers['content-type'];
            if (contentType && (contentType.includes('text/html') || contentType.includes('application/json'))) {
                console.log(`  -> Valid status but invalid content-type: ${contentType}`);
                // drain stream
                response.data.resume();
                continue;
            }

            const writer = fs.createWriteStream(tempAudioPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // Check file size - ignore tiny files (e.g. empty responses)
            const stats = fs.statSync(tempAudioPath);
            if (stats.size < 1000) {
                console.log(`  -> File too small (${stats.size} bytes), likely error/empty.`);
                if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
                continue;
            }

            console.log(`✓ Downloaded audio from ${url} (${stats.size} bytes)`);
            downloaded = true;
            break;
        } catch (e) {
            console.log(`  -> Failed: ${e.message}`);
        }
    }

    if (!downloaded) {
        console.warn("⚠️ Could not download recording via CloudTalk API.");
        console.warn("   CloudTalk does not expose a direct audio file URL via their public API.");
        console.warn("   Options: Contact CloudTalk support for premium API access or Conversation Intelligence tier.");
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        return null;
    }

    try {
        console.log(`Sending to OpenAI Whisper...`);
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempAudioPath),
            model: "whisper-1",
            response_format: "text"
        });

        console.log(`✓ OpenAI Transcription successful (${transcription.length} chars)`);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        return transcription;

    } catch (error) {
        console.error("OpenAI Transcription logic failed:", error.message);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
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

        // --- ASYNC PROCESSING START ---
        // Respond immediately to prevent CloudTalk timeout
        res.status(202).json({ success: true, message: 'Processing started', callId });

        // Continue processing in background
        (async () => {
            console.log('Starting background processing for callId:', callId);

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
            // 2. CloudTalk API (Text) - Quick check
            // 3. OpenAI Whisper (Audio -> Text)
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

                    // Try fetching Text from CloudTalk API (Briefly)
                    let fetchedText = null;
                    const idsToTry = [];
                    if (validUuid) idsToTry.push(validUuid);

                    for (const targetId of idsToTry) {
                        const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${targetId}.json`;
                        try {
                            const res = await axios.get(transUrl, { auth });
                            if (res.data && res.data.text) {
                                fetchedText = res.data.text;
                                console.log('✓ Fetched native CloudTalk transcript');
                                break;
                            }
                        } catch (e) { /* ignore 404s */ }
                    }

                    if (fetchedText) {
                        transcriptData.transcript = fetchedText;
                    }
                }
            }

            // 3. OpenAI Whisper Transcription (if still no text)
            if ((!transcriptData.transcript || transcriptData.transcript === 'null') && transcriptData.recording_link) {
                console.log("No native transcript. Attempting AI transcription (OpenAI)...");
                const aiText = await transcribeAudio(callId);
                if (aiText) {
                    transcriptData.transcript = `[AI Transcription (OpenAI Whisper)]\n\n${aiText}`;
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

        })().catch(err => console.error("Background Processing Error:", err));

        // --- ASYNC PROCESSING END ---

    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Probe CloudTalk API for recording access
app.get('/probe', async (req, res) => {
    console.log('Starting CloudTalk API Probe...');
    const API_KEY = process.env.CLOUDTALK_API_KEY;
    const API_SECRET = process.env.CLOUDTALK_API_SECRET;

    if (!API_KEY || !API_SECRET) {
        return res.status(500).json({ error: 'Missing Credentials in Environment' });
    }

    const auth = { username: API_KEY, password: API_SECRET };
    const logs = [];
    const log = (msg) => { console.log(msg); logs.push(msg); };

    try {
        const baseUrls = [
            'https://my.cloudtalk.io/api',
            'https://api.cloudtalk.io/v1'
        ];

        let calls = null;
        let successfulBaseUrl = null;

        for (const baseUrl of baseUrls) {
            // Try explicit endpoint variations
            const suffixes = baseUrl.includes('my.cloudtalk.io')
                ? ['/calls/index.json', '/calls.json']
                : ['/calls'];

            for (const suffix of suffixes) {
                try {
                    const url = `${baseUrl}${suffix}?per_page=5`;
                    log(`Trying GET ${url} ...`);

                    const callsRes = await axios.get(url, { auth, validateStatus: null });
                    log(`  Status: ${callsRes.status}`);

                    if (callsRes.data) {
                        const bodySnippet = JSON.stringify(callsRes.data).substring(0, 200);
                        log(`  Body: ${bodySnippet}`);
                    }

                    if (callsRes.status === 200) {
                        calls = callsRes.data.data || callsRes.data.responseData?.data || callsRes.data;
                        successfulBaseUrl = baseUrl;
                        log(`  ✓ SUCCESS`);
                        break;
                    }
                } catch (e) {
                    log(`  Error: ${e.message}`);
                    if (e.response && e.response.data) {
                        log(`  Resp: ${JSON.stringify(e.response.data).substring(0, 100)}`);
                    }
                }
            }
            if (calls) break;
        }

        if (!calls || !Array.isArray(calls) || calls.length === 0) {
            return res.json({ logs, error: 'No calls found after trying all base URLs' });
        }

        // Try to find one with a recording link, otherwise just take the first one
        let targetCall = calls.find(c => c.recording_link || (c.Cdr && c.Cdr.recording_link));
        if (!targetCall) {
            log("No call with explicit 'recording_link' found. Using the first call in the list.");
            targetCall = calls[0];
        }

        const callId = targetCall.id || (targetCall.Cdr ? targetCall.Cdr.id : null);

        // Extract known links if they exist
        const link = targetCall.recording_link || (targetCall.Cdr ? targetCall.Cdr.recording_link : null); // often dashboard link
        const streamLink = targetCall.recording || (targetCall.Cdr ? targetCall.Cdr.recording : null);

        log(`Target Call ID: ${callId}`);
        if (targetCall.Cdr) {
            // Log ALL keys from Cdr to find any hidden audio-related field
            log(`All Cdr Keys: ${Object.keys(targetCall.Cdr).join(', ')}`);
        }

        log(`Existing Link Property: ${link}`);
        log(`Existing Stream Property: ${streamLink}`);

        if (!callId) {
            return res.json({ logs, error: 'Could not extract ID from call object', sample: targetCall });
        }

        // Test Endpoint Guesses based on successful base URL
        // We want to find the AUDIO FILE.
        const endpoints = [
            link, // Dashboard link (likely redirects)
            streamLink, // If we found a stream link
            `${successfulBaseUrl}/calls/${callId}/recording`,
            `${successfulBaseUrl}/calls/${callId}/recording.mp3`, // Common pattern

            // Explicitly try V1 API even if 'my.cloudtalk.io' was the successful base
            `https://api.cloudtalk.io/v1/calls/${callId}/recording`,

            // Try fetching the single call details again, maybe it has more data than the list view
            `${successfulBaseUrl}/calls/${callId}.json`,
            `https://my.cloudtalk.io/api/recordings/${callId}`,
            `https://my.cloudtalk.io/api/calls/index.json?call_id=${callId}`,
            // Try transcript endpoint just in case
            `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${callId}`
        ].filter(u => u); // filter out nulls


        const results = {};

        for (const url of endpoints) {
            if (!url) continue;
            try {
                log(`Trying GET ${url} ...`);
                const testRes = await axios.get(url, {
                    auth,
                    validateStatus: null,
                    maxRedirects: 0 // We want to see if it redirects to S3
                });
                results[url] = {
                    status: testRes.status,
                    type: testRes.headers['content-type'],
                    location: testRes.headers['location']
                };
                log(`  -> Status: ${testRes.status}, Type: ${testRes.headers['content-type']}`);

                if (testRes.status === 200) {
                    // Log the body to see if we can find the URL in json
                    try {
                        const bodyPrev = JSON.stringify(testRes.data);
                        log(`  -> Body: ${bodyPrev.substring(0, 1000)}...`); // Log first 1000 chars
                    } catch (e) { log('  -> Body: (Not JSON)'); }
                }

                if (testRes.status === 302 || testRes.status === 307 || testRes.status === 301) {
                    log(`  -> Redirects to: ${testRes.headers['location']}`);
                }
            } catch (e) {
                results[url] = { error: e.message };
            }
        }

        res.json({ logs, results });

    } catch (error) {
        log(`Probe Fatal Error: ${error.message}`);
        res.status(500).json({ logs, error: error.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.send('<h1>CloudTalk to ClickUp Webhook Server</h1><p>Running with AI Transcription Support (OpenAI Whisper)</p>'));

app.listen(PORT, () => console.log(`\n🚀 Webhook server running on port ${PORT}`));
