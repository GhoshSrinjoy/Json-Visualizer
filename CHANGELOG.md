# Changelog

## 2.0.0

The Streamlit/pyvis JSON visualizer has been rewritten as **StructLens**: a VS Code extension, a command-line tool and an MCP server. The Python app (`app.py`) has been removed; it remains in the git history.

### Data files
- Graph, tree, table, schema and text views for JSON, JSONC, JSON5, JSON Lines, YAML, XML, HTML, TOML, CSV/TSV, Excel (.xlsx/.xlsm), INI, .env and .properties.
- A tolerant streaming JSON parser (~300 MB/s) with source positions. Parsing runs in a Web Worker, and large arrays are paged.
- JSONPath queries, text search, and schema inference exportable as JSON Schema or TypeScript.
- Click-to-reveal in the editor, cursor following, and an **Open With… → StructLens Visualizer** custom editor for very large files.

### Code
- Structure, logic-flow (control-flow graph), data-flow and call-graph views. TypeScript, JavaScript, Python, Java, C#, Go, Rust, C, C++, Ruby and PHP are parsed with tree-sitter; about 24 more languages get outlines.
- Mermaid export for flows and call graphs.

### Repositories
- File tree, treemap, folder graph, dependency graph with cycle detection, and statistics. `.gitignore` is respected.

### AI agents
- 14 read-only tools for GitHub Copilot agent mode and an MCP server (stdio and Streamable HTTP).
- **Connect AI Agents** configures Claude Code, Codex, Cursor, Gemini CLI, Windsurf and Claude Desktop.
- Agents can open interactive diagrams in the running VS Code window.

### Interface
- A new canvas renderer with level-of-detail, minimap, animations, and dark and light themes that follow VS Code.
- Layouts adapt to narrow side-by-side panels.
