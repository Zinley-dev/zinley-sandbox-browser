/**
 * FileSystem - Full port from browser_use/filesystem/file_system.py (synced with 0.13.10)
 * In-memory file system with disk persistence support
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fontSizesNumeric } from '../typography.js';

const DEFAULT_FILE_SYSTEM_PATH = 'browseruse_agent_data';

/** Extensions the agent must never try to write through write_file */
export const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'bmp',
	'svg',
	'webp',
	'ico',
	'mp3',
	'mp4',
	'wav',
	'avi',
	'mov',
	'zip',
	'tar',
	'gz',
	'rar',
	'exe',
	'bin',
	'dll',
	'so',
]);

export class FileSystemError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FileSystemError';
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a specific error message explaining why the filename was rejected and how to fix it.
 */
export function buildFilenameErrorMessage(fileName: string, supportedExtensions: string[]): string {
	const base = path.basename(fileName);
	const supported = supportedExtensions.map((e) => '.' + e).join(', ');

	// Check for binary/image extension
	if (base.includes('.')) {
		const ext = base.slice(base.lastIndexOf('.') + 1);
		const extLower = ext.toLowerCase();
		if (UNSUPPORTED_BINARY_EXTENSIONS.has(extLower)) {
			return (
				`Error: Cannot write binary/image file '${base}'. ` +
				'The write_file tool only supports text-based files. ' +
				`Supported extensions: ${supported}. ` +
				'For screenshots, the browser automatically captures them - do not try to save screenshots as files.'
			);
		}
		if (!supportedExtensions.includes(extLower)) {
			return (
				`Error: Unsupported file extension '.${extLower}' in '${base}'. ` +
				`Supported extensions: ${supported}. ` +
				'Please rename the file to use a supported extension.'
			);
		}
	}

	// No extension or no dot
	if (!base.includes('.')) {
		return `Error: Filename '${base}' has no extension. Please add a supported extension: ${supported}.`;
	}

	return (
		`Error: Invalid filename '${base}'. ` +
		'Filenames must contain only letters, numbers, underscores, hyphens, dots, parentheses, and spaces. ' +
		`Supported extensions: ${supported}.`
	);
}

/**
 * Split a markdown ATX heading into [text, level].
 *
 * Only `# ` / `## ` / `### ` (note the required space) are headings.
 * Anything else, including `#hashtag`, is returned unchanged with level null.
 */
export function splitHeading(line: string): [string, number | null] {
	if (line.startsWith('### ')) {
		return [line.slice(4), 3];
	}
	if (line.startsWith('## ')) {
		return [line.slice(3), 2];
	}
	if (line.startsWith('# ')) {
		return [line.slice(2), 1];
	}
	return [line, null];
}

const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;

export interface InlineSegment {
	text: string;
	bold: boolean;
	italic: boolean;
	code: boolean;
}

const SEG_START = '';
const SEG_END = '';

/**
 * Convert a markdown subset (inline code, **bold**, *italic*) into styled segments.
 *
 * Mirrors `_markdown_inline_to_rml`: underscore emphasis is intentionally
 * unsupported so `snake_case` identifiers survive; inline code is stashed before
 * emphasis so markers inside backticks stay literal; bold content cannot start
 * with `/`, so globs like `**\/foo/**` stay literal.
 */
