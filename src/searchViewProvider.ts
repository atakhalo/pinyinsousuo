import * as vscode from 'vscode';
import { SearchEngine, SearchOptions, FileMatch } from './searchEngine';

export class SearchViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'pinyinsousuo.searchContent';
	private _view?: vscode.WebviewView;
	private _engine: SearchEngine;
	private _pendingFocus = false;
	private _pendingText = '';

	constructor(private readonly _extensionUri: vscode.Uri) {
		this._engine = new SearchEngine();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		// 取消上次视图残留的搜索，使用新引擎
		this._engine.cancel();
		this._engine = new SearchEngine();

		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media'),
			],
		};

		webviewView.webview.html = this._getHtmlContent(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'search':
					await this._startSearch(msg);
					break;
				case 'cancel':
					this._engine.cancel();
					break;
				case 'open':
					await this._openFile(msg.uri, msg.line, msg.column);
					break;
			}
		});

		// 处理 pending focus 请求
		if (this._pendingFocus) {
			this._pendingFocus = false;
			this.focus(this._pendingText);
		}
	}

	private async _startSearch(msg: { query: string; include?: string; exclude?: string; openEditorsOnly: boolean; useExcludeSettings: boolean }) {
		this._view?.webview.postMessage({ type: 'searchStart' });

		const options: SearchOptions = {
			query: msg.query,
			include: msg.include || undefined,
			exclude: msg.exclude || undefined,
			openEditorsOnly: msg.openEditorsOnly || false,
		};

		const useExclude = msg.useExcludeSettings !== false;

		await this._engine.search(
			options,
			useExclude,
			useExclude,
			(processed, total) => {
				this._view?.webview.postMessage({ type: 'progress', processed, total });
			},
			(result: FileMatch) => {
				this._view?.webview.postMessage({ type: 'result', result });
			},
		);

		this._view?.webview.postMessage({ type: 'searchDone' });
	}

	private async _openFile(uriStr: string, line: number, column?: number) {
		try {
			const uri = vscode.Uri.parse(uriStr);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);
			const pos = new vscode.Position(line - 1, column || 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		} catch {
			// 文件可能已被删除
		}
	}

	/**
	 * 激活视图并聚焦搜索输入框
	 * @param selectedText 编辑器选中的文本，用于预填搜索
	 */
	focus(selectedText?: string) {
		if (!this._view) {
			this._pendingFocus = true;
			this._pendingText = selectedText || '';
			return;
		}
		this._view.show?.(true);
		this._view.webview.postMessage({ type: 'focus', selectedText: selectedText || '' });
	}

	private _getHtmlContent(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'search.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'search.css'),
		);

		const nonce = this._getNonce();

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div class="search-container">
		<div class="search-box">
			<input type="text" id="searchInput" placeholder="搜索文件内容（支持拼音）" spellcheck="false">
		</div>
		<div class="options-section">
			<div class="option-row">
				<input type="text" id="includeInput" placeholder="包含的文件(不用加工作区文件夹）" spellcheck="false">
			</div>
			<div class="option-row">
				<input type="text" id="excludeInput" placeholder="排除的文件(不用加工作区文件夹）" spellcheck="false">
			</div>
			<div class="toggle-section">
				<label class="toggle-label">
					<input type="checkbox" id="openEditorsOnly">
					<span>仅在打开的编辑器中搜索</span>
				</label>
				<label class="toggle-label">
					<input type="checkbox" id="useExcludeSettings" checked>
					<span>使用"排除设置"与"忽略文件"</span>
				</label>
			</div>
		</div>
		<div class="progress-section" id="progressSection" style="display:none">
			<div class="spinner"></div>
			<span id="progressText">正在搜索...</span>
		</div>
		<div class="results-section" id="resultsSection">
			<div class="results-summary" id="resultsSummary"></div>
			<div class="results-tree" id="resultsTree"></div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private _getNonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 64; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}
}
