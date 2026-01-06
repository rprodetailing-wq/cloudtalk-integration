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
async function transcribeAudio(audioUrl) {
    if (!process.env.OPENAI_API_KEY) {
        console.log("Skipping AI Transcription: No OPENAI_API_KEY found.");
        return null;
    }

    const tempAudioPath = path.join(__dirname, '..', '.tmp', `audio_temp_${Date.now()}.mp3`);
    let browser = null;

    try {
        console.log(`Resolving audio URL via Puppeteer: ${audioUrl}`);

        const puppeteer = require('puppeteer-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: 'new'
        });
        const page = await browser.newPage();

        // --- LOGIN FLOW START ---
        if (process.env.CLOUDTALK_USER && process.env.CLOUDTALK_PASS) {
            console.log('Logging in to CloudTalk Dashboard...');
            try {
                // Navigate to Dashboard Login
                await page.goto('https://dashboard.cloudtalk.io/login', { waitUntil: 'networkidle2', timeout: 60000 });

                // Cloudflare Challenge Detection & Solver
                try {
                    const title = await page.title();
                    if (title.includes("Just a moment")) {
                        console.log("Cloudflare Challenge Detected. Attempting to click turnstile...");
                        await page.waitForSelector('iframe', { timeout: 10000 });

                        // Try various common Cloudflare checkbox selectors inside frames
                        const frames = page.frames();
                        for (const frame of frames) {
                            try {
                                const checkbox = await frame.$('input[type="checkbox"]');
                                if (checkbox) {
                                    await checkbox.click();
                                    console.log("Clicked potential Cloudflare checkbox.");
                                    await new Promise(r => setTimeout(r, 5000));
                                    break;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) { console.log("Cloudflare check error (ignoring):", e.message); }

                // Wait for selectors using robust data attributes
                // Fallback to type/placeholder if data-test-id is missing
                const emailSelector = 'input[data-test-id="EmailField"]';
                const passSelector = 'input[data-test-id="PasswordField"]';
                const submitSelector = 'button[type="submit"]';

                try {
                    await page.waitForSelector(emailSelector, { timeout: 30000 });
                } catch (e) {
                    console.log("Standard selector failed, trying broad input wait...");
                    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
                }

                // Type Credentials
                // Use type() with delay to mimic human behavior (helps bot detection)
                await page.type(emailSelector, process.env.CLOUDTALK_USER, { delay: 50 });
                await page.type(passSelector, process.env.CLOUDTALK_PASS, { delay: 50 });

                // Click Login
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
                    page.click(submitSelector)
                ]);
                console.log('✓ Login submitted. Navigation complete.');
            } catch (e) {
                console.warn(`Login attempt failed: ${e.message}`);
                try {
                    const title = await page.title();
                    console.log(`[DEBUG] Page Title: ${title}`);
                    const content = await page.content();
                    console.log(`[DEBUG] Page Content: ${content.substring(0, 500)}...`);
                } catch (err) { }
            }
        } else {
            console.warn('No CloudTalk credentials in .env. Attempting public access (likely to fail).');
        }
        // --- LOGIN FLOW END ---


        // Intercept network requests to find the audio file
        let finalAudioUrl = null;
        await page.setRequestInterception(true);

        page.on('request', request => {
            if (['media'].includes(request.resourceType()) || request.url().endsWith('.mp3') || request.url().endsWith('.wav')) {
                console.log('Intercepted potential audio URL:', request.url());
                if (!finalAudioUrl) finalAudioUrl = request.url();
            }
            request.continue();
        });

        // Navigate to recording page
        console.log(`Navigating to recording page: ${audioUrl}`);
        try {
            await page.goto(audioUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch (e) {
            console.log('Navigation timeout or error (continuing if URL found):', e.message);
        }

        // If not found via network, try extracting from DOM (some players put src in audio tag after load)
        if (!finalAudioUrl) {
            console.log('Searching DOM for audio source...');
            try {
                // Wait a bit for player to render
                await new Promise(r => setTimeout(r, 2000));

                finalAudioUrl = await page.evaluate(() => {
                    const audio = document.querySelector('audio');
                    if (audio) return audio.src;
                    const source = document.querySelector('source');
                    if (source) return source.src;
                    // fallback regex on body
                    const match = document.body.innerHTML.match(/https:\/\/[^"']+\.(mp3|wav)/);
                    return match ? match[0] : null;
                });
            } catch (e) { /* ignore dom errors */ }
        }

        if (!finalAudioUrl) {
            console.log('❌ Could not find audio URL on page.');
            // Try original URL as last resort if it looks like a file (unlikely here)
            if (audioUrl.match(/\.(mp3|wav)$/)) finalAudioUrl = audioUrl;
            else throw new Error("Could not extract audio source from page.");
        }

        console.log(`Downloading audio for transcription from: ${finalAudioUrl}`);

        // Use axios to download. Need cookies if it's signed?
        // Puppeteer cookies -> Axios?
        // Actually, usually signed S3 links (long params) are public for a short time.
        // If not, we download using Puppeteer page content? No, binary is hard.
        // Let's copy cookies from Puppeteer to Axios just in case.

        const cookies = await page.cookies();
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        const response = await axios.get(finalAudioUrl, {
            responseType: 'stream',
            headers: { Cookie: cookieString }
        });

        const writer = fs.createWriteStream(tempAudioPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

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
    } finally {
        if (browser) await browser.close();
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
                const aiText = await transcribeAudio(transcriptData.recording_link);
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

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.send('<h1>CloudTalk to ClickUp Webhook Server</h1><p>Running with AI Transcription Support (OpenAI Whisper)</p>'));

app.listen(PORT, () => console.log(`\n🚀 Webhook server running on port ${PORT}`));