export function markdownInlineSegments(text: string): InlineSegment[] {
	const segments: InlineSegment[] = [];
	for (const part of text.split(/(`[^`]+`)/)) {
		if (!part) {
			continue;
		}
		if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
			segments.push({ text: part.slice(1, -1), bold: false, italic: false, code: true });
			continue;
		}
		// Bold before italic so `**` is not treated as two italic markers.
		let marked = part.replace(/\*\*([^\s*/](?:[^*]*[^\s*])?)\*\*/g, `${SEG_START}b$1${SEG_END}`);
		// Non-space boundaries keep `2 * 3 * 4` literal; leading `* ` is a bullet, not italic
		marked = marked.replace(/(^|[^*])\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, `$1${SEG_START}i$2${SEG_END}`);

		for (const chunk of marked.split(new RegExp(`(${SEG_START}[bi][^${SEG_END}]*${SEG_END})`))) {
			if (!chunk) {
				continue;
			}
			if (chunk.startsWith(SEG_START)) {
				const kind = chunk[1];
				segments.push({
					text: chunk.slice(2, -1),
					bold: kind === 'b',
					italic: kind === 'i',
					code: false,
				});
			} else {
				segments.push({ text: chunk, bold: false, italic: false, code: false });
			}
		}
	}
	return segments;
}

/** Plain-text rendering of a markdown line (markers removed). */
export function stripMarkdownInline(text: string): string {
	return markdownInlineSegments(text)
		.map((s) => s.text)
		.join('');
}

/**
 * Load an optional runtime dependency without letting the bundler try to
 * resolve it at build time (the specifier is deliberately opaque to Vite).
 * Returns the module's default export (or the namespace) or null when absent.
 */
async function loadOptionalModule(specifier: string, unwrapDefault: boolean = true): Promise<any | null> {
	try {
		const mod: any = await import(/* @vite-ignore */ specifier);
		if (!mod) {
			return null;
		}
		return unwrapDefault ? (mod.default ?? mod) : mod;
	} catch {
		return null;
	}
}

// ============================================================================
// Minimal ZIP writer (STORE method) for building .docx packages
// ============================================================================

const CRC32_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build an uncompressed (STORE) ZIP archive. Enough for Office Open XML
 * packages, and independent of any zip library's runtime environment.
 */
export function buildStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
	const now = new Date();
	const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
	const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = Buffer.from(entry.name, 'utf-8');
		const crc = crc32(entry.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // local file header signature
		local.writeUInt16LE(20, 4); // version needed to extract
		local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
		local.writeUInt16LE(0, 8); // compression: STORE
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(entry.data.length, 18); // compressed size
		local.writeUInt32LE(entry.data.length, 22); // uncompressed size
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28); // extra field length
		localParts.push(local, nameBytes, entry.data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); // central directory header signature
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed to extract
		central.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
		central.writeUInt16LE(0, 10); // compression: STORE
		central.writeUInt16LE(dosTime, 12);
		central.writeUInt16LE(dosDate, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(entry.data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt16LE(0, 30); // extra field length
		central.writeUInt16LE(0, 32); // file comment length
		central.writeUInt16LE(0, 34); // disk number start
		central.writeUInt16LE(0, 36); // internal attributes
		central.writeUInt32LE(0, 38); // external attributes
		central.writeUInt32LE(offset, 42); // relative offset of local header
		centralParts.push(central, nameBytes);

		offset += local.length + nameBytes.length + entry.data.length;
	}

	const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
	eocd.writeUInt16LE(0, 4); // this disk
	eocd.writeUInt16LE(0, 6); // disk with central directory
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16); // offset of central directory
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * Read a ZIP archive (STORE or DEFLATE entries) into a name -> bytes map.
 * Sufficient for Office Open XML packages; ZIP64 archives are rejected.
 */
export function readZipEntries(archive: Buffer): Map<string, Buffer> {
	// Locate the end-of-central-directory record (may be followed by a comment)
	let eocd = -1;
	for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
		if (archive.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		throw new Error('Not a ZIP archive (end of central directory not found)');
	}

	const entryCount = archive.readUInt16LE(eocd + 10);
	const centralOffset = archive.readUInt32LE(eocd + 16);
	if (entryCount === 0xffff || centralOffset === 0xffffffff) {
		throw new Error('ZIP64 archives are not supported');
	}

	const entries = new Map<string, Buffer>();
	let pos = centralOffset;
	for (let n = 0; n < entryCount; n++) {
		if (archive.readUInt32LE(pos) !== 0x02014b50) {
			throw new Error('Corrupt ZIP archive (bad central directory header)');
		}
		const method = archive.readUInt16LE(pos + 10);
		const compressedSize = archive.readUInt32LE(pos + 20);
		const nameLength = archive.readUInt16LE(pos + 28);
		const extraLength = archive.readUInt16LE(pos + 30);
		const commentLength = archive.readUInt16LE(pos + 32);
		const localOffset = archive.readUInt32LE(pos + 42);
		const name = archive.subarray(pos + 46, pos + 46 + nameLength).toString('utf-8');
		pos += 46 + nameLength + extraLength + commentLength;

		if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new Error(`Corrupt ZIP archive (bad local header for ${name})`);
		}
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = archive.subarray(dataStart, dataStart + compressedSize);

		if (name.endsWith('/')) {
			continue; // directory entry
		}
		if (method === 0) {
			entries.set(name, Buffer.from(raw));
		} else if (method === 8) {
			entries.set(name, zlib.inflateRawSync(raw));
		} else {
			throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
		}
	}
	return entries;
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&amp;/g, '&');
}

// ============================================================================
// CSV (RFC 4180) helpers - equivalent of Python's csv.reader / csv.writer
// ============================================================================

/**
 * Parse CSV text into rows. Quoted fields may contain commas, newlines and
 * doubled quotes; quotes inside unquoted fields are kept literally.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let i = 0;
	let fieldStarted = false;

	const endField = () => {
		row.push(field);
		field = '';
		fieldStarted = false;
	};
	const endRow = () => {
		rows.push(row);
		row = [];
	};

	while (i < text.length) {
		const ch = text[i];

		if (!fieldStarted && ch === '"') {
			// Quoted field
			fieldStarted = true;
			i++;
			while (i < text.length) {
				const c = text[i];
				if (c === '"') {
					if (text[i + 1] === '"') {
						field += '"';
						i += 2;
						continue;
					}
					i++; // closing quote
					break;
				}
				field += c;
				i++;
			}
			// Anything between the closing quote and the delimiter is kept literally (non-strict)
			while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
				field += text[i];
				i++;
			}
			continue;
		}

		if (ch === ',') {
			endField();
			i++;
			continue;
		}

		if (ch === '\r' || ch === '\n') {
			endField();
			endRow();
			if (ch === '\r' && text[i + 1] === '\n') {
				i++;
			}
			i++;
			continue;
		}

		fieldStarted = true;
		field += ch;
		i++;
	}

	// Flush the trailing field/row when the text does not end with a newline
	if (fieldStarted || field.length > 0 || row.length > 0) {
		endField();
		endRow();
	}

	// A blank line produces a row with one empty field; Python's reader yields [] for it
	return rows.map((r) => (r.length === 1 && r[0] === '' ? [] : r));
}

function csvQuote(field: string): string {
	if (/[",\r\n]/.test(field)) {
		return `"${field.replace(/"/g, '""')}"`;
	}
	return field;
}

/**
 * Serialize rows as CSV with Python's QUOTE_MINIMAL semantics and `\n` line terminator.
 */
export function serializeCsv(rows: string[][]): string {
	return rows
		.map((row) => {
			// Python writes a lone empty field as "" so the row is not mistaken for a blank line
			if (row.length === 1 && row[0] === '') {
				return '""';
			}
			return row.map(csvQuote).join(',');
		})
		.map((line) => line + '\n')
		.join('');
}

// ============================================================================
// Base File Classes
// ============================================================================

export abstract class BaseFile {
	name: string;
	content: string;

	constructor(name: string, content: string = '') {
		this.name = name;
		this.content = content;
	}

