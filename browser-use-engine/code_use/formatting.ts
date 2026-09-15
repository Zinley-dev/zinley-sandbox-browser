/**
 * Browser state formatting helpers for code-use agent.
 * Port from browser_use/code_use/formatting.py
 */

import { getLogger } from '../logging_config.js';
import { BrowserSession } from '../browser/session.js';
import { BrowserStateSummary } from '../browser/views.js';

const logger = getLogger('browser-use.code_use.formatting');

/**
 * Format browser state summary for LLM consumption in code-use mode.
 *
 * @param state - Browser state summary from browser_session.getState()
 * @param namespace - The code execution namespace (for showing available variables)
 * @param browserSession - Browser session for additional checks
 * @returns Formatted browser state text for LLM
 */
export async function formatBrowserStateForLlm(
	state: BrowserStateSummary,
	namespace: Record<string, any>,
	browserSession: BrowserSession
): Promise<string> {
	const domState = state.domState;
	if (!domState) {
		return '## Browser State\n\nNo DOM state available.';
	}

	// Use eval_representation (compact serializer for code agents)
	let domHtml = domState.llmRepresentation?.([]) || '';
	if (domHtml === '') {
		domHtml = 'Empty DOM tree (you might have to wait for the page to load)';
	}

	// Format with URL and title header
	const lines: string[] = ['## Browser State'];
	lines.push(`**URL:** ${state.url}`);
	lines.push(`**Title:** ${state.title}`);
	lines.push('');

	// Add tabs info if multiple tabs exist
	if (state.tabs && state.tabs.length > 1) {
		lines.push('**Tabs:**');
		const currentTargetCandidates: string[] = [];
		// Find tabs that match current URL and title
		for (const tab of state.tabs) {
			if (tab.url === state.url && tab.title === state.title) {
				currentTargetCandidates.push(tab.targetId);
			}
		}
		const currentTargetId = currentTargetCandidates.length === 1 ? currentTargetCandidates[0] : null;

		for (const tab of state.tabs) {
			const isCurrent = tab.targetId === currentTargetId ? ' (current)' : '';
			const tabId = tab.targetId.slice(-4);
			const title = tab.title?.slice(0, 30) || '';
			lines.push(`  - Tab ${tabId}: ${tab.url} - ${title}${isCurrent}`);
		}
		lines.push('');
	}

	// Add page scroll info if available
	if (state.pageInfo) {
		const pi = state.pageInfo;
		const pagesAbove = pi.viewportHeight > 0 ? pi.pixelsAbove / pi.viewportHeight : 0;
		const pagesBelow = pi.viewportHeight > 0 ? pi.pixelsBelow / pi.viewportHeight : 0;
		const totalPages = pi.viewportHeight > 0 ? pi.pageHeight / pi.viewportHeight : 0;

		let scrollInfo = `**Page:** ${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below`;
		if (totalPages > 1.2) {
			scrollInfo += `, ${totalPages.toFixed(1)} total pages`;
		}
		lines.push(scrollInfo);
		lines.push('');
	}

	// Add network loading info if there are pending requests
	if (state.pendingNetworkRequests && state.pendingNetworkRequests.length > 0) {
		// Remove duplicates by URL (keep first occurrence)
		const seenUrls = new Set<string>();
		const uniqueRequests: typeof state.pendingNetworkRequests = [];
		for (const req of state.pendingNetworkRequests) {
			if (!seenUrls.has(req.url)) {
				seenUrls.add(req.url);
				uniqueRequests.push(req);
			}
		}

		lines.push(`**Loading:** ${uniqueRequests.length} network requests still loading`);
		// Show up to 20 unique requests with truncated URLs (30 chars max)
		for (const req of uniqueRequests.slice(0, 20)) {
			const durationSec = req.loadingDurationMs / 1000;
			const urlDisplay = req.url.length <= 30 ? req.url : req.url.slice(0, 27) + '...';
			logger.info(`  - [${durationSec.toFixed(1)}s] ${urlDisplay}`);
			lines.push(`  - [${durationSec.toFixed(1)}s] ${urlDisplay}`);
		}
		if (uniqueRequests.length > 20) {
			lines.push(`  - ... and ${uniqueRequests.length - 20} more`);
		}
		lines.push(
			'**Tip:** Content may still be loading. Consider waiting with `await new Promise(r => setTimeout(r, 1000))` if data is missing.'
		);
		lines.push('');
	}

	// Add available variables and functions BEFORE DOM structure
	const skipVars = new Set([
		'browser',
		'file_system',
		'np',
		'pd',
		'plt',
		'numpy',
		'pandas',
		'matplotlib',
		'requests',
		'BeautifulSoup',
		'bs4',
		'pypdf',
		'PdfReader',
		'wait',
	]);

	// Highlight code block variables separately from regular variables
	const codeBlockVars: string[] = [];
	const regularVars: string[] = [];
	const trackedCodeBlocks = (namespace._code_block_vars as Set<string>) || new Set();

	for (const name of Object.keys(namespace)) {
		// Skip private vars and system objects/actions
		if (!name.startsWith('_') && !skipVars.has(name)) {
			if (trackedCodeBlocks.has(name)) {
				codeBlockVars.push(name);
			} else {
				regularVars.push(name);
			}
		}
	}

	// Sort for consistent display
	const availableVarsSorted = regularVars.sort();
	const codeBlockVarsSorted = codeBlockVars.sort();

	// Build available line with code blocks and variables
	const parts: string[] = [];
	if (codeBlockVarsSorted.length > 0) {
		const codeBlockDetails: string[] = [];
		for (const varName of codeBlockVarsSorted) {
			const value = namespace[varName];
			if (value !== undefined) {
				const typeName = typeof value;
				const valueStr = String(value);

				// Check if it's a function
				const isFunction =
					valueStr.trim().startsWith('(function') || valueStr.trim().startsWith('(async function');

				if (isFunction) {
					codeBlockDetails.push(`${varName}(${typeName})`);
				} else {
					// Show first and last 20 chars
					const first20 = valueStr.slice(0, 20).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
					const last20 = valueStr.length > 20 ? valueStr.slice(-20).replace(/\n/g, '\\n').replace(/\t/g, '\\t') : '';

					if (last20 && first20 !== last20) {
						codeBlockDetails.push(`${varName}(${typeName}): "${first20}...${last20}"`);
					} else {
						codeBlockDetails.push(`${varName}(${typeName}): "${first20}"`);
					}
				}
			}
		}
		parts.push(`**Code block variables:** ${codeBlockDetails.join(' | ')}`);
	}
	if (availableVarsSorted.length > 0) {
		parts.push(`**Variables:** ${availableVarsSorted.join(', ')}`);
	}

	lines.push(`**Available:** ${parts.join(' | ')}`);
	lines.push('');

	// Add DOM structure
	lines.push('**DOM Structure:**');

	// Add scroll position hints for DOM
	if (state.pageInfo) {
		const pi = state.pageInfo;
		const pagesAbove = pi.viewportHeight > 0 ? pi.pixelsAbove / pi.viewportHeight : 0;
		const pagesBelow = pi.viewportHeight > 0 ? pi.pixelsBelow / pi.viewportHeight : 0;

		if (pagesAbove > 0) {
			domHtml = `... ${pagesAbove.toFixed(1)} pages above \n${domHtml}`;
		} else {
			domHtml = '[Start of page]\n' + domHtml;
		}

		if (pagesBelow > 0) {
			domHtml += `\n... ${pagesBelow.toFixed(1)} pages below `;
		} else {
			domHtml += '\n[End of page]';
		}
	}

	// Truncate DOM if too long and notify LLM
	const maxDomLength = 60000;
	if (domHtml.length > maxDomLength) {
		lines.push(domHtml.slice(0, maxDomLength));
		lines.push(
			`\n[DOM truncated after ${maxDomLength} characters. Full page contains ${domHtml.length} characters total. Use evaluate to explore more.]`
		);
	} else {
		lines.push(domHtml);
	}

	return lines.join('\n');
}
