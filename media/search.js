(function () {
	const vscode = acquireVsCodeApi();

	// DOM 元素
	const searchInput = document.getElementById('searchInput');
	const includeInput = document.getElementById('includeInput');
	const excludeInput = document.getElementById('excludeInput');
	const openEditorsOnly = document.getElementById('openEditorsOnly');
	const useExcludeSettings = document.getElementById('useExcludeSettings');
	const progressSection = document.getElementById('progressSection');
	const progressText = document.getElementById('progressText');
	const resultsSummary = document.getElementById('resultsSummary');
	const resultsTree = document.getElementById('resultsTree');

	// 状态
	let searchTimeout = null;
	const results = {};
	const fileOrder = [];
	const expandedFiles = {};       // file uri → bool
	const expandedGroups = {};      // group key → bool
	let isSearching = false;
	let viewMode = 'list';          // 'list' | 'tree'

	// 搜索历史
	const MAX_HISTORY = 20;
	let searchHistory = [];
	let historyIdx = -1;
	let isRestoring = false;

	// ======== 搜索 ========

	function scheduleSearch() {
		if (isRestoring) return;
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(doSearch, 500);
	}

	function doSearch() {
		const query = searchInput.value.trim();
		if (!query) {
			clearResults();
			saveState();
			return;
		}
		if (isSearching) vscode.postMessage({ type: 'cancel' });
		for (const k in results) delete results[k];
		fileOrder.length = 0;
		for (const k in expandedFiles) delete expandedFiles[k];
		for (const k in expandedGroups) delete expandedGroups[k];
		renderResults();
		addToHistory(query);
		isSearching = true;
		// 清空上次残留的结果 DOM
		progressSection.style.display = 'none';
		vscode.postMessage({
			type: 'search',
			query: query,
			include: includeInput.value.trim() || undefined,
			exclude: excludeInput.value.trim() || undefined,
			openEditorsOnly: openEditorsOnly.checked,
			useExcludeSettings: useExcludeSettings.checked,
		});
		saveState();
	}

	function clearResults() {
		for (const k in results) delete results[k];
		fileOrder.length = 0;
		for (const k in expandedFiles) delete expandedFiles[k];
		for (const k in expandedGroups) delete expandedGroups[k];
		resultsSummary.textContent = '';
		resultsTree.innerHTML = '';
		progressSection.style.display = 'none';
		isSearching = false;
	}

	// ======== 搜索历史 ========

	function addToHistory(query) {
		if (!query.trim()) return;
		const idx = searchHistory.indexOf(query);
		if (idx !== -1) searchHistory.splice(idx, 1);
		searchHistory.unshift(query);
		if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
		historyIdx = -1;
		saveState();
	}

	// ======== 匹配行文本格式化 ========

	function formatMatchLine(text, hlStart, hlEnd) {
		const beforeCtx = 6;
		const afterCtx = 20;
		const leading = text.match(/^[ \t]*/);
		const trimLen = leading ? leading[0].length : 0;
		const clean = text.substring(trimLen);
		let s = hlStart - trimLen;
		let e = hlEnd - trimLen;
		let display = clean;
		if (s > beforeCtx) {
			const cutAt = s - beforeCtx;
			display = '…' + clean.substring(cutAt);
			s = beforeCtx + 1;
			e = s + (hlEnd - hlStart);
		}
		if (display.length - e > afterCtx) {
			display = display.substring(0, e + afterCtx) + '…';
		}
		return { text: display, start: s, end: e };
	}

	// ======== 消息处理 ========

	window.addEventListener('message', function (event) {
		const msg = event.data;
		switch (msg.type) {
			case 'searchStart':
				progressSection.style.display = 'flex';
				progressText.textContent = '正在搜索...';
				isSearching = true;
				break;
			case 'progress':
				progressText.textContent = '正在搜索 ' + msg.processed + '/' + msg.total + ' 个文件...';
				break;
			case 'result':
				addFileResult(msg.result);
				break;
			case 'searchDone':
				progressSection.style.display = 'none';
				isSearching = false;
				saveState();
				renderResults();
				break;
			case 'focus':
				if (msg.selectedText) {
					searchInput.value = msg.selectedText;
					clearTimeout(searchTimeout);
					doSearch();
				}
				searchInput.focus();
				searchInput.select();
				break;
		}
	});

	// ======== 结果管理 ========

	function addFileResult(fileMatch) {
		var uri = fileMatch.uri;
		if (results[uri]) {
			results[uri] = fileMatch;
		} else {
			results[uri] = fileMatch;
			fileOrder.push(uri);
			expandedFiles[uri] = true;
		}
		renderResults();
	}

	// ======== 辅助：是否需要显示工作区 ========

	function isMultiWorkspace() {
		var wfNames = {};
		for (var i = 0; i < fileOrder.length; i++) {
			var fm = results[fileOrder[i]];
			var wf = (fm && fm.workspaceFolder) || '';
			wfNames[wf] = true;
		}
		var keys = Object.keys(wfNames);
		return keys.length > 1;
	}

	// ======== 构建树结构 ========

	function buildTree() {
		var roots = {};
		for (var i = 0; i < fileOrder.length; i++) {
			var uri = fileOrder[i];
			var fm = results[uri];
			if (!fm) continue;
			var wf = fm.workspaceFolder || '';
			if (!roots[wf]) {
				roots[wf] = { type: 'workspace', name: wf, dirs: {}, files: [], matchCount: 0 };
			}
			roots[wf].matchCount += fm.matchCount;
			if (fm.parentDir) {
				var current = roots[wf];
				var parts = fm.parentDir.split('/').filter(function (p) { return p; });
				for (var j = 0; j < parts.length; j++) {
					var part = parts[j];
					if (!current.dirs[part]) {
						current.dirs[part] = { type: 'dir', name: part, dirs: {}, files: [], matchCount: 0, dirPath: parts.slice(0, j + 1).join('/') };
					}
					current = current.dirs[part];
					current.matchCount += fm.matchCount;
				}
				current.files.push(fm);
			} else {
				roots[wf].files.push(fm);
			}
		}
		return roots;
	}

	// ======== 整体渲染 ========

	function renderResults() {
		resultsTree.innerHTML = '';
		if (fileOrder.length === 0) {
			resultsSummary.textContent = '';
			return;
		}

		var totalMatches = fileOrder.reduce(function (sum, uri) {
			return sum + (results[uri] ? results[uri].matchCount : 0);
		}, 0);
		resultsSummary.innerHTML = '';

		var summaryText = document.createElement('span');
		summaryText.textContent = fileOrder.length + ' 个文件 ' + totalMatches + ' 处匹配';
		resultsSummary.appendChild(summaryText);

		// 折叠/展开全部 — 从当前 DOM 状态计算
		renderFoldAllBtn();

		// 列表/树状切换
		renderModeSwitch();

		if (viewMode === 'tree') {
			renderTreeMode();
		} else {
			renderListMode();
		}
	}

	function renderFoldAllBtn() {
		var allExpanded = fileOrder.every(function (uri) { return expandedFiles[uri] !== false; });
		var btn = document.createElement('a');
		btn.className = 'toggle-all-btn';
		btn.textContent = allExpanded ? '折叠全部' : '展开全部';
		btn.href = '#';
		btn.onclick = function (e) {
			e.preventDefault();
			// 从 files 的当前展开状态决定折叠还是展开
			var curAllExpanded = fileOrder.every(function (uri) { return expandedFiles[uri] !== false; });
			var expand = !curAllExpanded;
			for (var i = 0; i < fileOrder.length; i++) {
				expandedFiles[fileOrder[i]] = expand;
			}
			renderResults();
		};
		resultsSummary.appendChild(btn);
	}

	function renderModeSwitch() {
		var sw = document.createElement('span');
		sw.className = 'mode-switch';
		['list', 'tree'].forEach(function (mode) {
			var btn = document.createElement('a');
			btn.className = 'mode-btn' + (viewMode === mode ? ' active' : '');
			btn.textContent = mode === 'list' ? '列表' : '树状';
			btn.href = '#';
			btn.onclick = function (e) {
				e.preventDefault();
				if (viewMode === mode) return;
				viewMode = mode;
				for (var k in expandedGroups) delete expandedGroups[k];
				renderResults();
			};
			sw.appendChild(btn);
		});
		resultsSummary.appendChild(sw);
	}

	// ======== 列表模式 ========

	function renderListMode() {
		var showWf = isMultiWorkspace();

		var grouped = {};
		for (var i = 0; i < fileOrder.length; i++) {
			var uri = fileOrder[i];
			var fm = results[uri];
			var wf = fm ? fm.workspaceFolder || '' : '';
			if (!grouped[wf]) grouped[wf] = [];
			grouped[wf].push(uri);
		}
		var wfNames = Object.keys(grouped).sort();

		wfNames.forEach(function(wfName) {
			var uris = grouped[wfName];

			if (showWf) {
				var wfKey = 'wf_:list:' + wfName;
				var groupExpanded = expandedGroups[wfKey] !== false;
				var wfMatchCount = uris.reduce(function (s, u) { return s + (results[u] ? results[u].matchCount : 0); }, 0);

				var wfHeader = document.createElement('div');
				wfHeader.className = 'group-header';
				wfHeader.onclick = function () {
					expandedGroups[wfKey] = !expandedGroups[wfKey];
					renderResults();
				};

				var wfArrow = document.createElement('span');
				wfArrow.className = 'arrow' + (groupExpanded ? ' expanded' : '');
				wfArrow.textContent = '▶';

				var wfIcon = document.createElement('span');
				wfIcon.className = 'node-icon';
				wfIcon.textContent = '📁';

				var wfNameEl = document.createElement('span');
				wfNameEl.className = 'group-name';
				wfNameEl.textContent = (wfName || '工作区') + '  (' + uris.length + ' 文件 ' + wfMatchCount + ' 匹配)';

				wfHeader.appendChild(wfArrow);
				wfHeader.appendChild(wfIcon);
				wfHeader.appendChild(wfNameEl);
				resultsTree.appendChild(wfHeader);

				if (!groupExpanded) return;
			}

			for (var fi = 0; fi < uris.length; fi++) {
				renderFileNode(uris[fi]);
			}
		});
	}

	// ======== 树状模式 ========

	function renderTreeMode() {
		var roots = buildTree();
		var wfNames = Object.keys(roots).sort();
		var showWf = wfNames.length > 1;

		for (var wi = 0; wi < wfNames.length; wi++) {
			var root = roots[wfNames[wi]];
			if (showWf) {
				// 多工作区：将工作区文件夹作为顶层节点
				renderTreeNode(root, 0, 'wf:tree:' + wfNames[wi]);
			} else {
				// 单工作区：跳过工作区节点，直接渲染子目录和文件
				var subNames = Object.keys(root.dirs).sort();
				for (var di = 0; di < subNames.length; di++) {
					renderTreeNode(root.dirs[subNames[di]], 0, 'tree:' + subNames[di]);
				}
				for (var fi = 0; fi < root.files.length; fi++) {
					renderFileNode(root.files[fi].uri);
				}
			}
		}
	}

	function renderTreeNode(node, depth, groupKey) {
		var isWorkspace = node.type === 'workspace';
		var nodeExpanded = expandedGroups[groupKey] !== false;
		var fileCount = countFilesInNode(node);

		// 节点头部
		var nodeHeader = document.createElement('div');
		nodeHeader.className = 'tree-node-header';
		nodeHeader.style.paddingLeft = (depth * 16 + 4) + 'px';
		nodeHeader.onclick = function () {
			expandedGroups[groupKey] = !expandedGroups[groupKey];
			renderResults();
		};

		var arrow = document.createElement('span');
		arrow.className = 'arrow' + (nodeExpanded ? ' expanded' : '');
		arrow.textContent = '▶';

		var nameEl = document.createElement('span');

		if (isWorkspace) {
			nameEl.className = 'group-name';
			nameEl.textContent = node.name;

			var wfIcon = document.createElement('span');
			wfIcon.className = 'node-icon';
			wfIcon.textContent = '📁';

			var wfCountEl = document.createElement('span');
			wfCountEl.className = 'match-count';
			wfCountEl.textContent = '(' + fileCount + ' 文件 ' + node.matchCount + ' 匹配)';

			nodeHeader.appendChild(arrow);
			nodeHeader.appendChild(wfIcon);
			nodeHeader.appendChild(nameEl);
			nodeHeader.appendChild(wfCountEl);
		} else {
			nameEl.className = 'dir-name';
			nameEl.textContent = node.name;

			var dirCountEl = document.createElement('span');
			dirCountEl.className = 'match-count';
			dirCountEl.textContent = String(node.matchCount);

			nodeHeader.appendChild(arrow);
			nodeHeader.appendChild(nameEl);
			nodeHeader.appendChild(dirCountEl);
		}

		resultsTree.appendChild(nodeHeader);

		if (nodeExpanded) {
			var subNames = Object.keys(node.dirs).sort();
			for (var i = 0; i < subNames.length; i++) {
				renderTreeNode(node.dirs[subNames[i]], depth + 1, groupKey + '/' + subNames[i]);
			}
			for (var i = 0; i < node.files.length; i++) {
				renderFileNode(node.files[i].uri, depth + 1);
			}
		}
	}

	function countFilesInNode(node) {
		var count = node.files.length;
		var subs = Object.keys(node.dirs);
		for (var i = 0; i < subs.length; i++) {
			count += countFilesInNode(node.dirs[subs[i]]);
		}
		return count;
	}

	// ======== 渲染文件节点 ========

	function renderFileNode(uri, depth) {
		var fileMatch = results[uri];
		if (!fileMatch) return;
		var fileExpanded = expandedFiles[uri] !== false;
		var indent = (depth || 0) * 16 + 4;

		var fileDiv = document.createElement('div');
		fileDiv.className = 'file-item';

		var fileHeader = document.createElement('div');
		fileHeader.className = 'file-header';
		fileHeader.style.paddingLeft = (viewMode === 'tree' ? indent : 4) + 'px';
		fileHeader.onclick = function () {
			expandedFiles[uri] = !expandedFiles[uri];
			renderResults();
		};

		var arrow = document.createElement('span');
		arrow.className = 'arrow' + (fileExpanded ? ' expanded' : '');
		arrow.textContent = '▶';

		var nameEl = document.createElement('span');
		nameEl.className = 'file-name';
		nameEl.textContent = fileMatch.fileName;

		var countEl = document.createElement('span');
		countEl.className = 'match-count';
		countEl.textContent = String(fileMatch.matchCount);

		var pathEl = document.createElement('span');
		pathEl.className = 'file-path';
		pathEl.textContent = viewMode === 'tree' ? '' : fileMatch.parentDir;

		fileHeader.appendChild(arrow);
		fileHeader.appendChild(nameEl);
		fileHeader.appendChild(countEl);
		fileHeader.appendChild(pathEl);
		fileDiv.appendChild(fileHeader);

		if (fileExpanded) {
			var matchesDiv = document.createElement('div');
			matchesDiv.className = 'matches-container';
			matchesDiv.style.paddingLeft = (indent + 0) + 'px';

			var maxDisplay = 50;
			var displayMatches = fileMatch.matches.slice(0, maxDisplay);
			for (var mi = 0; mi < displayMatches.length; mi++) {
				var match = displayMatches[mi];
				var matchRow = document.createElement('div');
				matchRow.className = 'match-row';
				matchRow.onclick = function (m) {
					return function () {
						vscode.postMessage({ type: 'open', uri: fileMatch.uri, line: m.lineNumber, column: m.highlight[0] });
					};
				}(match);

				var lineNum = document.createElement('span');
				lineNum.className = 'line-number';
				lineNum.textContent = String(match.lineNumber);

				var lineText = document.createElement('span');
				lineText.className = 'line-text';
				var fmt = formatMatchLine(match.text, match.highlight[0], match.highlight[1]);
				if (fmt.start > 0) lineText.appendChild(document.createTextNode(fmt.text.substring(0, fmt.start)));
				var hl = document.createElement('span');
				hl.className = 'highlight';
				hl.textContent = fmt.text.substring(fmt.start, fmt.end + 1);
				lineText.appendChild(hl);
				if (fmt.end + 1 < fmt.text.length) lineText.appendChild(document.createTextNode(fmt.text.substring(fmt.end + 1)));

				matchRow.appendChild(lineNum);
				matchRow.appendChild(lineText);
				matchesDiv.appendChild(matchRow);
			}
			if (fileMatch.matches.length > maxDisplay) {
				var more = document.createElement('div');
				more.className = 'more-matches';
				more.textContent = '…还有 ' + (fileMatch.matches.length - maxDisplay) + ' 处匹配';
				matchesDiv.appendChild(more);
			}
			fileDiv.appendChild(matchesDiv);
		}
		resultsTree.appendChild(fileDiv);
	}

	// ======== 键盘事件 ========

	searchInput.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { clearTimeout(searchTimeout); doSearch(); return; }
		if (e.key === 'ArrowUp') {
			if (searchHistory.length === 0) return;
			e.preventDefault();
			if (historyIdx === -1) historyIdx = 0;
			else if (historyIdx < searchHistory.length - 1) historyIdx++;
			searchInput.value = searchHistory[historyIdx];
			return;
		}
		if (e.key === 'ArrowDown') {
			if (historyIdx < 0) return;
			e.preventDefault();
			historyIdx--;
			if (historyIdx === -1) searchInput.value = '';
			else searchInput.value = searchHistory[historyIdx];
			return;
		}
	});

	// ======== 输入事件 ========

	searchInput.addEventListener('input', scheduleSearch);
	includeInput.addEventListener('change', scheduleSearch);
	excludeInput.addEventListener('change', scheduleSearch);
	openEditorsOnly.addEventListener('change', scheduleSearch);
	useExcludeSettings.addEventListener('change', scheduleSearch);

	// ======== 状态持久化 ========

	function saveState() {
		var state = {
			query: searchInput.value,
			include: includeInput.value,
			exclude: excludeInput.value,
			openEditorsOnly: openEditorsOnly.checked,
			useExcludeSettings: useExcludeSettings.checked,
			searchHistory: searchHistory,
			viewMode: viewMode,
		};
		if (fileOrder.length > 0) {
			state.savedResults = {
				fileOrder: fileOrder.slice(),
				results: JSON.parse(JSON.stringify(results)),
				expandedFiles: Object.assign({}, expandedFiles),
				expandedGroups: Object.assign({}, expandedGroups),
			};
		}
		vscode.setState(state);
	}

	function restoreState() {
		isRestoring = true;
		var state = vscode.getState();
		if (state) {
			searchInput.value = state.query || '';
			includeInput.value = state.include || '';
			excludeInput.value = state.exclude || '';
			searchHistory = state.searchHistory || [];
			viewMode = state.viewMode || 'list';
			openEditorsOnly.checked = state.openEditorsOnly || false;
			useExcludeSettings.checked = state.useExcludeSettings !== false;
			if (state.savedResults && state.savedResults.fileOrder && state.savedResults.results) {
				var saved = state.savedResults;
				for (var k in results) delete results[k];
				fileOrder.length = 0;
				for (var k in expandedFiles) delete expandedFiles[k];
				for (var k in expandedGroups) delete expandedGroups[k];
				for (var i = 0; i < saved.fileOrder.length; i++) {
					var uri = saved.fileOrder[i];
					if (saved.results[uri]) { results[uri] = saved.results[uri]; fileOrder.push(uri); }
				}
				if (saved.expandedFiles) Object.assign(expandedFiles, saved.expandedFiles);
				if (saved.expandedGroups) Object.assign(expandedGroups, saved.expandedGroups);
				renderResults();
			}
		}
		progressSection.style.display = 'none';
		isRestoring = false;
	}

	restoreState();
})();
