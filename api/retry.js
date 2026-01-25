// Vercel Serverless Function for retry operations
// Calls the Integrator API and updates Supabase

const INTEGRATOR_API_URL = process.env.INTEGRATOR_API_URL || 'https://integrations-api.composio.io';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
        const { app_name, workflow_id, connection_id, environment, linear_ticket, failed_actions, complete_rerun } = req.body;

        if (!app_name || !workflow_id || !connection_id) {
            return res.status(400).json({ error: 'Missing required fields (app_name, workflow_id, connection_id)' });
        }

        // Build payload for Integrator API
        const payload = {
            model_provider: 'claude',
            force_run: true,
            timeout_hours: 36,
            previous_workflow_id: workflow_id,
            linear_issue_link: linear_ticket ? `https://linear.app/composio/issue/${linear_ticket}` : '',
            env: environment || 'production',
            integrator_branch: 'next',
            app_name: app_name,
            base_branch: 'master',
            connection_id: connection_id,
            test_instruction: "Test thoroughly and ensure: (1) tool/parameter descriptions are clear and accurate, not sloppy or vague, (2) correct API endpoints are used, (3) response schemas are complete and useful, (4) the tool is well-built for agent use with sensible defaults."
        };

        // Only add action_names if not a complete rerun
        if (!complete_rerun && failed_actions?.length) {
            payload.action_names = failed_actions;
        }

        // Call Integrator API
        const apiResponse = await fetch(`${INTEGRATOR_API_URL}/workflows/test-and-fix-action/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const apiResult = await apiResponse.json();

        if (!apiResponse.ok || !apiResult.workflow_id) {
            return res.status(500).json({
                error: 'Failed to trigger workflow',
                details: apiResult.message || 'No workflow_id returned',
                api_response: apiResult
            });
        }

        // Get the current max run_number for this workflow
        const runsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/workflow_runs?workflow_id=eq.${workflow_id}&select=run_number&order=run_number.desc&limit=1`,
            {
                headers: {
                    'apikey': SUPABASE_SERVICE_KEY,
                    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
                }
            }
        );
        const runs = await runsResponse.json();
        const newRunNumber = (runs[0]?.run_number || 0) + 1;

        // Insert new workflow_run
        await fetch(`${SUPABASE_URL}/rest/v1/workflow_runs`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                workflow_id: apiResult.workflow_id,
                run_number: newRunNumber,
                status: 'active',
                execution_state: 'PENDING',
                started_at: new Date().toISOString()
            })
        });

        return res.status(200).json({
            success: true,
            workflow_id: apiResult.workflow_id,
            run_number: newRunNumber,
            actions_count: complete_rerun ? 'ALL' : (failed_actions?.length || 0),
            complete_rerun: complete_rerun || false,
            api_response: apiResult
        });

    } catch (error) {
        console.error('Retry error:', error);
        return res.status(500).json({ error: error.message });
    }
}
