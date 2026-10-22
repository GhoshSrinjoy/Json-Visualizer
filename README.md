# StructLens

**See the structure of anything in your workspace: data files, code, whole repositories. Your AI agents can see it too.**

StructLens is a VS Code extension (plus a CLI and an MCP server) that turns JSON, YAML, XML, TOML, CSV and Excel files into fast interactive graphs, tables and schemas. It draws logic-flow and data-flow diagrams for the function under your cursor and maps repositories as trees, treemaps and dependency graphs. The same views are available to GitHub Copilot, Claude Code, Codex, Cursor and any other MCP client.

![Logic flow of the function at the cursor, next to the editor](docs/screenshots/vscode-code-flow.png)

- **Data files.** Graph, tree, table, schema and text views for JSON, JSONC, JSON5, JSON Lines, YAML, XML, HTML, TOML, CSV/TSV, Excel (.xlsx), INI, .env and .properties. Edit values in place, compare two files structurally, validate against a JSON Schema, generate types for nine languages, and convert to YAML, TOML, CSV or XML. Includes JSONPath queries, search, schema inference, value previews (colors, images, dates, JWTs) and click-to-reveal in the editor.
- **Code.** Structure, logic flow (control-flow graph), data flow and call graph for TypeScript, JavaScript, Python, Java, C#, Go, Rust, C, C++, Ruby and PHP, parsed with tree-sitter. Outlines cover about 24 more languages (Kotlin, Swift, Scala, Dart, Lua, Elixir, Haskell, …).
- **Repositories.** File tree with sizes and line counts, a zoomable treemap, folder graph, import/dependency graph with cycle detection, and language statistics. `.gitignore` is respected.
- **AI agents.** 18 read-only tools for Copilot agent mode and an MCP server (stdio or HTTP), including diffs, schema validation and type generation. An agent can also open an interactive diagram in your VS Code window.
- **Fast.** The JSON parser reads about 300 MB/s (a 100 MB file in about a third of a second) and keeps source positions. Parsing runs in a worker. Rendering is a culled, level-of-detail canvas, and big arrays are paged.

## Screenshots

| | |
| --- | --- |
| ![JSON graph](docs/screenshots/vscode-data-graph.png) **JSON graph.** Cards expand on click; big arrays are paged. | ![Data flow](docs/screenshots/vscode-code-dataflow.png) **Data flow.** Parameters → variables → calls → return value. |
| ![Treemap](docs/screenshots/vscode-repo-treemap.png) **Repository treemap** by lines or bytes, colored by language. | ![Dependencies](docs/screenshots/vscode-repo-deps.png) **Dependency graph** at folder or file level; cycles in red. |
| ![Excel table](docs/screenshots/vscode-excel-table.png) **Excel workbook** as a sortable, filterable table. | ![Opened by an agent](docs/screenshots/vscode-agent-opened-flow.png) **Opened by an AI agent** over MCP, inside VS Code. |

Working with data files:

| | |
| --- | --- |
| ![Value previews](docs/screenshots/data-previews.png) **Previews.** Colors, images, dates and decoded JWTs in the Inspector; every edge names its key. | ![Compare](docs/screenshots/data-compare.png) **Compare.** A structural diff: records matched by id, so a reordered list shows moves. |
| ![Validation](docs/screenshots/data-validation.png) **Schema validation.** Errors pinned to their nodes, from the document's own `$schema`. | ![Types](docs/screenshots/data-types.png) **Types** for TypeScript, Zod, Python, Go, Rust, C#, Kotlin, Swift and Java. |
| ![Editing](docs/screenshots/data-edit.png) **Edit in place.** Minimal text edits: comments and formatting stay. | |

Light themes are followed automatically:

![Light theme](docs/screenshots/vscode-code-flow-light.png)

## Install

StructLens needs VS Code 1.101 or newer.

```bash
git clone https://github.com/GhoshSrinjoy/Json-Visualizer.git
cd Json-Visualizer
npm ci
npm run package                                   # → structlens-2.1.0.vsix
code --install-extension structlens-2.1.0.vsix
```

You can also install the `.vsix` from the Extensions view: **⋯ → Install from VSIX…**.

## Using it in VS Code