	abstract get extension(): string;

	get fullName(): string {
		return `${this.name}.${this.extension}`;
	}

	get size(): number {
		return this.content.length;
	}

	get lineCount(): number {
		return this.content.split('\n').length;
	}

	writeFileContent(content: string): void {
		this.updateContent(content);
	}

	appendFileContent(content: string): void {
		this.updateContent(this.content + content);
	}

	updateContent(content: string): void {
		this.content = content;
	}

	async syncToDisk(dirPath: string): Promise<void> {
		const filePath = path.join(dirPath, this.fullName);
		await fs.writeFile(filePath, this.content, 'utf-8');
	}

	syncToDiskSync(dirPath: string): void {
		const filePath = path.join(dirPath, this.fullName);
		fsSync.writeFileSync(filePath, this.content, 'utf-8');
	}

	async write(content: string, dirPath: string): Promise<void> {
		this.writeFileContent(content);
		await this.syncToDisk(dirPath);
	}

	async append(content: string, dirPath: string): Promise<void> {
		this.appendFileContent(content);
		await this.syncToDisk(dirPath);
	}

	read(): string {
		return this.content;
	}
}

export class MarkdownFile extends BaseFile {
	get extension(): string {
		return 'md';
	}
}

export class TxtFile extends BaseFile {
	get extension(): string {
		return 'txt';
	}
}

export class JsonFile extends BaseFile {
	get extension(): string {
		return 'json';
	}
}

/**
 * CSV file implementation with automatic RFC 4180 normalization.
 *
 * LLMs frequently produce malformed CSV (missing quotes around fields with commas,
 * inconsistent empty fields, unescaped internal quotes). This class parses the raw
 * content on every write to guarantee well-formed output.
 */
export class CsvFile extends BaseFile {
	get extension(): string {
		return 'csv';
	}

	/**
	 * Parse and re-serialize CSV content to fix quoting, empty fields, and escaping.
	 *
	 * Handles common LLM mistakes: unquoted fields containing commas, unescaped
	 * quotes inside fields, inconsistent empty fields, trailing/leading blank
	 * lines, and double-escaped JSON output (literal backslash-n and
	 * backslash-quote instead of real newlines/quotes).
	 */
	static normalizeCsv(raw: string): string {
		let stripped = raw.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
		if (!stripped) {
			return raw;
		}

		// Detect double-escaped LLM tool call output: if the content has no real
		// newlines but contains literal \n sequences, the entire string is likely
		// double-escaped JSON. Unescape \" -> " first, then \n -> newline.
		if (!stripped.includes('\n') && stripped.includes('\\n')) {
			stripped = stripped.replace(/\\"/g, '"');
			stripped = stripped.replace(/\\n/g, '\n');
		}

		// Skip completely empty rows (artifacts of blank lines)
		const rows = parseCsv(stripped).filter((row) => row.length > 0);
		if (rows.length === 0) {
			return raw;
		}

		// Strip trailing newline so callers (write_file action) control line endings
		return serializeCsv(rows).replace(/\n+$/, '');
	}

	writeFileContent(content: string): void {
		this.updateContent(CsvFile.normalizeCsv(content));
	}

	appendFileContent(content: string): void {
		const normalizedNew = CsvFile.normalizeCsv(content);
		if (!normalizedNew.replace(/[\r\n]/g, '')) {
			return;
		}
		let existing = this.content;
		if (existing && !existing.endsWith('\n')) {
			existing += '\n';
		}
		this.updateContent(CsvFile.normalizeCsv(existing + normalizedNew));
	}
}

export class JsonlFile extends BaseFile {
	get extension(): string {
		return 'jsonl';
	}
}

export class PdfFile extends BaseFile {
	get extension(): string {
		return 'pdf';
	}

	/**
	 * Generate PDF content using PDFKit if available, rendering the markdown
	 * subset upstream supports (headings, bullets, fenced code, inline emphasis).
	 * Falls back to writing text with .pdf extension if PDFKit is not installed.
	 */
	async syncToDisk(dirPath: string): Promise<void> {
		const filePath = path.join(dirPath, this.fullName);

		const PDFDocument = await loadOptionalModule('pdfkit');

		if (!PDFDocument) {
			console.debug('PDFKit not available, writing text file with .pdf extension');
			await fs.writeFile(filePath, this.content, 'utf-8');
			return;
		}

		try {
			const doc = new PDFDocument();
			const chunks: Buffer[] = [];
			doc.on('data', (chunk: Buffer) => chunks.push(chunk));
			const pdfPromise = new Promise<Buffer>((resolve) => {
				doc.on('end', () => resolve(Buffer.concat(chunks)));
			});

			const headingSizes: Record<number, number> = {
				1: fontSizesNumeric['2xl'],
				2: fontSizesNumeric.lg,
				3: fontSizesNumeric.md,
			};
			const bodySize = fontSizesNumeric.sm;

			const writeSegments = (text: string, size: number, baseFont: string) => {
				const segments = markdownInlineSegments(text);
				segments.forEach((seg, idx) => {
					let font = baseFont;
					if (seg.code) {
						font = 'Courier';
					} else if (seg.bold && seg.italic) {
						font = 'Helvetica-BoldOblique';
					} else if (seg.bold) {
						font = 'Helvetica-Bold';
					} else if (seg.italic) {
						font = 'Helvetica-Oblique';
					}
					doc.font(font).fontSize(size).text(seg.text, { continued: idx < segments.length - 1 });
				});
				if (segments.length === 0) {
					doc.text('');
				}
			};

			let inFence = false;
			for (const line of this.content.split('\n')) {
				const stripped = line.trim();
				if (stripped.startsWith('```')) {
					inFence = !inFence;
					continue;
				}

				if (!stripped) {
					doc.moveDown(0.5);
					continue;
				}

				if (inFence) {
					// Fenced blocks are literal: no emphasis / inline-code conversion
					doc.font('Courier').fontSize(bodySize).text(line);
					continue;
				}

				const [text, headingLevel] = splitHeading(line);
				if (headingLevel !== null) {
					writeSegments(text, headingSizes[headingLevel], 'Helvetica-Bold');
					doc.moveDown(0.3);
					continue;
				}

				const bullet = BULLET_RE.exec(line);
				if (bullet) {
					writeSegments(`• ${bullet[2]}`, bodySize, 'Helvetica');
					continue;
				}

				writeSegments(line, bodySize, 'Helvetica');
			}

			doc.end();
			const pdfBuffer = await pdfPromise;
			await fs.writeFile(filePath, pdfBuffer);
		} catch (error: any) {
			throw new FileSystemError(`Error: Could not write to file '${this.fullName}'. ${error?.message ?? error}`);
		}
	}

