import * as vscode from 'vscode';
import PinyinMatch from 'pinyin-match';

export interface LineMatch {
	lineNumber: number;       // 1-based
	text: string;
	highlight: [number, number];
}

export interface FileMatch {
	uri: string;
	fileName: string;
	parentDir: string;
	relativePath: string;
	workspaceFolder: string;
	matchCount: number;
	matches: LineMatch[];
}

export interface SearchOptions {
	query: string;
	include?: string;
	exclude?: string;
	openEditorsOnly: boolean;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// 将用户模式规范化为 findFiles 兼容的 glob，模拟 VS Code 原生搜索行为：
// - 去掉前导 ./
// - 已有 glob 字符（*?{[）→ 原样返回
// - 有文件后缀（如 .py）→ 视为文件名，加 **/ 前缀匹配任意深度
// - 无后缀 → 视为目录名，加 /** 后缀匹配其下所有文件
function normalizeGlob(pattern: string): string {
	let p = pattern.trim().replace(/^\.\//, '');
	if (/[*?{\[]/.test(p)) {
		return p;
	}
	if (/\.[a-zA-Z0-9]+$/.test(p)) {
		return '**/' + p;
	}
	return p.replace(/\/$/, '') + '/**';
}

/**
 * 从 VSCode 配置读取排除模式列表
 */
function readConfigExcludes(): string[] {
	const result: string[] = [];
	const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') || {};
	for (const [key, val] of Object.entries(searchExclude)) {
		if (val) {result.push(key);}
	}
	const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') || {};
	for (const [key, val] of Object.entries(filesExclude)) {
		if (val && !result.includes(key)) {result.push(key);}
	}
	return result;
}

export class SearchEngine {
	private _cancelled = false;

	cancel(): void {
		this._cancelled = true;
	}

	async search(
		options: SearchOptions,
		useDefaultExcludes: boolean,
		useExcludeSettings: boolean,
		onProgress: (processed: number, total: number) => void,
		onFileResult: (result: FileMatch) => void,
	): Promise<void> {
		this._cancelled = false;

		const { query, include, exclude, openEditorsOnly } = options;
		if (!query.trim()) {return;}

		let files: vscode.Uri[];

		if (openEditorsOnly) {
			files = this._getOpenEditorFiles();
		} else {
			// 构建 include glob
			const includeParts: string[] = [];
			if (include?.trim()) {
				for (const p of include.split(/[,;\n]+/)) {
					const t = p.trim();
					if (t) { includeParts.push(normalizeGlob(t)); }
				}
			}
			const includePattern = includeParts.length > 0
				? (includeParts.length === 1 ? includeParts[0] : `{${includeParts.join(',')}}`)
				: '**/*';

			// 构建 exclude glob
			const excludeParts: string[] = [];

			if (useExcludeSettings) {
				excludeParts.push(...readConfigExcludes());
			}

			if (exclude?.trim()) {
				for (const p of exclude.split(/[,;\n]+/)) {
					const t = p.trim();
					if (t) { excludeParts.push(normalizeGlob(t)); }
				}
			}

			const excludePattern = excludeParts.length > 0
				? `{${excludeParts.join(',')}}`
				: undefined;

			files = await vscode.workspace.findFiles(includePattern, excludePattern);
		}

		const total = files.length;
		let processed = 0;

		for (const uri of files) {
			if (this._cancelled) {return;}

			onProgress(++processed, total);

			const fileMatch = await this._searchFile(uri, query);
			if (fileMatch) {
				onFileResult(fileMatch);
			}
		}
	}

	private _getOpenEditorFiles(): vscode.Uri[] {
		const uris: vscode.Uri[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					uris.push(tab.input.uri);
				}
			}
		}
		return uris;
	}

	private async _searchFile(uri: vscode.Uri, query: string): Promise<FileMatch | null> {
		try {
			const content = await vscode.workspace.fs.readFile(uri);
			if (content.length > MAX_FILE_SIZE) {return null;}

			const contentBytes = new Uint8Array(content);
			// 检测二进制文件：检查前 4KB 是否包含空字节
			const checkLen = Math.min(contentBytes.length, 4096);
			for (let i = 0; i < checkLen; i++) {
				if (contentBytes[i] === 0) {return null;}
			}

			const text = new TextDecoder('utf-8', { fatal: false }).decode(contentBytes);
			const lines = text.split(/\r?\n/);

			const matches: LineMatch[] = [];
			for (let i = 0; i < lines.length; i++) {
				const result = PinyinMatch.match(lines[i], query);
				if (result) {
					matches.push({
						lineNumber: i + 1,
						text: lines[i],
						highlight: result,
					});
				}
			}

			if (matches.length === 0) {return null;}

			const relativePath = vscode.workspace.asRelativePath(uri);
			const segments = relativePath.split(/[\\/]/);
			segments.pop(); // remove filename
			const parentDir = segments.join('/');
			const wsFolder = vscode.workspace.getWorkspaceFolder(uri);

			return {
				uri: uri.toString(),
				fileName: uri.path.split('/').pop() || '',
				parentDir,
				relativePath,
				workspaceFolder: wsFolder ? wsFolder.name : '',
				matchCount: matches.length,
				matches,
			};
		} catch {
			return null;
		}
	}
}