| Do this | How |
| --- | --- |
| Visualize the current file | `Ctrl+Alt+V` (`Cmd+Alt+V`), or the StructLens button in the editor title bar |
| Logic flow of the function at the cursor | `Ctrl+Alt+F` (`Cmd+Alt+F`), or right-click → **Show Logic Flow** |
| Data flow / call graph / structure | Right-click in a source file, or the Command Palette (**StructLens: Show Data Flow**, **Show Call Graph**, **Show Code Structure**) |
| A folder or the whole repository | Explorer right-click → **Visualize Folder Structure** / **Show Dependency Graph**, or **StructLens: Visualize Workspace** / **Show Repository Treemap** |
| Very large data files | **Open With… → StructLens Visualizer**. It reads the file directly, with no text editor in between. |
| Compare two data files | Select both in the Explorer → right-click → **Compare With…** (with one file selected, you pick the other), or the **Compare** tab |
| Connect Claude Code, Codex, Cursor… | **StructLens: Connect AI Agents (MCP)…** |

The visualizer follows the editor. Moving the cursor selects the matching node or switches to that function's flow, and clicking a node highlights its source. Edits and saves refresh the view.

Inside the visualizer: `1`–`6` switch views, `/` or `Ctrl+F` searches (type `$` for JSONPath), `F` fits, `+`/`-`/`0` zoom, `E`/`C` expand or collapse all, `D` flips the layout direction, `L` toggles key labels on graph edges, `B`/`I` toggle the side panels, and `R` refreshes. In data graphs the arrow keys move between entries (→ expands, ← collapses), `F2` edits the selected value, `Delete` deletes it (after asking), and `F7` steps through the changes of a comparison. `?` lists every shortcut. Every diagram exports to PNG and SVG; code and dependency diagrams also export to Mermaid.

### Data files

- **Graph**: expandable cards, one per object or array, with the type, size and values inline. Each edge is labelled with the key it leads to (`users`, `[0]`, `<item>`). Colors get a swatch, and hovering an image link shows the image. Arrays of records show a sample first, and big arrays are paged. Right-click a card to expand it one or two levels, **Focus on this** (show only that subtree), or **Find all like this** (the same field in every element, as a JSONPath search).
- **Tree**: a virtualized outline that stays fast with millions of nodes.
- **Table**: picks the array of records automatically, with sorting and filtering.
- **Schema**: the inferred structure, including optional fields with presence %, enums, formats (date-time, email, uuid, …) and numeric ranges. **Types & schema** turns it into code: TypeScript, Zod, Python (Pydantic), Go, Rust (serde), C#, Kotlin, Swift, Java (Jackson), JSON Schema, or compact text for AI prompts.
- **Text**: the source with line numbers and syntax issues marked in the gutter. Selecting a node anywhere highlights its lines, and clicking in the text selects the node there. Parsing is tolerant, so a broken file still shows everything that could be read; strict JSON files also get warnings for comments, trailing commas and duplicate keys.
- **Compare**: a structural diff with another file. Key order and formatting don't matter, arrays of records are matched by their ids (so a reordered list shows moves, not a wall of changes), and the formats can differ (JSON against YAML works). Changes are also marked on the graph and tree.

The **Inspector** shows the selected value's path and details, with previews: a swatch and RGB/HSL for colors, the image for image links, local, UTC and relative time for dates and Unix timestamps, the decoded header and claims of a JWT (with its expiry), and JSON stored inside a string.

**Editing**: **Edit**, **Rename**, **Delete** and **Add** in the Inspector (or the right-click menu, `F2`, `Delete`) change the file itself for JSON, JSONC, JSON5, JSON Lines and YAML. Each change is a minimal text edit, so comments and formatting elsewhere are kept; in VS Code it is a normal editor change that Undo reverts. A change is refused if the file was modified after the view read it.

**Validation**: a document with a `$schema` (a path or URL; a YAML `# yaml-language-server: $schema=…` line also works) or a schema associated with it in VS Code's `json.schemas` / `yaml.schemas` is checked against it when it opens. You can also pick a schema in the Inspector. Every error is pinned to its node: red rows and outlined cards in the graph, a list in the Inspector, and a count in the toolbar. JSON Schema drafts 4, 6 and 7, 2019-09 and 2020-12 are supported, including `$ref` across files.

**Export and convert**: the export menu saves the selection (or the document) as JSON, YAML, TOML, CSV, TSV, XML or JSON Lines, and the right-click menu copies any value as JSON or YAML. Large integers keep all their digits in every format.

Excel workbooks become one record array per sheet (the first row is the header, and dates are decoded). They then work with the same views, queries and schema inference as JSON.

### Code

