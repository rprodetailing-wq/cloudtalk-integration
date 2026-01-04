require('dotenv').config();
const path = require('path');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
    if (!process.env.CLICKUP_API_KEY) {
        console.error("Error: CLICKUP_API_KEY must be set in .env");
        process.exit(1);
    }

    // Attempt to locate the server module
    let serverPath;
    try {
        serverPath = require.resolve('@chykalophia/clickup-mcp-server/dist/index.js');
    } catch (e) {
        serverPath = path.resolve(__dirname, '../node_modules/@chykalophia/clickup-mcp-server/dist/index.js');
    }

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            CLICKUP_API_TOKEN: process.env.CLICKUP_API_KEY
        }
    });

    const client = new Client({
        name: "clickup-inspector",
        version: "1.0.0",
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        console.log("Connected to ClickUp MCP Server.");

        const toolsList = await client.listTools();
        console.log("\n--- Available Tools ---");
        toolsList.tools.forEach(t => console.log(`- ${t.name}: ${t.description?.substring(0, 50)}...`));

        // Try to find a tool to list workspaces or lists
        // Common names: 'get_teams' (workspaces), 'get_spaces', 'get_folders', 'get_lists'

        // Strategy: 
        // 1. Get Teams (Workspaces)
        // 2. Use first Team ID to Get Spaces
        // 3. Use first Space ID to Get Lists (or Folders then Lists)

        // This is a discovery script, so we'll try to just dump the workspaces first to see if it works.
        const getTeamsTool = toolsList.tools.find(t => t.name.includes("get_teams") || t.name === "get_workspaces");

        // Inspect available tools again to be sure
        // console.log("Tools:", toolsList.tools.map(t => t.name));

        const getTasksTool = toolsList.tools.find(t => t.name.includes("get_tasks"));
        const getAccessibleCustomFields = toolsList.tools.find(t => t.name.includes("get_accessible_custom_fields"));

        // We need to see the Custom Fields (Columns) to find "Phone Number" and where to put Transcript/Proposal
        if (getTasksTool) {
            console.log(`\nCalling ${getTasksTool.name} for List ${process.env.CLICKUP_LIST_ID}...`);
            // Try to fetch a few tasks to see their structure and custom_fields
            const tasksResult = await client.callTool({
                name: getTasksTool.name,
                arguments: {
                    list_id: process.env.CLICKUP_LIST_ID,
                    include_closed: true
                }
            });
            // Log the structure of the first task to see Custom Fields mappings
            if (tasksResult.tasks && tasksResult.tasks.length > 0) {
                console.log("Sample Task Structure:", JSON.stringify(tasksResult.tasks[0], null, 2));
                console.log("Task Custom Fields:", JSON.stringify(tasksResult.tasks[0].custom_fields, null, 2));
            } else {
                console.log("No tasks found in this list.", JSON.stringify(tasksResult, null, 2));
            }
        }

        // if (getTeamsTool) {
        //     console.log(`\nCalling ${getTeamsTool.name}...`);
        //     const teamsResult = await client.callTool({ name: getTeamsTool.name, arguments: {} });
        //     console.log("Teams/Workspaces:", JSON.stringify(teamsResult, null, 2));

        //     // If we got teams, maybe we can list spaces for the first one
        //     // Note: The specific structure of the result depends on the server implementation.
        //     // We'll inspect the text output.
        // }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
    }
}

main().catch(console.error);
