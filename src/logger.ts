import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('拼音搜索');
	}
	return channel;
}
