/**
 * Minimal ambient typing for `adm-zip` (the package ships no types and the
 * project does not pull `@types/adm-zip`). Only the surface used by
 * browser-use is declared.
 */
declare module 'adm-zip' {
	interface IZipEntry {
		entryName: string;
		name: string;
		isDirectory: boolean;
		getData(): Buffer;
	}

	class AdmZip {
		constructor(input?: string | Buffer);
		addFile(entryName: string, content: Buffer, comment?: string, attr?: number): void;
		addLocalFile(localPath: string, zipPath?: string, zipName?: string): void;
		addLocalFolder(localPath: string, zipPath?: string): void;
		getEntries(): IZipEntry[];
		getEntry(name: string): IZipEntry | null;
		readAsText(entry: string | IZipEntry, encoding?: string): string;
		readFile(entry: string | IZipEntry): Buffer | null;
		extractAllTo(targetPath: string, overwrite?: boolean, keepOriginalPermission?: boolean): void;
		extractEntryTo(
			entry: string | IZipEntry,
			targetPath: string,
			maintainEntryPath?: boolean,
			overwrite?: boolean
		): boolean;
		toBuffer(): Buffer;
		writeZip(targetFileName?: string): void;
	}

	export = AdmZip;
}
