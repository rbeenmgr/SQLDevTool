# 🛠️ SQLDevTool - Developer & Database Utility Suite

A modern, 100% browser-based single-page web application featuring essential code diffing, SQL/JSON/XML formatting, spreadsheet conversion, and T-SQL script generation utilities.

Built with **HTML5**, **Vanilla CSS3**, **JavaScript (ES6)**, **Monaco Editor**, and **SheetJS**.

---

## ✨ Key Features

### 🔍 1. Diff Checker & Interactive Merge Engine
- **Side-by-Side & Unified Code Diffing**: Powered by Microsoft's Monaco Editor engine.
- **3-Way Hunk Transfer & Merge Engine**:
  - **Inline CodeLens Action Pills**: Click `▶ Push to Right (→)`, `◀ Pull to Left (←)`, or `⇄ Merge Both` directly above any changed block inside the editor.
  - **Center Active Hunk Merge Toolbar**: Step through differences (`F7` / `Shift+F7`) and click **`Push Right →`** (`Alt+Right`), **`⇄ Merge Both`** (`Alt+M`), or **`← Pull Left`** (`Alt+Left`) to move or combine individual blocks.
  - **Full Insertion, Deletion & Modification Support**: Accurately handles pure deletions, pure insertions, and modified blocks with full **Undo / Redo (`Ctrl+Z` / `Ctrl+Y`)** support.
  - **Per-Pane Export & Undo Bar**: Undo, Redo, Copy, or Download either the Left (`Original`) or Right (`Modified`) merged result independently.
- **Multi-Language Support**: Syntax highlighting for 13+ languages (*SQL, JavaScript, TypeScript, JSON, HTML, CSS, Python, C#, Java, C++, XML, Markdown, Plain Text*).
- **One-Click Sample Loader**: Load a realistic T-SQL Stored Procedure comparison with `⚡ Load Sample`.

### ⚡ 2. Code Formatter, Minifier & Unescaper
- **Multi-Language Formatting**: Prettify or Minify **JSON**, **T-SQL**, and **XML** payloads.
- **JSON Unescaper & Escaper**: Convert escaped JSON strings (`"{\"key\": \"val\"}"`) into raw formatted objects, or escape raw text into a string literal.
- **File Upload & Live Status Badge**: Drag/upload `.json`, `.sql`, or `.xml` files with real-time validation status.

### 📊 3. Sheet to SQL Generator
- **Bulk Insert Script Generator**: Upload Excel (`.xlsx`, `.xls`) or `.csv` files, or click `⚡ Load Sample Sheet`.
- **Interactive Preview, Column Filter & Manual Type Overrides**:
  - Search/filter columns by name.
  - Select or deselect columns via chips or table checkboxes.
  - **Override Inferred SQL Types**: Click any column's type badge (`INT`, `NVARCHAR(50)`, `DECIMAL(18,2)`, `DATETIME`, etc.) to override its SQL data type before generating.
- **Auto-Generate Mode**: Automatically updates the T-SQL script whenever you toggle columns, change table names, or override data types.

### 📄 4. Sheet to JSON & SSMS OPENJSON Script Generator
- **SSMS T-SQL OPENJSON Generator**: Generates `DECLARE @json NVARCHAR(MAX)` and `INSERT INTO #TempTable SELECT ... FROM OPENJSON(@json) WITH (...)` using validated column schemas.
- **Dot (`.`) Safe JSON Pathing**: Automatically quotes property names containing dots or special characters (e.g., `'$."Order.ID"'`).
- **Multi-Output Modes**: Export as **SSMS OPENJSON Script**, **Raw JSON Array**, or **MongoDB `insertMany`**.

### 📈 5. Data to Excel & CSV Converter
- **Live Split-Pane Table Preview**: Instantly preview your JSON object array or CSV text as a rendered data table with row and column counts before exporting.
- **Export `.xlsx` or `.csv`**: Download styled Microsoft Excel workbooks or CSV files with custom file and worksheet names.

### 🌐 6. HTML Renderer & Live Preview
- **Live HTML/CSS/JS Sandbox**: Side-by-side Monaco HTML code editor and live sandboxed iframe preview frame with Prettify and Minify tools.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt + 1..6` | Switch between tools (Diff, Formatter, Sheet to SQL, Sheet to JSON, Excel, HTML) |
| `F7` / `Shift + F7` | Jump to Next / Previous difference in Diff Checker |
| `Alt + N` / `Alt + P` | Jump to Next / Previous difference in Diff Checker |
| `Esc` | Close active modal |

---

## 🚀 Quick Start / Setup

No build step or Node server required!

1. Clone this repository:
   ```bash
   git clone https://github.com/rbeenmgr/SQLDevTool.git
   ```
2. Open `index.html` directly in any web browser, or serve it using a local HTTP server:
   ```bash
   # Using Python
   python -m http.server 8000

   # Or using Node npx
   npx serve .
   ```
