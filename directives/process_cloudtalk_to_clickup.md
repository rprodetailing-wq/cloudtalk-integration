# Process CloudTalk Calls to ClickUp Proposals

This directive outlines the process of fetching call transcripts from CloudTalk, generating a proposal document, and creating a task in ClickUp.

## Goal
Automate the flow from a customer call to a proposal task in the project management system.

## Tools
- `execution/fetch_cloudtalk_transcripts.js`: Retrieving data.
- `execution/generate_proposal.js`: Data processing/formatting.
- `execution/update_clickup_task.js`: Data submission (Search & Update).

## Inputs
- `Call ID` (optional, specific call) or `Date Range` (default: today).
- `ClickUp List ID` (Target list for the proposal task).

## Process

1.  **Fetch Transcripts**
    - Run `node execution/fetch_cloudtalk_transcripts.js`
    - **Arguments**:
        - `--call-id <id>` OR `--date <YYYY-MM-DD>`
    - **Output**: JSON or Text files in `.tmp/transcripts/`

2.  **Generate Proposal**
    - Run `node execution/generate_proposal.js`
    - **Arguments**:
        - `--input <path_to_transcript_file>`
    - **Output**: Markdown proposal file in `.tmp/proposals/`

3.  **Update ClickUp Task (via MCP)**
    - Run `node execution/update_clickup_task.js`
    - **Arguments**:
        - `--transcript <path_to_transcript_json>`
        - `--proposal <path_to_proposal_file>`
    - **Mechanism**:
        - Spawns `@chykalophia/clickup-mcp-server`.
        - Fetches tasks from `CLICKUP_LIST_ID`.
        - Matches task by `phone_number` from transcript.
        - Updates "Transcript" and "Proposal" columns.
    - **Output**: Logs matched task and update status.

## Edge Cases
- **No Transcript**: If CloudTalk doesn't have a transcript yet, retry later or alert user.
- **API Errors**: Check `.env` keys if 401/403 errors occur.
