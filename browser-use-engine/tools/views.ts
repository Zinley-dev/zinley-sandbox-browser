/**
 * Action parameter models.
 * Port of browser_use/tools/views.py (Python browser-use 0.13.10).
 *
 * Field names are snake_case on purpose: they are the LLM-facing tool
 * parameters and must match the Python prompts / examples verbatim.
 */

import { z } from 'zod';

// ============================================================================
// Content extraction and page exploration
// ============================================================================

export const ExtractActionSchema = z.object({
	query: z.string().describe('What information to extract from the page'),
	extract_links: z
		.boolean()
		.optional()
		.default(false)
		.describe('Set True to true if the query requires links, else false to safe tokens'),
	extract_images: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Set True to include image src URLs in extracted markdown. Auto-enabled when query contains image-related keywords.'
		),
	start_from_char: z
		.number()
		.int()
		.min(0)
		.optional()
		.default(0)
		.describe('Use this for long markdowns to start from a specific character (not index in browser_state)'),
	// `output_schema` is intentionally NOT part of the LLM-facing schema (Python marks it
	// SkipJsonSchema). Structured extraction is driven by the agent-injected
	// `extractionSchema` in the action context instead.
	already_collected: z
		.array(z.string())
		.optional()
		.default([])
		.describe(
			'Item identifiers (name, URL, or ID) already collected in prior extract calls on other pages. The extractor will skip items matching these to prevent duplicates. Use when paginating across multiple pages.'
		),
});
export type ExtractAction = z.infer<typeof ExtractActionSchema>;

export const SearchPageActionSchema = z.object({
	pattern: z.string().describe('Text or regex pattern to search for in page content'),
	regex: z.boolean().optional().default(false).describe('Treat pattern as regex (default: literal text match)'),
	case_sensitive: z
		.boolean()
		.optional()
		.default(false)
		.describe('Case-sensitive search (default: case-insensitive)'),
	context_chars: z.number().int().optional().default(150).describe('Characters of surrounding context per match'),
	css_scope: z.string().nullable().optional().describe('CSS selector to limit search scope (e.g. "div#main")'),
	max_results: z.number().int().optional().default(25).describe('Maximum matches to return'),
});
export type SearchPageAction = z.infer<typeof SearchPageActionSchema>;

export const FindElementsActionSchema = z.object({
	selector: z.string().describe('CSS selector to query elements (e.g. "table tr", "a.link", "div.product")'),
	attributes: z
		.array(z.string())
		.nullable()
		.optional()
		.describe(
			'Specific attributes to extract (e.g. ["href", "src", "class"]). If not set, returns tag and text only.'
		),
	max_results: z.number().int().optional().default(50).describe('Maximum elements to return'),
	include_text: z.boolean().optional().default(true).describe('Include text content of each element'),
});
export type FindElementsAction = z.infer<typeof FindElementsActionSchema>;

// ============================================================================
// Navigation
// ============================================================================

export const SEARCH_ENGINES = ['duckduckgo', 'google', 'bing'] as const;

export const SearchActionSchema = z.object({
	query: z.string().describe('The search query'),
	engine: z
		.enum(SEARCH_ENGINES)
		.optional()
		.default('duckduckgo')
		.describe('Search engine to use: duckduckgo (default), google, or bing'),
});
export type SearchAction = z.infer<typeof SearchActionSchema>;
/** Backward compatibility alias (Python: SearchGoogleAction = SearchAction) */
export const SearchGoogleActionSchema = SearchActionSchema;

export const NavigateActionSchema = z.object({
	url: z.string().describe('The URL to navigate to'),
	new_tab: z.boolean().optional().default(false).describe('Open in a new tab'),
});
export type NavigateAction = z.infer<typeof NavigateActionSchema>;
/** Backward compatibility alias (Python: GoToUrlAction = NavigateAction) */
export const GoToUrlActionSchema = NavigateActionSchema;

// ============================================================================
// Element interaction
// ============================================================================

/** Click by index OR by viewport coordinates (used when coordinate clicking is enabled). */
export const ClickElementActionSchema = z.object({
	index: z.number().int().min(1).nullable().optional().describe('Element index from browser_state'),
	coordinate_x: z.number().int().nullable().optional().describe('Horizontal coordinate relative to viewport left edge'),
	coordinate_y: z.number().int().nullable().optional().describe('Vertical coordinate relative to viewport top edge'),
	button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to use'),
});
export type ClickElementAction = z.infer<typeof ClickElementActionSchema>;

