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

/** findFiles 专用的基础排除——单层 {} 无嵌套，安全有效 */
const BASE_EXCLUDE = '**/{node_modules,.git,dist,out,build,.vscode,__pycache__}/**';

/**
 * 将简单 Glob 模式转为正则（不支持深层嵌套 {} 或复杂语法）
 */
function globToRegex(pattern: string): RegExp {
	let p = pattern.replace(/\\/g, '/');
	// 转义正则特殊字符（除了 */? 已经在后续替换中处理）
	p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	// 还原被过度转义的 * ? {
	p = p.replace(/\\\*/g, '*');
	p = p.replace(/\\\?/g, '?');
	p = p.replace(/\\\{/g, '{');
	p = p.replace(/\\\}/g, '}');
	p = p.replace(/\\\,/g, ',');
	// ** → 匹配任意层级
	p = p.replace(/\*\*/g, '<<STARSTAR>>');
	// * → 匹配单层任意字符
	p = p.replace(/\*/g, '[^/]*');
	p = p.replace(/<<STARSTAR>>/g, '.*');
	// ? → 匹配单字符
	p = p.replace(/\?/g, '.');
	// {a,b} → 正则选择
	p = p.replace(/\{([^}]+)\}/g, (_, alt) => `(${alt.split(',').map((s: string) => s.trim()).join('|')})`);
	return new RegExp('^(.*/)?' + p + '(/.*)?$');
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
			const includePattern = include?.trim() || '**/*';

			// 只有基础排除传给 findFiles（单层 {}，无嵌套，不会非法）
			const findFilesExclude = useDefaultExcludes ? BASE_EXCLUDE : undefined;
			files = await vscode.workspace.findFiles(includePattern, findFilesExclude);

			// 收集附加排除模式（来源于配置和用户输入），用代码后过滤
			const extraExcludes: string[] = [];

			if (useExcludeSettings) {
				extraExcludes.push(...readConfigExcludes());
			}

			if (exclude?.trim()) {
				for (const p of exclude.split(/[,;\n]+/)) {
					const t = p.trim();
					if (t) {extraExcludes.push(t);}
				}
			}

			if (extraExcludes.length > 0) {
				const regexes = extraExcludes.map(p => globToRegex(p));
				files = files.filter(f => {
					const rel = vscode.workspace.asRelativePath(f).replace(/\\/g, '/');
					return !regexes.some(r => r.test(rel));
				});
			}
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
