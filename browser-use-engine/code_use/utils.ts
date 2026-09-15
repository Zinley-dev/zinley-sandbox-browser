/**
 * Utility functions for code-use agent.
 * Port from browser_use/code_use/utils.py
 */

/**
 * Truncate message content to max_length characters for history.
 */
export function truncateMessageContent(content: string, maxLength: number = 10000): string {
	if (content.length <= maxLength) {
		return content;
	}
	return content.slice(0, maxLength) + `\n\n[... truncated ${content.length - maxLength} characters for history]`;
}

/**
 * Detect if the LLM response hit token limits or is repetitive garbage.
 *
 * @returns Tuple of [isProblematic, errorMessage]
 */
export function detectTokenLimitIssue(
	completion: string,
	completionTokens: number | null,
	maxTokens: number | null,
	stopReason: string | null
): [boolean, string | null] {
	// Check 1: Stop reason indicates max_tokens
	if (stopReason === 'max_tokens') {
		return [true, `Response terminated due to max_tokens limit (stop_reason: ${stopReason})`];
	}

	// Check 2: Used 90%+ of max_tokens (if we have both values)
	if (completionTokens !== null && maxTokens !== null && maxTokens > 0) {
		const usageRatio = completionTokens / maxTokens;
		if (usageRatio >= 0.9) {
			return [true, `Response used ${(usageRatio * 100).toFixed(1)}% of max_tokens (${completionTokens}/${maxTokens})`];
		}
	}

	// Check 3: Last 6 characters repeat 40+ times (repetitive garbage)
	if (completion.length >= 6) {
		const last6 = completion.slice(-6);
		const repetitionCount = completion.split(last6).length - 1;
		if (repetitionCount >= 40) {
			return [true, `Repetitive output detected: last 6 chars "${last6}" appears ${repetitionCount} times`];
		}
	}

	return [false, null];
}

/**
 * Extract URL from task string using naive pattern matching.
 */
export function extractUrlFromTask(task: string): string | null {
	// Remove email addresses from task before looking for URLs. Lookbehind
	// instead of \b: the local-part class contains `.`, so \b let the engine
	// retry from every index of a dotted run (~1s per 40KB pasted token, O(n²)).
	const taskWithoutEmails = task.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '');

	// Look for common URL patterns
	const patterns = [
		/https?:\/\/[^\s<>"']+/g, // Full URLs with http/https
		// Domain names with paths. The leading lookbehind restricts match
		// attempts to run boundaries: without it the engine retried the
		// ambiguous `+(\.…)*` tail from EVERY index, which measured ~6s on a
		// 100KB pasted token (O(n²) ReDoS) — and this runs in the MAIN process,
		// freezing every window. Mid-run starts only ever produced duplicate
		// noise, so matches are unchanged.
		/(?<![a-zA-Z0-9.-])(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(?:\/[^\s<>"']*)?/g,
	];

	const foundUrls: string[] = [];
	for (const pattern of patterns) {
		const matches = taskWithoutEmails.match(pattern);
		if (matches) {
			for (let url of matches) {
				// Remove trailing punctuation that's not part of URLs
				url = url.replace(/[.,;:!?()\[\]]+$/, '');
				// Add https:// if missing
				if (!url.startsWith('http://') && !url.startsWith('https://')) {
					url = 'https://' + url;
				}
				foundUrls.push(url);
			}
		}
	}

	const uniqueUrls = [...new Set(foundUrls)];

	// If multiple URLs found, skip auto-navigation to avoid ambiguity
	if (uniqueUrls.length > 1) {
		return null;
	}

	// If exactly one URL found, return it
	if (uniqueUrls.length === 1) {
		return uniqueUrls[0];
	}

	return null;
}

/**
 * Extract all code blocks from markdown response.
 *
 * Supports:
 * - ```python, ```js, ```javascript, ```bash, ```markdown, ```md
 * - Named blocks: ```js variable_name -> saved as 'variable_name' in namespace
 * - Nested blocks: Use 4+ backticks for outer block when inner content has 3 backticks
 *
 * @returns Dict mapping block_name -> content
 */
export function extractCodeBlocks(text: string): Record<string, string> {
	// Pattern to match code blocks with language identifier and optional variable name
	const pattern = /(`{3,})(\w+)(?:\s+(\w+))?\n([\s\S]*?)\1(?:\n|$)/g;

	const blocks: Record<string, string> = {};
	let pythonBlockCounter = 0;

	let match;
	while ((match = pattern.exec(text)) !== null) {
		const [, , lang, varName, content] = match;
		const langLower = lang.toLowerCase();

		// Normalize language names
		let langNormalized: string;
		if (langLower === 'javascript' || langLower === 'js') {
			langNormalized = 'js';
		} else if (langLower === 'markdown' || langLower === 'md') {
			langNormalized = 'markdown';
		} else if (langLower === 'sh' || langLower === 'shell') {
			langNormalized = 'bash';
		} else if (langLower === 'python') {
			langNormalized = 'python';
		} else {
			continue; // Unknown language, skip
		}

		// Only process supported types
		if (['python', 'js', 'bash', 'markdown'].includes(langNormalized)) {
			const trimmedContent = content.trimEnd();
			if (trimmedContent) {
				if (varName) {
					// Named block - use the variable name
					blocks[varName] = trimmedContent;
				} else if (langNormalized === 'python') {
					// Unnamed Python blocks - give each a unique key
					blocks[`python_${pythonBlockCounter}`] = trimmedContent;
					pythonBlockCounter++;
				} else {
					// Other unnamed blocks - keep last one only
					blocks[langNormalized] = trimmedContent;
				}
			}
		}
	}

	// If we have multiple python blocks, mark the first one as 'python' for backward compat
	if (pythonBlockCounter > 0) {
		blocks['python'] = blocks['python_0'];
	}

	// Fallback: if no python block but there's generic ``` block, treat as python
	if (pythonBlockCounter === 0 && !blocks['python']) {
		const genericPattern = /```\n([\s\S]*?)```/g;
		const genericMatches = [];
		let genericMatch;
		while ((genericMatch = genericPattern.exec(text)) !== null) {
			genericMatches.push(genericMatch[1]);
		}
		if (genericMatches.length > 0) {
			const combined = genericMatches
				.map((m) => m.trim())
				.filter((m) => m)
				.join('\n\n');
			if (combined) {
				blocks['python'] = combined;
			}
		}
	}

	return blocks;
}

/**
 * Strip JavaScript comments before CDP evaluation.
 */
export function stripJsComments(jsCode: string): string {
	// Remove multi-line comments
	jsCode = jsCode.replace(/\/\*[\s\S]*?\*\//g, '');

	// Remove single-line comments - only lines that START with // (after whitespace)
	jsCode = jsCode.replace(/^\s*\/\/.*$/gm, '');

	return jsCode;
}
