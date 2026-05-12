import * as vscode from 'vscode';
import PinyinMatch from 'pinyin-match';

interface FileItem {
	uri: vscode.Uri;
	fileName: string;
	parentDir: string;
	relativePath: string;
}

interface FileQuickPickItem extends vscode.QuickPickItem {
	fileItem: FileItem;
	/** 运行时生效，VSCode 内部支持此字段用于 label 高亮 */
	highlights?: Array<{ start: number; end: number }>;
}

interface MatchedFile {
	file: FileItem;
	labelHighlights?: Array<{ start: number; end: number }>;
}

const EXT_ICON: Record<string, string> = {
	ts: 'symbol-class',    tsx: 'symbol-ruler',
	js: 'symbol-method',   jsx: 'symbol-ruler',
	mjs: 'symbol-method',  cjs: 'symbol-method',
	d: 'type-hierarchy',
	json: 'json',          jsonc: 'json',
	md: 'markdown',        mdx: 'markdown',
	html: 'code',          htm: 'code',
	css: 'symbol-color',   scss: 'symbol-color',
	sass: 'symbol-color',  less: 'symbol-color',
	py: 'symbol-method',   rb: 'symbol-method',
	go: 'symbol-method',   rs: 'symbol-method',
	java: 'symbol-method', c: 'symbol-method',
	cpp: 'symbol-method',  h: 'symbol-method',
	hpp: 'symbol-method',  cs: 'symbol-method',
	php: 'symbol-method',  swift: 'symbol-method',
	kt: 'symbol-method',
	sh: 'terminal',        bash: 'terminal',
	zsh: 'terminal',       ps1: 'terminal',
	bat: 'terminal',       cmd: 'terminal',
	yaml: 'settings',      yml: 'settings',
	toml: 'settings',      xml: 'code',
	svg: 'file-media',     png: 'file-media',
	jpg: 'file-media',     jpeg: 'file-media',
	gif: 'file-media',     webp: 'file-media',
	ico: 'file-media',     pdf: 'file-pdf',
	lock: 'lock',
	gitignore: 'settings', editorconfig: 'settings',
	dockerfile: 'settings',
};

function getIcon(ext: string): vscode.ThemeIcon {
	const id = EXT_ICON[ext.toLowerCase()];
	return id ? new vscode.ThemeIcon(id) : new vscode.ThemeIcon('file');
}

function matchAll(text: string, pattern: string): Array<{ start: number; end: number }> | false {
	const r = PinyinMatch.match(text, pattern);
	return r === false ? false : [{ start: r[0], end: r[1] }];
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('pinyinsousuo.searchFiles', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const files = await vscode.workspace.findFiles(
			'**/*',
			'**/{node_modules,.git,dist,out,build,.vscode,__pycache__}/**'
		);

		const root = workspaceFolders[0].uri.fsPath;
		const multiRoot = workspaceFolders.length > 1;

		const allFiles: FileItem[] = files.map(uri => {
			const relPath = uri.fsPath.startsWith(root)
				? uri.fsPath.slice(root.length + 1)
				: uri.path.replace(/^\//, '');
			const segments = relPath.split(/[\\/]/);
			const name = segments.pop() || '';
			const parentDir = segments.join('/');
			return { uri, relativePath: relPath, fileName: name, parentDir };
		});

		const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
		quickPick.placeholder = '输入文件名进行搜索（支持拼音、首字母缩写）';
		quickPick.keepScrollPosition = true;

		const toItem = (mf: MatchedFile, alwaysShow = false): FileQuickPickItem => {
			const ext = mf.file.fileName.includes('.')
				? mf.file.fileName.split('.').pop()?.toLowerCase() || ''
				: '';
			return {
				label: mf.file.fileName,
				description: mf.file.parentDir,
				detail: multiRoot ? workspaceFolders[0].name : undefined,
				iconPath: getIcon(ext),
				alwaysShow,
				highlights: mf.labelHighlights,
				fileItem: mf.file,
			};
		};

		quickPick.items = allFiles.map(f => toItem({ file: f }));

		quickPick.onDidChangeValue(value => {
			if (!value) {
				quickPick.items = allFiles.map(f => toItem({ file: f }));
				return;
			}

			const matched: MatchedFile[] = [];

			for (const f of allFiles) {
				const nameMatch = matchAll(f.fileName, value);
				if (nameMatch) {
					matched.push({ file: f, labelHighlights: nameMatch });
					continue;
				}
				// 路径匹配但文件名不匹配：有结果但 label 无高亮
				const pathMatch = PinyinMatch.match(f.relativePath, value);
				if (pathMatch !== false) {
					matched.push({ file: f });
				}
			}

			quickPick.items = matched.map(m => toItem(m, true));
		});

		quickPick.onDidAccept(() => {
			const selection = quickPick.selectedItems[0];
			if (selection) {
				vscode.workspace.openTextDocument(selection.fileItem.uri).then(doc => {
					vscode.window.showTextDocument(doc);
				});
			}
			quickPick.hide();
		});

		quickPick.show();
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