- **Structure**: classes, functions, methods and fields with signatures, line ranges and cyclomatic complexity.
- **Logic flow**: decisions with yes/no branches, loops with back edges, `switch`/`match` cases, `try`/`catch`/`finally` (early exits run the `finally` first), early returns, `throw`, `break`/`continue`, `goto`, Rust's `?` and unreachable code.
- **Data flow**: how values move through a function: parameters → locals → calls → return value, plus fields written, collections mutated and loop iteration.
- **Calls**: the call graph of the file or the whole workspace, resolved through imports.

### Repositories

**Files** (sizes, line counts, languages), **Treemap**, **Graph**, **Dependencies** and **Stats**. The dependency graph handles TypeScript path aliases and workspaces, Python packages, Go modules, Java/Kotlin/C# packages, C/C++ includes, Rust `mod`/`use`, PHP PSR-4 and CSS imports. It reports cycles, hubs and external packages.

## Connect AI agents

### GitHub Copilot (VS Code)

The tools are registered automatically for Copilot Chat in **Agent** mode. Pick them in the tools menu, or reference them in a prompt, for example `#repoOverview`, `#fileStructure`, `#codeFlow` or `#dependencyGraph`. You can turn this off with `structlens.ai.copilotTools`.

### Claude Code, Codex, Cursor, Gemini CLI, Windsurf, Claude Desktop

Run **StructLens: Connect AI Agents (MCP)…** and pick a client. It adds the StructLens MCP server to that client's configuration:

| Client | Where it is configured |
| --- | --- |
| Claude Code | `.mcp.json` in the project, or user scope through `claude mcp add` |
| OpenAI Codex (CLI and IDE) | `~/.codex/config.toml` |
| Cursor | `.cursor/mcp.json` |
| Gemini CLI | `.gemini/settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop | `claude_desktop_config.json` |
| Anything else | **Copy MCP server JSON** |

The extension keeps a copy of the server in VS Code's global storage and refreshes it when the extension updates. It runs with your `node` 18+ (written as an absolute path) or with VS Code's own runtime. Existing client configs are edited in place: only the `structlens` entry changes, comments are kept, and a config with syntax errors is left alone.

Without VS Code, use the CLI from a clone (`npm ci && npm run build`):

```bash
node dist/cli.js setup claude             # or: codex, cursor, gemini, windsurf, claude-desktop, vscode, json
node dist/cli.js setup codex --dry-run    # show what would be written
```

Or add it by hand:

```bash
claude mcp add structlens -- node /path/to/Json-Visualizer/dist/cli.js mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.structlens]
command = "node"
args = ["/path/to/Json-Visualizer/dist/cli.js", "mcp"]
```

The server uses the client's workspace roots, or `--root <dir>` (repeatable). For clients that connect over HTTP, run `structlens mcp --http 7811`: the endpoint is `http://127.0.0.1:7811/mcp`, and clients send the printed token as `Authorization: Bearer <token>` (pin it with `--token` or `STRUCTLENS_TOKEN`). Each HTTP session uses its own client roots; `--root` fixes them.

```bash
claude mcp add --transport http structlens http://127.0.0.1:7811/mcp --header "Authorization: Bearer <token>"
```

### What agents can do