	syncToDiskSync(dirPath: string): void {
		const filePath = path.join(dirPath, this.fullName);
		// For sync version, just write text (PDF generation is async)
		fsSync.writeFileSync(filePath, this.content, 'utf-8');
	}
}

/**
 * DOCX file implementation. Writes a minimal but valid Office Open XML package
 * (headings via `# ` / `## ` / `### `, one paragraph per line) without an
 * external library.
 */
export class DocxFile extends BaseFile {
	get extension(): string {
		return 'docx';
	}

	/** Build the .docx package bytes for the current content. */
	toBuffer(): Buffer {
		const paragraphs: string[] = [];
		for (const line of this.content.split('\n')) {
			if (!line.trim()) {
				paragraphs.push('<w:p/>'); // Empty paragraph for spacing
				continue;
			}
			const [text, headingLevel] = splitHeading(line);
			const pPr = headingLevel !== null ? `<w:pPr><w:pStyle w:val="Heading${headingLevel}"/></w:pPr>` : '';
			const body = headingLevel !== null ? text : line;
			paragraphs.push(
				`<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(body)}</w:t></w:r></w:p>`
			);
		}

		const documentXml =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			`<w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;

		const heading = (id: string, name: string, size: number) =>
			`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
			`<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr>` +
			`<w:rPr><w:b/><w:sz w:val="${size * 2}"/></w:rPr></w:style>`;
		const stylesXml =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>' +
			heading('Heading1', 'heading 1', 16) +
			heading('Heading2', 'heading 2', 14) +
			heading('Heading3', 'heading 3', 12) +
			'</w:styles>';

		const contentTypes =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
			'<Default Extension="xml" ContentType="application/xml"/>' +
			'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
			'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
			'</Types>';

		const rels =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
			'</Relationships>';

		const documentRels =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
			'</Relationships>';

		return buildStoredZip([
			{ name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
			{ name: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
			{ name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
			{ name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf-8') },
			{ name: 'word/styles.xml', data: Buffer.from(stylesXml, 'utf-8') },
		]);
	}

	syncToDiskSync(dirPath: string): void {
		const filePath = path.join(dirPath, this.fullName);
		try {
			fsSync.writeFileSync(filePath, this.toBuffer());
		} catch (error: any) {
			throw new FileSystemError(`Error: Could not write to file '${this.fullName}'. ${error?.message ?? error}`);
		}
	}

	async syncToDisk(dirPath: string): Promise<void> {
		const filePath = path.join(dirPath, this.fullName);
		try {
			await fs.writeFile(filePath, this.toBuffer());
		} catch (error: any) {
			throw new FileSystemError(`Error: Could not write to file '${this.fullName}'. ${error?.message ?? error}`);
		}
	}
}

export class HtmlFile extends BaseFile {
	get extension(): string {
		return 'html';
	}
}

export class XmlFile extends BaseFile {
	get extension(): string {
		return 'xml';
	}
}

/**
 * Extract paragraph text from a .docx package (equivalent of python-docx
 * `'\n'.join(p.text for p in doc.paragraphs)`).
 */
export function extractDocxText(source: string | Buffer): string {
	const archive = typeof source === 'string' ? fsSync.readFileSync(source) : source;
	const entry = readZipEntries(archive).get('word/document.xml');
	if (!entry) {
		throw new Error('Not a valid .docx package (missing word/document.xml)');
	}
	const xml = entry.toString('utf-8');
	const paragraphs: string[] = [];
	const paragraphRe = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
	let match: RegExpExecArray | null;
	while ((match = paragraphRe.exec(xml)) !== null) {
		const inner = match[1] ?? '';
		let text = '';
		const textRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;
		let t: RegExpExecArray | null;
		while ((t = textRe.exec(inner)) !== null) {
			if (t[0] === '<w:tab/>') {
				text += '\t';
			} else if (t[0] === '<w:br/>') {
				text += '\n';
			} else {
				text += unescapeXml(t[1] ?? '');
			}
		}
		paragraphs.push(text);
	}
	return paragraphs.join('\n');
}

// ============================================================================
// File System State
// ============================================================================

export interface FileSystemState {
	files: Record<string, { type: string; data: any }>;
	baseDir: string;
	extractedContentCount: number;
}

export interface FileReadResult {
	/** The message to display to the LLM */
	message: string;
	/** Image data if the file is an image: [{ name, data: base64 }] */
	images: { name: string; data: string }[] | null;
}

type FileClass = new (name: string, content?: string) => BaseFile;

const FILE_TYPE_BY_CLASS_NAME: Record<string, FileClass> = {
	MarkdownFile,
	TxtFile,
	JsonFile,
	JsonlFile,
	CsvFile,
	PdfFile,
	DocxFile,
	HtmlFile,
	XmlFile,
};

/** Extensions read through a dedicated reader instead of as plain text */
const SPECIAL_READ_EXTENSIONS = new Set(['docx', 'pdf', 'jpg', 'jpeg', 'png']);

const MAX_PDF_CHARS = 60000;

// ============================================================================
// FileSystem
// ============================================================================

export class FileSystem {
	private baseDir: string;
	private dataDir: string;
	private files: Map<string, BaseFile> = new Map();
	private extractedContentCount: number = 0;
	private defaultFiles: string[] = ['todo.md'];

	private fileTypes: Record<string, FileClass> = {
		md: MarkdownFile,
		txt: TxtFile,
		json: JsonFile,
		jsonl: JsonlFile,
		csv: CsvFile,
		pdf: PdfFile,
		docx: DocxFile,
		html: HtmlFile,
		xml: XmlFile,
	};

	constructor(baseDir: string, createDefaultFiles: boolean = true) {
		this.baseDir = baseDir;
		this.dataDir = path.join(baseDir, DEFAULT_FILE_SYSTEM_PATH);

		// Create directories synchronously during construction
		try {
			if (!fsSync.existsSync(this.baseDir)) {
				fsSync.mkdirSync(this.baseDir, { recursive: true });
			}

			// Clean and recreate data directory
			if (fsSync.existsSync(this.dataDir)) {
				fsSync.rmSync(this.dataDir, { recursive: true, force: true });
			}
			fsSync.mkdirSync(this.dataDir, { recursive: true });
		} catch (error: any) {
			throw new FileSystemError(`Failed to create file system directories: ${error.message}`);
		}

		if (createDefaultFiles) {
			this.createDefaultFiles();
		}
	}

	getAllowedExtensions(): string[] {
		return Object.keys(this.fileTypes);
	}

	private getFileTypeClass(extension: string): FileClass | null {
		return this.fileTypes[extension.toLowerCase()] || null;
	}

	private createDefaultFiles(): void {
		for (const fullFilename of this.defaultFiles) {
			const [nameWithoutExt, extension] = this.parseFilename(fullFilename);
			const FileClassCtor = this.getFileTypeClass(extension);
			if (!FileClassCtor) {
				throw new Error(`Error: Invalid file extension '${extension}' for file '${fullFilename}'.`);
			}

			const fileObj = new FileClassCtor(nameWithoutExt);
			this.files.set(fullFilename, fileObj);
			fileObj.syncToDiskSync(this.dataDir);
		}
	}

	/**
	 * Check if filename matches the required pattern: name.extension
	 *
	 * Allows letters, numbers, underscores, hyphens, dots, parentheses, spaces,
	 * and CJK characters in the name part, followed by a dot and a supported extension.
	 */
	isValidFilename(fileName: string): boolean {
		const extensions = Object.keys(this.fileTypes).join('|');
		// Allow dots, spaces, parens in the name part - match everything up to the last dot
		const pattern = new RegExp(`^[a-zA-Z0-9_\\-\\.\\(\\) \\u4e00-\\u9fff]+\\.(${extensions})$`);
		const base = path.basename(fileName);
		if (!pattern.test(base)) {
			return false;
		}
		// Ensure the name part (before last dot) is non-empty
		const namePart = base.slice(0, base.lastIndexOf('.'));
		return namePart.trim().length > 0;
	}

	/**
	 * Sanitize a filename by replacing/removing invalid characters.
	 *
	 * - Replaces spaces with hyphens
	 * - Removes characters that are not alphanumeric, underscore, hyphen, dot, parentheses, or CJK
	 * - Preserves the extension (lower-cased)
	 * - Collapses multiple consecutive hyphens
	 */
	static sanitizeFilename(fileName: string): string {
		const base = path.basename(fileName);
		if (!base.includes('.')) {
			return base;
		}

		const dot = base.lastIndexOf('.');
		let namePart = base.slice(0, dot);
		const ext = base.slice(dot + 1);

		// Replace spaces with hyphens
		namePart = namePart.replace(/ /g, '-');
		// Remove invalid characters (keep alphanumeric, underscore, hyphen, dot, parens, CJK)
		namePart = namePart.replace(/[^a-zA-Z0-9_\-.()一-鿿]/g, '');
		// Collapse multiple hyphens
		namePart = namePart.replace(/-{2,}/g, '-');
		// Strip leading/trailing hyphens and dots
		namePart = namePart.replace(/^[-.]+/, '').replace(/[-.]+$/, '');

		if (!namePart) {
			namePart = 'file';
		}

		return `${namePart}.${ext.toLowerCase()}`;
	}

	/**
	 * Resolve a filename, attempting sanitization if the original is invalid.
	 *
	 * Normalizes to basename first to prevent directory traversal (e.g. ../secret.md).
	 *
	 * @returns [resolvedName, wasChanged] - whether the result differs from the input.
	 * If resolution fails, returns [basename, wasChanged].
	 */
	private resolveFilename(fileName: string): [string, boolean] {
		const baseName = path.basename(fileName);
		const wasChanged = baseName !== fileName;

		if (this.isValidFilename(baseName)) {
			return [baseName, wasChanged];
		}

		const sanitized = FileSystem.sanitizeFilename(baseName);
		if (sanitized !== baseName && this.isValidFilename(sanitized)) {
			return [sanitized, true];
		}

		return [baseName, wasChanged];
	}

	private parseFilename(filename: string): [string, string] {
		const lastDotIndex = filename.lastIndexOf('.');
		if (lastDotIndex === -1) {
			throw new Error('Invalid filename: no extension found');
		}
		const name = filename.substring(0, lastDotIndex);
		const extension = filename.substring(lastDotIndex + 1).toLowerCase();
		return [name, extension];
	}

	getDir(): string {
		return this.dataDir;
	}

	/**
	 * Get a file object by full filename, trying sanitization if the name is invalid.
	 */
	getFile(fullFilename: string): BaseFile | null {
		const [resolved] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			return null;
		}
		return this.files.get(resolved) || null;
	}

	async listFiles(): Promise<string[]> {
		return Array.from(this.files.values()).map((file) => file.fullName);
	}

	displayFile(fullFilename: string): string | null {
		const [resolved] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			return null;
		}

		const fileObj = this.files.get(resolved);
		if (!fileObj) {
			return null;
		}

		return fileObj.read();
	}

	/**
	 * Read file and return structured data including images if applicable.
	 */
	async readFileStructured(fullFilename: string, externalFile: boolean = false): Promise<FileReadResult> {
		const result: FileReadResult = { message: '', images: null };

		if (externalFile) {
			try {
				let extension: string;
				try {
					[, extension] = this.parseFilename(fullFilename);
				} catch {
					result.message = `Error: Invalid filename format ${fullFilename}. Must be alphanumeric with a supported extension.`;
					return result;
				}

				// Text-based extensions: derive from fileTypes, excluding those with special readers
				const textExtensions = Object.keys(this.fileTypes).filter((ext) => !SPECIAL_READ_EXTENSIONS.has(ext));

				if (textExtensions.includes(extension)) {
					const content = await fs.readFile(fullFilename, 'utf-8');
					result.message = `Read from file ${fullFilename}.\n<content>\n${content}\n</content>`;
					return result;
				} else if (extension === 'docx') {
					await fs.access(fullFilename); // surfaces ENOENT / EACCES with the usual error codes
					const content = extractDocxText(fullFilename);
					result.message = `Read from file ${fullFilename}.\n<content>\n${content}\n</content>`;
					return result;
				} else if (extension === 'pdf') {
					result.message = await this.readExternalPdf(fullFilename);
					return result;
				} else if (['jpg', 'jpeg', 'png'].includes(extension)) {
					const imgData = await fs.readFile(fullFilename);
					result.message = `Read image file ${fullFilename}.`;
					result.images = [{ name: path.basename(fullFilename), data: imgData.toString('base64') }];
					return result;
				} else {
					result.message = `Error: Cannot read file ${fullFilename} as ${extension} extension is not supported.`;
					return result;
				}
			} catch (error: any) {
				if (error?.code === 'ENOENT') {
					result.message = `Error: File '${fullFilename}' not found.`;
				} else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
					result.message = `Error: Permission denied to read file '${fullFilename}'.`;
				} else {
					result.message = `Error: Could not read file '${fullFilename}'. ${error?.message ?? error}`;
				}
				return result;
			}
		}

		// For internal files, only non-image types are supported
		const [resolved, wasSanitized] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			result.message = buildFilenameErrorMessage(fullFilename, this.getAllowedExtensions());
			return result;
		}

		const fileObj = this.files.get(resolved);
		if (!fileObj) {
			result.message = wasSanitized
				? `File '${resolved}' not found. (Filename was auto-corrected from '${fullFilename}')`
				: `File '${fullFilename}' not found.`;
			return result;
		}

		try {
			const content = fileObj.read();
			const sanitizeNote = wasSanitized
				? `Note: filename was auto-corrected from '${fullFilename}' to '${resolved}'. `
				: '';
			result.message = `${sanitizeNote}Read from file ${resolved}.\n<content>\n${content}\n</content>`;
			return result;
		} catch (error: any) {
			if (error instanceof FileSystemError) {
				result.message = error.message;
			} else {
				result.message = `Error: Could not read file '${fullFilename}'. ${error?.message ?? error}`;
			}
			return result;
		}
	}

