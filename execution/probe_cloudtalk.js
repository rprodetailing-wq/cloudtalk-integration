const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.CLOUDTALK_API_KEY;
const API_SECRET = process.env.CLOUDTALK_API_SECRET;

const auth = {
    username: API_KEY,
    password: API_SECRET
};

async function probe() {
    const candidates = [
        'https://my.cloudtalk.io/api/workflows',
        'https://my.cloudtalk.io/api/automations',
        'https://my.cloudtalk.io/api/integrations',
        'https://api.cloudtalk.io/v1/workflows',
        'https://api.cloudtalk.io/v1/automations'
    ];

    console.log("Probing undocumented endpoints...");

    for (const url of candidates) {
        try {
            console.log(`GET ${url}`);
            const res = await axios.get(url, { auth, validateStatus: () => true });
            console.log(`Status: ${res.status}`);
            if (res.status === 200) {
                console.log("!!! DISCOVERED ENDPOINT !!!");
                console.log(JSON.stringify(res.data).substring(0, 200));
            }
        } catch (e) {
            console.log(`Error: ${e.message}`);
        }
    }
}

probe();
