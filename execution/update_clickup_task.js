require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

// Parse arguments
const args = process.argv.slice(2);
let proposalPath = null;
let transcriptPath = null; // New arg to get phone number from transcript json
let listId = process.env.CLICKUP_LIST_ID;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proposal') {
        proposalPath = args[i + 1];
        i++;
    } else if (args[i] === '--transcript') {
        transcriptPath = args[i + 1];
        i++;
    } else if (args[i] === '--list-id') {
        listId = args[i + 1];
        i++;
    }
}

async function main() {
    if (!process.env.CLICKUP_API_KEY) {
        console.error("Error: CLICKUP_API_KEY must be set in .env");
        process.exit(1);
    }
    if (!listId) {
        console.error("Error: CLICKUP_LIST_ID must be provided");
        process.exit(1);
    }
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        console.error("Error: Transcript file required (for phone number extraction)");
        process.exit(1);
    }

    // Load Data
    const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    const targetPhone = transcriptData.phone_number;

    let proposalContent = "";
    if (proposalPath && fs.existsSync(proposalPath)) {
        proposalContent = fs.readFileSync(proposalPath, 'utf8');
    }

    console.log(`Looking for task with Phone Number: ${targetPhone} in Map ${listId}...`);

    // Setup MCP
    let serverPath;
    try {
        serverPath = require.resolve('@chykalophia/clickup-mcp-server/build/index.js');
    } catch (e) {
        serverPath = path.resolve(__dirname, '../node_modules/@chykalophia/clickup-mcp-server/build/index.js');
    }

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            CLICKUP_API_TOKEN: process.env.CLICKUP_API_KEY
        }
    });

    const client = new Client({ name: "clickup-updater", version: "1.0.0" }, { capabilities: {} });

    try {
        await client.connect(transport);

        // 1. Get Tasks to find match
        const getTasksTool = (await client.listTools()).tools.find(t => t.name.includes("get_tasks"));
        if (!getTasksTool) throw new Error("get_tasks tool not found");

        console.log(`Calling ${getTasksTool.name}...`);
        const tasksResult = await client.callTool({
            name: getTasksTool.name,
            arguments: { list_id: listId, include_closed: true }
        });
        console.log("Tool call returned.");

        fs.writeFileSync('.tmp/tasks_dump.json', JSON.stringify(tasksResult, null, 2));
        console.log("Dumped tasks to .tmp/tasks_dump.json");

        let tasks = [];
        if (tasksResult.content && tasksResult.content[0] && tasksResult.content[0].text) {
            try {
                const parsed = JSON.parse(tasksResult.content[0].text);
                tasks = parsed.tasks || [];
            } catch (e) {
                console.error("Failed to parse tasks JSON:", e);
            }
        }

        console.log(`Found ${tasks.length} tasks in the list.`);
        if (tasks.length > 0) {
            console.log("First Task:", tasks[0].name);
            console.log("Custom Fields:", tasks[0].custom_fields.map(cf => `${cf.name}: ${cf.value || '(empty)'}`).join(", "));
        }

        const normalizePhone = (p) => p ? p.replace(/\s+/g, '').replace(/^00/, '+') : '';
        const searchPhone = normalizePhone(targetPhone);

        const matchedTask = tasks.find(t => {
            const phoneField = t.custom_fields.find(cf =>
                (cf.name === "Phone Number" || cf.name === "Phone" || cf.name === "Telefon") && cf.value
            );
            if (!phoneField) return false;

            // Check strictly or normalized
            const taskPhone = normalizePhone(phoneField.value);
            return taskPhone.includes(searchPhone) || searchPhone.includes(taskPhone);
        });

        if (!matchedTask) {
            console.log(`No task found for phone number ${searchPhone}. Creating new task...`);

            // Spawn create_clickup_task.js
            const { spawnSync } = require('child_process');

            const createProcess = spawnSync('node', [
                path.join(__dirname, 'create_clickup_task.js'),
                '--transcript', transcriptPath,
                '--list-id', listId
            ], {
                encoding: 'utf-8',
                env: process.env
            });

            if (createProcess.error) {
                console.error("Failed to start create script:", createProcess.error);
                process.exit(1);
            }

            console.log(createProcess.stdout);

            if (createProcess.stderr) {
                console.error("Create Script Error:", createProcess.stderr);
            }

            if (createProcess.status !== 0) {
                console.error("Create script failed with status:", createProcess.status);
                process.exit(1);
            }

            // Exit successfully as we handled the case via creation
            process.exit(0);
        }

        console.log(`Found Task: ${matchedTask.name} (ID: ${matchedTask.id})`);

        // 2. Identify Custom Fields for Update
        // We need the IDs of "Transcript" and "Proposal" fields from the task definition
        const transcriptField = matchedTask.custom_fields.find(cf => cf.name === "Transcript");
        const proposalField = matchedTask.custom_fields.find(cf => cf.name === "Proposal");

        if (!transcriptField || !proposalField) {
            console.error("Could not find 'Transcript' or 'Proposal' custom fields on the task.");
            console.log("Available fields:", matchedTask.custom_fields.map(cf => cf.name).join(", "));
            // process.exit(1); 
            // Proceeding to create text/doc if possible, or just log
        }

        // 3. Update Task
        // Depending on tool capabilities, we might use 'update_task' or 'set_custom_field'
        // Let's assume 'set_custom_field_value' or generic 'update_task' with custom_fields arg
        const tools = await client.listTools();
        const setFieldTool = tools.tools.find(t => t.name.includes("set_custom_field"));

        // Helper to update field
        const updateField = async (fieldId, value) => {
            if (setFieldTool && fieldId) {
                console.log(`Updating Field ${fieldId} with value length ${value.length}...`);
                await client.callTool({
                    name: setFieldTool.name,
                    arguments: {
                        task_id: matchedTask.id,
                        field_id: fieldId,
                        value: value // Text value or URL
                    }
                });
            } else {
                console.log(`Skipping update for field (Tool or ID missing). Value start: ${value.substring(0, 20)}...`);
            }
        };

        if (transcriptField) {
            // In a real app, maybe upload file and link? For now, pasting text or mocking functionality.
            // If Text field:
            await updateField(transcriptField.id, transcriptData.transcript);
        }

        if (proposalField && proposalContent) {
            await updateField(proposalField.id, proposalContent);
        }

        console.log("Update sequence matched.");

    } catch (error) {
        console.error("Error communicating with MCP Server:", JSON.stringify(error, null, 2));
        if (error.data) console.error("Error Data:", JSON.stringify(error.data, null, 2));
    } finally {
        await client.close();
    }
}

main().catch(console.error);
