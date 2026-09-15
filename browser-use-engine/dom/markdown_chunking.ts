/**
 * Markdown post-processing and structure-aware chunking.
 * Port of `_preprocess_markdown_content` and `chunk_markdown_by_structure`
 * from browser_use/dom/markdown_extractor.py (0.13.10).
 */

import { MarkdownChunk } from './views.js';

/**
 * Light preprocessing of markdown output - minimal cleanup with JSON blob removal.
 *
 * @returns [content, charsFiltered]
 */
export function preprocessMarkdownContent(content: string, maxNewlines: number = 3): [string, number] {
	const originalLength = content.length;

	// Compress consecutive newlines (4+ newlines become maxNewlines)
	content = content.replace(/\n{4,}/g, '\n'.repeat(maxNewlines));

	// Remove lines that are only whitespace
	const filteredLines: string[] = [];
	for (const line of content.split('\n')) {
		const stripped = line.trim();
		if (!stripped) {
			continue;
		}
		// Skip long lines that actually parse as JSON (SPA state blobs). A prefix check alone is
		// not enough: markdown links/images also start with '['.
		if (stripped.length > 100 && (stripped[0] === '{' || stripped[0] === '[')) {
			try {
				JSON.parse(stripped);
				continue;
			} catch {
				// not JSON, keep the line
			}
		}
		filteredLines.push(line);
	}

	content = filteredLines.join('\n');
	return [content, originalLength - content.length];
}

// ---------------------------------------------------------------------------
// Structure-aware markdown chunking
// ---------------------------------------------------------------------------

enum BlockType {
	HEADER,
	CODE_FENCE,
	TABLE,
	LIST_ITEM,
	PARAGRAPH,
	BLANK,
}

interface AtomicBlock {
	blockType: BlockType;
	lines: string[];
	/** Offset in original content */
	charStart: number;
	/** Offset in original content (exclusive) */
	charEnd: number;
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)]) /;
const LIST_CONTINUATION_RE = /^(\s{2,}|\t)/;