/** Default click model: index only. */
export const ClickElementActionIndexOnlySchema = z.object({
	index: z.number().int().min(1).describe('Element index from browser_state'),
	button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to use'),
});
export type ClickElementActionIndexOnly = z.infer<typeof ClickElementActionIndexOnlySchema>;

export const InputTextActionSchema = z.object({
	index: z.number().int().min(0).describe('from browser_state'),
	text: z.string().describe('Text to enter. With clear=True, text="" clears the field without typing.'),
	clear: z
		.boolean()
		.optional()
		.default(true)
		.describe('Clear existing text before typing. Set to False to append instead.'),
});
export type InputTextAction = z.infer<typeof InputTextActionSchema>;

export const DONE_TEXT_DESCRIPTION =
	'Final message to the user. ' +
	'ONLY report data you directly observed in browser_state, tool outputs, or screenshots during this session. ' +
	'Do NOT use training knowledge to fill gaps — if information was not found on the page, say so explicitly. ' +
	'Do NOT claim completion of steps from compacted_memory or prior session summaries ' +
	'unless you explicitly verified them yourself. ' +
	'If uncertain whether a prior step completed, say so explicitly.';

export const DoneActionSchema = z.object({
	text: z.string().describe(DONE_TEXT_DESCRIPTION),
	success: z.boolean().optional().default(true).describe('True if user_request completed successfully'),
	files_to_display: z.array(z.string()).nullable().optional().default([]),
});
export type DoneAction = z.infer<typeof DoneActionSchema>;

/**
 * Structured output variant of `done`.
 * Python hides `success` / `files_to_display` from the JSON schema so they never
 * collide with user models; here they are kept optional so the LLM can omit them.
 */
export function createStructuredOutputActionSchema<T extends z.ZodTypeAny>(dataSchema: T) {
	return z.object({
		success: z.boolean().optional().default(true).describe('True if user_request completed successfully'),
		data: dataSchema.describe('The actual output data matching the requested schema'),
		files_to_display: z.array(z.string()).nullable().optional().default([]),
	});
}
export type StructuredOutputAction<T = unknown> = {
	success: boolean;
	data: T;
	files_to_display?: string[] | null;
};

// ============================================================================
// Tabs
// ============================================================================

export const SwitchTabActionSchema = z.object({
	tab_id: z.string().length(4).describe('Last 4 chars of TargetID'),
});
export type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;

export const CloseTabActionSchema = z.object({
	tab_id: z.string().length(4).describe('Last 4 chars of TargetID'),
});
export type CloseTabAction = z.infer<typeof CloseTabActionSchema>;

// ============================================================================
// Scrolling and keyboard
// ============================================================================

