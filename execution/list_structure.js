require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.CLICKUP_API_KEY;

if (!API_KEY) {
    console.error("Missing CLICKUP_API_KEY");
    process.exit(1);
}

async function dumpStructure() {
    const headers = {
        'Authorization': API_KEY,
        'Content-Type': 'application/json'
    };

    const structure = {
        user: null,
        teams: []
    };

    try {
        // 1. Get User
        const userRes = await axios.get('https://api.clickup.com/api/v2/user', { headers });
        structure.user = userRes.data.user;
        console.log(`User: ${structure.user.username}`);

        // 2. Get Teams
        const teamsRes = await axios.get('https://api.clickup.com/api/v2/team', { headers });

        for (const team of teamsRes.data.teams) {
            const teamData = { name: team.name, id: team.id, spaces: [] };
            console.log(`Processing Team: ${team.name}`);

            // 3. Get Spaces
            const spacesRes = await axios.get(`https://api.clickup.com/api/v2/team/${team.id}/space`, { headers });

            for (const space of spacesRes.data.spaces) {
                const spaceData = { name: space.name, id: space.id, folders: [], lists: [] };

                // 4. Get Folders
                const foldersRes = await axios.get(`https://api.clickup.com/api/v2/space/${space.id}/folder`, { headers });
                for (const folder of foldersRes.data.folders) {
                    const folderData = { name: folder.name, id: folder.id, lists: [] };
                    for (const list of folder.lists) {
                        folderData.lists.push({ name: list.name, id: list.id });
                    }
                    spaceData.folders.push(folderData);
                }

                // 5. Get Folderless Lists
                const listsRes = await axios.get(`https://api.clickup.com/api/v2/space/${space.id}/list`, { headers });
                for (const list of listsRes.data.lists) {
                    spaceData.lists.push({ name: list.name, id: list.id });
                }

                teamData.spaces.push(spaceData);
            }
            structure.teams.push(teamData);
        }

        fs.writeFileSync('.tmp/clickup_structure.json', JSON.stringify(structure, null, 2));
        console.log("Structure dumped to .tmp/clickup_structure.json");

    } catch (e) {
        console.error("Error:", e.message);
        if (e.response) console.error(e.response.data);
    }
}

dumpStructure();