| Tool | What it returns |
| --- | --- |
| `repo_overview` | File and line counts, languages, largest files, key config and entry files, top of the tree |
| `repo_tree` | Directory tree with file and line counts |
| `file_structure` | The structure of any file: a schema for data, an outline for code |
| `data_schema` | Inferred schema as text, JSON Schema or TypeScript |
| `data_query` | JSONPath results with paths, line numbers and values |
| `data_search` | Keys and values matching text |
| `data_tree` | An outline of the values at a path |
| `data_validate` | Errors against a JSON Schema (the document's `$schema`, or one you name), each with its path and line |
| `data_diff` | The structural differences between two data files |
| `data_types` | Type declarations for TypeScript, Zod, Python, Go, Rust, C#, Kotlin, Swift or Java |
| `data_convert` | A data file (or part of it) as YAML, TOML, CSV, TSV, XML or JSON Lines |
| `code_outline` | Symbols, imports and exports with line ranges |
| `code_flow` | A function's control-flow graph as Mermaid and text, with complexity |
| `code_dataflow` | How values move through a function |
| `call_graph` | Who calls what, across files |
| `dependency_graph` | The import graph with cycles, hubs and external packages |
| `find_symbol` | Where a symbol is defined |
| `open_visualizer` | Opens the interactive diagram for the user, in VS Code or the browser |

Every tool is read-only and limited to the workspace roots. Output is plain text and Mermaid, sized for a model's context.

When an agent such as Claude Code or Codex calls `open_visualizer`, the diagram opens **inside your VS Code window** if the extension is running there. Otherwise it opens in a browser, or with `--no-browser` the agent gets a link to share.

## Command line

The commands return the same output that agents get:

```text
structlens [path]                 Interactive visualizer in the browser
structlens overview <path>        Repository summary
structlens tree <path>            Directory tree with file and line counts
structlens structure <path>       Structure of any data or source file
structlens schema <path>          Inferred schema (--format text | json-schema | typescript)
structlens query <path> <query>   JSONPath query
structlens search <path> <text>   Search keys and values
structlens values <path> <at>     Outline of the values at a path
structlens validate <path>        Check against a JSON Schema (--schema <file or URL>)
structlens diff <old> <new>       Structural differences between two data files
structlens types <path>           Type declarations (--language typescript | zod | python | go | rust | csharp | kotlin | swift | java)
structlens convert <path>         Convert (--to yaml | toml | csv | tsv | xml | jsonl)
structlens outline <path>         Symbols, imports and exports
structlens flow <path> <fn>       Control flow of a function (--format mermaid | text)
structlens dataflow <path> <fn>   Data flow of a function
structlens calls <paths>          Call graph
structlens deps <path>            Dependency graph (--level folder | file)
structlens find <query> <path>    Find symbol definitions
structlens mcp                    MCP server (stdio, or --http <port>)
structlens setup <client>         Register the MCP server with an AI client
```

```bash
structlens query data/users.json '$.users[?(@.active && @.age > 30)].email'
structlens schema exports/orders.xlsx --format typescript
structlens diff config/prod.yaml config/staging.yaml
structlens types api/response.json --language go
structlens validate deploy.yaml --schema https://json.schemastore.org/github-workflow.json
structlens flow src/server.ts handleRequest --format mermaid
```

From a clone, run `node dist/cli.js …`, or `npm link` once to get a `structlens` command.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `structlens.graph.direction` | `LR` | Layout direction of data and structure graphs |
| `structlens.graph.initialDepth` | `3` | Levels expanded when a document opens |
| `structlens.graph.maxVisibleNodes` | `1500` | Upper bound for **Expand all** |
| `structlens.graph.childPageSize` | `50` | Rows per card before “show more” |
| `structlens.graph.edgeLabels` | `true` | Label graph edges with the key they lead to |
| `structlens.data.autoValidate` | `true` | Validate data files against their `$schema` or associated schema when they open |
| `structlens.animations` / `structlens.minimap` | `true` | Layout animations, minimap |
| `structlens.followCursor` | `true` | Sync the selection with the editor cursor |
| `structlens.theme` | `auto` | `auto` follows the VS Code theme |
| `structlens.repo.respectGitignore` | `true` | Honor `.gitignore` files |
| `structlens.repo.exclude` | VCS, dependency and cache folders | Always-excluded patterns |
| `structlens.repo.maxFiles` | `200000` | Scan limit |
| `structlens.repo.countLines` | `true` | Count lines while scanning |
| `structlens.ai.copilotTools` | `true` | Offer the tools to Copilot agent mode |
| `structlens.ai.mcpServer` | `false` | Also publish StructLens through VS Code's MCP support |
| `structlens.ai.bridge` | `true` | Let MCP agents open views in this window |

## Privacy and security

Everything runs locally and nothing is uploaded. StructLens only reaches the network to download a schema that a document references by URL (VS Code's `json.schemaDownload.enable` turns this off) and to show an image preview when you select or hover an image link. The agent bridge, the browser visualizer and the HTTP MCP server listen on `127.0.0.1` only and require a random per-session token. Bridge details are stored in `~/.structlens/bridges`, readable only by you. MCP tools are read-only, and paths outside the workspace roots are rejected, including through symbolic links or junctions. Links from documents open only for `http`, `https` and `mailto`.

## Development

```bash
npm ci
npm run build          # or: npm run watch
npm test               # unit tests (vitest)
npm run typecheck
npm run test:vscode    # smoke test in a real VS Code with a throw-away profile
npm run screenshots    # the smoke test, saving docs/screenshots/*.png
npm run bench          # parser benchmark on generated 100 MB files
npm run package        # build the .vsix
```

Press `F5` with the repository open to launch an Extension Development Host. The code is laid out as follows:

- `src/core`: platform-independent parsers, analysis and layout.
- `src/node`: the workspace, file system and agent bridge.
- `src/mcp`: tool definitions and the server.
- `src/extension`: the VS Code integration.
- `src/webview`: the UI, shared by VS Code, the CLI server and the static site in `dist/web`.

## License

[MIT](LICENSE) © Srinjoy Ghosh