	/**
	 * Read an external PDF with pdf-parse. Small PDFs are returned whole with
	 * page markers; large ones are trimmed to MAX_PDF_CHARS, prioritising pages
	 * with the most distinctive vocabulary (IDF scoring) and always page 1.
	 */
	private async readExternalPdf(fullFilename: string): Promise<string> {
		const pdfParseModule = await loadOptionalModule('pdf-parse', false);
		const PDFParse: any = pdfParseModule?.PDFParse ?? pdfParseModule?.default?.PDFParse ?? null;
		if (!PDFParse) {
			return `Error: Could not read file '${fullFilename}'. PDF parsing is not available in this build.`;
		}

		const data = await fs.readFile(fullFilename);
		const parser = new PDFParse({ data: new Uint8Array(data) });
		let pages: { num: number; text: string }[];
		try {
			const textResult = await parser.getText();
			pages = (textResult.pages ?? []).map((p: any, i: number) => ({ num: p.num ?? i + 1, text: p.text ?? '' }));
		} finally {
			await parser.destroy?.().catch?.(() => {});
		}

		const numPages = pages.length;
		const pageTexts: [number, string][] = pages.map((p) => [p.num, p.text]);
		const totalChars = pageTexts.reduce((sum, [, text]) => sum + text.length, 0);
		const fmt = (n: number) => n.toLocaleString('en-US');

		// If small enough, return everything
		if (totalChars <= MAX_PDF_CHARS) {
			const contentParts = pageTexts.filter(([, text]) => text.trim()).map(([num, text]) => `--- Page ${num} ---\n${text}`);
			return (
				`Read from file ${fullFilename} (${numPages} pages, ${fmt(totalChars)} chars).\n` +
				`<content>\n${contentParts.join('\n\n')}\n</content>`
			);
		}

		// Large PDF - prioritise pages with distinctive content (inverse document frequency)
		const wordToPages = new Map<string, Set<number>>();
		const pageWords = new Map<number, Set<string>>();
		for (const [pageNum, text] of pageTexts) {
			const words = new Set((text.toLowerCase().match(/\b[a-zA-Z]{4,}\b/g) ?? []) as string[]);
			pageWords.set(pageNum, words);
			for (const word of words) {
				if (!wordToPages.has(word)) {
					wordToPages.set(word, new Set());
				}
				wordToPages.get(word)!.add(pageNum);
			}
		}

		const pageScores = new Map<number, number>();
		for (const [pageNum, words] of pageWords) {
			let score = 0;
			for (const word of words) {
				score += Math.log(numPages / wordToPages.get(word)!.size);
			}
			pageScores.set(pageNum, score);
		}

		// Sort pages by score (highest first), always include page 1
		const sortedPages = [...pageScores.entries()].sort((a, b) => b[1] - a[1]);
		const priorityPages: number[] = [1];
		for (const [pageNum] of sortedPages) {
			if (!priorityPages.includes(pageNum)) {
				priorityPages.push(pageNum);
			}
		}
		for (const [pageNum] of pageTexts) {
			if (!priorityPages.includes(pageNum)) {
				priorityPages.push(pageNum);
			}
		}

		const textByPage = new Map(pageTexts);
		const contentParts: [number, string][] = [];
		let charsUsed = 0;
		const pagesIncluded: number[] = [];
		const truncationSuffix = '\n[...truncated]';

		for (const pageNum of priorityPages) {
			const text = textByPage.get(pageNum) ?? '';
			if (!text.trim()) {
				continue;
			}
			const pageHeader = `--- Page ${pageNum} ---\n`;
			const remaining = MAX_PDF_CHARS - charsUsed;
			// Need room for header + suffix + at least some content
			const minUseful = pageHeader.length + truncationSuffix.length + 50;
			if (remaining < minUseful) {
				break; // no room left for meaningful content
			}
			let pageContent = pageHeader + text;
			if (pageContent.length > remaining) {
				// Truncate page to fit remaining budget exactly
				pageContent = pageContent.slice(0, remaining - truncationSuffix.length) + truncationSuffix;
			}
			contentParts.push([pageNum, pageContent]);
			charsUsed += pageContent.length;
			pagesIncluded.push(pageNum);
			if (charsUsed >= MAX_PDF_CHARS) {
				break;
			}
		}

		// Sort included pages by page number for readability
		contentParts.sort((a, b) => a[0] - b[0]);
		const extractedText = contentParts.map(([, part]) => part).join('\n\n');

		const pagesNotShown = numPages - pagesIncluded.length;
		let truncationNote = '';
		if (pagesNotShown > 0) {
			const skipped = pageTexts.map(([num]) => num).filter((num) => !pagesIncluded.includes(num));
			truncationNote =
				`\n\n[Showing ${pagesIncluded.length} of ${numPages} pages. ` +
				`Skipped pages: [${skipped.slice(0, 10).join(', ')}]${skipped.length > 10 ? '...' : ''}. ` +
				'Use extract with start_from_char to read further into the file.]';
		}

		return (
			`Read from file ${fullFilename} (${numPages} pages, ${fmt(totalChars)} chars total).\n` +
			`<content>\n${extractedText}${truncationNote}\n</content>`
		);
	}

