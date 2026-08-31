require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

require(['vs/editor/editor.main'], function () {
    // Initialize the Diff Editor
    // --- Diff Editor (View 1) ---
    const diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor'), {
        theme: 'vs-dark',
        originalEditable: true,
        automaticLayout: false, // We will manually layout on view switch
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        glyphMargin: true // Enable Glyph Margin for buttons
    });

    const originalModel = monaco.editor.createModel("", "javascript");
    const modifiedModel = monaco.editor.createModel("", "javascript");

    diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel
    });

    diffEditor.layout(); // Initial layout

    // --- Granular Transfer Logic ---
    let originalDecorations = [];
    let modifiedDecorations = [];
    let currentLineChanges = [];

    // Helper: Update Decorations on Diff Change
    const updateDiffDecorations = () => {
        const changes = diffEditor.getLineChanges();
        currentLineChanges = changes || [];

        if (!changes) return;

        const newOriginalDecorations = [];
        const newModifiedDecorations = [];

        changes.forEach(change => {
            // Original Side Arrow
            // Ensure valid range (start > 0)
            if (change.originalStartLineNumber > 0) {
                newOriginalDecorations.push({
                    range: new monaco.Range(change.originalStartLineNumber, 1, change.originalStartLineNumber, 1),
                    options: {
                        glyphMarginClassName: 'diff-arrow-right',
                        glyphMarginHoverMessage: { value: 'Copy Current Block to Modified' }
                    }
                });
            } else if (change.originalStartLineNumber === 0 && change.originalEndLineNumber === 0) {
                // It's an insertion in Modified (Deletion in Original context is effectively empty range?)
                // If original has no lines (start=0, end=0), we can't really put a decoration on line 0.
                // We might put it on the line *after* or *before* depending on context, 
                // but visually for "Copy to Modified", we can't copy *nothing* to *something* easily via a button on a non-existent line.
                // However, usually we show it on the nearest line.
                // For now, skip pure insertions where original range is empty (0-0).
            }

            // Modified Side Arrow
            if (change.modifiedStartLineNumber > 0) {
                newModifiedDecorations.push({
                    range: new monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedStartLineNumber, 1),
                    options: {
                        glyphMarginClassName: 'diff-arrow-left',
                        glyphMarginHoverMessage: { value: 'Copy Current Block to Original' }
                    }
                });
            }
        });

        originalDecorations = originalModel.deltaDecorations(originalDecorations, newOriginalDecorations);
        modifiedDecorations = modifiedModel.deltaDecorations(modifiedDecorations, newModifiedDecorations);
    };

    // Listen for Diff Updates
    diffEditor.onDidUpdateDiff(() => {
        updateDiffDecorations();
    });

    // Handle Clicks in Glyph Margin (Original)
    diffEditor.getOriginalEditor().onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position.lineNumber;
            const change = currentLineChanges.find(c =>
                lineNumber >= c.originalStartLineNumber && lineNumber <= c.originalEndLineNumber
            );

            if (change) {
                // Transfer Original -> Modified
                const text = originalModel.getValueInRange(new monaco.Range(
                    change.originalStartLineNumber, 1,
                    change.originalEndLineNumber, originalModel.getLineMaxColumn(change.originalEndLineNumber)
                ));

                // If Modified range is 0 (Deletion in Modified), we insert.
                // If Modified range has content (Modification), we replace.
                // Monaco's applyEdits handles ranges. 
                // Careful: if modifiedStartLineNumber is 0 (it often happens for inserts at top?), handle boundaries.

                let targetRange;
                if (change.modifiedStartLineNumber === 0) {
                    // Insertion at start? Or handling empty range is tricky.
                    // Usually implies start at 1 but length 0 logic? 
                    // But Monaco changes uses 0 for "none".
                    targetRange = new monaco.Range(1, 1, 1, 1); // Fallback
                } else {
                    // If it's pure insertion in Modified (original 0-0), we are here because we clicked Original? 
                    // No, if original 0-0, we skipped decoration. So we are here only if Original has content.

                    // If Modified is empty (deletion), modifiedStart > modifiedEnd (e.g. 5, 4).
                    // We need to insert AT modifiedStart.
                    if (change.modifiedEndLineNumber < change.modifiedStartLineNumber) {
                        targetRange = new monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedStartLineNumber, 1);
                    } else {
                        targetRange = new monaco.Range(
                            change.modifiedStartLineNumber, 1,
                            change.modifiedEndLineNumber, modifiedModel.getLineMaxColumn(change.modifiedEndLineNumber)
                        );
                    }
                }

                // For deletions in Modified, we need to insert *and* maybe add newline?
                // Using `pushEditOperations` is better to support Undo.
                // Actually, standard `setValue` or specific edit.
                // Let's try simpler: Replace the range. 
                // Note: If copying 3 lines to replace 0 lines, we simply insert those 3 lines.
                // Issues: Newline handling. `getValueInRange` gets text. 
                // If we insert, do we need to add a newline char? 

                // Let's assume standard explicit replacement works best visually.

                // Special case: Copying to a Deletion (Insert in Original, Delete in Modified).
                // Target is a point. Re-inserting lines there.

                modifiedModel.pushEditOperations([], [{
                    range: targetRange,
                    text: text
                }], () => null);
            }
        }
    });

    // Handle Clicks in Glyph Margin (Modified)
    diffEditor.getModifiedEditor().onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position.lineNumber;
            const change = currentLineChanges.find(c =>
                lineNumber >= c.modifiedStartLineNumber && lineNumber <= c.modifiedEndLineNumber
            );

            if (change) {
                // Transfer Modified -> Original
                const text = modifiedModel.getValueInRange(new monaco.Range(
                    change.modifiedStartLineNumber, 1,
                    change.modifiedEndLineNumber, modifiedModel.getLineMaxColumn(change.modifiedEndLineNumber)
                ));

                let targetRange;
                if (change.originalEndLineNumber < change.originalStartLineNumber) {
                    // Deletion in Original (Insert in Modified).
                    // We inserting back to Original.
                    targetRange = new monaco.Range(change.originalStartLineNumber, 1, change.originalStartLineNumber, 1);
                } else {
                    targetRange = new monaco.Range(
                        change.originalStartLineNumber, 1,
                        change.originalEndLineNumber, originalModel.getLineMaxColumn(change.originalEndLineNumber)
                    );
                }

                originalModel.pushEditOperations([], [{
                    range: targetRange,
                    text: text
                }], () => null);
            }
        }
    });

    // --- Formatter Editors (View 2) ---
    // Input Editor (Left)
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

    // Output Editor (Right)
    const formatOutputEditor = monaco.editor.create(document.getElementById('format-output'), {
        value: "",
        language: "json",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: true,
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    // --- Navigation Logic ---
    const navItems = document.querySelectorAll('.nav-item[data-target]');
    const views = document.querySelectorAll('.view');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Update Nav State
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            // Update View State
            const targetId = item.getAttribute('data-target');
            views.forEach(view => {
                view.classList.remove('active');
                if (view.id === targetId) {
                    view.classList.add('active');
                }
            });

            // Trigger Resize for Monaco Editors
            setTimeout(() => {
                if (targetId === 'view-diff') {
                    diffEditor.layout();
                } else if (targetId === 'view-format') {
                    formatInputEditor.layout();
                    formatOutputEditor.layout();
                } else if (targetId === 'view-sql-gen') {
                    sqlOutputEditor.layout();
                } else if (targetId === 'view-json-gen') {
                    jsonOutputEditor.layout();
                } else if (targetId === 'view-excel-gen') {
                    excelInputEditor.layout();
                } else if (targetId === 'view-html-render') {
                    htmlInputEditor.layout();
                }
            }, 10);
        });
    });

    // --- Window Resize Handling ---
    window.addEventListener('resize', () => {
        if (document.getElementById('view-diff').classList.contains('active')) {
            diffEditor.layout();
        } else if (document.getElementById('view-format').classList.contains('active')) {
            formatInputEditor.layout();
            formatOutputEditor.layout();
        } else if (document.getElementById('view-sql-gen').classList.contains('active')) {
            sqlOutputEditor.layout();
        } else if (document.getElementById('view-json-gen').classList.contains('active')) {
            jsonOutputEditor.layout();
        } else if (document.getElementById('view-excel-gen').classList.contains('active')) {
            excelInputEditor.layout();
        } else if (document.getElementById('view-html-render').classList.contains('active')) {
            htmlInputEditor.layout();
        }
    });


    // --- Diff View Controls ---
    const diffLangSelector = document.getElementById('diff-language-selector');
    diffLangSelector.addEventListener('change', (e) => {
        const newLang = e.target.value;
        monaco.editor.setModelLanguage(originalModel, newLang);
        monaco.editor.setModelLanguage(modifiedModel, newLang);
    });

    // Transfer Buttons
    document.getElementById('transfer-to-modified').addEventListener('click', () => {
        modifiedModel.setValue(originalModel.getValue());
    });

    document.getElementById('transfer-to-original').addEventListener('click', () => {
        originalModel.setValue(modifiedModel.getValue());
    });


    // --- Formatter View Controls ---
    const formatLangSelector = document.getElementById('format-language-selector');

    // Reusable Format Function
    const performFormat = () => {
        const lang = formatLangSelector.value;
        const value = formatInputEditor.getValue();
        if (!value.trim()) {
            formatOutputEditor.setValue("");
            return;
        }

        try {
            let formatted = value;
            if (lang === 'json') {
                formatted = JSON.stringify(JSON.parse(value), null, 4);
            } else if (lang === 'xml') {
                formatted = formatXml(value);
            }
            formatOutputEditor.setValue(formatted);
        } catch (e) {
            // Display error in the output editor instead of toaster/alert
            formatOutputEditor.setValue(`Error parsing ${lang.toUpperCase()}:\n${e.message}`);
        }
    };

    // Auto-Format on Content Change (Paste/Type)
    formatInputEditor.onDidChangeModelContent(() => {
        performFormat();
    });

    // Language Change Trigger
    formatLangSelector.addEventListener('change', (e) => {
        const newLang = e.target.value;
        monaco.editor.setModelLanguage(formatInputEditor.getModel(), newLang);
        monaco.editor.setModelLanguage(formatOutputEditor.getModel(), newLang);
        performFormat();
    });

    const formatBtn = document.getElementById('format-btn');
    formatBtn.addEventListener('click', () => {
        performFormat();
    });

    const unescapeBtn = document.getElementById('unescape-btn');
    unescapeBtn.addEventListener('click', () => {
        const value = formatInputEditor.getValue();
        if (!value.trim()) return;

        try {
            // First parse the input as JSON string
            const parsed = JSON.parse(value);
            
            // Check if result is a string (meaning input was an escaped JSON string)
            if (typeof parsed === 'string') {
                formatInputEditor.setValue(parsed);
                // The onDidChangeModelContent listener will trigger performFormat() automatically
            } else {
                // If it's already an object/array, performFormat will just format it
                // We could show a message, but for now just ensure it's formatted
                performFormat();
                // Maybe show a quick status? 
                // Let's use the output editor for temporary feedback if needed, but performFormat writes to it.
                // If parsed is not a string, it means it wasn't a stringified JSON string.
                // Example: User put {"a":1} directly. JSON.parse returns object.
                // User put "foo". JSON.parse returns "foo".
                // If user put "\"foo\"". JSON.parse returns "foo".
                // We only want to "unescape" if we actually peeled off a layer of stringification that resulted in a JSON string.
                // But generally "Unescape" implies "Treat as JSON string and give me the content".
            }
        } catch (e) {
            formatOutputEditor.setValue(`Error unescaping: ${e.message}`);
        }
    });

    const copyBtn = document.getElementById('copy-btn');
    copyBtn.addEventListener('click', () => {
        const value = formatOutputEditor.getValue();
        if (value.startsWith("Error parsing")) return; // Don't copy errors blindly

        navigator.clipboard.writeText(value).then(() => {
            // Visual feedback (optional)
            const originalText = copyBtn.innerText;
            copyBtn.innerText = 'Copied!';
            setTimeout(() => copyBtn.innerText = originalText, 2000);
        });
    });

    const downloadBtn = document.getElementById('download-btn');
    downloadBtn.addEventListener('click', () => {
        const value = formatOutputEditor.getValue();
        if (!value) return;

        const lang = formatLangSelector.value;
        const extension = lang === 'json' ? 'json' : 'xml';
        const blob = new Blob([value], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `formatted.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    });

    function formatXml(xml) {
        let formatted = '';
        let reg = /(>)(<)(\/*)/g;
        xml = xml.replace(reg, '$1\r\n$2$3');
        let pad = 0;
        xml.split('\r\n').forEach((node) => {
            let indent = 0;
            if (node.match(/.+<\/\w[^>]*>$/)) {
                indent = 0;
            } else if (node.match(/^<\/\w/)) {
                if (pad !== 0) {
                    pad -= 1;
                }
            } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
                indent = 1;
            } else {
                indent = 0;
            }

            let padding = '';
            for (let i = 0; i < pad; i++) {
                padding += '  ';
            }

            formatted += padding + node + '\r\n';
            pad += indent;
        });
        return formatted;
    }

    // --- Theme Toggle (Global) ---
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
        } else {
            monaco.editor.setTheme('vs');
            document.documentElement.style.setProperty('--bg-primary', '#ffffff');
            document.documentElement.style.setProperty('--bg-secondary', '#f6f8fa');
            document.documentElement.style.setProperty('--bg-tertiary', '#eaeef2');
            document.documentElement.style.setProperty('--text-primary', '#24292f');
            document.documentElement.style.setProperty('--text-secondary', '#57606a');
            document.documentElement.style.setProperty('--border-color', '#d0d7de');
        }
    });

    // --- SQL Generator (View 3) ---
    const sqlOutputEditor = monaco.editor.create(document.getElementById('sql-output'), {
        value: "-- Upload a sheet to generate SQL",
        language: "sql",
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        readOnly: false, // User can modify if they want
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Courier New', monospace"
    });

    // --- Navigation Update for SQL View ---
    const sqlNavItem = document.querySelector('.nav-item[data-target="view-sql-gen"]');
    if (sqlNavItem) {
        sqlNavItem.addEventListener('click', () => {
            setTimeout(() => {
                sqlOutputEditor.layout();
            }, 10);
        });
    }

    // Also handle window resize for SQL editor
    window.addEventListener('resize', () => {
        if (document.getElementById('view-sql-gen').classList.contains('active')) {
            sqlOutputEditor.layout();
        }
    });


    // --- File Upload & SQL Logic ---
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-upload');
    const generateBtn = document.getElementById('generate-sql-btn');
    const sheetSelector = document.getElementById('sheet-selector');
    const sheetContainer = document.getElementById('sheet-selection-container');

    let loadedData = null; // Store parsed data
    let currentWorkbook = null;

    // Click to browse
    dropZone.addEventListener('click', () => fileInput.click());

    // Drag parsers
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFile(e.target.files[0]);
        }
    });

    function handleFile(file) {
        // Visual feedback
        const dropText = dropZone.querySelector('.drop-text p');
        dropText.innerText = `Loaded: ${file.name}`;

        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            currentWorkbook = workbook;

            // Populate Sheet Selector
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

            // Load first sheet by default
            loadSheetData(workbook.SheetNames[0]);

            // Auto-generate on upload? Or wait for button?
            // Let's output a success message or preview.
            sqlOutputEditor.setValue(`-- File loaded: ${file.name}\n-- Sheets: ${workbook.SheetNames.join(', ')}\n-- Rows: ${loadedData.length}\n-- Click 'Generate SQL' to create script.`);
        };
        reader.readAsArrayBuffer(file);
    }

    sheetSelector.addEventListener('change', (e) => {
        if (currentWorkbook) {
            loadSheetData(e.target.value);
            sqlOutputEditor.setValue(`-- Switched to sheet: ${e.target.value}\n-- Rows: ${loadedData.length}\n-- Click 'Generate SQL' to create script.`);
        }
    });

    function loadSheetData(sheetName) {
        if (!currentWorkbook) return;
        const worksheet = currentWorkbook.Sheets[sheetName];
        loadedData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
    }

    generateBtn.addEventListener('click', () => {
        if (!loadedData || loadedData.length === 0) {
            sqlOutputEditor.setValue("-- No data loaded. Please upload a file first.");
            return;
        }

        const tableName = document.getElementById('table-name').value || "#TempTable";
        const hasHeader = document.getElementById('header-row').checked;

        try {
            const sql = generateSQL(loadedData, tableName, hasHeader);
            sqlOutputEditor.setValue(sql);
        } catch (err) {
            sqlOutputEditor.setValue(`-- Error generating SQL:\n-- ${err.message}`);
        }
    });

    function generateSQL(data, tableName, hasHeader) {
        if (data.length === 0) return "-- Empty data";

        let headers = [];
        let rows = data;

        if (hasHeader) {
            headers = data[0].map(h => h ? h.toString().trim().replace(/\s+/g, '_') : 'Column_x');
            // Duplicate header check?
            rows = data.slice(1);
        } else {
            // Generate Col1, Col2...
            const colCount = data[0].length;
            for (let i = 0; i < colCount; i++) {
                headers.push(`Col${i + 1}`);
            }
        }

        if (rows.length === 0) return `-- No data rows found in ${tableName}`;

        // Type Inference
        // We'll scan up to 1000 rows for types to be safe/fast
        const scanLimit = Math.min(rows.length, 1000);
        const colTypes = headers.map(() => ({ type: 'INT', length: 0, isNullable: false }));

        for (let c = 0; c < headers.length; c++) {
            let isInt = true;
            let isDecimal = true; // Int is also decimal
            let isDate = true;
            let maxLen = 0;
            let hasNull = false;

            for (let r = 0; r < scanLimit; r++) {
                const val = rows[r][c];
                if (val === null || val === undefined || val === '') {
                    hasNull = true;
                    continue;
                }

                const strVal = val.toString();
                if (strVal.length > maxLen) maxLen = strVal.length;

                // Check Number
                if (typeof val === 'number') {
                    if (!Number.isInteger(val)) isInt = false;
                } else {
                    // It's a string, try parse
                    if (isNaN(val) || strVal.trim() === '') {
                        isInt = false;
                        isDecimal = false;
                    } else {
                        if (!Number.isInteger(Number(val))) isInt = false;
                    }
                }

                // Check Date (simple check)
                // SheetJS parses dates as numbers sometimes or strings. 
                // If it's a number, it might be an Excel serial date, but we can't be sure unless we know cell format.
                // For simplicity, let's treat everything not strictly a JS Date object or ISO string as NOT date for safety, 
                // unless we want to try parsing strings.
                // Let's default to NVARCHAR mostly unless sure.
                if (!(val instanceof Date) && isNaN(Date.parse(val))) {
                    isDate = false;
                }
            }

            // Decide Type
            if (isDate && maxLen > 0) colTypes[c].type = 'DATETIME';
            // Prefer decimal/int only if ALL non-nulls were valid numbers
            else if (isInt && maxLen > 0) colTypes[c].type = 'INT';
            else if (isDecimal && maxLen > 0) colTypes[c].type = 'DECIMAL(18,4)'; // Generic Decimal
            else {
                // Varchar
                // Round up length to nearest power of 2 or typical buckets
                let finalLen = maxLen < 50 ? 50 : maxLen < 255 ? 255 : maxLen < 4000 ? 4000 : 'MAX';
                colTypes[c].type = `NVARCHAR(${finalLen})`;
            }
        }

        // 1. CREATE TABLE
        let script = `CREATE TABLE ${tableName} (\n`;
        script += headers.map((h, i) => `    [${h}] ${colTypes[i].type}${colTypes[i].isNullable ? '' : ' NULL'}`).join(',\n');
        script += `\n);\n\n`;

        // 2. INSERT Data
        // Batch every 1000 rows
        const BATCH_SIZE = 1000;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            script += `INSERT INTO ${tableName} (${headers.map(h => `[${h}]`).join(', ')}) VALUES \n`;

            const rowStrings = batch.map(row => {
                const vals = headers.map((_, colIndex) => {
                    let val = row[colIndex];
                    if (val === null || val === undefined || val === '') return 'NULL';

                    const type = colTypes[colIndex].type;

                    if (type.startsWith('INT') || type.startsWith('DECIMAL')) {
                        return val; // Numbers don't need quotes
                    } else if (type === 'DATETIME') {
                        // Format date to 'YYYY-MM-DD HH:mm:ss'
                        // If it's a SheetJS number (serial), might need conversion, but assumed Date obj or string above
                        if (val instanceof Date) {
                            return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
                        }
                        return `'${val}'`;
                    } else {
                        // String escaping: replace ' with ''
                        return `'${val.toString().replace(/'/g, "''")}'`;
                    }
                });
                return `(${vals.join(', ')})`;
            });

            script += rowStrings.join(',\n');
            script += `;\n\n`;
        }

        script += `-- Inserted ${rows.length} rows.\n`;
        script += `SELECT * FROM ${tableName};\n`;

        return script;
    }

    // --- Control Buttons ---
    document.getElementById('sql-copy-btn').addEventListener('click', () => {
        const value = sqlOutputEditor.getValue();
        navigator.clipboard.writeText(value);
        // Feedback could be added here
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
    });

    // --- Sheet to JSON & SSMS Script (View 4) ---
    const jsonOutputEditor = monaco.editor.create(document.getElementById('json-output'), {
        value: "-- Upload a sheet to generate JSON or SSMS OPENJSON script",
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

    jsonDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        jsonDropZone.classList.add('drag-over');
    });

    jsonDropZone.addEventListener('dragleave', () => {
        jsonDropZone.classList.remove('drag-over');
    });

    jsonDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        jsonDropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) {
            handleJsonFile(e.dataTransfer.files[0]);
        }
    });

    jsonFileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleJsonFile(e.target.files[0]);
        }
    });

    function handleJsonFile(file) {
        const dropText = jsonDropZone.querySelector('.drop-text p');
        dropText.innerText = `Loaded: ${file.name}`;

        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
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
            jsonOutputEditor.setValue(`-- File loaded: ${file.name}\n-- Sheets: ${workbook.SheetNames.join(', ')}\n-- Rows: ${jsonLoadedData.length}\n-- Click 'Generate' to create JSON/SSMS script.`);
        };
        reader.readAsArrayBuffer(file);
    }

    jsonSheetSelector.addEventListener('change', (e) => {
        if (jsonCurrentWorkbook) {
            loadJsonSheetData(e.target.value);
            jsonOutputEditor.setValue(`-- Switched to sheet: ${e.target.value}\n-- Rows: ${jsonLoadedData.length}\n-- Click 'Generate' to create JSON/SSMS script.`);
        }
    });

    function loadJsonSheetData(sheetName) {
        if (!jsonCurrentWorkbook) return;
        const worksheet = jsonCurrentWorkbook.Sheets[sheetName];
        jsonLoadedData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
    }

    jsonGenerateBtn.addEventListener('click', () => {
        if (!jsonLoadedData || jsonLoadedData.length === 0) {
            jsonOutputEditor.setValue("-- No data loaded. Please upload a file first.");
            return;
        }

        const tableName = document.getElementById('json-table-name').value || "#TempTable";
        const hasHeader = document.getElementById('json-header-row').checked;
        const outputMode = document.getElementById('json-output-mode').value;
        const prettify = document.getElementById('json-prettify').checked;

        try {
            const script = generateJsonScript(jsonLoadedData, tableName, hasHeader, outputMode, prettify);
            jsonOutputEditor.setValue(script);
        } catch (err) {
            jsonOutputEditor.setValue(`-- Error generating script:\n-- ${err.message}`);
        }
    });

    function generateJsonScript(data, tableName, hasHeader, outputMode, prettify) {
        if (data.length === 0) return "-- Empty data";

        let headers = [];
        let rows = data;

        if (hasHeader) {
            headers = data[0].map(h => h ? h.toString().trim().replace(/\s+/g, '_') : 'Column_x');
            rows = data.slice(1);
        } else {
            const colCount = data[0].length;
            for (let i = 0; i < colCount; i++) {
                headers.push(`Col${i + 1}`);
            }
        }

        if (rows.length === 0) return `-- No data rows found`;

        // Transform rows to JSON objects array
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

        // SSMS OPENJSON Script mode
        monaco.editor.setModelLanguage(jsonOutputEditor.getModel(), 'sql');

        // Type Inference for WITH clause schema
        const scanLimit = Math.min(rows.length, 1000);
        const colTypes = headers.map(() => ({ type: 'INT', maxLen: 0 }));

        for (let c = 0; c < headers.length; c++) {
            let isInt = true;
            let isDecimal = true;
            let isDate = true;
            let maxLen = 0;

            for (let r = 0; r < scanLimit; r++) {
                const val = rows[r][c];
                if (val === null || val === undefined || val === '') continue;

                const strVal = val.toString();
                if (strVal.length > maxLen) maxLen = strVal.length;

                if (typeof val === 'number') {
                    if (!Number.isInteger(val)) isInt = false;
                } else {
                    if (isNaN(val) || strVal.trim() === '') {
                        isInt = false;
                        isDecimal = false;
                    } else {
                        if (!Number.isInteger(Number(val))) isInt = false;
                    }
                }

                if (!(val instanceof Date) && isNaN(Date.parse(val))) {
                    isDate = false;
                }
            }

            if (isDate && maxLen > 0) colTypes[c].type = 'DATETIME';
            else if (isInt && maxLen > 0) colTypes[c].type = 'INT';
            else if (isDecimal && maxLen > 0) colTypes[c].type = 'DECIMAL(18,4)';
            else {
                let finalLen = maxLen < 50 ? 50 : maxLen < 255 ? 255 : maxLen < 4000 ? 4000 : 'MAX';
                colTypes[c].type = `NVARCHAR(${finalLen})`;
            }
        }

        const jsonPayload = JSON.stringify(objects, null, prettify ? 2 : 0);
        // Escape single quotes inside SQL N'...' literal
        const sqlEscapedJson = jsonPayload.replace(/'/g, "''");

        let script = `-- =============================================\n`;
        script += `-- SSMS OPENJSON Insert Script for ${tableName}\n`;
        script += `-- Total Rows: ${rows.length}\n`;
        script += `-- =============================================\n\n`;
        script += `DECLARE @json NVARCHAR(MAX) = N'${sqlEscapedJson}';\n\n`;
        script += `IF OBJECT_ID('tempdb..${tableName}') IS NOT NULL DROP TABLE ${tableName};\n\n`;
        script += `CREATE TABLE ${tableName} (\n`;
        script += headers.map((h, i) => `    [${h}] ${colTypes[i].type} NULL`).join(',\n');
        script += `\n);\n\n`;
        script += `INSERT INTO ${tableName} (\n    ${headers.map(h => `[${h}]`).join(', ')}\n)\n`;
        script += `SELECT \n    ${headers.map(h => `[${h}]`).join(',\n    ')}\n`;
        script += `FROM OPENJSON(@json)\nWITH (\n`;
        script += headers.map((h, i) => `    [${h}] ${colTypes[i].type} '$.${h}'`).join(',\n');
        script += `\n);\n\n`;
        script += `-- Verify inserted data:\n`;
        script += `SELECT * FROM ${tableName};\n`;

        return script;
    }

    document.getElementById('json-copy-btn').addEventListener('click', () => {
        const value = jsonOutputEditor.getValue();
        navigator.clipboard.writeText(value);
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
        a.download = `script.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    });

    // --- Sheet to Excel (View 5) ---
    const excelInputEditor = monaco.editor.create(document.getElementById('excel-input'), {
        value: JSON.stringify([
            { "ID": 101, "FullName": "John Doe", "Department": "Engineering", "Salary": 85000 },
            { "ID": 102, "FullName": "Jane Smith", "Department": "Marketing", "Salary": 78000 }
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

    document.getElementById('export-excel-btn').addEventListener('click', () => {
        const value = excelInputEditor.getValue().trim();
        if (!value) return;

        const fileName = document.getElementById('excel-file-name').value.trim() || 'data_export';
        const sheetName = document.getElementById('excel-sheet-name').value.trim() || 'Sheet1';

        try {
            let worksheet;
            let parsedData;

            // Try parsing as JSON first
            try {
                parsedData = JSON.parse(value);
            } catch (jsonErr) {
                // If not valid JSON, treat as CSV string using SheetJS
                const csvWb = XLSX.read(value, { type: 'string' });
                const firstSheetName = csvWb.SheetNames[0];
                worksheet = csvWb.Sheets[firstSheetName];
            }

            if (!worksheet && parsedData) {
                if (Array.isArray(parsedData)) {
                    worksheet = XLSX.utils.json_to_sheet(parsedData);
                } else if (typeof parsedData === 'object') {
                    worksheet = XLSX.utils.json_to_sheet([parsedData]);
                } else {
                    throw new Error("Invalid JSON structure. Must be an array of objects or an object.");
                }
            }

            if (!worksheet) {
                throw new Error("Could not parse input data into an Excel sheet.");
            }

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, worksheet, sheetName);
            XLSX.writeFile(wb, `${fileName}.xlsx`);
        } catch (err) {
            alert(`Error exporting to Excel:\n${err.message}`);
        }
    });

    // --- HTML Renderer & Preview (View 6) ---
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
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            margin: 0 auto;
        }
        .btn {
            background-color: #3b82f6;
            color: white;
            border: none;
            padding: 10px 18px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn:hover {
            background-color: #2563eb;
        }
    </style>
</head>
<body>
    <div class="card">
        <h2>⚡ Live HTML Preview</h2>
        <p>Type or paste your HTML, CSS, and JavaScript here to see real-time updates.</p>
        <button class="btn" onclick="alert('Hello from HTML Renderer!')">Click Me</button>
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
        const content = htmlInputEditor.getValue();
        htmlPreviewFrame.srcdoc = content;
    }

    // Initial render
    renderHtmlPreview();

    // Auto-update with debounce
    htmlInputEditor.onDidChangeModelContent(() => {
        if (htmlAutoUpdateCb && htmlAutoUpdateCb.checked) {
            if (renderTimeout) clearTimeout(renderTimeout);
            renderTimeout = setTimeout(() => {
                renderHtmlPreview();
            }, 300);
        }
    });

    // Helper: Prettify HTML Code
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
                if (!isVoid) {
                    indentLevel++;
                }
            } else {
                formatted += (formatted ? '\n' : '') + tab.repeat(indentLevel) + str;
            }
        });

        return formatted;
    }

    // Helper: Minify / Inline HTML Code
    function inlineHtmlCode(html) {
        if (!html || !html.trim()) return '';
        return html
            .replace(/\r?\n|\r/g, ' ')
            .replace(/>\s+</g, '><')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const prettifyBtn = document.getElementById('html-prettify-btn');
    if (prettifyBtn) {
        prettifyBtn.addEventListener('click', () => {
            const value = htmlInputEditor.getValue();
            if (!value.trim()) return;
            const formatted = prettifyHtmlCode(value);
            htmlInputEditor.setValue(formatted);
            renderHtmlPreview();
        });
    }

    const inlineBtn = document.getElementById('html-inline-btn');
    if (inlineBtn) {
        inlineBtn.addEventListener('click', () => {
            const value = htmlInputEditor.getValue();
            if (!value.trim()) return;
            const inlined = inlineHtmlCode(value);
            htmlInputEditor.setValue(inlined);
            renderHtmlPreview();
        });
    }

    document.getElementById('html-render-btn').addEventListener('click', () => {
        renderHtmlPreview();
    });

    document.getElementById('html-open-tab-btn').addEventListener('click', () => {
        const content = htmlInputEditor.getValue();
        const blob = new Blob([content], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    });

    document.getElementById('html-copy-btn').addEventListener('click', () => {
        const value = htmlInputEditor.getValue();
        navigator.clipboard.writeText(value).then(() => {
            const btn = document.getElementById('html-copy-btn');
            const originalText = btn.innerText;
            btn.innerText = 'Copied!';
            setTimeout(() => btn.innerText = originalText, 2000);
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
    });

});
