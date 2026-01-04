const fs = require('fs');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
let inputFile = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') {
        inputFile = args[i + 1];
        i++;
    }
}

if (!inputFile) {
    console.error("Error: --input argument is required");
    process.exit(1);
}

function generateProposal() {
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: File ${inputFile} not found.`);
        return;
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    const outputDir = path.join('.tmp', 'proposals');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const proposalContent = `# Project Proposal for ${data.client || 'Unknown Client'}

## Overview
Based on our conversation on ${data.date}, here is a proposal draft.

## Discussion Summary
${data.transcript}

## Proposed Action Items
1. [User to fill in]
2. [User to fill in]

## Next Steps
- Review this proposal.
- Confirm scope.

---
*Generated automatically from CloudTalk Call ID: ${data.id}*
`;

    const outputFilename = path.join(outputDir, `proposal_${data.id}.md`);
    fs.writeFileSync(outputFilename, proposalContent);

    console.log(`Proposal generated at ${outputFilename}`);
}

generateProposal();
