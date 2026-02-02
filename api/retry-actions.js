// Vercel Serverless Function for retrying specific failed actions
// Calls the Integrator API and updates the failed_tools table

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
        const { toolkit, connection_id, action_names, linear_ticket, environment } = req.body;

        if (!toolkit || !connection_id || !action_names?.length) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['toolkit', 'connection_id', 'action_names (array)']
            });
        }

        // Normalize environment
        const normalizedEnv = environment === 'prod' ? 'production' : (environment || 'production');

        // Build payload for Integrator API
        const payload = {
            model_provider: 'claude',
            force_run: true,
            timeout_hours: 36,
            linear_issue_link: linear_ticket ? `https://linear.app/composio/issue/${linear_ticket}` : '',
            env: normalizedEnv,
            integrator_branch: 'next',
            app_name: toolkit,
            base_branch: 'master',
            connection_id: connection_id,
            action_names: action_names,
            test_instruction: "Test thoroughly and ensure: (1) tool/parameter descriptions are clear and accurate, not sloppy or vague, (2) correct API endpoints are used, (3) response schemas are complete and useful, (4) the tool is well-built for agent use with sensible defaults."
        };

        console.log('Calling Integrator API with payload:', JSON.stringify(payload, null, 2));

        // Call Integrator API
        const apiResponse = await fetch(`${INTEGRATOR_API_URL}/workflows/test-and-fix-action/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const apiResult = await apiResponse.json();
        console.log('Integrator API response:', JSON.stringify(apiResult, null, 2));

        if (!apiResponse.ok || !apiResult.workflow_id) {
            console.error('API Error - Status:', apiResponse.status, 'Result:', apiResult);
            return res.status(500).json({
                error: 'Failed to trigger workflow',
                details: apiResult.message || apiResult.error || 'No workflow_id returned',
                api_response: apiResult,
                http_status: apiResponse.status
            });
        }

        // Update failed_tools table - mark these actions as retrying
        const updatePromises = action_names.map(async (action) => {
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/failed_tools?toolkit=eq.${encodeURIComponent(toolkit)}&action_name=eq.${encodeURIComponent(action)}`,
                {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPABASE_SERVICE_KEY,
                        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({
                        status: 'retrying',
                        retry_workflow_id: apiResult.workflow_id,
                        retry_run_number: 1,
                        retried_at: new Date().toISOString()
                    })
                }
            );
            return response.ok;
        });

        await Promise.all(updatePromises);

        // Also create a workflow_runs entry for tracking in the main dashboard
        // First, upsert the workflow entry
        await fetch(`${SUPABASE_URL}/rest/v1/workflows`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal,resolution=merge-duplicates'
            },
            body: JSON.stringify({
                workflow_id: apiResult.workflow_id,
                app_name: toolkit,
                linear_ticket: linear_ticket || 'N/A',
                connection_id: connection_id,
                environment: normalizedEnv
            })
        });

        // Then create the workflow_run
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
                run_number: 1,
                status: 'active',
                execution_state: 'PENDING',
                total: action_names.length,
                started_at: new Date().toISOString()
            })
        });

        return res.status(200).json({
            success: true,
            workflow_id: apiResult.workflow_id,
            toolkit: toolkit,
            actions_count: action_names.length,
            actions: action_names,
            api_response: apiResult
        });

    } catch (error) {
        console.error('Retry actions error:', error);
        return res.status(500).json({ error: error.message });
    }
}