export const ScrollActionSchema = z.object({
	down: z.boolean().optional().default(true).describe('down=True=scroll down, down=False scroll up'),
	pages: z.number().optional().default(1.0).describe('0.5=half page, 1=full page, 10=to bottom/top'),
	index: z
		.number()
		.int()
		.nullable()
		.optional()
		.describe('Optional element index to scroll within specific element'),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const SendKeysActionSchema = z.object({
	keys: z.string().describe('Keys to send (e.g., "Enter", "Control+A")'),
});
export type SendKeysAction = z.infer<typeof SendKeysActionSchema>;

export const FindTextActionSchema = z.object({
	text: z.string().describe('The text to find and scroll to'),
});
export type FindTextAction = z.infer<typeof FindTextActionSchema>;

export const WaitActionSchema = z.object({
	seconds: z.number().optional().default(3).describe('Number of seconds to wait'),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

// ============================================================================
// Files
// ============================================================================

export const UploadFileActionSchema = z.object({
	index: z.number().int().describe('The element index of the file input'),
	path: z.string().describe('The path of the file to upload'),
});
export type UploadFileAction = z.infer<typeof UploadFileActionSchema>;

/** Actions without parameters. Gemini rejects empty objects, hence the optional field. */
export const NoParamsActionSchema = z
	.object({
		description: z.string().nullable().optional().describe('Optional description for the action'),
	})
	.passthrough();
export type NoParamsAction = z.infer<typeof NoParamsActionSchema>;

export const ScreenshotActionSchema = z
	.object({
		file_name: z
			.string()
			.nullable()
			.optional()
			.describe(
				'If provided, saves screenshot to this file and returns path. Otherwise screenshot is included in next observation.'
			),
	})
	.passthrough();
export type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;

export const PDF_PAPER_FORMATS = ['Letter', 'Legal', 'A4', 'A3', 'Tabloid'] as const;

export const SaveAsPdfActionSchema = z.object({
	file_name: z
		.string()
		.nullable()
		.optional()
		.describe(
			'Output PDF filename (without path). Defaults to page title. Extension .pdf is added automatically if missing.'
		),
	print_background: z.boolean().optional().default(true).describe('Include background graphics and colors'),
	landscape: z.boolean().optional().default(false).describe('Use landscape orientation'),
	scale: z.number().min(0.1).max(2.0).optional().default(1.0).describe('Scale of the webpage rendering (0.1 to 2.0)'),
	paper_format: z.string().optional().default('Letter').describe('Paper size: Letter, Legal, A4, A3, or Tabloid'),
	display_header_footer: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Print page metadata into the margins, matching the browser Print dialog default: ' +
				'the date in the header and the page URL plus page numbers in the footer. ' +
				'Set to False for a clean PDF with no header/footer.'
		),
	header_template: z
		.string()
		.nullable()
		.optional()
		.describe(
			'Custom HTML for the page header. Inject values with spans using the classes ' +
				"date, title, url, pageNumber, totalPages (e.g. '<span class=\"title\"></span>'). " +
				'Set an explicit font-size or the text renders invisibly. Only used when ' +
				'display_header_footer is True; defaults to showing the date.'
		),
	footer_template: z
		.string()
		.nullable()
		.optional()
		.describe(
			'Custom HTML for the page footer, same format as header_template. Only used when ' +
				'display_header_footer is True; defaults to showing the page URL and page numbers.'
		),
});
export type SaveAsPdfAction = z.infer<typeof SaveAsPdfActionSchema>;

export const WriteFileActionSchema = z.object({
	file_name: z.string().describe('The filename with extension (e.g., notes.md, data.json)'),
	content: z.string().describe('The content to write to the file'),
	append: z.boolean().optional().default(false).describe('Append to existing file instead of overwriting'),
	trailing_newline: z.boolean().optional().default(true).describe('Add trailing newline'),
	leading_newline: z.boolean().optional().default(false).describe('Add leading newline'),
});
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

export const ReadFileActionSchema = z.object({
	file_name: z.string().describe('The filename to read'),
});
export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

export const ReplaceFileActionSchema = z.object({
	file_name: z.string().describe('The filename to modify'),
	old_str: z.string().describe('The string to find and replace'),
	new_str: z.string().describe('The replacement string'),
});
export type ReplaceFileAction = z.infer<typeof ReplaceFileActionSchema>;

// ============================================================================
// Dropdowns and JavaScript
// ============================================================================

export const GetDropdownOptionsActionSchema = z.object({
	index: z.number().int().describe('The element index of the dropdown/select'),
});
export type GetDropdownOptionsAction = z.infer<typeof GetDropdownOptionsActionSchema>;

export const SelectDropdownOptionActionSchema = z.object({
	index: z.number().int().describe('The element index of the dropdown/select'),
	text: z.string().describe('The text of the option to select'),
});
export type SelectDropdownOptionAction = z.infer<typeof SelectDropdownOptionActionSchema>;

export const EvaluateActionSchema = z.object({
	code: z.string().describe('JavaScript code to execute in the browser context'),
});
export type EvaluateAction = z.infer<typeof EvaluateActionSchema>;

// ============================================================================
// Action descriptions (LLM-facing, verbatim from Python 0.13.10)
// ============================================================================

export const ACTION_DESCRIPTIONS = {
	search: 'Search the web using a search engine (duckduckgo, google, or bing)',
	navigate: 'Navigate to a URL',
	go_back: 'Go back',
	go_forward: 'Navigate forward in browser history',
	refresh: 'Refresh the current page',
	wait: 'Wait for x seconds.',
	click_index_only: 'Click element by index.',
	click_with_coordinates:
		'Click element by index or coordinates. Use coordinates only if the index is not available. Either provide coordinates or index.',
	input:
		'Input text into element by index. Clears existing text by default; pass text="" to clear only, or clear=False to append.',
	upload_file: 'Upload file to interactive element with file path',
	switch:
		'Switch to another open tab by tab_id. Tab IDs are shown in browser state tabs list (last 4 chars of target_id). Use when you need to work with content in a different tab.',
	close:
		'Close a tab by tab_id. Tab IDs are shown in browser state tabs list (last 4 chars of target_id). Use to clean up tabs you no longer need.',
	extract:
		"LLM extracts structured data from page markdown. Use when: on right page, know what to extract, haven't called before on same page+query. Can't get interactive elements. Set extract_links=True for URLs. Set extract_images=True for image src URLs. Use start_from_char if previous extraction was truncated to extract data further down the page. When paginating across pages, pass already_collected with item identifiers (names/URLs) from prior pages to avoid duplicates.",
	search_page:
		'Search page text for a pattern (like grep). Zero LLM cost, instant. Returns matches with surrounding context. Use to find specific text, verify content exists, or locate data on the page. Set regex=True for regex patterns. Use css_scope to search within a specific section.',
	find_elements:
		'Query DOM elements by CSS selector (like find). Zero LLM cost, instant. Returns matching elements with tag, text, and attributes. Use to explore page structure, count items, get links/attributes. Use attributes=["href","src"] to extract specific attributes.',
	scroll:
		'Scroll by pages. REQUIRED: down=True/False (True=scroll down, False=scroll up, default=True). Optional: pages=0.5-10.0 (default 1.0). Use index for scroll elements (dropdowns/custom UI). High pages (10) reaches bottom. Multi-page scrolls sequentially. Viewport-based height, fallback 1000px/page.',
	send_keys:
		'Send keyboard keys or shortcuts. Supports special keys like Escape, Backspace, Enter and combinations like Control+o, Shift+Enter.',
	find_text: 'Scroll to text.',
	screenshot:
		'Take a screenshot of the current viewport. If file_name is provided, saves to that file and returns the path. ' +
		'Otherwise, screenshot is included in the next browser_state observation.',
	save_as_pdf:
		'Save the current page as a PDF file. Returns the file path of the saved PDF. ' +
		'Use this to capture the full page content (including content below the fold) as a printable document.',
	dropdown_options: 'Get list of option values exposed by a specific dropdown input field. Only works on dropdown-style form elements (<select>, Semantic UI/aria-labeled select, etc.).',
	select_dropdown: 'Set the option of a <select> element.',
	write_file:
		'Write content to a file. By default this OVERWRITES the entire file - use append=true to add to an existing file, or use replace_file for targeted edits within a file. ' +
		'FILENAME RULES: Use only letters, numbers, underscores, hyphens, dots, parentheses. Spaces are auto-converted to hyphens. ' +
		'SUPPORTED EXTENSIONS: .txt, .md, .json, .jsonl, .csv, .html, .xml, .pdf, .docx. ' +
		'CANNOT write binary/image files (.png, .jpg, .mp4, etc.) - do not attempt to save screenshots as files. ' +
		'For PDF files, write content in markdown format and it will be auto-converted to PDF.',
	replace_file:
		'Replace specific text within a file by searching for old_str and replacing with new_str. Use this for targeted edits like updating todo checkboxes or modifying specific lines without rewriting the entire file.',
	read_file:
		'Read the complete content of a file. Use this to view file contents before editing or to retrieve data from files. Supports text files (txt, md, json, csv, jsonl), documents (pdf, docx), and images (jpg, png).',
	evaluate:
		"Execute browser JavaScript. Best practice: wrap in IIFE (function(){...})() with try-catch for safety. Use ONLY browser APIs (document, window, DOM). NO Node.js APIs (fs, require, process). Example: (function(){try{const el=document.querySelector('#id');return el?el.value:'not found'}catch(e){return 'Error: '+e.message}})() Avoid comments. Use for hover, drag, zoom, custom selectors, extract/filter links, or analysing page structure. IMPORTANT: Shadow DOM elements with [index] markers can be clicked directly with click(index) — do NOT use evaluate() to click them. Only use evaluate for shadow DOM elements that are NOT indexed. Limit output size.",
	done: 'Complete task. Only report actions you performed and data you extracted in this session.',
	done_structured: 'Complete task with structured output.',
} as const;