	/**
	 * Read file content and return the message for the LLM.
	 * Note: for image files, use readFileStructured() to get image data.
	 */
	async readFile(fullFilename: string, externalFile: boolean = false): Promise<string> {
		const result = await this.readFileStructured(fullFilename, externalFile);
		return result.message;
	}

	async writeFile(fullFilename: string, content: string): Promise<string> {
		const originalFilename = fullFilename;
		const [resolved, wasSanitized] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			return buildFilenameErrorMessage(fullFilename, this.getAllowedExtensions());
		}
		fullFilename = resolved;

		try {
			const [nameWithoutExt, extension] = this.parseFilename(fullFilename);
			const FileClassCtor = this.getFileTypeClass(extension);
			if (!FileClassCtor) {
				throw new Error(`Error: Invalid file extension '${extension}' for file '${fullFilename}'.`);
			}

			// Create or get existing file
			let fileObj = this.files.get(fullFilename);
			if (!fileObj) {
				const newFileObj = new FileClassCtor(nameWithoutExt);
				this.files.set(fullFilename, newFileObj);
				fileObj = newFileObj;
			}

			// Use file-specific write method
			await fileObj.write(content, this.dataDir);
			const sanitizeNote = wasSanitized ? ` (auto-corrected from '${originalFilename}')` : '';
			return `Data written to file ${fullFilename} successfully.${sanitizeNote}`;
		} catch (error: any) {
			if (error instanceof FileSystemError) {
				return error.message;
			}
			return `Error: Could not write to file '${fullFilename}'. ${error.message}`;
		}
	}

