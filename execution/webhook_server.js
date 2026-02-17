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

// Helper: Sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Fetch with Retry
async function fetchWithRetry(fn, retries = 3, initialDelay = 2000, description = 'Operation') {
    let delay = initialDelay;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            // If it's the last attempt, throw
            if (i === retries - 1) throw error;

            console.log(`⚠️ ${description} failed (Attempt ${i + 1}/${retries}): ${error.message}`);
            console.log(`   Retrying in ${delay}ms...`);
            await sleep(delay);
            delay *= 2; // Exponential backoff
        }
    }
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

    // Wrapper to try all candidates with a retry mechanism for the *set* of candidates
    // If the recording isn't ready, all candidates might fail.
    try {
        await fetchWithRetry(async () => {
            let success = false;
            // Try each candidate
            for (const url of candidates) {
                try {
                    console.log(`Trying ${url}...`);
                    const response = await axios.get(url, {
                        responseType: 'stream',
                        auth,
                        validateStatus: status => status === 200
                    });

                    // Validate content type
                    const contentType = response.headers['content-type'];
                    if (contentType && (contentType.includes('text/html') || contentType.includes('application/json'))) {
                        console.log(`  -> Valid status but invalid content-type: ${contentType}`);
                        response.data.resume(); // drain
                        continue;
                    }

                    const writer = fs.createWriteStream(tempAudioPath);
                    response.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    // Check file size
                    const stats = fs.statSync(tempAudioPath);
                    if (stats.size < 1000) {
                        console.log(`  -> File too small (${stats.size} bytes), likely error/empty.`);
                        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
                        continue; // try next candidate logic? Or fail this attempt?
                        // If it's too small, it might be an error response.
                    }

                    console.log(`✓ Downloaded audio from ${url} (${stats.size} bytes)`);
                    success = true;
                    downloaded = true;
                    break; // Stop trying candidates
                } catch (e) {
                    console.log(`  -> Failed: ${e.message}`);
                }
            }

            if (!success) {
                throw new Error("All recording URL candidates failed.");
            }

        }, 3, 5000, "Download Audio Recording"); // Retry whole process 3 times, init wait 5s

    } catch (finalErr) {
        console.error(`❌ Final failure downloading recording: ${finalErr.message}`);
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
        // Helper to format CloudTalk CSV
        const formatCloudTalkCsv = (csvText) => {
            if (!csvText || typeof csvText !== 'string') return csvText;

            // Basic CSV parser for CloudTalk format: timestamp,in,out
            // Handles quotes and simple commas
            try {
                const lines = csvText.split('\n');
                let formatted = [];

                // Skip header if present
                let startIndex = 0;
                if (lines[0] && lines[0].includes('timestamp')) startIndex = 1;

                for (let i = startIndex; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Simple regex to split by comma respecting quotes
                    const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
                    // Fallback split if regex fails or simple structure
                    const parts = matches || line.split(',');

                    if (parts.length >= 3) {
                        // CloudTalk CSV usually: timestamp, in_channel (Caller), out_channel (Agent)
                        // Note: "in" is usually the caller (Client), "out" is the agent
                        let time = parts[0].replace(/"/g, '').trim(); // timestamp
                        let incoming = parts[1] ? parts[1].replace(/^"|"$/g, '').trim() : ''; // Client
                        let outgoing = parts[2] ? parts[2].replace(/^"|"$/g, '').trim() : ''; // Agent

                        // Format seconds to MM:SS
                        const totalSeconds = parseInt(time, 10);
                        if (!isNaN(totalSeconds)) {
                            const m = Math.floor(totalSeconds / 60);
                            const s = totalSeconds % 60;
                            time = `${m}:${s.toString().padStart(2, '0')}`;
                        }

                        if (outgoing) {
                            formatted.push(`**Agent:** ${outgoing}`);
                        }
                        if (incoming) {
                            formatted.push(`**Client:** ${incoming}`);
                        }
                    }
                }

                if (formatted.length > 0) {
                    return formatted.join('\n\n');
                }
                return csvText; // Return original if parsing fails to find structure
            } catch (e) {
                console.error('Error parsing CSV transcript:', e);
                return csvText; // Fallback to raw text
            }
        };

        (async () => {
            console.log('Starting background processing for callId:', callId);

            // Prepare transcript data
            const transcriptDir = path.join(__dirname, '..', '.tmp', 'transcripts');
            if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir, { recursive: true });

            // Normalize transcription field (handle object vs string)
            let rawTranscript = typeof transcription === 'string' ? transcription : JSON.stringify(transcription);

            // Check if it looks like CSV (has "timestamp,in,out" or similar patterns)
            let formattedTranscript = rawTranscript;
            if (rawTranscript && (rawTranscript.includes('timestamp,in,out') || rawTranscript.includes('timestamp, in, out'))) {
                formattedTranscript = formatCloudTalkCsv(rawTranscript);
            }

            const transcriptData = {
                id: callId,
                uuid: callUuid,
                phone_number: phoneNumber,
                client: data.contacts?.name || 'Unknown',
                date: new Date().toISOString(),
                transcript: formattedTranscript,
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

                    // Try fetching Text from CloudTalk API (with Retry)
                    let fetchedText = null;
                    const idsToTry = [];
                    if (validUuid) idsToTry.push(validUuid);

                    // Add a tiny delay before first attempt to let CloudTalk process
                    await sleep(2000);

                    for (const targetId of idsToTry) {
                        const transUrl = `https://my.cloudtalk.io/api/conversation-intelligence/transcription/${targetId}.json`;

                        try {
                            // Wrap axios call in retry logic
                            // validationStatus: assume 404 means "not ready yet" so we want to throw to trigger retry
                            await fetchWithRetry(async () => {
                                const res = await axios.get(transUrl, {
                                    auth,
                                    // Treat 404 as an error to trigger retry (default axios behavior)
                                });
                                if (res.data && res.data.text) {
                                    fetchedText = res.data.text;
                                    console.log('✓ Fetched native CloudTalk transcript');
                                } else {
                                    throw new Error("Response missing 'text' field");
                                }
                            }, 3, 3000, "Fetch Native Transcript"); // 3 retries, start waiting 3s

                            if (fetchedText) break;

                        } catch (e) {
                            console.log(`   -> Gave up on native transcript for ID ${targetId}: ${e.message}`);
                        }
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

            // Generate Offer (Proposal) using the new Craft Offer architecture
            console.log('Generating AI Offer...');
            const templatePath = path.join(__dirname, '..', 'templates', 'offer_framework.txt');

            // Default to a basic proposal if crafting fails
            let proposalFile = path.join(__dirname, '..', '.tmp', 'proposals', `proposal_${callId}.md`);
            const fallbackContent = `# Call Proposal\n\n**Call ID:** ${callId}\n**Phone:** ${phoneNumber}\n**Date:** ${new Date().toLocaleDateString()}\n\n## Transcript Summary\n\n${transcriptData.transcript}\n\n## Note\n\nAI Offer generation failed or was skipped. Review transcript manually.`;

            // Ensure proposal dir exists (legacy path, or we can use the new offers path)
            const proposalDir = path.join(__dirname, '..', '.tmp', 'proposals');
            if (!fs.existsSync(proposalDir)) fs.mkdirSync(proposalDir, { recursive: true });
            fs.writeFileSync(proposalFile, fallbackContent); // Write fallback first

            if (fs.existsSync(templatePath)) {
                try {
                    const craftProcess = spawn('node', [
                        path.join(__dirname, 'craft_offer.js'),
                        '--transcript', transcriptFile,
                        '--template', templatePath
                    ], {
                        cwd: path.join(__dirname, '..'),
                        env: process.env
                    });

                    let craftOutput = '';
                    craftProcess.stdout.on('data', d => {
                        const str = d.toString();
                        console.log(`[CraftOffer] ${str.trim()}`);
                        craftOutput += str;
                    });

                    craftProcess.stderr.on('data', d => console.error(`[CraftOffer Error] ${d.toString().trim()}`));

                    await new Promise((resolve) => {
                        craftProcess.on('close', (code) => {
                            if (code === 0) {
                                // Extract the output file path from stdout if needed, or just look in known location
                                const match = craftOutput.match(/__OUTPUT_FILE__:(.+)/);
                                if (match && match[1]) {
                                    proposalFile = match[1].trim(); // Point to the new offer file
                                    console.log(`✓ Offer generation successful. Using: ${proposalFile}`);
                                }
                            } else {
                                console.error(`Offer generation exited with code ${code}. using fallback.`);
                            }
                            resolve();
                        });
                    });
                } catch (e) {
                    console.error("Error executing craft_offer.js:", e);
                }
            } else {
                console.warn("Template file not found. Using fallback proposal.");
            }

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
