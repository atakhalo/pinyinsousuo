import * as vscode from 'vscode';
import PinyinMatch from 'pinyin-match';
import { getLogger } from './logger';

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
// - 有 glob 字符 + 文件后缀（如 *.ts, **/*.py）→ 原样返回
// - 有 glob 字符 + 无后缀（如 **/任务UI）→ 视为目录，加 /** 后缀
// - 无 glob + 有后缀（如 测试.py）→ 视为文件名，加 **/ 前缀
// - 无 glob + 无后缀（如 测试文件夹）→ 视为目录，加 /** 后缀
function normalizeGlob(pattern: string): string {
	let p = pattern.trim().replace(/^\.\//, '');
	// 规范化连续星号：*** → **，**.ext → **/*.ext
	p = p.replace(/\*{3,}/g, '**');
	p = p.replace(/\*\*([^\/\*])/g, '**/*$1');
	const hasGlob = /[*?{\[]/.test(p);
	const hasExt = /\.[a-zA-Z0-9]+$/.test(p);
	// 纯扩展名模式：.cs → **/*.cs，匹配所有该扩展名的文件
	if (/^\.[a-zA-Z0-9]+$/.test(p)) {
		return '**/*' + p;
	}
	if (hasGlob && hasExt) {
		// *.cs → **/*.cs，确保 findFiles 能递归匹配子目录
		return p.includes('/') ? p : '**/' + p;
	}
	if (hasGlob) {
		return p.replace(/\/$/, '') + '/**';
	}
	if (hasExt) {
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
			// 构建 include glob（多根工作区时使用 RelativePattern 限定范围）
			const includeParts: string[] = [];
			let includeWs: vscode.WorkspaceFolder | undefined;
			let wsConflict = false;

			if (include?.trim()) {
				const wsFolders = vscode.workspace.workspaceFolders;
				for (const raw of include.split(/[,;\n]+/)) {
					const t = raw.trim();
					if (!t) {continue;}
					const resolved = this._resolveWorkspacePrefix(t, wsFolders);
					const glob = resolved.pattern ? normalizeGlob(resolved.pattern) : '**/*';
					includeParts.push(glob);
					if (resolved.workspace) {
						if (!includeWs) {
							includeWs = resolved.workspace;
						} else if (includeWs !== resolved.workspace) {
							wsConflict = true;
						}
					}
				}
			}

			const includeGlobStr = includeParts.length === 0
				? '**/*'
				: (includeParts.length === 1 ? includeParts[0] : `{${includeParts.join(',')}}`);

			// 构建基础 exclude（来自配置和用户输入，不含 .gitignore）
			const baseExcludeParts: string[] = [];

			if (useExcludeSettings) {
				baseExcludeParts.push(...readConfigExcludes());
			}

			if (exclude?.trim()) {
				for (const p of exclude.split(/[,;\n]+/)) {
					const t = p.trim();
					if (t) { baseExcludeParts.push(normalizeGlob(t)); }
				}
			}

			if (useExcludeSettings) {
				// 逐工作区收集 .gitignore + findFiles，最后合并结果
				const wsFolders = vscode.workspace.workspaceFolders;
				const targetWss = (!wsConflict && includeWs)
					? [includeWs]
					: (wsFolders && wsFolders.length > 0 ? [...wsFolders] : [undefined]);

				const allResults: vscode.Uri[] = [];
				for (const ws of targetWss) {
					if (this._cancelled) {return;}

					const gitExcludes = await this._collectGitignoreExcludes(includeParts, baseExcludeParts, ws);
					const wsExcludeParts = [...baseExcludeParts, ...gitExcludes];
					const wsExcludePattern = wsExcludeParts.length > 0
						? `{${wsExcludeParts.join(',')}}`
						: undefined;

					const wsInclude: vscode.GlobPattern = ws
						? new vscode.RelativePattern(ws, includeGlobStr)
						: includeGlobStr;

					// getLogger().appendLine(`${ws?.name} search include: ${includeGlobStr} in ${ws?.name}`);
					// getLogger().appendLine(`${ws?.name} search exclude: ${wsExcludePattern}`);

					const wsFiles = await vscode.workspace.findFiles(wsInclude, wsExcludePattern);
					allResults.push(...wsFiles);
					// getLogger().appendLine(`${ws?.name} matched files: ${wsFiles.length}`);
				}
				files = allResults;

				// getLogger().appendLine(`total matched files: ${files.length}`);
			} else {
				// 不使用排除设置：单次 findFiles
				let includePattern: vscode.GlobPattern;
				if (!wsConflict && includeWs) {
					includePattern = new vscode.RelativePattern(includeWs, includeGlobStr);
				} else {
					includePattern = includeGlobStr;
				}

				const excludePattern = baseExcludeParts.length > 0
					? `{${baseExcludeParts.join(',')}}`
					: undefined;

				files = await vscode.workspace.findFiles(includePattern, excludePattern);
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

	// 去掉 ./工作区名称[/...] 前缀，返回剩余模式与匹配到的工作区
	private _resolveWorkspacePrefix(
		raw: string,
		wsFolders: readonly vscode.WorkspaceFolder[] | undefined,
	): { pattern: string; workspace?: vscode.WorkspaceFolder } {
		let p = raw.trim().replace(/^\.\//, '');
		if (wsFolders) {
			for (const ws of wsFolders) {
				if (p.startsWith(ws.name + '/')) {
					return { pattern: p.substring(ws.name.length + 1), workspace: ws };
				}
				if (p === ws.name) {
					return { pattern: '', workspace: ws };
				}
			}
		}
		return { pattern: p };
	}

	// 找出纳入搜索范围的 .gitignore 文件，读取并转为 findFiles 用 glob
	private async _collectGitignoreExcludes(
		includeParts: string[],
		excludeParts: string[],
		includeWs?: vscode.WorkspaceFolder,
	): Promise<string[]> {
		try {
			// 构建 .gitignore 文件的查找范围
			let gitInclude: string;
			if (includeParts.length > 0) {
				const dirs = includeParts.map(p => {
					const m = p.match(/^([^*?{\[]*\/)/);
					return m ? m[1] : '';
				}).filter(Boolean);
				const unique = [...new Set(dirs)];
				if (unique.length > 0) {
					const parts = ['.gitignore'];
					for (const d of unique) {
						parts.push(`${d}.gitignore`, `${d}**/.gitignore`);
					}
					gitInclude = `{${parts.join(',')}}`;
				} else {
					gitInclude = '.gitignore';
				}
			} else {
				gitInclude = '**/.gitignore';
			}
			const gitExclude = excludeParts.length > 0
				? `{${excludeParts.join(',')}}`
				: undefined;

			const gitignoreGlob: vscode.GlobPattern = includeWs
				? new vscode.RelativePattern(includeWs, gitInclude)
				: gitInclude;

			const gitignoreUris = await vscode.workspace.findFiles(gitignoreGlob, gitExclude);
			if (gitignoreUris.length === 0) {return [];}

			const results: string[] = [];
			for (const uri of gitignoreUris) {
				if (this._cancelled) {return results;}
				const patterns = await this._readGitignoreFile(uri);
				results.push(...patterns);
			}
			return results;
		} catch {
			return [];
		}
	}

	// 读取单个 .gitignore，转换每条模式为 glob
	private async _readGitignoreFile(uri: vscode.Uri): Promise<string[]> {
		try {
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
			const dir = uri.path.substring(0, uri.path.lastIndexOf('/'));
			// getWorkspaceFolder 打包版只返回
			const wsFolder = vscode.workspace.getWorkspaceFolder(uri); 
			let relativeDir = '';
			if (wsFolder) {
				// 统一小写比较，修复 Windows 盘符大小写不一致（e:/ vs E:/）
				const wsPath = wsFolder.uri.path;
				const lowerDir = dir.toLowerCase();
				const lowerWsPath = wsPath.toLowerCase();
				if (lowerDir.startsWith(lowerWsPath + '/')) {
					relativeDir = dir.substring(wsPath.length + 1);
				}
			}
			// getLogger().appendLine(`scan ignore ${uri.path} in ${wsFolder?.name} ${relativeDir}`);

			const results: string[] = [];
			for (const line of text.split(/\r?\n/)) {
				const p = line.trim();
				if (!p || p.startsWith('#') || p.startsWith('!')) {continue;}

				const globs = this._gitignoreToGlob(p, relativeDir);
				results.push(...globs);
			}
			return results;
		} catch {
			return [];
		}
	}

	// 将单条 .gitignore 规则转为 findFiles 兼容的 glob
	private _gitignoreToGlob(pattern: string, relativeDir: string): string[] {
		let p = pattern;

		// 去除末尾空格（.gitignore 允许）
		p = p.trimEnd();

		let anchored = false; 
		if (p.startsWith('/')) {
			anchored = true;
			p = p.substring(1);
		}

		let isDir = false;
		if (p.endsWith('/')) {
			isDir = true;
			p = p.substring(0, p.length - 1);
		}

		if (!p) {return [];}

		const hasSlash = p.includes('/');

		// 构建相对工作区根目录的 glob
		// 每个目录下的.gitignore应该只影响该目录下，所以都需要加前缀路径
		let base: string;
		if (anchored || hasSlash) {
			base = relativeDir ? `${relativeDir}/${p}` : p;
		} else {
			// 无 / 无锚定 → 匹配任意深度
			base = relativeDir ? `${relativeDir}/**/${p}` : `**/${p}`;
		}

		const results: string[] = [];
		if (isDir) {
			results.push(`${base}/**`);
		} else {
			results.push(base);
			// 无后缀且无 glob 字符的非目录模式，很可能也指目录（如 node_modules、build）
			if (!/\.[a-zA-Z0-9]+$/.test(p) && !/[*?{\[]/.test(p)) {
				results.push(`${base}/**`);
			}
		}
		return results;
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
