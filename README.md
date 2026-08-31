# 🛠️ SQLDevTool - Developer & Database Utility Suite

A modern, browser-based single-page web application featuring essential code diffing, formatting, spreadsheet conversion, and T-SQL script generation utilities.

Built with **HTML5**, **Vanilla CSS3**, **JavaScript (ES6)**, **Monaco Editor**, and **SheetJS**.

---

## ✨ Features

### 🔍 1. Diff Checker
- **Side-by-Side Code Diffing**: Powered by Microsoft's Monaco Editor engine.
- **Multi-Language Support**: Syntax highlighting for 13+ languages (*JavaScript, TypeScript, HTML, CSS, JSON, Python, Java, C++, C#, SQL, XML, Markdown, Plain Text*).
- **Granular Block Transfers**: Transfer individual code blocks between *Original* and *Modified* panes using custom glyph margin arrows.

### ⚡ 2. Code Formatter & Unescaper
- **Code Formatter**: Instant formatting for JSON and XML payloads.
- **JSON Unescaper**: Convert escaped JSON strings (`"{\"key\": \"val\"}"`) into raw, formatted JSON objects.
- **Copy & Download**: Export formatted output with a single click.

### 📊 3. Sheet to SQL Generator
- **Bulk Insert Script Generator**: Upload Excel (`.xlsx`, `.xls`) or `.csv` files.
- **T-SQL Schema Inference**: Automatically infers column data types (`INT`, `DECIMAL(18,4)`, `DATETIME`, `NVARCHAR`).
- **Batched Inserts**: Produces `CREATE TABLE` and `INSERT INTO ... VALUES` statements batched every 1,000 rows.

### 📄 4. Sheet to JSON & SSMS OPENJSON Script Generator
- **SSMS T-SQL OPENJSON Generator**: Upload spreadsheets and generate SQL Server scripts utilizing `DECLARE @json NVARCHAR(MAX)` and `INSERT INTO #TempTable (...) SELECT ... FROM OPENJSON(@json) WITH (...)`.
- **Prettify Toggle**: Option to format JSON payloads as indented structures or compact strings.
- **Multi-Output Modes**: Export as **SSMS OPENJSON Script**, **Raw JSON Array**, or **Mongo insertMany**.

### 📈 5. Sheet to Excel Converter
- **JSON / CSV to Excel**: Convert raw JSON object arrays or CSV text directly into styled Microsoft Excel (`.xlsx`) workbooks.
- **Customizable Sheets**: Specify output file name and worksheet title.

### 🌐 6. HTML Renderer & Live Preview
- **Live HTML/CSS/JS Preview**: Side-by-side Monaco HTML code editor and live sandboxed iframe preview frame.
- **Auto-Update & Manual Render**: Real-time debounced updates as you type with an option to toggle auto-update on or off.
- **Export & Inspect**: Open rendered output in a new browser tab, copy HTML string, or download as `.html` file.

---

## 🚀 Quick Start / Setup

No build step or Node server required!

1. Clone or download this repository:
   ```bash
   git clone https://github.com/<your-username>/SQLDevTool.git
   ```
2. Open `index.html` directly in any web browser, or serve it using a local HTTP server:
   ```bash
   # Using Python
   python -m http.server 8000

   # Or using Node npx
   npx serve .
   ```

---

## 🎨 Theme Support

Includes built-in **Dark** and **Light** mode toggling that seamlessly updates Monaco Editor themes (`vs-dark` / `vs`) and CSS variables.

---

## 📜 License

MIT License - free to use, modify, and distribute for personal and commercial applications.