	async appendFile(fullFilename: string, content: string): Promise<string> {
		const originalFilename = fullFilename;
		const [resolved, wasSanitized] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			return buildFilenameErrorMessage(fullFilename, this.getAllowedExtensions());
		}
		fullFilename = resolved;

		const fileObj = this.files.get(fullFilename);
		if (!fileObj) {
			if (wasSanitized) {
				return `File '${fullFilename}' not found. (Filename was auto-corrected from '${originalFilename}')`;
			}
			return `File '${fullFilename}' not found.`;
		}

		try {
			await fileObj.append(content, this.dataDir);
			const sanitizeNote = wasSanitized ? ` (auto-corrected from '${originalFilename}')` : '';
			return `Data appended to file ${fullFilename} successfully.${sanitizeNote}`;
		} catch (error: any) {
			if (error instanceof FileSystemError) {
				return error.message;
			}
			return `Error: Could not append to file '${fullFilename}'. ${error.message}`;
		}
	}

	async replaceFileStr(fullFilename: string, oldStr: string, newStr: string): Promise<string> {
		const originalFilename = fullFilename;
		const [resolved, wasSanitized] = this.resolveFilename(fullFilename);
		if (!this.isValidFilename(resolved)) {
			return buildFilenameErrorMessage(fullFilename, this.getAllowedExtensions());
		}
		fullFilename = resolved;

		if (!oldStr) {
			return 'Error: Cannot replace empty string. Please provide a non-empty string to replace.';
		}

		const fileObj = this.files.get(fullFilename);
		if (!fileObj) {
			if (wasSanitized) {
				return `File '${fullFilename}' not found. (Filename was auto-corrected from '${originalFilename}')`;
			}
			return `File '${fullFilename}' not found.`;
		}

		try {
			let content = fileObj.read();
			if (!content.includes(oldStr)) {
				return `Error: Could not find the specified text in file ${fullFilename}.`;
			}
			// Literal replacement of every occurrence (no regex semantics)
			content = content.split(oldStr).join(newStr);
			await fileObj.write(content, this.dataDir);
			const sanitizeNote = wasSanitized ? ` (auto-corrected from '${originalFilename}')` : '';
			return `Successfully replaced all occurrences of "${oldStr}" with "${newStr}" in file ${fullFilename}${sanitizeNote}`;
		} catch (error: any) {
			if (error instanceof FileSystemError) {
				return error.message;
			}
			return `Error: Could not replace string in file '${fullFilename}'. ${error.message}`;
		}
	}

	async saveExtractedContent(content: string): Promise<string> {
		const initialFilename = `extracted_content_${this.extractedContentCount}`;
		const extractedFilename = `${initialFilename}.md`;
		const fileObj = new MarkdownFile(initialFilename);
		await fileObj.write(content, this.dataDir);
		this.files.set(extractedFilename, fileObj);
		this.extractedContentCount += 1;
		return extractedFilename;
	}

	describe(): string {
		const DISPLAY_CHARS = 400;
		let description = '';

		for (const fileObj of this.files.values()) {
			// Skip todo.md from description
			if (fileObj.fullName === 'todo.md') {
				continue;
			}

			const content = fileObj.read();

			// Handle empty files
			if (!content) {
				description += `<file>\n${fileObj.fullName} - [empty file]\n</file>\n`;
				continue;
			}

			const lines = content.split('\n');
			const lineCount = lines.length;

			// For small files, display the entire content
			const wholeFileDescription = `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${content}\n</content>\n</file>\n`;
			if (content.length < 1.5 * DISPLAY_CHARS) {
				description += wholeFileDescription;
				continue;
			}

			// For larger files, display start and end previews
			const halfDisplayChars = Math.floor(DISPLAY_CHARS / 2);

			// Get start preview
			let startPreview = '';
			let startLineCount = 0;
			let charsCount = 0;
			for (const line of lines) {
				if (charsCount + line.length + 1 > halfDisplayChars) {
					break;
				}
				startPreview += line + '\n';
				charsCount += line.length + 1;
				startLineCount += 1;
			}

			// Get end preview
			let endPreview = '';
			let endLineCount = 0;
			charsCount = 0;
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i];
				if (charsCount + line.length + 1 > halfDisplayChars) {
					break;
				}
				endPreview = line + '\n' + endPreview;
				charsCount += line.length + 1;
				endLineCount += 1;
			}

			// Calculate lines in between
			const middleLineCount = lineCount - startLineCount - endLineCount;
			if (middleLineCount <= 0) {
				description += wholeFileDescription;
				continue;
			}

			startPreview = startPreview.trim();
			endPreview = endPreview.trim();

			// Format output
			if (!startPreview && !endPreview) {
				description += `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${middleLineCount} lines...\n</content>\n</file>\n`;
			} else {
				description += `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${startPreview}\n`;
				description += `... ${middleLineCount} more lines ...\n`;
				description += `${endPreview}\n`;
				description += '</content>\n</file>\n';
			}
		}

		return description.trim();
	}

	getTodoContents(): string {
		const todoFile = this.getFile('todo.md');
		return todoFile ? todoFile.read() : '';
	}

	getState(): FileSystemState {
		const filesData: Record<string, { type: string; data: any }> = {};
		for (const [fullFilename, fileObj] of this.files.entries()) {
			filesData[fullFilename] = {
				type: fileObj.constructor.name,
				data: {
					name: fileObj.name,
					content: fileObj.content,
				},
			};
		}

		return {
			files: filesData,
			baseDir: this.baseDir,
			extractedContentCount: this.extractedContentCount,
		};
	}

	nuke(): void {
		fsSync.rmSync(this.dataDir, { recursive: true, force: true });
	}

	static fromState(state: FileSystemState): FileSystem {
		const fileSystem = new FileSystem(state.baseDir, false);
		fileSystem.extractedContentCount = state.extractedContentCount;

		// Restore all files
		for (const [fullFilename, fileData] of Object.entries(state.files)) {
			const FileClassCtor = FILE_TYPE_BY_CLASS_NAME[fileData.type];
			if (!FileClassCtor) {
				// Skip unknown file types
				continue;
			}
			const fileInfo = fileData.data;
			const fileObj = new FileClassCtor(fileInfo.name, fileInfo.content);

			// Add to files dict and sync to disk
			fileSystem.files.set(fullFilename, fileObj);
			fileObj.syncToDiskSync(fileSystem.dataDir);
		}

		return fileSystem;
	}
}
