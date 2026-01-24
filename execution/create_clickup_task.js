require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

// Parse arguments
const args = process.argv.slice(2);
let transcriptPath = null;
let proposalPath = null;
let listId = process.env.CLICKUP_LIST_ID;
let status = 'lead necontactat'; // Default status

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transcript') {
        transcriptPath = args[i + 1];
        i++;
    } else if (args[i] === '--proposal') {
        proposalPath = args[i + 1];
        i++;
    } else if (args[i] === '--list-id') {
        listId = args[i + 1];
        i++;
    } else if (args[i] === '--status') {
        status = args[i + 1];
        i++;
    }
}

if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    console.error("Error: Transcript file required");
    process.exit(1);
}

const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
const taskName = transcriptData.client || 'New Caller';
const phoneNumber = transcriptData.phone_number;
const transcriptText = transcriptData.transcript;

async function main() {
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

    const client = new Client({ name: "clickup-creator", version: "1.0.0" }, { capabilities: {} });

    try {
        await client.connect(transport);

        // list_id and name are required for create_task
        const createTool = (await client.listTools()).tools.find(t => t.name.includes("create_task"));

        if (!createTool) throw new Error("create_task tool not found");

        console.log(`Creating task "${taskName}" in list ${listId}...`);

        const result = await client.callTool({
            name: createTool.name,
            arguments: {
                list_id: listId,
                name: taskName,
                description: `Created via CloudTalk Webhook\n\nCall ID: ${transcriptData.id}\nDate: ${transcriptData.date}\n\n## Transcript\n\n${transcriptText}`,
                status: status
            }
        });

        // Parse result to get Task ID
        let taskId = null;
        try {
            // MCP result content is text usually
            const text = result.content[0].text;
            // The tool output format depends on the specific MCP server implementation
            // Often it returns a JSON string or a success message with ID
            // Let's assume it returns the Task object JSON
            const taskObj = JSON.parse(text);
            taskId = taskObj.id;
        } catch (e) {
            console.log("Could not parse create_task output as JSON. Trying to find ID in text:", result.content[0].text);
            // Fallback regex or simple check if needed
        }

        if (!taskId) {
            console.error("Failed to retrieve new Task ID.");
            console.log("Result:", result);
            process.exit(1);
        }

        console.log(`Task Created! ID: ${taskId}`);

        // Update Custom Fields
        const setFieldTool = (await client.listTools()).tools.find(t => t.name.includes("set_custom_field"));

        if (setFieldTool) {
            // IDs from analysis
            const PHONE_FIELD_ID = "eb97c5e8-b471-4bb3-884d-90612080a2c9";
            const SURSA_FIELD_ID = "f4612f98-bbf7-4502-872f-988b0ac8cca7";
            const TRANSCRIPT_FIELD_ID = "ed412f37-c8fc-4a0d-9754-bba6008cda48";

            // Update Phone
            if (phoneNumber) {
                console.log(`Setting Phone: ${phoneNumber}`);
                await client.callTool({
                    name: setFieldTool.name,
                    arguments: { task_id: taskId, field_id: PHONE_FIELD_ID, value: phoneNumber }
                });
            }

            // Update Sursa (Telefonic = option index 3)
            console.log(`Setting Sursa: Telefonic (3)`);
            await client.callTool({
                name: setFieldTool.name,
                arguments: { task_id: taskId, field_id: SURSA_FIELD_ID, value: 3 }
            });

            // Update Transcript
            if (transcriptText) {
                console.log(`Setting Transcript`);
                await client.callTool({
                    name: setFieldTool.name,
                    arguments: { task_id: taskId, field_id: TRANSCRIPT_FIELD_ID, value: transcriptText }
                });
            }

            // Update Proposal
            if (proposalPath && fs.existsSync(proposalPath)) {
                try {
                    const proposalContent = fs.readFileSync(proposalPath, 'utf8');
                    const PROPOSAL_FIELD_ID = "8c80cd3c-d8bf-42c7-8f04-baf4066cb8b9"; // ID from tasks_dump.json
                    console.log(`Setting Proposal`);
                    await client.callTool({
                        name: setFieldTool.name,
                        arguments: { task_id: taskId, field_id: PROPOSAL_FIELD_ID, value: proposalContent }
                    });
                } catch (err) {
                    console.error("Failed to read/set proposal:", err);
                }
            }
        }

    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    } finally {
        await client.close();
    }
}

main();
