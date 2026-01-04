require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.CLICKUP_API_KEY;
const LIST_ID = process.env.CLICKUP_LIST_ID;

if (!API_KEY) {
    console.error("Missing CLICKUP_API_KEY");
    process.exit(1);
}

async function verify() {
    const headers = {
        'Authorization': API_KEY,
        'Content-Type': 'application/json'
    };

    console.log(`Verifying Token: ${API_KEY.substring(0, 10)}...`);

    // 1. Get Authorized User
    try {
        console.log("1. Fetching User...");
        const userRes = await axios.get('https://api.clickup.com/api/v2/user', { headers });
        console.log("   Success! User:", userRes.data.user.username, "(ID:", userRes.data.user.id, ")");
    } catch (e) {
        console.error("   FAILED to fetch user:", e.message);
        return;
    }

    // 2. Get Teams (Workspaces)
    try {
        console.log("2. Fetching Teams (Workspaces)...");
        const teamsRes = await axios.get('https://api.clickup.com/api/v2/team', { headers });
        console.log("   Teams found:", teamsRes.data.teams.length);
        teamsRes.data.teams.forEach(t => console.log(`   - ${t.name} (ID: ${t.id})`));
    } catch (e) {
        console.error("   FAILED to fetch teams:", e.message);
    }

    // 3. Get List
    if (LIST_ID) {
        try {
            console.log(`3. Fetching List ${LIST_ID}...`);
            const listRes = await axios.get(`https://api.clickup.com/api/v2/list/${LIST_ID}`, { headers });
            console.log("   Success! List Name:", listRes.data.name);
            console.log("   Folder:", listRes.data.folder?.name);
            console.log("   Space:", listRes.data.space?.name);
            console.log("   Statuses:", listRes.data.statuses.map(s => s.status).join(", "));
        } catch (e) {
            console.error("   FAILED to fetch list:", e.message);
            if (e.response) {
                console.error("   Details:", e.response.status, JSON.stringify(e.response.data));
            }
        }
    } else {
        console.log("3. Skipping List check (no ID provided defined in env)");
    }
}

verify();