/** Phase 1: walk lines, group into unsplittable blocks. */
function parseAtomicBlocks(content: string): AtomicBlock[] {
	const lines = content.split('\n');
	const blocks: AtomicBlock[] = [];
	let i = 0;
	let offset = 0; // char offset tracking

	while (i < lines.length) {
		const line = lines[i];
		const lineLen = line.length + 1; // +1 for the newline we split on

		// BLANK
		if (!line.trim()) {
			blocks.push({ blockType: BlockType.BLANK, lines: [line], charStart: offset, charEnd: offset + lineLen });
			offset += lineLen;
			i += 1;
			continue;
		}

		// CODE FENCE
		if (line.trim().startsWith('```')) {
			const fenceLines = [line];
			let fenceEnd = offset + lineLen;
			i += 1;
			// Consume until closing fence or EOF
			while (i < lines.length) {
				const fenceLine = lines[i];
				fenceLines.push(fenceLine);
				fenceEnd += fenceLine.length + 1;
				i += 1;
				if (fenceLine.trim().startsWith('```') && fenceLines.length > 1) {
					break;
				}
			}
			blocks.push({ blockType: BlockType.CODE_FENCE, lines: fenceLines, charStart: offset, charEnd: fenceEnd });
			offset = fenceEnd;
			continue;
		}

		// HEADER
		if (line.trimStart().startsWith('#')) {
			blocks.push({ blockType: BlockType.HEADER, lines: [line], charStart: offset, charEnd: offset + lineLen });
			offset += lineLen;
			i += 1;
			continue;
		}

		// TABLE (consecutive |...| lines): header + separator row stay together; each data row is its own block
		if (TABLE_ROW_RE.test(line)) {
			const headerLines = [line];
			let headerEnd = offset + lineLen;
			i += 1;
			// Check if next line is separator (contains ---)
			if (i < lines.length && TABLE_ROW_RE.test(lines[i]) && lines[i].includes('---')) {
				headerLines.push(lines[i]);
				headerEnd += lines[i].length + 1;
				i += 1;
			}
			// Emit header+separator as one atomic block
			blocks.push({ blockType: BlockType.TABLE, lines: headerLines, charStart: offset, charEnd: headerEnd });
			offset = headerEnd;
			// Each subsequent table row is its own TABLE block (splittable between rows)
			while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
				const row = lines[i];
				const rowLen = row.length + 1;
				blocks.push({ blockType: BlockType.TABLE, lines: [row], charStart: offset, charEnd: offset + rowLen });
				offset += rowLen;
				i += 1;
			}
			continue;
		}

		// LIST ITEM (with indented continuations)
		if (LIST_ITEM_RE.test(line)) {
			const listLines = [line];
			let listEnd = offset + lineLen;
			i += 1;
			// Consume continuation lines (indented or further items)
			while (i < lines.length) {
				const nextLine = lines[i];
				const nextLen = nextLine.length + 1;
				// Another list item -> still part of this block
				if (LIST_ITEM_RE.test(nextLine)) {
					listLines.push(nextLine);
					listEnd += nextLen;
					i += 1;
					continue;
				}
				// Indented continuation
				if (nextLine.trim() && LIST_CONTINUATION_RE.test(nextLine)) {
					listLines.push(nextLine);
					listEnd += nextLen;
					i += 1;
					continue;
				}
				break;
			}
			blocks.push({ blockType: BlockType.LIST_ITEM, lines: listLines, charStart: offset, charEnd: listEnd });
			offset = listEnd;
			continue;
		}

		// PARAGRAPH (everything else, up to next blank line or another block type)
		const paraLines = [line];
		let paraEnd = offset + lineLen;
		i += 1;
		while (i < lines.length && lines[i].trim()) {
			const nl = lines[i];
			if (nl.trimStart().startsWith('#') || nl.trim().startsWith('```') || TABLE_ROW_RE.test(nl) || LIST_ITEM_RE.test(nl)) {
				break;
			}
			paraLines.push(nl);
			paraEnd += nl.length + 1;
			i += 1;
		}
		blocks.push({ blockType: BlockType.PARAGRAPH, lines: paraLines, charStart: offset, charEnd: paraEnd });
		offset = paraEnd;
	}

	// Fix last block charEnd: the parser counts +1 per line for the newline it split on, so
	// content ending in \n (or a final blank line) overshoots content.length.
	if (blocks.length > 0 && content && blocks[blocks.length - 1].charEnd > content.length) {
		blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], charEnd: content.length };
	}

	return blocks;
}

function blockText(block: AtomicBlock): string {
	return block.lines.join('\n');
}

/** Extract table header + separator rows from a TABLE block. */
function getTableHeader(block: AtomicBlock): string | null {
	if (block.lines.length < 2) {
		return null;
	}
	// Header is first line, separator is second line (must contain ---)
	const sepLine = block.lines[1];
	if (sepLine.includes('---') || sepLine.includes('- -')) {
		return block.lines[0] + '\n' + block.lines[1];
	}
	return null;
}

export interface ChunkMarkdownOptions {
	/** Target maximum chars per chunk (soft limit for single blocks). Default 100_000 */
	maxChunkChars?: number;
	/** Number of trailing lines from the previous chunk to prepend. Default 5 */
	overlapLines?: number;
	/** Return chunks starting from the chunk that contains this offset. Default 0 */
	startFromChar?: number;
}

/**
 * Split markdown into structure-aware chunks.
 *
 * Phase 1 — parse atomic blocks (headers, code fences, tables, list items, paragraphs).
 * Phase 2 — greedy chunk assembly: accumulate blocks until exceeding maxChunkChars, preferring
 *           to split right before a header; a single block exceeding the limit is allowed.
 * Phase 3 — build overlap prefixes (table headers are carried into table continuations).
 *
 * @returns list of MarkdownChunk; empty if startFromChar is past the end of the content.
 */
