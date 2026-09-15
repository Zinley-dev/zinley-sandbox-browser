/**
 * Gmail Actions for Browser Use
 * Defines agent actions for Gmail integration including 2FA code retrieval,
 * email reading, and authentication management.
 * Port from browser_use/integrations/gmail/actions.py
 */

import { z } from 'zod';
import { ActionResult } from '../../agent/views.js';
import { Tools } from '../../tools/service.js';
import { GmailService, GmailServiceOptions } from './service.js';

// Global Gmail service instance - initialized when actions are registered
let _gmailService: GmailService | null = null;

/**
 * Parameters for getting recent emails
 */
export const GetRecentEmailsParamsSchema = z.object({
	keyword: z.string().default('').describe("A single keyword for search, e.g. github, airbnb, etc."),
	maxResults: z.number().min(1).max(50).default(3).describe("Maximum number of emails to retrieve (1-50, default: 3)"),
});

export type GetRecentEmailsParams = z.infer<typeof GetRecentEmailsParamsSchema>;

/**
 * Register Gmail actions with the provided tools
 * @param tools The browser-use tools to register actions with
 * @param gmailService Optional pre-configured Gmail service instance
 * @param accessToken Optional direct access token (alternative to file-based auth)
 * @returns The tools instance with Gmail actions registered
 */
export function registerGmailActions(
	tools: Tools,
	gmailService?: GmailService,
	accessToken?: string
): Tools {
	// Use provided service or create a new one with access token if provided
	if (gmailService) {
		_gmailService = gmailService;
	} else if (accessToken) {
		_gmailService = new GmailService({ accessToken });
	} else {
		_gmailService = new GmailService();
	}

	// Register get_recent_emails action
	tools.registry.register({
		name: 'get_recent_emails',
		description: 'Get recent emails from the mailbox with a keyword to retrieve verification codes, OTP, 2FA tokens, magic links, or any recent email content. Keep your query a single keyword.',
		function: getRecentEmailsAction,
		paramModel: GetRecentEmailsParamsSchema,
	});

	return tools;
}

/**
 * Get recent emails from the last 5 minutes with full content
 */
async function getRecentEmailsAction(params: GetRecentEmailsParams): Promise<ActionResult> {
	try {
		if (!_gmailService) {
			throw new Error('Gmail service not initialized');
		}

		// Ensure authentication
		if (!_gmailService.isAuthenticated()) {
			console.log('📧 Gmail not authenticated, attempting authentication...');
			const authenticated = await _gmailService.authenticate();
			if (!authenticated) {
				return {
					extractedContent: 'Failed to authenticate with Gmail. Please ensure Gmail credentials are set up properly.',
					longTermMemory: 'Gmail authentication failed',
				};
			}
		}

		// Use specified max_results (1-50, default 3), last 5 minutes
		const maxResults = params.maxResults;
		const timeFilter = '5m';

		// Build query with time filter and optional user query
		const queryParts = [`newer_than:${timeFilter}`];
		if (params.keyword.trim()) {
			queryParts.push(params.keyword.trim());
		}

		const query = queryParts.join(' ');
		console.log(`🔍 Gmail search query: ${query}`);

		// Get emails
		const emails = await _gmailService.getRecentEmails(maxResults, query, timeFilter);

		if (emails.length === 0) {
			const queryInfo = params.keyword.trim() ? ` matching '${params.keyword}'` : '';
			const memory = `No recent emails found from last ${timeFilter}${queryInfo}`;
			return {
				extractedContent: memory,
				longTermMemory: memory,
			};
		}

		// Format with full email content for large display
		let content = `Found ${emails.length} recent email${emails.length > 1 ? 's' : ''} from the last ${timeFilter}:\n\n`;

		for (let i = 0; i < emails.length; i++) {
			const email = emails[i];
			content += `Email ${i + 1}:\n`;
			content += `From: ${email.from}\n`;
			content += `Subject: ${email.subject}\n`;
			content += `Date: ${email.date}\n`;
			content += `Content:\n${email.body}\n`;
			content += '-'.repeat(50) + '\n\n';
		}

		console.log(`📧 Retrieved ${emails.length} recent emails`);
		return {
			extractedContent: content,
			includeExtractedContentOnlyOnce: true,
			longTermMemory: `Retrieved ${emails.length} recent emails from last ${timeFilter} for query ${query}.`,
		};
	} catch (e: any) {
		console.error(`Error getting recent emails: ${e.message}`);
		return {
			error: `Error getting recent emails: ${e.message}`,
			longTermMemory: 'Failed to get recent emails due to error',
		};
	}
}

// Export for direct use
export const gmailActions = {
	getRecentEmails: getRecentEmailsAction,
};
