# Changelog

## 2.1.0

### New for data files
- **Edge labels**: graph edges name the key they lead to (`users`, `[0]`, `<item>`), with room left for them in the layout. Toggle with `L`, the settings menu or `structlens.graph.edgeLabels`.
- **Editing**: Edit, Rename, Delete and Add (Inspector, right-click menu, `F2`, `Delete`) change the file for JSON, JSONC, JSON5, JSON Lines and YAML. Changes are minimal text edits that keep comments and formatting; in VS Code they are ordinary editor changes (Undo works); a change is refused if the file moved on since the view read it.
- **Compare**: a new Compare view and **StructLens: Compare With…** (Explorer, one or two files). The structural diff ignores key order and formatting, matches arrays of records by id (reorders show as moves), works across formats, marks changes on the graph and tree, and steps through them with `F7`.
- **JSON Schema validation**: drafts 4, 6, 7, 2019-09 and 2020-12 with `$ref` across files, from the document's `$schema` (or YAML modeline), VS Code's `json.schemas` / `yaml.schemas`, or a schema you pick. Errors are pinned to their nodes (graph, tree, Inspector) and counted in the toolbar. `structlens.data.autoValidate` turns the automatic check off.
- **Types**: the Schema view's **Types & schema** mode generates TypeScript, Zod, Python (Pydantic), Go, Rust (serde), C#, Kotlin, Swift and Java (Jackson), plus JSON Schema and compact text.
- **Convert**: save the selection or document as YAML, TOML, CSV, TSV, XML or JSON Lines; copy any value as YAML.
- **Previews**: color swatches (graph, tree, Inspector), image thumbnails (Inspector and on hover), local/UTC/relative times for dates and Unix timestamps, decoded JWTs with their expiry, and JSON stored inside strings.
- **Graph**: arrow-key navigation, **Focus on this** (show one subtree), expand one or two levels, **Find all like this** (a JSONPath for the same field in every element).
- **Search**: match case, whole word, regular expression and keys/values toggles; the count says `+` when it is capped.
- **Text view**: line numbers, issues in the gutter with next/previous, and selection sync both ways.
- Views keep their expanded nodes, camera, table sort and filter, and schema scope when the file changes or you switch tabs; Table and Schema now refresh after edits.
- `?` shows every keyboard shortcut.

### Fixes for data files
- Export JSON, Copy as JSON and Copy value include the whole selection (they stopped after 200,000 values); one too large for the clipboard says so instead of copying a cut-off value.
- Big integers and other number spellings (hex, `.5`, `+1`, `1_000`, NaN, Infinity) come out exact and valid in exports, conversions and MCP results.
- YAML aliases and `<<` merge keys are resolved (alias bombs are capped).
- TOML: cursor sync works when tables interleave, and one syntax error no longer hides the rest of the file.
- Excel sheets with 150,000+ rows open; columns wider than the header get names.
- Search finds text written with escapes (`C:\\Users`, `\u00fc`, escaped quotes), and `^…$` regexes match JSON strings.
- JSONPath: filters such as `$[?(@.a==1) && (@.b==2)]` parse, and `\uXXXX` in quoted names is decoded.
- JSON Schema export: accepts the document it came from (null in enums, JSON5 numbers, RFC 3339-exact formats), handles very deep documents, and describes repeated XML elements as arrays.
- Strict `.json` files report invalid numbers (`2024-01-01`, `1.2.3`) as errors and comments, trailing commas, single quotes and duplicate keys as warnings; an empty file says so.
- Table sorting is about 20× faster on large string columns.
- SVG export produces valid XML (font names with quotes broke it) and includes edge labels.

### Code
- Logic flow: return/throw/break/continue inside `try` run `finally` (and Ruby `ensure`) first, so cleanup code is no longer shown as unreachable.
- `goto` jumps to its label (C, C++, PHP, Go); Rust's `?` is an early return, and `let v = match/if/loop …` shows its branches.
- `while (true)`, `while True:` and `for (;;)` no longer get an exit edge; `break label` leaves labeled blocks.
- The outline and the flow view show the same cyclomatic complexity (one documented definition).
- Call graph: a bare call no longer resolves to a class method in Python, JS/TS, Go, Rust or PHP; `from pkg import mod` then `mod.fn()` resolves; the workspace limit is 2,000 files and a truncated graph says so.
- Dependency graph: strings such as `'lib/*.js'` no longer hide imports; no false imports from Python docstrings, PHP trait `use`, or Rust `mod x; use x::Y`; `from pkg import mod` links the module.

### AI agents and CLI
- Four new tools and commands: `data_validate` (`structlens validate`), `data_diff` (`structlens diff`), `data_types` (`structlens types`) and `data_convert` (`structlens convert`).
- `mcp --http` requires a bearer token, checks Host and Origin, and gives each session its own roots (`--root` fixes them).
- `setup` and **Connect AI Agents** edit only the `structlens` entry, keep comments, and leave configs with syntax errors untouched; they write absolute node and cli.js paths and never `npx` (the package is not on npm).
- Boolean CLI flags no longer swallow the next argument.

### Security
- Path confinement follows symbolic links and junctions, ignores case on Windows and macOS, and accepts `file:///C:/…` URLs.
- The browser visualizer page requires its token.
- Links from documents open only for `http`, `https` and `mailto`.

### VS Code
- Activation loads a 4.8 KB entry instead of ~950 KB; the rest loads on first use, and the agent bridge starts only in windows with a folder open.
- The VSIX is smaller (no source maps or stand-alone site).

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
