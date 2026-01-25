// Vercel Serverless Function to fetch failed actions from Integrator API
// Proxies the request to avoid CORS issues

const INTEGRATOR_API_URL = process.env.INTEGRATOR_API_URL || 'https://integrations-api.composio.io';

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { workflow_id, run_number } = req.body;

        if (!workflow_id || !run_number) {
            return res.status(400).json({ error: 'Missing required fields (workflow_id, run_number)' });
        }

        console.log(`Fetching failed actions for workflow ${workflow_id} run ${run_number}`);

        // Call Integrator API
        const apiResponse = await fetch(`${INTEGRATOR_API_URL}/dashboard/get-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflow_id,
                run_number
            })
        });

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error('Integrator API error:', apiResponse.status, errorText);
            return res.status(apiResponse.status).json({
                error: 'Failed to fetch from Integrator API',
                details: errorText
            });
        }

        const apiData = await apiResponse.json();
        const failedActions = apiData.failed_actions || [];

        console.log(`Found ${failedActions.length} failed actions`);

        return res.status(200).json({
            success: true,
            failed_actions: failedActions,
            execution_state: apiData.execution_state
        });

    } catch (error) {
        console.error('Error in get-failed-actions:', error);
        return res.status(500).json({ error: error.message });
    }
}
