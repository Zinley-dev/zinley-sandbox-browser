/**
 * Export code-use session to Jupyter notebook format.
 * Port from browser_use/code_use/notebook_export.py
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	CellType,
	NotebookExport,
	NotebookSession,
	createNotebookExport,
} from './views.js';

/**
 * Check if a string looks like JavaScript code
 */
function isJavaScriptCode(value: string): boolean {
	const jsPatterns = [
		/function\s+\w+\s*\(/i,
		/\(\s*function\s*\(\)/,
		/=>\s*\{/,
		/document\./,
		/Array\.from\(/,
		/\.querySelector/,
		/\.textContent/,
		/\.innerHTML/,
		/return\s+/,
		/console\.log/,
		/window\./,
		/\.map\(/,
		/\.filter\(/,
		/\.forEach\(/,
	];

	return jsPatterns.some((pattern) => pattern.test(value));
}

/**
 * Export a NotebookSession to a Jupyter notebook (.ipynb) file.
 *
 * @param session - The NotebookSession to export
 * @param outputPath - Path where to save the notebook file
 * @param namespace - Optional namespace for JavaScript blocks
 * @returns Path to the saved notebook file
 */
export function exportToIpynb(
	session: NotebookSession,
	outputPath: string,
	namespace?: Record<string, any>
): string {
	// Create notebook structure
	const notebook = createNotebookExport({
		kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
		language_info: {
			name: 'python',
			version: '3.11.0',
			mimetype: 'text/x-python',
			codemirror_mode: { name: 'ipython', version: 3 },
			pygments_lexer: 'ipython3',
			nbconvert_exporter: 'python',
			file_extension: '.py',
		},
	});

	// Add setup cell at the beginning
	const setupCode = `import asyncio
import json
from typing import Any
from browser_use import BrowserSession
from browser_use.code_use import create_namespace

# Initialize browser and namespace
browser = BrowserSession()
await browser.start()

# Create namespace with all browser control functions
namespace: dict[str, Any] = create_namespace(browser)

# Import all functions into the current namespace
globals().update(namespace)

# Type hints for better IDE support (these are now available globally)
# navigate, click, input, evaluate, search, extract, scroll, done, etc.

print("Browser-use environment initialized!")
print("Available functions: navigate, click, input, evaluate, search, extract, done, etc.")`;

	const setupCell = {
		cell_type: 'code',
		metadata: {},
		source: setupCode.split('\n'),
		execution_count: null,
		outputs: [],
	};
	notebook.cells.push(setupCell);

	// Add JavaScript code blocks as variables FIRST
	if (namespace) {
		const codeBlockVars = (namespace._code_block_vars as Set<string>) || new Set();

		for (const varName of Array.from(codeBlockVars).sort()) {
			const varValue = namespace[varName];
			if (typeof varValue === 'string' && varValue.trim()) {
				if (isJavaScriptCode(varValue)) {
					const jsCell = {
						cell_type: 'code',
						metadata: {},
						source: [`# JavaScript Code Block: ${varName}\n`, `${varName} = """${varValue}"""`],
						execution_count: null,
						outputs: [],
					};
					notebook.cells.push(jsCell);
				}
			}
		}
	}

	// Convert cells
	for (const cell of session.cells) {
		const notebookCell: Record<string, any> = {
			cell_type: cell.cellType,
			metadata: {},
			source: cell.source.split('\n').map((line, i, arr) => (i < arr.length - 1 ? line + '\n' : line)),
		};

		if (cell.cellType === CellType.CODE) {
			notebookCell.execution_count = cell.executionCount;
			notebookCell.outputs = [];

			// Add output if available
			if (cell.output) {
				notebookCell.outputs.push({
					output_type: 'stream',
					name: 'stdout',
					text: cell.output.split('\n'),
				});
			}

			// Add error if available
			if (cell.error) {
				notebookCell.outputs.push({
					output_type: 'error',
					ename: 'Error',
					evalue: cell.error.split('\n')[0] || '',
					traceback: cell.error.split('\n'),
				});
			}

			// Add browser state as a separate output
			if (cell.browserState) {
				notebookCell.outputs.push({
					output_type: 'stream',
					name: 'stdout',
					text: [`Browser State:\n${cell.browserState}`],
				});
			}
		}

		notebook.cells.push(notebookCell);
	}

	// Ensure directory exists
	const dir = path.dirname(outputPath);
	if (dir) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// Write to file
	fs.writeFileSync(outputPath, JSON.stringify(notebook, null, 2), 'utf-8');

	return outputPath;
}

/**
 * Convert a NotebookSession to a Python script.
 *
 * @param session - The NotebookSession to convert
 * @param namespace - Optional namespace for JavaScript blocks
 * @returns Python script as a string
 */
export function sessionToPythonScript(session: NotebookSession, namespace?: Record<string, any>): string {
	const lines: string[] = [];

	lines.push('# Generated from browser-use code-use session\n');
	lines.push('import asyncio\n');
	lines.push('import json\n');
	lines.push('from browser_use import BrowserSession\n');
	lines.push('from browser_use.code_use import create_namespace\n\n');

	lines.push('async def main():\n');
	lines.push('\t# Initialize browser and namespace\n');
	lines.push('\tbrowser = BrowserSession()\n');
	lines.push('\tawait browser.start()\n\n');
	lines.push('\t# Create namespace with all browser control functions\n');
	lines.push('\tnamespace = create_namespace(browser)\n\n');
	lines.push('\t# Extract functions from namespace for direct access\n');
	lines.push('\tnavigate = namespace["navigate"]\n');
	lines.push('\tclick = namespace["click"]\n');
	lines.push('\tinput_text = namespace["input"]\n');
	lines.push('\tevaluate = namespace["evaluate"]\n');
	lines.push('\tsearch = namespace["search"]\n');
	lines.push('\textract = namespace["extract"]\n');
	lines.push('\tscroll = namespace["scroll"]\n');
	lines.push('\tdone = namespace["done"]\n');
	lines.push('\tgo_back = namespace["go_back"]\n');
	lines.push('\twait = namespace["wait"]\n');
	lines.push('\tscreenshot = namespace["screenshot"]\n');
	lines.push('\tfind_text = namespace["find_text"]\n');
	lines.push('\tswitch_tab = namespace["switch"]\n');
	lines.push('\tclose_tab = namespace["close"]\n');
	lines.push('\tdropdown_options = namespace["dropdown_options"]\n');
	lines.push('\tselect_dropdown = namespace["select_dropdown"]\n');
	lines.push('\tupload_file = namespace["upload_file"]\n');
	lines.push('\tsend_keys = namespace["send_keys"]\n\n');

	// Add JavaScript code blocks as variables FIRST
	if (namespace) {
		const codeBlockVars = (namespace._code_block_vars as Set<string>) || new Set();

		for (const varName of Array.from(codeBlockVars).sort()) {
			const varValue = namespace[varName];
			if (typeof varValue === 'string' && varValue.trim()) {
				if (isJavaScriptCode(varValue)) {
					lines.push(`\t# JavaScript Code Block: ${varName}\n`);
					lines.push(`\t${varName} = """${varValue}"""\n\n`);
				}
			}
		}
	}

	for (let i = 0; i < session.cells.length; i++) {
		const cell = session.cells[i];
		if (cell.cellType === CellType.CODE) {
			lines.push(`\t# Cell ${i + 1}\n`);

			// Indent each line of source
			const sourceLines = cell.source.split('\n');
			for (const line of sourceLines) {
				if (line.trim()) {
					lines.push(`\t${line}\n`);
				}
			}

			lines.push('\n');
		}
	}

	lines.push('\tawait browser.stop()\n\n');
	lines.push("if __name__ == '__main__':\n");
	lines.push('\tasyncio.run(main())\n');

	return lines.join('');
}

/**
 * Export to notebook - simpler interface
 */
export function exportToNotebook(code: string[]): NotebookExport {
	const notebook = createNotebookExport({
		kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
	});

	for (const codeBlock of code) {
		notebook.cells.push({
			cell_type: 'code',
			metadata: {},
			source: codeBlock.split('\n'),
			execution_count: null,
			outputs: [],
		});
	}

	return notebook;
}
