require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

require(['vs/editor/editor.main'], function () {
    // =========================================================================
    // 0. TOAST NOTIFICATION & UI HELPERS
    // =========================================================================
    function showToast(message, type = 'info', duration = 2600) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '✨';
        toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            toast.style.transition = 'all 0.2s ease';
            setTimeout(() => toast.remove(), 220);
        }, duration);
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // =========================================================================
    // 1. DIFF EDITOR & ADVANCED INTERACTIVE MERGE ENGINE (View 1)
    // =========================================================================
    const diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor'), {
        theme: 'vs-dark',
        originalEditable: true,
        automaticLayout: false,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        glyphMargin: true,
        codeLens: true
    });

    const originalModel = monaco.editor.createModel("", "sql");
    const modifiedModel = monaco.editor.createModel("", "sql");

    diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel
    });

    const origEditor = diffEditor.getOriginalEditor();
    const modEditor = diffEditor.getModifiedEditor();
    origEditor.updateOptions({ codeLens: true, glyphMargin: true });
    modEditor.updateOptions({ codeLens: true, glyphMargin: true });

    diffEditor.layout();

    let originalDecorations = [];
    let modifiedDecorations = [];
    let currentLineChanges = [];
    let currentDiffIndex = -1;

    const diffCountBadge = document.getElementById('diff-count-badge');
    const diffPrevBtn = document.getElementById('diff-prev-btn');
    const diffNextBtn = document.getElementById('diff-next-btn');

    // Simple Emitter to refresh CodeLens whenever diff hunks update
    const codeLensListeners = [];
    const diffCodeLensEmitter = {
        event(listener) {
            codeLensListeners.push(listener);
            return {
                dispose() {
                    const idx = codeLensListeners.indexOf(listener);
                    if (idx >= 0) codeLensListeners.splice(idx, 1);
                }
            };
        },
        fire() {
            codeLensListeners.forEach(fn => fn());
        }
    };

    // Helper: Get lines array from a model given start..end (1-indexed, inclusive)
    function getModelLines(model, startLine, endLine) {
        if (endLine <= 0 || startLine <= 0 || endLine < startLine) return [];
        return model.getLinesContent().slice(startLine - 1, endLine);
    }

    // Helper: Apply a range replacement, pure insertion, or pure deletion with Undo Stops
    function applyModelPatch(targetModel, targetEditor, targetStartLine, targetEndLine, hasSourceLines, sourceText) {
        const lineCount = targetModel.getLineCount();
        let editOp = null;

        if (targetEndLine > 0) {
            // Target has existing lines [targetStartLine..targetEndLine]
            if (hasSourceLines) {
                // Replace existing target lines with sourceText
                editOp = {
                    range: new monaco.Range(
                        targetStartLine, 1,
                        targetEndLine, targetModel.getLineMaxColumn(targetEndLine)
                    ),
                    text: sourceText
                };
            } else {
                // Pure Deletion of target lines [targetStartLine..targetEndLine]
                if (targetEndLine < lineCount) {
                    editOp = {
                        range: new monaco.Range(targetStartLine, 1, targetEndLine + 1, 1),
                        text: ''
                    };
                } else if (targetStartLine > 1) {
                    editOp = {
                        range: new monaco.Range(
                            targetStartLine - 1, targetModel.getLineMaxColumn(targetStartLine - 1),
                            targetEndLine, targetModel.getLineMaxColumn(targetEndLine)
                        ),
                        text: ''
                    };
                } else {
                    editOp = {
                        range: new monaco.Range(1, 1, targetEndLine, targetModel.getLineMaxColumn(targetEndLine)),
                        text: ''
                    };
                }
            }
        } else {
            // Target has NO lines in this hunk (targetEndLine === 0) -> Pure Insertion into Target
            if (!hasSourceLines) return;
            const isTargetEmpty = lineCount === 1 && targetModel.getLineContent(1) === '';
            if (isTargetEmpty) {
                editOp = {
                    range: new monaco.Range(1, 1, 1, 1),
                    text: sourceText
                };
            } else if (targetStartLine <= 0) {
                // Insert at the very top before line 1
                editOp = {
                    range: new monaco.Range(1, 1, 1, 1),
                    text: sourceText + '\n'
                };
            } else {
                // Insert after targetStartLine
                const safeAnchor = Math.min(targetStartLine, lineCount);
                const maxCol = targetModel.getLineMaxColumn(safeAnchor);
                editOp = {
                    range: new monaco.Range(safeAnchor, maxCol, safeAnchor, maxCol),
                    text: '\n' + sourceText
                };
            }
        }

        if (editOp) {
            targetEditor.pushUndoStop();
            targetModel.pushEditOperations([], [editOp], () => null);
            targetEditor.pushUndoStop();
        }
    }

    /**
     * Core 3-Way Hunk Transfer & Merge Engine
     * @param {number} hunkIndex Index into currentLineChanges
     * @param {'push-right'|'pull-left'|'merge-to-right'|'merge-to-left'} action
     */
    function applyHunkAction(hunkIndex, action) {
        if (!currentLineChanges || currentLineChanges.length === 0) {
            showToast('No diff hunks available to merge', 'info');
            return;
        }
        const idx = (hunkIndex >= 0 && hunkIndex < currentLineChanges.length)
            ? hunkIndex
            : (currentDiffIndex >= 0 ? currentDiffIndex : 0);

        const change = currentLineChanges[idx];
        if (!change) return;

        const origHasLines = change.originalEndLineNumber > 0;
        const modHasLines = change.modifiedEndLineNumber > 0;

        const origLines = getModelLines(originalModel, change.originalStartLineNumber, change.originalEndLineNumber);
        const modLines = getModelLines(modifiedModel, change.modifiedStartLineNumber, change.modifiedEndLineNumber);

        const origText = origLines.join('\n');
        const modText = modLines.join('\n');

        if (action === 'push-right') {
            // Move Left (Original) -> Right (Modified)
            applyModelPatch(
                modifiedModel,
                modEditor,
                change.modifiedStartLineNumber,
                change.modifiedEndLineNumber,
                origHasLines,
                origText
            );
            showToast(`Pushed Hunk #${idx + 1} Left → Right`, 'success');
        } else if (action === 'pull-left') {
            // Move Right (Modified) -> Left (Original)
            applyModelPatch(
                originalModel,
                origEditor,
                change.originalStartLineNumber,
                change.originalEndLineNumber,
                modHasLines,
                modText
            );
            showToast(`← Pulled Hunk #${idx + 1} Right → Left`, 'success');
        } else if (action === 'merge-to-right') {
            // Combine both Left & Right blocks in Right (Modified)
            let combinedText = '';
            if (origHasLines && modHasLines) combinedText = origText + '\n' + modText;
            else if (origHasLines) combinedText = origText;
            else if (modHasLines) combinedText = modText;

            applyModelPatch(
                modifiedModel,
                modEditor,
                change.modifiedStartLineNumber,
                change.modifiedEndLineNumber,
                origHasLines || modHasLines,
                combinedText
            );
            showToast(`⇄ Merged Both into Right (Hunk #${idx + 1})`, 'success');
        } else if (action === 'merge-to-left') {
            // Combine both Left & Right blocks in Left (Original)
            let combinedText = '';
            if (origHasLines && modHasLines) combinedText = origText + '\n' + modText;
            else if (origHasLines) combinedText = origText;
            else if (modHasLines) combinedText = modText;

            applyModelPatch(
                originalModel,
                origEditor,
                change.originalStartLineNumber,
                change.originalEndLineNumber,
                origHasLines || modHasLines,
                combinedText
            );
            showToast(`⇄ Merged Both into Left (Hunk #${idx + 1})`, 'success');
        }
    }

    // Register Monaco Commands for Inline CodeLens Clicks
    const cmdPushRightId = origEditor.addCommand(0, (_, hunkIdx) => applyHunkAction(hunkIdx, 'push-right'));
    const cmdPullLeftId = modEditor.addCommand(0, (_, hunkIdx) => applyHunkAction(hunkIdx, 'pull-left'));
    const cmdMergeRightId = origEditor.addCommand(0, (_, hunkIdx) => applyHunkAction(hunkIdx, 'merge-to-right'));
    const cmdMergeLeftId = modEditor.addCommand(0, (_, hunkIdx) => applyHunkAction(hunkIdx, 'merge-to-left'));

    // Placement Mode Toggle: 'inline' (default) | 'middle' | 'both'
    let mergeUiMode = 'inline';
    const mergeUiModeSelect = document.getElementById('diff-merge-ui-mode');
    const hunkMergeToolbar = document.getElementById('hunk-merge-toolbar');
    if (hunkMergeToolbar) {
        hunkMergeToolbar.style.display = 'none';
    }

    if (mergeUiModeSelect) {
        mergeUiModeSelect.addEventListener('change', (e) => {
            mergeUiMode = e.target.value;
            if (hunkMergeToolbar) {
                hunkMergeToolbar.style.display = (mergeUiMode === 'inline') ? 'none' : 'flex';
            }
            const showCodeLens = (mergeUiMode === 'both' || mergeUiMode === 'inline');
            origEditor.updateOptions({ codeLens: showCodeLens });
            modEditor.updateOptions({ codeLens: showCodeLens });
            diffCodeLensEmitter.fire();
            showToast(
                mergeUiMode === 'both' ? 'Showing Both Middle (< = >) and In-Code Merge Badges'
                    : mergeUiMode === 'middle' ? 'Showing Middle (< = >) Merge Buttons Only'
                        : 'Showing In-Code Merge Badges Only',
                'info'
            );
        });
    }

    // Register Universal CodeLens Provider for Inline Merge Actions
    monaco.languages.registerCodeLensProvider('*', {
        onDidChange: diffCodeLensEmitter.event,
        provideCodeLenses: function (model) {
            if (mergeUiMode === 'middle') {
                return { lenses: [], dispose: () => {} };
            }
            if (model !== originalModel && model !== modifiedModel) {
                return { lenses: [], dispose: () => {} };
            }
            const isOrig = model === originalModel;
            const lenses = [];

            currentLineChanges.forEach((change, idx) => {
                const origHasLines = change.originalEndLineNumber > 0;
                const modHasLines = change.modifiedEndLineNumber > 0;
                const hunkNum = idx + 1;

                if (isOrig) {
                    const line = Math.min(
                        Math.max(1, change.originalStartLineNumber || 1),
                        Math.max(1, model.getLineCount())
                    );
                    const range = new monaco.Range(line, 1, line, 1);

                    const pushLabel = origHasLines
                        ? `Push to Right #${hunkNum}  >`
                        : `Delete from Right #${hunkNum}  >`;

                    lenses.push({
                        range,
                        command: {
                            id: cmdPushRightId,
                            title: pushLabel,
                            arguments: [idx]
                        }
                    });

                    if (origHasLines && modHasLines) {
                        lenses.push({
                            range,
                            command: {
                                id: cmdMergeRightId,
                                title: `=  Merge Both`,
                                arguments: [idx]
                            }
                        });
                    }
                } else {
                    const line = Math.min(
                        Math.max(1, change.modifiedStartLineNumber || 1),
                        Math.max(1, model.getLineCount())
                    );
                    const range = new monaco.Range(line, 1, line, 1);

                    const pullLabel = modHasLines
                        ? `<  Pull to Left #${hunkNum}`
                        : `<  Delete from Left #${hunkNum}`;

                    lenses.push({
                        range,
                        command: {
                            id: cmdPullLeftId,
                            title: pullLabel,
                            arguments: [idx]
                        }
                    });

                    if (origHasLines && modHasLines) {
                        lenses.push({
                            range,
                            command: {
                                id: cmdMergeLeftId,
                                title: `=  Merge Both`,
                                arguments: [idx]
                            }
                        });
                    }
                }
            });

            return { lenses, dispose: () => {} };
        }
    });

    const updateDiffState = () => {
        const changes = diffEditor.getLineChanges() || [];
        currentLineChanges = changes;

        if (changes.length === 0) {
            currentDiffIndex = -1;
        } else if (currentDiffIndex < 0 || currentDiffIndex >= changes.length) {
            currentDiffIndex = 0;
        }

        if (diffCountBadge) {
            const count = changes.length;
            if (count === 0) {
                diffCountBadge.innerText = '0 diffs';
                diffCountBadge.className = 'diff-badge no-diff';
            } else {
                diffCountBadge.innerText = `Diff ${currentDiffIndex + 1} of ${count}`;
                diffCountBadge.className = 'diff-badge has-diff';
            }
        }

        const newOriginalDecorations = [];
        const newModifiedDecorations = [];

        changes.forEach((change, idx) => {
            const isCurrent = idx === currentDiffIndex;
            const origLine = Math.min(Math.max(1, change.originalStartLineNumber || 1), Math.max(1, originalModel.getLineCount()));
            const modLine = Math.min(Math.max(1, change.modifiedStartLineNumber || 1), Math.max(1, modifiedModel.getLineCount()));
            const origEnd = change.originalEndLineNumber > 0 ? change.originalEndLineNumber : origLine;
            const modEnd = change.modifiedEndLineNumber > 0 ? change.modifiedEndLineNumber : modLine;

            // Glyph Margin Arrow on Original Side
            newOriginalDecorations.push({
                range: new monaco.Range(origLine, 1, origLine, 1),
                options: {
                    glyphMarginClassName: 'diff-arrow-right',
                    glyphMarginHoverMessage: { value: `Push Hunk #${idx + 1} to Right (Modified) >` }
                }
            });

            // Glyph Margin Arrow on Modified Side
            newModifiedDecorations.push({
                range: new monaco.Range(modLine, 1, modLine, 1),
                options: {
                    glyphMarginClassName: 'diff-arrow-left',
                    glyphMarginHoverMessage: { value: `< Pull Hunk #${idx + 1} to Left (Original)` }
                }
            });

            // Top Separator Border on first line of every diff hunk to separate CodeLens from code
            newOriginalDecorations.push({
                range: new monaco.Range(origLine, 1, origLine, 1),
                options: { isWholeLine: true, className: 'diff-hunk-top-border' }
            });
            newModifiedDecorations.push({
                range: new monaco.Range(modLine, 1, modLine, 1),
                options: { isWholeLine: true, className: 'diff-hunk-top-border' }
            });

            // Highlight active hunk border
            if (isCurrent) {
                newOriginalDecorations.push({
                    range: new monaco.Range(origLine, 1, origEnd, 1),
                    options: { isWholeLine: true, className: 'active-diff-hunk-line' }
                });
                newModifiedDecorations.push({
                    range: new monaco.Range(modLine, 1, modEnd, 1),
                    options: { isWholeLine: true, className: 'active-diff-hunk-line' }
                });
            }
        });

        originalDecorations = originalModel.deltaDecorations(originalDecorations, newOriginalDecorations);
        modifiedDecorations = modifiedModel.deltaDecorations(modifiedDecorations, newModifiedDecorations);
        diffCodeLensEmitter.fire();
    };

    const navigateDiff = (direction) => {
        if (!currentLineChanges || currentLineChanges.length === 0) {
            showToast('No differences found between panes', 'info');
            return;
        }

        if (direction === 'next') {
            currentDiffIndex = (currentDiffIndex + 1) % currentLineChanges.length;
        } else if (direction === 'prev') {
            currentDiffIndex = (currentDiffIndex - 1 + currentLineChanges.length) % currentLineChanges.length;
        }

        updateDiffState();

        const change = currentLineChanges[currentDiffIndex];
        if (change) {
            const modLine = change.modifiedStartLineNumber > 0 ? change.modifiedStartLineNumber : 1;
            const origLine = change.originalStartLineNumber > 0 ? change.originalStartLineNumber : 1;

            modEditor.revealLineInCenter(modLine);
            origEditor.revealLineInCenter(origLine);
        }
    };

    if (diffPrevBtn) diffPrevBtn.addEventListener('click', () => navigateDiff('prev'));
    if (diffNextBtn) diffNextBtn.addEventListener('click', () => navigateDiff('next'));

    // Auto-select hunk when user clicks inside either editor
    const syncActiveHunkFromCursor = (lineNumber, isOrig) => {
        if (!currentLineChanges || currentLineChanges.length === 0) return;
        const foundIdx = currentLineChanges.findIndex(c => {
            if (isOrig) {
                const start = Math.max(1, c.originalStartLineNumber || 1);
                const end = c.originalEndLineNumber > 0 ? c.originalEndLineNumber : start;
                return lineNumber >= start && lineNumber <= end;
            } else {
                const start = Math.max(1, c.modifiedStartLineNumber || 1);
                const end = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber : start;
                return lineNumber >= start && lineNumber <= end;
            }
        });
        if (foundIdx !== -1 && foundIdx !== currentDiffIndex) {
            currentDiffIndex = foundIdx;
            updateDiffState();
        }
    };

    origEditor.onDidChangeCursorPosition(e => syncActiveHunkFromCursor(e.position.lineNumber, true));
    modEditor.onDidChangeCursorPosition(e => syncActiveHunkFromCursor(e.position.lineNumber, false));

    diffEditor.onDidUpdateDiff(() => {
        updateDiffState();
    });

    // Glyph Margin Clicks (Now uses the full 3-way applyHunkAction engine!)
    origEditor.onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position.lineNumber;
            const hunkIdx = currentLineChanges.findIndex(c => {
                const start = Math.max(1, c.originalStartLineNumber || 1);
                const end = c.originalEndLineNumber > 0 ? c.originalEndLineNumber : start;
                return lineNumber >= start && lineNumber <= end;
            });
            if (hunkIdx !== -1) {
                currentDiffIndex = hunkIdx;
                applyHunkAction(hunkIdx, 'push-right');
            }
        }
    });

    modEditor.onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position.lineNumber;
            const hunkIdx = currentLineChanges.findIndex(c => {
                const start = Math.max(1, c.modifiedStartLineNumber || 1);
                const end = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber : start;
                return lineNumber >= start && lineNumber <= end;
            });
            if (hunkIdx !== -1) {
                currentDiffIndex = hunkIdx;
                applyHunkAction(hunkIdx, 'pull-left');
            }
        }
    });

    // Center Active Hunk Merge Toolbar Buttons
    document.getElementById('hunk-push-right-btn')?.addEventListener('click', () => {
        applyHunkAction(currentDiffIndex, 'push-right');
    });
    document.getElementById('hunk-pull-left-btn')?.addEventListener('click', () => {
        applyHunkAction(currentDiffIndex, 'pull-left');
    });
    document.getElementById('hunk-merge-both-btn')?.addEventListener('click', () => {
        applyHunkAction(currentDiffIndex, 'merge-to-right');
    });

    // Per-Pane Undo / Copy Controls
    document.getElementById('undo-original-btn')?.addEventListener('click', () => {
        origEditor.trigger('toolbar', 'undo', null);
        showToast('Undid last change in Original pane', 'info');
    });
    document.getElementById('copy-original-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(originalModel.getValue()).then(() => {
            showToast('Copied Original code to clipboard!', 'success');
        });
    });

    document.getElementById('undo-modified-btn')?.addEventListener('click', () => {
        modEditor.trigger('toolbar', 'undo', null);
        showToast('Undid last change in Modified pane', 'info');
    });
    document.getElementById('copy-modified-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(modifiedModel.getValue()).then(() => {
            showToast('Copied Modified code to clipboard!', 'success');
        });
    });

    // Diff Controls
    const diffLangSelector = document.getElementById('diff-language-selector');
    diffLangSelector.addEventListener('change', (e) => {
        const newLang = e.target.value;
        monaco.editor.setModelLanguage(originalModel, newLang);
        monaco.editor.setModelLanguage(modifiedModel, newLang);
    });

    document.getElementById('diff-swap-btn')?.addEventListener('click', () => {
        const orig = originalModel.getValue();
        const mod = modifiedModel.getValue();
        originalModel.setValue(mod);
        modifiedModel.setValue(orig);
        showToast('Swapped Original and Modified panes', 'info');
    });

    document.getElementById('diff-clear-btn')?.addEventListener('click', () => {
        originalModel.setValue("");
        modifiedModel.setValue("");
        const origLabel = document.getElementById('original-pane-label');
        const modLabel = document.getElementById('modified-pane-label');
        if (origLabel) origLabel.innerText = "Original";
        if (modLabel) modLabel.innerText = "Modified";
        showToast('Cleared both diff editors', 'info');
    });

    const diffToggleInlineBtn = document.getElementById('diff-toggle-inline');
    let isSideBySide = true;
    diffToggleInlineBtn?.addEventListener('click', () => {
        isSideBySide = !isSideBySide;
        diffEditor.updateOptions({ renderSideBySide: isSideBySide });
        diffToggleInlineBtn.classList.toggle('active', !isSideBySide);
        diffToggleInlineBtn.title = isSideBySide ? "Toggle Split / Unified View" : "Unified View Active (Click for Split View)";
        showToast(isSideBySide ? 'Switched to Side-by-Side Diff' : 'Switched to Inline Unified Diff', 'info');
    });

    const diffToggleWhitespaceBtn = document.getElementById('diff-toggle-whitespace');
    let ignoreWhitespace = false;
    diffToggleWhitespaceBtn?.addEventListener('click', () => {
        ignoreWhitespace = !ignoreWhitespace;
        diffEditor.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace });
        diffToggleWhitespaceBtn.classList.toggle('active', ignoreWhitespace);
        showToast(ignoreWhitespace ? 'Ignoring whitespace differences' : 'Showing all whitespace differences', 'info');
    });

    // Sample Diff Button
    document.getElementById('diff-sample-btn')?.addEventListener('click', () => {
        diffLangSelector.value = 'sql';
        monaco.editor.setModelLanguage(originalModel, 'sql');
        monaco.editor.setModelLanguage(modifiedModel, 'sql');

        originalModel.setValue(`CREATE PROCEDURE dbo.usp_GetCustomerOrders
    @CustomerId INT,
    @StartDate DATETIME
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        o.OrderID,
        o.OrderDate,
        c.CustomerName,
        o.TotalAmount,
        o.Status
    FROM dbo.Orders o
    INNER JOIN dbo.Customers c ON o.CustomerID = c.CustomerID
    WHERE o.CustomerID = @CustomerId
      AND o.OrderDate >= @StartDate
    ORDER BY o.OrderDate DESC;
END;`);

        modifiedModel.setValue(`CREATE OR ALTER PROCEDURE dbo.usp_GetCustomerOrders
    @CustomerId INT,
    @StartDate DATE,
    @IncludeCancelled BIT = 0
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        o.OrderID,
        CAST(o.OrderDate AS DATE) AS OrderDate,
        c.CustomerName,
        c.EmailAddress,
        o.TotalAmount,
        ISNULL(o.DiscountAmount, 0.00) AS DiscountAmount,
        o.Status
    FROM dbo.Orders o WITH (NOLOCK)
    INNER JOIN dbo.Customers c WITH (NOLOCK) ON o.CustomerID = c.CustomerID
    WHERE o.CustomerID = @CustomerId
      AND o.OrderDate >= @StartDate
      AND (@IncludeCancelled = 1 OR o.Status <> 'Cancelled')
    ORDER BY o.OrderDate DESC, o.OrderID DESC;
END;`);
        showToast('Loaded sample T-SQL stored procedure diff', 'success');
    });

    // Diff Pane File Uploads
    const detectLanguageFromExtension = (filename) => {
        const ext = filename.split('.').pop().toLowerCase();
        const langMap = {
            'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript',
            'ts': 'typescript', 'tsx': 'typescript',
            'html': 'html', 'htm': 'html',
            'css': 'css', 'scss': 'css', 'less': 'css',
            'json': 'json', 'py': 'python', 'java': 'java',
            'cpp': 'cpp', 'c': 'cpp', 'h': 'cpp', 'hpp': 'cpp',
            'cs': 'csharp', 'sql': 'sql', 'xml': 'xml', 'svg': 'xml',
            'md': 'markdown', 'markdown': 'markdown', 'txt': 'plaintext'
        };
        return langMap[ext] || null;
    };

    const loadFileIntoModel = (file, model, labelElement, defaultLabel) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            model.setValue(e.target.result);
            if (labelElement) {
                labelElement.innerText = `${defaultLabel}: ${file.name}`;
                labelElement.title = file.name;
            }
            const detectedLang = detectLanguageFromExtension(file.name);
            if (detectedLang) {
                diffLangSelector.value = detectedLang;
                monaco.editor.setModelLanguage(originalModel, detectedLang);
                monaco.editor.setModelLanguage(modifiedModel, detectedLang);
            }
            showToast(`Loaded ${file.name} into ${defaultLabel}`, 'success');
        };
        reader.readAsText(file);
    };

    const uploadOriginalBtn = document.getElementById('upload-original-btn');
    const originalFileInput = document.getElementById('original-file-input');
    const originalPaneLabel = document.getElementById('original-pane-label');
    if (uploadOriginalBtn && originalFileInput) {
        uploadOriginalBtn.addEventListener('click', () => originalFileInput.click());
        originalFileInput.addEventListener('change', (e) => {
            if (e.target.files.length) loadFileIntoModel(e.target.files[0], originalModel, originalPaneLabel, 'Original');
        });
    }

    const uploadModifiedBtn = document.getElementById('upload-modified-btn');
    const modifiedFileInput = document.getElementById('modified-file-input');
    const modifiedPaneLabel = document.getElementById('modified-pane-label');
    if (uploadModifiedBtn && modifiedFileInput) {
        uploadModifiedBtn.addEventListener('click', () => modifiedFileInput.click());
        modifiedFileInput.addEventListener('change', (e) => {
            if (e.target.files.length) loadFileIntoModel(e.target.files[0], modifiedModel, modifiedPaneLabel, 'Modified');
        });
    }

    // =========================================================================
    // 2. CODE FORMATTER & UNESCAPER (View 2 - JSON, SQL, XML)
    // =========================================================================
    const formatInputEditor = monaco.editor.create(document.getElementById('format-input'), {
        value: "",
        language: "json",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    const formatOutputEditor = monaco.editor.create(document.getElementById('format-output'), {
        value: "",
        language: "json",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: true,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    const formatLangSelector = document.getElementById('format-language-selector');
    const formatStatusPill = document.getElementById('format-status-pill');

    function setFormatStatus(text, isValid = true) {
        if (!formatStatusPill) return;
        formatStatusPill.innerText = text;
        formatStatusPill.className = `status-pill ${isValid ? 'valid' : 'invalid'}`;
    }

    // Lightweight T-SQL Formatter
    function formatSql(sql) {
        if (!sql || !sql.trim()) return '';
        let str = sql.replace(/\s+/g, ' ').trim();

        const majorKeywords = [
            'SELECT', 'FROM', 'INNER JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN',
            'FULL OUTER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'JOIN',
            'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'UNION ALL', 'UNION',
            'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
            'CREATE OR ALTER PROCEDURE', 'CREATE PROCEDURE', 'CREATE TABLE',
            'DECLARE', 'BEGIN', 'END', 'GO'
        ];

        majorKeywords.forEach(kw => {
            const regex = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
            str = str.replace(regex, `\n${kw.toUpperCase()}`);
        });

        // Indent AND / OR / ON
        str = str.replace(/\b(AND|OR)\b/gi, '\n  $1');
        str = str.replace(/,\s*/g, ',\n    ');

        return str.trim();
    }

    function formatXml(xml) {
        let formatted = '';
        const reg = /(>)(<)(\/*)/g;
        xml = xml.replace(reg, '$1\r\n$2$3');
        let pad = 0;
        xml.split('\r\n').forEach((node) => {
            let indent = 0;
            if (node.match(/.+<\/\w[^>]*>$/)) {
                indent = 0;
            } else if (node.match(/^<\/\w/)) {
                if (pad !== 0) pad -= 1;
            } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
                indent = 1;
            } else {
                indent = 0;
            }
            const padding = '  '.repeat(pad);
            formatted += padding + node + '\r\n';
            pad += indent;
        });
        return formatted.trim();
    }

    const performFormat = (minify = false) => {
        const lang = formatLangSelector.value;
        const value = formatInputEditor.getValue();
        if (!value.trim()) {
            formatOutputEditor.setValue("");
            setFormatStatus("Ready", true);
            return;
        }

        try {
            let result = value;
            if (lang === 'json') {
                const parsed = JSON.parse(value);
                result = JSON.stringify(parsed, null, minify ? 0 : 4);
                setFormatStatus(minify ? "Minified JSON" : "Valid JSON", true);
            } else if (lang === 'xml') {
                result = minify ? value.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim() : formatXml(value);
                setFormatStatus(minify ? "Minified XML" : "Formatted XML", true);
            } else if (lang === 'sql') {
                result = minify ? value.replace(/\s+/g, ' ').trim() : formatSql(value);
                setFormatStatus(minify ? "Minified SQL" : "Formatted SQL", true);
            }
            formatOutputEditor.setValue(result);
        } catch (e) {
            formatOutputEditor.setValue(`Error parsing ${lang.toUpperCase()}:\n${e.message}`);
            setFormatStatus(`Invalid ${lang.toUpperCase()}`, false);
        }
    };

    formatInputEditor.onDidChangeModelContent(() => performFormat(false));

    formatLangSelector.addEventListener('change', (e) => {
        const newLang = e.target.value;
        monaco.editor.setModelLanguage(formatInputEditor.getModel(), newLang);
        monaco.editor.setModelLanguage(formatOutputEditor.getModel(), newLang);
        performFormat(false);
    });

    document.getElementById('format-btn').addEventListener('click', () => {
        performFormat(false);
        showToast('Prettified code', 'success');
    });

    document.getElementById('minify-btn')?.addEventListener('click', () => {
        performFormat(true);
        showToast('Minified output into single line', 'success');
    });

    document.getElementById('unescape-btn').addEventListener('click', () => {
        const value = formatInputEditor.getValue().trim();
        if (!value) return;

        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === 'string') {
                formatInputEditor.setValue(parsed);
                showToast('Unescaped stringified payload!', 'success');
            } else {
                // Also support unescaping raw escaped quotes like \"key\": \"val\"
                const manualUnescaped = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                formatInputEditor.setValue(manualUnescaped);
                performFormat(false);
                showToast('Formatted payload', 'info');
            }
        } catch (e) {
            // Try stripping surrounding quotes and unescaping
            try {
                const rawUnescaped = value.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
                formatInputEditor.setValue(rawUnescaped);
                showToast('Unescaped raw string literals', 'success');
            } catch (err) {
                formatOutputEditor.setValue(`Error unescaping: ${e.message}`);
                setFormatStatus("Unescape Error", false);
            }
        }
    });

    document.getElementById('escape-btn')?.addEventListener('click', () => {
        const value = formatOutputEditor.getValue() || formatInputEditor.getValue();
        if (!value.trim()) return;
        const escaped = JSON.stringify(value);
        formatOutputEditor.setValue(escaped);
        setFormatStatus("Escaped String", true);
        showToast('Converted to escaped string literal', 'success');
    });

    document.getElementById('format-clear-btn')?.addEventListener('click', () => {
        formatInputEditor.setValue('');
        formatOutputEditor.setValue('');
        setFormatStatus('Ready', true);
    });

    document.getElementById('format-sample-btn')?.addEventListener('click', () => {
        const lang = formatLangSelector.value;
        if (lang === 'json') {
            formatInputEditor.setValue(`{"apiVersion":"2.1","database":"SQLServer_Prod","connectionPool":{"maxConnections":50,"idleTimeoutMs":30000,"encrypt":true},"tables":[{"name":"dbo.Transactions","rowCount":145200,"indexedColumns":["TransactionID","CustomerID","CreatedAt"]}]}`);
        } else if (lang === 'sql') {
            formatInputEditor.setValue(`select u.UserID, u.UserName, u.Email, r.RoleName, count(o.OrderID) as TotalOrders from dbo.Users u inner join dbo.UserRoles ur on u.UserID = ur.UserID inner join dbo.Roles r on ur.RoleID = r.RoleID left join dbo.Orders o on u.UserID = o.UserID where u.IsActive = 1 and o.OrderDate >= '2025-01-01' group by u.UserID, u.UserName, u.Email, r.RoleName having count(o.OrderID) > 5 order by TotalOrders desc`);
        } else {
            formatInputEditor.setValue(`<Configuration><Database provider="SqlServer"><ConnectionString>Server=tcp:prod-db.database.windows.net,1433;Database=CoreDB;</ConnectionString><CommandTimeout>60</CommandTimeout></Database><Logging level="Information"><Target type="Console"/><Target type="File" path="/logs/app.log"/></Logging></Configuration>`);
        }
        showToast(`Loaded sample ${lang.toUpperCase()}`, 'success');
    });

    // Formatter file upload
    const formatUploadBtn = document.getElementById('format-upload-btn');
    const formatFileInput = document.getElementById('format-file-input');
    if (formatUploadBtn && formatFileInput) {
        formatUploadBtn.addEventListener('click', () => formatFileInput.click());
        formatFileInput.addEventListener('change', (e) => {
            if (!e.target.files.length) return;
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                const ext = file.name.split('.').pop().toLowerCase();
                if (['json', 'sql', 'xml'].includes(ext)) {
                    formatLangSelector.value = ext;
                    monaco.editor.setModelLanguage(formatInputEditor.getModel(), ext);
                    monaco.editor.setModelLanguage(formatOutputEditor.getModel(), ext);
                }
                formatInputEditor.setValue(ev.target.result);
                showToast(`Loaded ${file.name}`, 'success');
            };
            reader.readAsText(file);
        });
    }

    document.getElementById('copy-btn').addEventListener('click', () => {
        const value = formatOutputEditor.getValue();
        if (!value || value.startsWith("Error parsing")) {
            showToast('Nothing valid to copy', 'error');
            return;
        }
        navigator.clipboard.writeText(value).then(() => {
            showToast('Formatted output copied to clipboard!', 'success');
        });
    });

    document.getElementById('download-btn').addEventListener('click', () => {
        const value = formatOutputEditor.getValue();
        if (!value) return;
        const lang = formatLangSelector.value;
        const blob = new Blob([value], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `formatted.${lang}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast(`Downloaded formatted.${lang}`, 'success');
    });

    // =========================================================================
    // 3. DATA VALIDATION & SQL SCHEMA INFERENCE ENGINE
    // =========================================================================
    const SqlSchemaInferrer = {
        isNullOrEmpty(val) {
            return val === null || val === undefined || (typeof val === 'string' && val.trim() === '');
        },

        DATE_PATTERNS: [
            /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
            /^\d{4}\/\d{1,2}\/\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/,
            /^\d{1,2}\/\d{1,2}\/\d{4}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/,
            /^\d{4}\.\d{1,2}\.\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/,
            /^\d{1,2}\.\d{1,2}\.\d{4}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/,
            /^\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s]\d{2,4}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?$/i,
            /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s]\d{1,2},?[-\s]\d{2,4}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?$/i
        ],

        GUID_PATTERN: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,

        validateCell(val) {
            if (this.isNullOrEmpty(val)) {
                return { type: 'NULL', val: null };
            }

            if (typeof val === 'boolean' || val === 'true' || val === 'false' || val === 'TRUE' || val === 'FALSE') {
                return { type: 'BIT', val: val === true || String(val).toLowerCase() === 'true' };
            }

            if (typeof val === 'number') {
                if (Number.isInteger(val)) {
                    if (val >= -2147483648 && val <= 2147483647) {
                        return { type: 'INT', val };
                    } else {
                        return { type: 'BIGINT', val };
                    }
                } else if (!isNaN(val)) {
                    const str = val.toString();
                    const parts = str.split('.');
                    const precision = (parts[0].replace('-', '').length) + (parts[1] ? parts[1].length : 0);
                    const scale = parts[1] ? parts[1].length : 0;
                    return { type: 'DECIMAL', precision, scale, val };
                }
            }

            if (val instanceof Date) {
                if (!isNaN(val.getTime())) {
                    const hasTime = val.getHours() !== 0 || val.getMinutes() !== 0 || val.getSeconds() !== 0 || val.getMilliseconds() !== 0;
                    return { type: 'DATE_TIME', hasTime, val };
                }
            }

            const strVal = String(val).trim();

            if (/^0\d+$/.test(strVal)) {
                return { type: 'STRING', length: strVal.length, val: strVal };
            }

            if (/^[+-]?\d+$/.test(strVal)) {
                const num = Number(strVal);
                if (num >= -2147483648 && num <= 2147483647 && strVal.length <= 10) {
                    return { type: 'INT', val: num };
                } else {
                    return { type: 'BIGINT', val: strVal };
                }
            }

            if (/^[+-]?\d+\.\d+$/.test(strVal)) {
                const parts = strVal.replace(/^[+-]/, '').split('.');
                const precision = parts[0].length + parts[1].length;
                const scale = parts[1].length;
                return { type: 'DECIMAL', precision, scale, val: Number(strVal) };
            }

            const matchesDatePattern = this.DATE_PATTERNS.some(pat => pat.test(strVal));
            if (matchesDatePattern) {
                const parsedMs = Date.parse(strVal);
                if (!isNaN(parsedMs)) {
                    const d = new Date(parsedMs);
                    const year = d.getFullYear();
                    if (year >= 1753 && year <= 9999) {
                        const hasTime = strVal.includes(':') || d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
                        return { type: 'DATE_TIME', hasTime, val: d };
                    }
                }
            }

            if (this.GUID_PATTERN.test(strVal)) {
                return { type: 'GUID', val: strVal };
            }

            return { type: 'STRING', length: strVal.length, val: strVal };
        },

        inferColumns(headers, rows, scanLimit = null) {
            const limit = scanLimit ? Math.min(rows.length, scanLimit) : rows.length;

            return headers.map((header, c) => {
                let hasNull = false;
                let maxLen = 0;
                let maxPrecision = 0;
                let maxScale = 0;
                let anyTime = false;

                let canBeBit = true;
                let canBeInt = true;
                let canBeBigInt = true;
                let canBeDecimal = true;
                let canBeDateTime = true;
                let canBeGuid = true;
                let nonNullCount = 0;

                for (let r = 0; r < limit; r++) {
                    const rawVal = rows[r] ? rows[r][c] : null;
                    const res = this.validateCell(rawVal);

                    if (res.type === 'NULL') {
                        hasNull = true;
                        continue;
                    }

                    nonNullCount++;
                    const strLen = String(rawVal).length;
                    if (strLen > maxLen) maxLen = strLen;

                    switch (res.type) {
                        case 'BIT':
                            canBeInt = false; canBeBigInt = false; canBeDecimal = false; canBeDateTime = false; canBeGuid = false;
                            break;
                        case 'INT':
                            canBeBit = false; canBeDateTime = false; canBeGuid = false;
                            break;
                        case 'BIGINT':
                            canBeBit = false; canBeInt = false; canBeDateTime = false; canBeGuid = false;
                            break;
                        case 'DECIMAL':
                            canBeBit = false; canBeInt = false; canBeBigInt = false; canBeDateTime = false; canBeGuid = false;
                            if (res.scale > maxScale) maxScale = res.scale;
                            if (res.precision > maxPrecision) maxPrecision = res.precision;
                            break;
                        case 'DATE_TIME':
                            canBeBit = false; canBeInt = false; canBeBigInt = false; canBeDecimal = false; canBeGuid = false;
                            if (res.hasTime) anyTime = true;
                            break;
                        case 'GUID':
                            canBeBit = false; canBeInt = false; canBeBigInt = false; canBeDecimal = false; canBeDateTime = false;
                            break;
                        case 'STRING':
                            canBeBit = false; canBeInt = false; canBeBigInt = false; canBeDecimal = false; canBeDateTime = false; canBeGuid = false;
                            break;
                    }
                }

                let type = '';
                let isNullable = hasNull || nonNullCount === 0 || limit < rows.length;

                if (nonNullCount === 0) {
                    type = 'NVARCHAR(50)';
                } else if (canBeBit) {
                    type = 'BIT';
                } else if (canBeInt) {
                    type = 'INT';
                } else if (canBeBigInt) {
                    type = 'BIGINT';
                } else if (canBeDecimal) {
                    const finalScale = Math.min(Math.max(maxScale, 2), 4);
                    const finalPrecision = Math.max(maxPrecision, 18);
                    type = `DECIMAL(${Math.min(finalPrecision, 38)},${finalScale})`;
                } else if (canBeDateTime) {
                    type = anyTime ? 'DATETIME' : 'DATE';
                } else if (canBeGuid) {
                    type = 'UNIQUEIDENTIFIER';
                } else {
                    let finalLen = maxLen <= 50 ? 50 : maxLen <= 255 ? 255 : maxLen <= 4000 ? 4000 : 'MAX';
                    type = `NVARCHAR(${finalLen})`;
                }

                return {
                    header,
                    type,
                    isNullable,
                    maxLen,
                    nonNullCount
                };
            });
        },

        formatSqlValue(val, colType) {
            if (this.isNullOrEmpty(val)) return 'NULL';

            const typeUpper = colType.toUpperCase();

            if (typeUpper === 'BIT') {
                if (val === true || String(val).toLowerCase() === 'true' || val === 1 || val === '1') return '1';
                return '0';
            }

            if (typeUpper.startsWith('INT') || typeUpper.startsWith('BIGINT') || typeUpper.startsWith('DECIMAL') || typeUpper.startsWith('FLOAT')) {
                const numVal = Number(String(val).trim());
                return isNaN(numVal) ? `'${String(val).replace(/'/g, "''")}'` : String(val).trim();
            }

            if (typeUpper === 'DATETIME' || typeUpper === 'DATE') {
                if (val instanceof Date && !isNaN(val.getTime())) {
                    if (typeUpper === 'DATE') {
                        return `'${val.toISOString().slice(0, 10)}'`;
                    }
                    const iso = val.toISOString().slice(0, 19).replace('T', ' ');
                    return `'${iso}'`;
                }
                const ms = Date.parse(val);
                if (!isNaN(ms)) {
                    const d = new Date(ms);
                    if (typeUpper === 'DATE') {
                        return `'${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}'`;
                    }
                    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                    return `'${iso}'`;
                }
                return `'${String(val).replace(/'/g, "''")}'`;
            }

            if (typeUpper === 'UNIQUEIDENTIFIER') {
                return `'${String(val).trim()}'`;
            }

            return `N'${String(val).replace(/'/g, "''")}'`;
        },

        formatJsonPath(propName) {
            const str = String(propName);
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
                return `'$.${str}'`;
            }
            const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "''");
            return `'$."${escaped}"'`;
        },

        sanitizeHeader(header) {
            if (!header) return 'Column_x';
            let str = String(header).trim();
            str = str.replace(/[\.\s\-\/\\]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
            str = str.replace(/_+/g, '_');
            if (/^[0-9]/.test(str)) {
                str = 'Col_' + str;
            }
            return str || 'Column_x';
        }
    };
    window.SqlSchemaInferrer = SqlSchemaInferrer;

    // =========================================================================
    // 4. INTERACTIVE PREVIEW, COLUMN SELECTION & TYPE OVERRIDE ENGINE
    // =========================================================================
    let selectedColumnsSql = new Set();
    let selectedColumnsJson = new Set();
    let typeOverridesSql = {};  // { colIndex: 'NVARCHAR(255)' }
    let typeOverridesJson = {};

    const COMMON_SQL_TYPES = [
        'INT', 'BIGINT', 'DECIMAL(18,2)', 'DECIMAL(18,4)',
        'BIT', 'DATE', 'DATETIME', 'UNIQUEIDENTIFIER',
        'NVARCHAR(50)', 'NVARCHAR(255)', 'NVARCHAR(4000)', 'NVARCHAR(MAX)'
    ];

    function getTypePillClass(type) {
        const t = (type || '').toUpperCase();
        if (t.startsWith('INT') || t.startsWith('BIGINT')) return 'type-int';
        if (t.startsWith('DECIMAL') || t.startsWith('FLOAT')) return 'type-decimal';
        if (t.startsWith('DATE') || t.startsWith('DATETIME')) return 'type-date';
        if (t.startsWith('NVARCHAR') || t.startsWith('VARCHAR')) return 'type-text';
        return 'type-other';
    }

    function extractHeaders(data, hasHeader, sanitizeHeaders) {
        if (!data || data.length === 0) return [];
        let headers = [];
        if (hasHeader) {
            headers = data[0].map((h, i) => {
                if (!h) return `Column_${i + 1}`;
                const raw = h.toString().trim();
                return sanitizeHeaders ? SqlSchemaInferrer.sanitizeHeader(raw) : raw.replace(/\s+/g, '_');
            });
        } else {
            const colCount = data[0].length;
            for (let i = 0; i < colCount; i++) {
                headers.push(`Col${i + 1}`);
            }
        }
        const usedHeaders = new Set();
        return headers.map((h) => {
            let name = h;
            let counter = 1;
            while (usedHeaders.has(name.toLowerCase())) {
                name = `${h}_${counter++}`;
            }
            usedHeaders.add(name.toLowerCase());
            return name;
        });
    }

    function triggerAutoGenerate(viewType) {
        if (viewType === 'sql') {
            const autoCb = document.getElementById('sql-auto-regen');
            if (autoCb && autoCb.checked && loadedData) {
                runSqlGeneration();
            }
        } else if (viewType === 'json') {
            const autoCb = document.getElementById('json-auto-regen');
            if (autoCb && autoCb.checked && jsonLoadedData) {
                runJsonGeneration();
            }
        }
    }

    function renderDataPreview(viewType, data) {
        const isSql = viewType === 'sql';
        const section = document.getElementById(`${viewType}-preview-section`);
        const chipsContainer = document.getElementById(`${viewType}-columns-chips`);
        const table = document.getElementById(`${viewType}-preview-table`);
        const badge = document.getElementById(`${viewType}-column-count-badge`);
        const editor = isSql ? sqlOutputEditor : jsonOutputEditor;
        const typeOverrides = isSql ? typeOverridesSql : typeOverridesJson;

        if (!data || data.length === 0) {
            if (section) section.style.display = 'none';
            return;
        }

        const hasHeaderEl = document.getElementById(isSql ? 'header-row' : 'json-header-row');
        const hasHeader = hasHeaderEl ? hasHeaderEl.checked : true;
        const sanitizeCheckbox = document.getElementById(isSql ? 'sql-sanitize-headers' : 'json-sanitize-headers');
        const sanitizeHeaders = sanitizeCheckbox ? sanitizeCheckbox.checked : false;

        const headers = extractHeaders(data, hasHeader, sanitizeHeaders);
        const rows = hasHeader ? data.slice(1) : data;
        const inferredTypes = SqlSchemaInferrer.inferColumns(headers, rows);

        // Apply any user manual overrides
        const colTypes = inferredTypes.map((c, idx) => ({
            ...c,
            type: typeOverrides[idx] || c.type
        }));

        let selectedSet = isSql ? selectedColumnsSql : selectedColumnsJson;
        if (selectedSet.size === 0 || Math.max(...selectedSet) >= headers.length) {
            selectedSet.clear();
            for (let i = 0; i < headers.length; i++) {
                selectedSet.add(i);
            }
        }

        const updateSelectionUI = (shouldAutoGen = false) => {
            if (badge) {
                badge.innerText = `${selectedSet.size} of ${headers.length} selected`;
            }

            chipsContainer.querySelectorAll('.column-chip').forEach(chip => {
                const idx = parseInt(chip.getAttribute('data-col'), 10);
                const isSelected = selectedSet.has(idx);
                const cb = chip.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = isSelected;
                chip.classList.toggle('active', isSelected);
                chip.classList.toggle('inactive', !isSelected);
            });

            table.querySelectorAll('[data-col]').forEach(el => {
                const idx = parseInt(el.getAttribute('data-col'), 10);
                const isSelected = selectedSet.has(idx);
                el.classList.toggle('col-unselected', !isSelected);
                const cb = el.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = isSelected;
            });

            if (shouldAutoGen) {
                triggerAutoGenerate(viewType);
            }
        };

        // Helper to build Type Override Dropdown
        const buildTypeSelectHtml = (colIdx, currentType) => {
            const optionsSet = new Set([currentType, ...COMMON_SQL_TYPES]);
            const optsHtml = Array.from(optionsSet).map(t =>
                `<option value="${t}" ${t === currentType ? 'selected' : ''}>${t}</option>`
            ).join('');
            return `<select class="type-select-override ${getTypePillClass(currentType)}" data-type-col="${colIdx}" title="Click to override inferred SQL Data Type">${optsHtml}</select>`;
        };

        // Render Chips
        chipsContainer.innerHTML = '';
        headers.forEach((h, i) => {
            const colInfo = colTypes[i];
            const isSelected = selectedSet.has(i);
            const chip = document.createElement('div');
            chip.className = `column-chip ${isSelected ? 'active' : 'inactive'}`;
            chip.setAttribute('data-col', i);
            chip.setAttribute('data-col-name', h.toLowerCase());
            chip.innerHTML = `
                <input type="checkbox" ${isSelected ? 'checked' : ''}>
                <span>${escapeHtml(h)}</span>
                ${buildTypeSelectHtml(i, colInfo ? colInfo.type : 'NVARCHAR(50)')}
            `;

            chip.addEventListener('click', (e) => {
                if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
                if (e.target.tagName !== 'INPUT') {
                    const cb = chip.querySelector('input[type="checkbox"]');
                    if (cb) cb.checked = !cb.checked;
                }
                const isChecked = chip.querySelector('input[type="checkbox"]').checked;
                if (isChecked) selectedSet.add(i);
                else selectedSet.delete(i);
                updateSelectionUI(true);
            });

            const selectEl = chip.querySelector('select.type-select-override');
            if (selectEl) {
                selectEl.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const newType = e.target.value;
                    typeOverrides[i] = newType;
                    selectEl.className = `type-select-override ${getTypePillClass(newType)}`;
                    // Also sync table header pill if exists
                    const thPill = table.querySelector(`th[data-col="${i}"] .type-pill`);
                    if (thPill) {
                        thPill.innerText = newType;
                        thPill.className = `type-pill ${getTypePillClass(newType)}`;
                    }
                    triggerAutoGenerate(viewType);
                    showToast(`Set [${h}] type to ${newType}`, 'info');
                });
            }

            chipsContainer.appendChild(chip);
        });

        // Render Table
        table.innerHTML = '';
        const thead = document.createElement('thead');
        let thHtml = '<tr><th class="row-num-header">#</th>';
        headers.forEach((h, i) => {
            const colInfo = colTypes[i];
            const isSelected = selectedSet.has(i);
            thHtml += `
                <th class="${isSelected ? '' : 'col-unselected'}" data-col="${i}">
                    <div class="th-content">
                        <input type="checkbox" ${isSelected ? 'checked' : ''}>
                        <span>${escapeHtml(h)}</span>
                        <span class="type-pill ${getTypePillClass(colInfo ? colInfo.type : '')}">${colInfo ? colInfo.type : 'NVARCHAR'}</span>
                    </div>
                </th>
            `;
        });
        thHtml += '</tr>';
        thead.innerHTML = thHtml;

        thead.querySelectorAll('th[data-col]').forEach(th => {
            const cb = th.querySelector('input[type="checkbox"]');
            if (cb) {
                cb.addEventListener('change', () => {
                    const colIdx = parseInt(th.getAttribute('data-col'), 10);
                    if (cb.checked) selectedSet.add(colIdx);
                    else selectedSet.delete(colIdx);
                    updateSelectionUI(true);
                });
            }
        });

        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const previewRows = rows.slice(0, 8);
        previewRows.forEach((row, rIdx) => {
            const tr = document.createElement('tr');
            let trHtml = `<td class="row-num-cell">${rIdx + 1}</td>`;
            headers.forEach((_, cIdx) => {
                const isSelected = selectedSet.has(cIdx);
                const rawVal = row ? row[cIdx] : '';
                let displayVal = rawVal;
                if (rawVal instanceof Date) {
                    displayVal = rawVal.toISOString().slice(0, 19).replace('T', ' ');
                } else if (rawVal === null || rawVal === undefined) {
                    displayVal = 'NULL';
                }
                trHtml += `<td class="${isSelected ? '' : 'col-unselected'}" data-col="${cIdx}" title="${escapeHtml(displayVal)}">${escapeHtml(displayVal)}</td>`;
            });
            tr.innerHTML = trHtml;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        updateSelectionUI(false);

        // Search filter for columns
        const searchInput = document.getElementById(`${viewType}-col-search`);
        if (searchInput) {
            searchInput.oninput = (e) => {
                const q = e.target.value.toLowerCase().trim();
                chipsContainer.querySelectorAll('.column-chip').forEach(chip => {
                    const name = chip.getAttribute('data-col-name') || '';
                    chip.style.display = (!q || name.includes(q)) ? 'inline-flex' : 'none';
                });
            };
        }

        // Toolbar buttons
        const selectAllBtn = document.getElementById(`${viewType}-select-all-btn`);
        const deselectAllBtn = document.getElementById(`${viewType}-deselect-all-btn`);
        const resetTypesBtn = document.getElementById(`${viewType}-reset-types-btn`);
        const toggleBtn = document.getElementById(`${viewType}-toggle-preview-btn`);

        if (selectAllBtn) {
            selectAllBtn.onclick = () => {
                for (let i = 0; i < headers.length; i++) selectedSet.add(i);
                updateSelectionUI(true);
            };
        }

        if (deselectAllBtn) {
            deselectAllBtn.onclick = () => {
                selectedSet.clear();
                updateSelectionUI(true);
            };
        }

        if (resetTypesBtn) {
            resetTypesBtn.onclick = () => {
                if (isSql) typeOverridesSql = {};
                else typeOverridesJson = {};
                renderDataPreview(viewType, data);
                triggerAutoGenerate(viewType);
                showToast('Reset all column types to auto-inferred schema', 'info');
            };
        }

        if (toggleBtn && !toggleBtn.dataset.wired) {
            toggleBtn.dataset.wired = 'true';
            toggleBtn.addEventListener('click', () => {
                section.classList.toggle('preview-collapsed');
                const isCollapsed = section.classList.contains('preview-collapsed');
                section.dataset.userExpanded = isCollapsed ? '' : 'true';
                toggleBtn.innerText = isCollapsed ? 'Expand ▼' : 'Collapse ▲';
                setTimeout(() => {
                    if (editor) editor.layout();
                }, 50);
            });
        }

        // Expand by default so user immediately sees interactive columns & type overrides
        if (section.dataset.userExpanded === undefined || section.dataset.userExpanded === 'true') {
            section.classList.remove('preview-collapsed');
            if (toggleBtn) toggleBtn.innerText = 'Collapse ▲';
        }

        section.style.display = 'flex';
        setTimeout(() => {
            if (editor) editor.layout();
        }, 50);
    }

    // =========================================================================
    // 5. SHEET TO SQL GENERATOR (View 3)
    // =========================================================================
    const sqlOutputEditor = monaco.editor.create(document.getElementById('sql-output'), {
        value: "-- Upload an Excel/CSV sheet or click '⚡ Load Sample Sheet' to generate T-SQL",
        language: "sql",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: false,
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-upload');
    const generateBtn = document.getElementById('generate-sql-btn');
    const sheetSelector = document.getElementById('sheet-selector');
    const sheetContainer = document.getElementById('sheet-selection-container');

    let loadedData = null;
    let currentWorkbook = null;

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        const dropText = dropZone.querySelector('.drop-text p');
        dropText.innerText = `✅ Loaded: ${file.name}`;
        const sqlSec = document.getElementById('sql-preview-section');
        if (sqlSec) sqlSec.dataset.userExpanded = 'true';

        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array', cellDates: true });
            currentWorkbook = workbook;

            sheetSelector.innerHTML = '';
            if (workbook.SheetNames.length > 1) {
                sheetContainer.style.display = 'flex';
                workbook.SheetNames.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.innerText = name;
                    sheetSelector.appendChild(option);
                });
            } else {
                sheetContainer.style.display = 'none';
            }

            loadSheetData(workbook.SheetNames[0]);
            showToast(`Loaded ${file.name} (${loadedData.length} rows)`, 'success');
        };
        reader.readAsArrayBuffer(file);
    }

    sheetSelector.addEventListener('change', (e) => {
        if (currentWorkbook) {
            loadSheetData(e.target.value);
            showToast(`Switched to sheet: ${e.target.value}`, 'info');
        }
    });

    function loadSheetData(sheetName) {
        if (!currentWorkbook) return;
        const worksheet = currentWorkbook.Sheets[sheetName];
        loadedData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
        selectedColumnsSql.clear();
        typeOverridesSql = {};
        renderDataPreview('sql', loadedData);
        triggerAutoGenerate('sql');
    }

    // Load Sample Sheet for SQL Generator
    document.getElementById('sql-sample-btn')?.addEventListener('click', () => {
        loadedData = [
            ["EmployeeID", "Full.Name", "Department", "HireDate", "AnnualSalary", "IsActive", "EmployeeGUID", "ZipCode"],
            [1001, "Aarav Sharma", "Platform Engineering", "2022-03-15", 115000.50, true, "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d", "07030"],
            [1002, "Maya Thapa", "Data Science & AI", "2023-07-01", 128500.00, true, "b2c3d4e5-f6a7-4b5c-9d0e-1f2a3b4c5d6e", "02138"],
            [1003, "Liam O'Connor", "Security Operations", "2021-11-20", 108250.75, false, "c3d4e5f6-a7b8-4c5d-0e1f-2a3b4c5d6e7f", "94107"],
            [1004, "Sophia Chen", "Database Architecture", "2020-01-10", 142000.00, true, "d4e5f6a7-b8c9-4d5e-1f2a-3b4c5d6e7f8a", "10001"],
            [1005, "Noah Patel", "Cloud Infrastructure", "2024-02-28", 98500.25, true, "e5f6a7b8-c9d0-4e5f-2a3b-4c5d6e7f8a9b", "08540"]
        ];
        const dropText = dropZone.querySelector('.drop-text p');
        if (dropText) dropText.innerText = `⚡ Loaded Sample: Employees_Directory.xlsx (5 rows)`;
        selectedColumnsSql.clear();
        typeOverridesSql = {};
        const sqlSec = document.getElementById('sql-preview-section');
        if (sqlSec) sqlSec.dataset.userExpanded = 'true';
        renderDataPreview('sql', loadedData);
        runSqlGeneration();
        showToast('Loaded sample Employee dataset & generated SQL!', 'success');
    });

    ['header-row', 'sql-sanitize-headers', 'sql-include-drop', 'table-name'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
                if (loadedData) {
                    if (id === 'header-row' || id === 'sql-sanitize-headers') {
                        renderDataPreview('sql', loadedData);
                    }
                    triggerAutoGenerate('sql');
                }
            });
        }
    });

    function runSqlGeneration() {
        if (!loadedData || loadedData.length === 0) {
            sqlOutputEditor.setValue("-- No data loaded. Please upload a file or click '⚡ Load Sample Sheet'.");
            return;
        }
        const tableName = document.getElementById('table-name').value || "#TempTable";
        const hasHeader = document.getElementById('header-row').checked;
        const sanitizeHeaders = document.getElementById('sql-sanitize-headers')?.checked || false;
        const includeDrop = document.getElementById('sql-include-drop')?.checked ?? true;

        try {
            const sql = generateSQL(loadedData, tableName, hasHeader, sanitizeHeaders, includeDrop);
            sqlOutputEditor.setValue(sql);
        } catch (err) {
            sqlOutputEditor.setValue(`-- Error generating SQL:\n-- ${err.message}`);
        }
    }

    generateBtn.addEventListener('click', () => {
        runSqlGeneration();
        if (loadedData) showToast('Generated T-SQL Script!', 'success');
    });

    function generateSQL(data, tableName, hasHeader, sanitizeHeaders = false, includeDrop = true) {
        if (data.length === 0) return "-- Empty data";

        let allHeaders = extractHeaders(data, hasHeader, sanitizeHeaders);
        let allRows = hasHeader ? data.slice(1) : data;

        if (allRows.length === 0) return `-- No data rows found in ${tableName}`;
        if (selectedColumnsSql.size === 0) {
            return `-- No columns selected. Please select at least one column from the preview above.`;
        }

        const selectedIndices = Array.from(selectedColumnsSql).sort((a, b) => a - b).filter(i => i < allHeaders.length);
        const headers = selectedIndices.map(i => allHeaders[i]);
        const rows = allRows.map(row => selectedIndices.map(i => (row ? row[i] : null)));

        const inferred = SqlSchemaInferrer.inferColumns(headers, rows);
        const colTypes = inferred.map((c, idx) => {
            const origColIdx = selectedIndices[idx];
            return {
                ...c,
                type: typeOverridesSql[origColIdx] || c.type
            };
        });

        let script = `-- =============================================\n`;
        script += `-- Table: ${tableName}\n`;
        script += `-- Total Rows: ${rows.length}\n`;
        script += `-- Validated Schema (${headers.length} selected columns):\n`;
        colTypes.forEach(c => {
            script += `--   [${c.header}] -> ${c.type} (${c.nonNullCount} non-null values)\n`;
        });
        script += `-- =============================================\n\n`;

        if (includeDrop) {
            if (tableName.startsWith('#')) {
                script += `IF OBJECT_ID('tempdb..${tableName}') IS NOT NULL DROP TABLE ${tableName};\n\n`;
            } else {
                script += `IF OBJECT_ID('${tableName}', 'U') IS NOT NULL DROP TABLE ${tableName};\n\n`;
            }
        }

        script += `CREATE TABLE ${tableName} (\n`;
        script += colTypes.map(c => `    [${c.header}] ${c.type}${c.isNullable ? ' NULL' : ' NOT NULL'}`).join(',\n');
        script += `\n);\n\n`;

        const BATCH_SIZE = 1000;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            script += `INSERT INTO ${tableName} (${headers.map(h => `[${h}]`).join(', ')}) VALUES \n`;

            const rowStrings = batch.map(row => {
                const vals = headers.map((_, colIndex) => {
                    const rawVal = row[colIndex];
                    return SqlSchemaInferrer.formatSqlValue(rawVal, colTypes[colIndex].type);
                });
                return `(${vals.join(', ')})`;
            });

            script += rowStrings.join(',\n');
            script += `;\n\n`;
        }

        script += `-- Verify inserted rows (${rows.length} total):\n`;
        script += `SELECT * FROM ${tableName};\n`;

        return script;
    }

    document.getElementById('sql-copy-btn').addEventListener('click', () => {
        const value = sqlOutputEditor.getValue();
        navigator.clipboard.writeText(value).then(() => showToast('SQL script copied to clipboard!', 'success'));
    });

    document.getElementById('sql-download-btn').addEventListener('click', () => {
        const value = sqlOutputEditor.getValue();
        const blob = new Blob([value], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'insert_script.sql';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast('Downloaded insert_script.sql', 'success');
    });

    // =========================================================================
    // 6. SHEET TO JSON & SSMS OPENJSON SCRIPT (View 4)
    // =========================================================================
    const jsonOutputEditor = monaco.editor.create(document.getElementById('json-output'), {
        value: "-- Upload a sheet or click '⚡ Load Sample Sheet' to generate JSON or SSMS OPENJSON script",
        language: "sql",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: false,
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    const jsonDropZone = document.getElementById('json-drop-zone');
    const jsonFileInput = document.getElementById('json-file-upload');
    const jsonGenerateBtn = document.getElementById('generate-json-script-btn');
    const jsonSheetSelector = document.getElementById('json-sheet-selector');
    const jsonSheetContainer = document.getElementById('json-sheet-selection-container');

    let jsonLoadedData = null;
    let jsonCurrentWorkbook = null;

    jsonDropZone.addEventListener('click', () => jsonFileInput.click());
    jsonDropZone.addEventListener('dragover', (e) => { e.preventDefault(); jsonDropZone.classList.add('drag-over'); });
    jsonDropZone.addEventListener('dragleave', () => jsonDropZone.classList.remove('drag-over'));
    jsonDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        jsonDropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleJsonFile(e.dataTransfer.files[0]);
    });
    jsonFileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleJsonFile(e.target.files[0]);
    });

    function handleJsonFile(file) {
        const dropText = jsonDropZone.querySelector('.drop-text p');
        dropText.innerText = `✅ Loaded: ${file.name}`;
        const jsonSec = document.getElementById('json-preview-section');
        if (jsonSec) jsonSec.dataset.userExpanded = 'true';

        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array', cellDates: true });
            jsonCurrentWorkbook = workbook;

            jsonSheetSelector.innerHTML = '';
            if (workbook.SheetNames.length > 1) {
                jsonSheetContainer.style.display = 'flex';
                workbook.SheetNames.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name;
                    option.innerText = name;
                    jsonSheetSelector.appendChild(option);
                });
            } else {
                jsonSheetContainer.style.display = 'none';
            }

            loadJsonSheetData(workbook.SheetNames[0]);
            showToast(`Loaded ${file.name} for JSON/OPENJSON`, 'success');
        };
        reader.readAsArrayBuffer(file);
    }

    jsonSheetSelector.addEventListener('change', (e) => {
        if (jsonCurrentWorkbook) {
            loadJsonSheetData(e.target.value);
            showToast(`Switched to sheet: ${e.target.value}`, 'info');
        }
    });

    function loadJsonSheetData(sheetName) {
        if (!jsonCurrentWorkbook) return;
        const worksheet = jsonCurrentWorkbook.Sheets[sheetName];
        jsonLoadedData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
        selectedColumnsJson.clear();
        typeOverridesJson = {};
        renderDataPreview('json', jsonLoadedData);
        triggerAutoGenerate('json');
    }

    // Sample Sheet for JSON / SSMS OPENJSON
    document.getElementById('json-sample-btn')?.addEventListener('click', () => {
        jsonLoadedData = [
            ["Order.ID", "Customer.Email", "OrderDate", "Order.Total", "IsPriority", "Tracking.Code"],
            [5001, "alex.rivera@example.com", "2025-02-10", 249.99, true, "0094812"],
            [5002, "priya.nair@example.com", "2025-02-11", 1049.50, true, "0094813"],
            [5003, "marcus.vance@example.com", "2025-02-12", 84.00, false, "0094814"],
            [5004, "elena.rostova@example.com", "2025-02-14", 530.75, true, "0094815"]
        ];
        const dropText = jsonDropZone.querySelector('.drop-text p');
        if (dropText) dropText.innerText = `⚡ Loaded Sample: ECommerce_Orders.xlsx (4 rows with dot headers)`;
        selectedColumnsJson.clear();
        typeOverridesJson = {};
        const jsonSec = document.getElementById('json-preview-section');
        if (jsonSec) jsonSec.dataset.userExpanded = 'true';
        renderDataPreview('json', jsonLoadedData);
        runJsonGeneration();
        showToast('Loaded sample Orders sheet & generated SSMS OPENJSON!', 'success');
    });

    ['json-header-row', 'json-sanitize-headers', 'json-output-mode', 'json-prettify', 'json-table-name'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
                if (jsonLoadedData) {
                    if (id === 'json-header-row' || id === 'json-sanitize-headers') {
                        renderDataPreview('json', jsonLoadedData);
                    }
                    triggerAutoGenerate('json');
                }
            });
        }
    });

    function runJsonGeneration() {
        if (!jsonLoadedData || jsonLoadedData.length === 0) {
            jsonOutputEditor.setValue("-- No data loaded. Please upload a file or click '⚡ Load Sample Sheet'.");
            return;
        }
        const tableName = document.getElementById('json-table-name').value || "#TempTable";
        const hasHeader = document.getElementById('json-header-row').checked;
        const sanitizeHeaders = document.getElementById('json-sanitize-headers')?.checked || false;
        const outputMode = document.getElementById('json-output-mode').value;
        const prettify = document.getElementById('json-prettify').checked;

        try {
            const script = generateJsonScript(jsonLoadedData, tableName, hasHeader, outputMode, prettify, sanitizeHeaders);
            jsonOutputEditor.setValue(script);
        } catch (err) {
            jsonOutputEditor.setValue(`-- Error generating script:\n-- ${err.message}`);
        }
    }

    jsonGenerateBtn.addEventListener('click', () => {
        runJsonGeneration();
        if (jsonLoadedData) showToast('Generated output script!', 'success');
    });

    function generateJsonScript(data, tableName, hasHeader, outputMode, prettify, sanitizeHeaders = false) {
        if (data.length === 0) return "-- Empty data";

        let allHeaders = extractHeaders(data, hasHeader, sanitizeHeaders);
        let allRows = hasHeader ? data.slice(1) : data;

        if (allRows.length === 0) return `-- No data rows found`;
        if (selectedColumnsJson.size === 0) {
            return `-- No columns selected. Please select at least one column from the preview above.`;
        }

        const selectedIndices = Array.from(selectedColumnsJson).sort((a, b) => a - b).filter(i => i < allHeaders.length);
        const headers = selectedIndices.map(i => allHeaders[i]);
        const rows = allRows.map(row => selectedIndices.map(i => (row ? row[i] : null)));

        const objects = rows.map(row => {
            let obj = {};
            headers.forEach((h, colIndex) => {
                let val = row[colIndex];
                if (val === undefined) val = null;
                obj[h] = val;
            });
            return obj;
        });

        if (outputMode === 'json-array') {
            monaco.editor.setModelLanguage(jsonOutputEditor.getModel(), 'json');
            return JSON.stringify(objects, null, prettify ? 2 : 0);
        }

        if (outputMode === 'mongo-insert') {
            monaco.editor.setModelLanguage(jsonOutputEditor.getModel(), 'javascript');
            const cleanTable = tableName.replace(/#/g, '');
            return `db.${cleanTable}.insertMany(\n${JSON.stringify(objects, null, prettify ? 2 : 0)}\n);`;
        }

        monaco.editor.setModelLanguage(jsonOutputEditor.getModel(), 'sql');

        const inferred = SqlSchemaInferrer.inferColumns(headers, rows);
        const colTypes = inferred.map((c, idx) => {
            const origColIdx = selectedIndices[idx];
            return {
                ...c,
                type: typeOverridesJson[origColIdx] || c.type
            };
        });

        const jsonPayload = JSON.stringify(objects, null, prettify ? 2 : 0);
        const sqlEscapedJson = jsonPayload.replace(/'/g, "''");

        let script = `-- =============================================\n`;
        script += `-- SSMS OPENJSON Insert Script for ${tableName}\n`;
        script += `-- Total Rows: ${rows.length}\n`;
        script += `-- Validated Schema (${headers.length} selected columns):\n`;
        colTypes.forEach(c => {
            script += `--   [${c.header}] -> ${c.type} (Path: ${SqlSchemaInferrer.formatJsonPath(c.header)})\n`;
        });
        script += `-- =============================================\n\n`;

        script += `DECLARE @json NVARCHAR(MAX) = N'${sqlEscapedJson}';\n\n`;
        script += `IF OBJECT_ID('tempdb..${tableName}') IS NOT NULL DROP TABLE ${tableName};\n\n`;
        script += `CREATE TABLE ${tableName} (\n`;
        script += colTypes.map(c => `    [${c.header}] ${c.type} NULL`).join(',\n');
        script += `\n);\n\n`;
        script += `INSERT INTO ${tableName} (\n    ${headers.map(h => `[${h}]`).join(', ')}\n)\n`;
        script += `SELECT \n    ${headers.map(h => `[${h}]`).join(',\n    ')}\n`;
        script += `FROM OPENJSON(@json)\nWITH (\n`;
        script += colTypes.map(c => `    [${c.header}] ${c.type} ${SqlSchemaInferrer.formatJsonPath(c.header)}`).join(',\n');
        script += `\n);\n\n`;
        script += `-- Verify inserted data:\n`;
        script += `SELECT * FROM ${tableName};\n`;

        return script;
    }

    document.getElementById('json-copy-btn').addEventListener('click', () => {
        const value = jsonOutputEditor.getValue();
        navigator.clipboard.writeText(value).then(() => showToast('Copied script to clipboard!', 'success'));
    });

    document.getElementById('json-download-btn').addEventListener('click', () => {
        const value = jsonOutputEditor.getValue();
        if (!value) return;
        const mode = document.getElementById('json-output-mode').value;
        const ext = mode === 'json-array' ? 'json' : mode === 'mongo-insert' ? 'js' : 'sql';
        const blob = new Blob([value], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `openjson_script.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast(`Downloaded openjson_script.${ext}`, 'success');
    });

    // =========================================================================
    // 7. DATA TO EXCEL CONVERTER + LIVE TABLE PREVIEW (View 5)
    // =========================================================================
    const excelInputEditor = monaco.editor.create(document.getElementById('excel-input'), {
        value: JSON.stringify([
            { "ID": 101, "FullName": "John Doe", "Department": "Engineering", "Salary": 85000, "Active": true },
            { "ID": 102, "FullName": "Jane Smith", "Department": "Marketing", "Salary": 78000, "Active": true },
            { "ID": 103, "FullName": "Carlos Mendez", "Department": "Database Admin", "Salary": 112000, "Active": false }
        ], null, 2),
        language: "json",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: false,
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    function parseExcelInputToWorksheet(rawText) {
        if (!rawText || !rawText.trim()) return null;
        let worksheet = null;
        let parsedData = null;

        try {
            parsedData = JSON.parse(rawText);
        } catch (jsonErr) {
            const csvWb = XLSX.read(rawText, { type: 'string' });
            const firstSheetName = csvWb.SheetNames[0];
            worksheet = csvWb.Sheets[firstSheetName];
        }

        if (!worksheet && parsedData) {
            if (Array.isArray(parsedData)) {
                worksheet = XLSX.utils.json_to_sheet(parsedData);
            } else if (typeof parsedData === 'object') {
                worksheet = XLSX.utils.json_to_sheet([parsedData]);
            }
        }
        return worksheet;
    }

    function updateExcelLivePreview() {
        const table = document.getElementById('excel-live-table');
        const badge = document.getElementById('excel-row-count-badge');
        if (!table) return;

        const value = excelInputEditor.getValue().trim();
        if (!value) {
            table.innerHTML = '<tbody><tr><td style="padding:16px; color:var(--text-secondary);">Paste JSON array or CSV on the left to preview rows...</td></tr></tbody>';
            if (badge) { badge.innerText = '0 rows'; badge.className = 'status-pill valid'; }
            return;
        }

        try {
            const ws = parseExcelInputToWorksheet(value);
            if (!ws) throw new Error('Unrecognized data format');
            const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (matrix.length === 0) {
                table.innerHTML = '';
                return;
            }
            const headers = matrix[0];
            const rows = matrix.slice(1);

            if (badge) {
                badge.innerText = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${headers.length} cols`;
                badge.className = 'status-pill valid';
            }

            let html = '<thead><tr><th class="row-num-header">#</th>';
            headers.forEach(h => {
                html += `<th>${escapeHtml(h)}</th>`;
            });
            html += '</tr></thead><tbody>';

            rows.slice(0, 100).forEach((r, idx) => {
                html += `<tr><td class="row-num-cell">${idx + 1}</td>`;
                headers.forEach((_, cIdx) => {
                    const cell = r[cIdx] !== undefined && r[cIdx] !== null ? r[cIdx] : '';
                    html += `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`;
                });
                html += '</tr>';
            });
            html += '</tbody>';
            table.innerHTML = html;
        } catch (err) {
            if (badge) {
                badge.innerText = 'Parse Error';
                badge.className = 'status-pill invalid';
            }
        }
    }

    updateExcelLivePreview();
    excelInputEditor.onDidChangeModelContent(() => {
        updateExcelLivePreview();
    });

    document.getElementById('excel-sample-btn')?.addEventListener('click', () => {
        excelInputEditor.setValue(JSON.stringify([
            { "ServerName": "SQL-PROD-01", "Database": "CustomerCore", "SizeGB": 428.5, "Status": "ONLINE", "LastBackup": "2025-02-20 03:00:00" },
            { "ServerName": "SQL-PROD-02", "Database": "AnalyticsDW", "SizeGB": 1840.0, "Status": "ONLINE", "LastBackup": "2025-02-20 01:30:00" },
            { "ServerName": "SQL-STG-01", "Database": "BillingStaging", "SizeGB": 64.2, "Status": "RESTORING", "LastBackup": "2025-02-19 22:00:00" },
            { "ServerName": "SQL-DEV-01", "Database": "SandboxDB", "SizeGB": 12.8, "Status": "ONLINE", "LastBackup": "2025-02-18 18:00:00" }
        ], null, 2));
        showToast('Loaded sample database inventory dataset', 'success');
    });

    const excelUploadBtn = document.getElementById('excel-upload-btn');
    const excelFileInput = document.getElementById('excel-file-input');
    if (excelUploadBtn && excelFileInput) {
        excelUploadBtn.addEventListener('click', () => excelFileInput.click());
        excelFileInput.addEventListener('change', (e) => {
            if (!e.target.files.length) return;
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                excelInputEditor.setValue(ev.target.result);
                showToast(`Loaded ${file.name}`, 'success');
            };
            reader.readAsText(file);
        });
    }

    document.getElementById('export-excel-btn').addEventListener('click', () => {
        const value = excelInputEditor.getValue().trim();
        if (!value) return;
        const fileName = document.getElementById('excel-file-name').value.trim() || 'data_export';
        const sheetName = document.getElementById('excel-sheet-name').value.trim() || 'Sheet1';

        try {
            const worksheet = parseExcelInputToWorksheet(value);
            if (!worksheet) throw new Error("Could not parse input data into an Excel sheet.");
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, worksheet, sheetName);
            XLSX.writeFile(wb, `${fileName}.xlsx`);
            showToast(`Exported ${fileName}.xlsx!`, 'success');
        } catch (err) {
            showToast(`Export error: ${err.message}`, 'error');
        }
    });

    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
        const value = excelInputEditor.getValue().trim();
        if (!value) return;
        const fileName = document.getElementById('excel-file-name').value.trim() || 'data_export';
        try {
            const worksheet = parseExcelInputToWorksheet(value);
            if (!worksheet) throw new Error("Could not parse input data.");
            const csvOutput = XLSX.utils.sheet_to_csv(worksheet);
            const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${fileName}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast(`Exported ${fileName}.csv!`, 'success');
        } catch (err) {
            showToast(`CSV export error: ${err.message}`, 'error');
        }
    });

    // =========================================================================
    // 8. HTML RENDERER & LIVE PREVIEW (View 6)
    // =========================================================================
    const defaultHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTML Preview</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 24px;
            background: #f8fafc;
            color: #1e293b;
        }
        .card {
            background: #ffffff;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
            max-width: 520px;
            margin: 0 auto;
            border: 1px solid #e2e8f0;
        }
        .badge {
            display: inline-block;
            background: #ede9fe;
            color: #6d28d9;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 8px;
        }
        .btn {
            background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
            color: white;
            border: none;
            padding: 10px 18px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <div class="card">
        <span class="badge">SQLDevTool Sandbox</span>
        <h2>⚡ Live HTML & UI Preview</h2>
        <p>Edit HTML, CSS, or JavaScript on the left to see instant updates in this sandboxed preview.</p>
        <button class="btn" onclick="alert('Hello from SQLDevTool HTML Renderer!')">Test Interaction</button>
    </div>
</body>
</html>`;

    const htmlInputEditor = monaco.editor.create(document.getElementById('html-input'), {
        value: defaultHtmlContent,
        language: "html",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: false,
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    const htmlPreviewFrame = document.getElementById('html-preview-frame');
    const htmlAutoUpdateCb = document.getElementById('html-auto-update');
    let renderTimeout = null;

    function renderHtmlPreview() {
        htmlPreviewFrame.srcdoc = htmlInputEditor.getValue();
    }

    renderHtmlPreview();

    htmlInputEditor.onDidChangeModelContent(() => {
        if (htmlAutoUpdateCb && htmlAutoUpdateCb.checked) {
            if (renderTimeout) clearTimeout(renderTimeout);
            renderTimeout = setTimeout(renderHtmlPreview, 300);
        }
    });

    document.getElementById('html-sample-btn')?.addEventListener('click', () => {
        htmlInputEditor.setValue(defaultHtmlContent);
        renderHtmlPreview();
        showToast('Restored sample HTML card template', 'success');
    });

    function prettifyHtmlCode(html) {
        if (!html || !html.trim()) return '';
        const tokenRegex = /(<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<\/[a-zA-Z0-9-]+>|<[a-zA-Z0-9-]+\b[^>]*\/>|<[a-zA-Z0-9-]+\b[^>]*>|[^<]+)/gi;
        const clean = html.replace(/>\s+</g, '><').trim();
        const tokens = clean.match(tokenRegex) || [clean];
        const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

        let formatted = '';
        let indentLevel = 0;
        const tab = '  ';

        tokens.forEach(token => {
            const str = token.trim();
            if (!str) return;
            if (str.startsWith('</')) {
                indentLevel = Math.max(0, indentLevel - 1);
                formatted += (formatted ? '\n' : '') + tab.repeat(indentLevel) + str;
            } else if (str.toLowerCase().startsWith('<style') || str.toLowerCase().startsWith('<script')) {
                formatted += (formatted ? '\n' : '') + tab.repeat(indentLevel) + str;
            } else if (str.startsWith('<')) {
                const tagNameMatch = str.match(/^<([a-zA-Z0-9-]+)/);
                const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : '';
                const isVoid = voidTags.has(tagName) || str.endsWith('/>') || str.startsWith('<!') || str.startsWith('<!--');
                formatted += (formatted ? '\n' : '') + tab.repeat(indentLevel) + str;
                if (!isVoid) indentLevel++;
            } else {
                formatted += (formatted ? '\n' : '') + tab.repeat(indentLevel) + str;
            }
        });
        return formatted;
    }

    function inlineHtmlCode(html) {
        if (!html || !html.trim()) return '';
        return html.replace(/\r?\n|\r/g, ' ').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    }

    document.getElementById('html-prettify-btn')?.addEventListener('click', () => {
        const val = htmlInputEditor.getValue();
        if (!val.trim()) return;
        htmlInputEditor.setValue(prettifyHtmlCode(val));
        renderHtmlPreview();
        showToast('Prettified HTML code', 'success');
    });

    document.getElementById('html-inline-btn')?.addEventListener('click', () => {
        const val = htmlInputEditor.getValue();
        if (!val.trim()) return;
        htmlInputEditor.setValue(inlineHtmlCode(val));
        renderHtmlPreview();
        showToast('Minified HTML to single line', 'success');
    });

    document.getElementById('html-render-btn').addEventListener('click', () => {
        renderHtmlPreview();
        showToast('Rendered HTML preview', 'info');
    });

    document.getElementById('html-open-tab-btn').addEventListener('click', () => {
        const content = htmlInputEditor.getValue();
        const blob = new Blob([content], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    });

    document.getElementById('html-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(htmlInputEditor.getValue()).then(() => {
            showToast('HTML copied to clipboard!', 'success');
        });
    });

    document.getElementById('html-download-btn').addEventListener('click', () => {
        const value = htmlInputEditor.getValue();
        if (!value) return;
        const blob = new Blob([value], { type: 'text/html' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `preview.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast('Downloaded preview.html', 'success');
    });

    // =========================================================================
    // 9. NAVIGATION, EXPANDABLE SIDEBAR, RESIZERS & THEME
    // =========================================================================
    let activeViewId = 'view-diff';

    function layoutActiveEditors() {
        setTimeout(() => {
            if (activeViewId === 'view-diff') diffEditor.layout();
            else if (activeViewId === 'view-format') { formatInputEditor.layout(); formatOutputEditor.layout(); }
            else if (activeViewId === 'view-sql-gen') sqlOutputEditor.layout();
            else if (activeViewId === 'view-json-gen') jsonOutputEditor.layout();
            else if (activeViewId === 'view-excel-gen') excelInputEditor.layout();
            else if (activeViewId === 'view-html-render') htmlInputEditor.layout();
        }, 35);
    }

    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    sidebarToggle?.addEventListener('click', () => {
        sidebar.classList.toggle('expanded');
        setTimeout(layoutActiveEditors, 240);
    });

    const navItems = document.querySelectorAll('.nav-item[data-target]');
    const views = document.querySelectorAll('.view');

    function switchToView(targetId) {
        activeViewId = targetId;
        navItems.forEach(n => n.classList.toggle('active', n.getAttribute('data-target') === targetId));
        views.forEach(v => v.classList.toggle('active', v.id === targetId));
        layoutActiveEditors();
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-target');
            if (targetId) switchToView(targetId);
        });
    });

    window.addEventListener('resize', layoutActiveEditors);

    // Theme Toggle
    const themeToggle = document.getElementById('theme-toggle');
    let isDark = true;

    themeToggle.addEventListener('click', () => {
        isDark = !isDark;
        if (isDark) {
            monaco.editor.setTheme('vs-dark');
            document.documentElement.style.setProperty('--bg-primary', '#0f1115');
            document.documentElement.style.setProperty('--bg-secondary', '#161b22');
            document.documentElement.style.setProperty('--bg-tertiary', '#21262d');
            document.documentElement.style.setProperty('--text-primary', '#f0f6fc');
            document.documentElement.style.setProperty('--text-secondary', '#8b949e');
            document.documentElement.style.setProperty('--border-color', '#30363d');
            showToast('Switched to Dark Theme', 'info');
        } else {
            monaco.editor.setTheme('vs');
            document.documentElement.style.setProperty('--bg-primary', '#ffffff');
            document.documentElement.style.setProperty('--bg-secondary', '#f6f8fa');
            document.documentElement.style.setProperty('--bg-tertiary', '#eaeef2');
            document.documentElement.style.setProperty('--text-primary', '#24292f');
            document.documentElement.style.setProperty('--text-secondary', '#57606a');
            document.documentElement.style.setProperty('--border-color', '#d0d7de');
            showToast('Switched to Light Theme', 'info');
        }
    });

    // Resizers
    function makeResizable(resizerId, leftPaneId, rightPaneId, onResizeCallback) {
        const resizer = document.getElementById(resizerId);
        const leftPane = document.getElementById(leftPaneId);
        const rightPane = document.getElementById(rightPaneId);
        if (!resizer || !leftPane || !rightPane) return;

        let isResizing = false;
        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.body.classList.add('is-resizing');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const container = resizer.parentElement;
            if (!container) return;
            const containerRect = container.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const minPx = 120;
            const maxPx = containerRect.width - 120;
            const leftWidth = Math.max(minPx, Math.min(mouseX, maxPx));
            const leftPercent = (leftWidth / containerRect.width) * 100;

            leftPane.style.flex = 'none';
            leftPane.style.width = `${leftPercent}%`;
            rightPane.style.flex = '1';
            rightPane.style.width = 'auto';
            if (onResizeCallback) onResizeCallback();
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.body.classList.remove('is-resizing');
                if (onResizeCallback) onResizeCallback();
            }
        });
    }

    makeResizable('html-resizer', 'html-input', 'html-preview-container', () => htmlInputEditor.layout());
    makeResizable('format-resizer', 'format-input', 'format-output', () => {
        formatInputEditor.layout();
        formatOutputEditor.layout();
    });
    makeResizable('excel-resizer', 'excel-input', 'excel-preview-pane', () => excelInputEditor.layout());

    // Help Modal
    const helpModal = document.getElementById('help-modal-overlay');
    document.getElementById('shortcuts-help-btn')?.addEventListener('click', () => {
        if (helpModal) helpModal.style.display = 'flex';
    });
    document.getElementById('help-modal-close')?.addEventListener('click', () => {
        if (helpModal) helpModal.style.display = 'none';
    });
    helpModal?.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.style.display = 'none';
    });

    // =========================================================================
    // 10. GLOBAL KEYBOARD SHORTCUTS
    // =========================================================================
    const VIEW_KEYS = {
        '1': 'view-diff',
        '2': 'view-format',
        '3': 'view-sql-gen',
        '4': 'view-json-gen',
        '5': 'view-excel-gen',
        '6': 'view-html-render'
    };

    window.addEventListener('keydown', (e) => {
        // Alt + 1..6 to switch views
        if (e.altKey && VIEW_KEYS[e.key]) {
            e.preventDefault();
            switchToView(VIEW_KEYS[e.key]);
            return;
        }
        // Escape closes modal
        if (e.key === 'Escape') {
            if (helpModal && helpModal.style.display !== 'none') {
                helpModal.style.display = 'none';
                return;
            }
        }
        // Diff View F7 / Alt+N / Alt+P / Alt+Right / Alt+Left / Alt+M
        if (activeViewId === 'view-diff') {
            if (e.key === 'F7') {
                e.preventDefault();
                navigateDiff(e.shiftKey ? 'prev' : 'next');
            } else if (e.altKey && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                navigateDiff('next');
            } else if (e.altKey && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                navigateDiff('prev');
            } else if (e.altKey && e.key === 'ArrowRight') {
                e.preventDefault();
                applyHunkAction(currentDiffIndex, 'push-right');
            } else if (e.altKey && e.key === 'ArrowLeft') {
                e.preventDefault();
                applyHunkAction(currentDiffIndex, 'pull-left');
            } else if (e.altKey && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                applyHunkAction(currentDiffIndex, 'merge-to-right');
            }
        }
    });
});