export function chunkMarkdownByStructure(content: string, options: ChunkMarkdownOptions = {}): MarkdownChunk[] {
	const maxChunkChars = options.maxChunkChars ?? 100_000;
	const overlapLines = options.overlapLines ?? 5;
	const startFromChar = options.startFromChar ?? 0;

	if (!content) {
		return [
			{
				content: '',
				chunkIndex: 0,
				totalChunks: 1,
				charOffsetStart: 0,
				charOffsetEnd: 0,
				overlapPrefix: '',
				hasMore: false,
			},
		];
	}

	if (startFromChar >= content.length) {
		return [];
	}

	// Phase 1: parse atomic blocks
	const blocks = parseAtomicBlocks(content);
	if (blocks.length === 0) {
		return [];
	}

	const blockSize = (b: AtomicBlock) => b.charEnd - b.charStart;

	// Phase 2: greedy chunk assembly with header-preferred splitting
	const rawChunks: AtomicBlock[][] = [];
	let currentChunk: AtomicBlock[] = [];
	let currentSize = 0;

	for (const block of blocks) {
		const size = blockSize(block);
		// If adding this block would exceed the limit AND we already have content, emit a chunk
		if (currentSize + size > maxChunkChars && currentChunk.length > 0) {
			// Prefer splitting at a header boundary within the current chunk: scan backwards for
			// the last HEADER block; if it wouldn't create a tiny chunk (< 50% of limit), split
			// right before it so the header starts the next chunk.
			let bestSplit = currentChunk.length;
			for (let j = currentChunk.length - 1; j > 0; j--) {
				if (currentChunk[j].blockType === BlockType.HEADER) {
					const prefixSize = currentChunk.slice(0, j).reduce((sum, b) => sum + blockSize(b), 0);
					if (prefixSize >= maxChunkChars * 0.5) {
						bestSplit = j;
						break;
					}
				}
			}
			rawChunks.push(currentChunk.slice(0, bestSplit));
			// Carry remaining blocks (from the header onward) into the next chunk
			currentChunk = currentChunk.slice(bestSplit);
			currentSize = currentChunk.reduce((sum, b) => sum + blockSize(b), 0);
		}
		currentChunk.push(block);
		currentSize += size;
	}

	if (currentChunk.length > 0) {
		rawChunks.push(currentChunk);
	}

	const totalChunks = rawChunks.length;

	// Phase 3: build MarkdownChunk objects with overlap prefixes
	const chunks: MarkdownChunk[] = [];
	// Track the table header from the previous chunk for table continuations
	let prevChunkLastTableHeader: string | null = null;

	rawChunks.forEach((chunkBlocks, idx) => {
		const chunkText = chunkBlocks.map(blockText).join('\n');
		const charStart = chunkBlocks[0].charStart;
		const charEnd = chunkBlocks[chunkBlocks.length - 1].charEnd;

		// Build overlap prefix
		let overlap = '';
		if (idx > 0) {
			const prevLines = rawChunks[idx - 1].map(blockText).join('\n').split('\n');
			const firstBlock = chunkBlocks[0];
			if (firstBlock.blockType === BlockType.TABLE && prevChunkLastTableHeader) {
				// Always prepend the table header for a continuation, deduplicating trailing lines
				const trailing = overlapLines > 0 ? prevLines.slice(-overlapLines) : [];
				const combined = prevChunkLastTableHeader.split('\n');
				for (const tl of trailing) {
					if (!combined.includes(tl)) {
						combined.push(tl);
					}
				}
				overlap = combined.join('\n');
			} else if (overlapLines > 0) {
				overlap = prevLines.slice(-overlapLines).join('\n');
			}
		}

		// Track the table header from this chunk for the next iteration. Only overwrite when this
		// chunk contains a new header+separator block so tables spanning 3+ chunks keep their header.
		for (const b of chunkBlocks) {
			if (b.blockType === BlockType.TABLE) {
				const hdr = getTableHeader(b);
				if (hdr !== null) {
					prevChunkLastTableHeader = hdr;
				}
			}
		}

		chunks.push({
			content: chunkText,
			chunkIndex: idx,
			totalChunks,
			charOffsetStart: charStart,
			charOffsetEnd: charEnd,
			overlapPrefix: overlap,
			hasMore: idx < totalChunks - 1,
		});
	});

	// Apply startFromChar filter: return chunks from the one containing that offset
	if (startFromChar > 0) {
		const firstIndex = chunks.findIndex((chunk) => chunk.charOffsetEnd > startFromChar);
		return firstIndex >= 0 ? chunks.slice(firstIndex) : [];
	}

	return chunks;
}
