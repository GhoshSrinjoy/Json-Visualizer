/** File type detection for repository maps (names, colors and categories). */

export type FileCategory = 'code' | 'data' | 'markup' | 'style' | 'docs' | 'config' | 'build' | 'test' | 'asset' | 'binary' | 'other';

export interface FileLanguage {
  id: string;
  name: string;
  /** GitHub Linguist-style color. */
  color: string;
  category: FileCategory;
}

const L = (id: string, name: string, color: string, category: FileCategory): FileLanguage => ({ id, name, color, category });

const LANGS: Record<string, FileLanguage> = {
  typescript: L('typescript', 'TypeScript', '#3178c6', 'code'),
  javascript: L('javascript', 'JavaScript', '#f1e05a', 'code'),
  python: L('python', 'Python', '#3572A5', 'code'),
  go: L('go', 'Go', '#00ADD8', 'code'),
  rust: L('rust', 'Rust', '#dea584', 'code'),
  java: L('java', 'Java', '#b07219', 'code'),
  kotlin: L('kotlin', 'Kotlin', '#A97BFF', 'code'),
  scala: L('scala', 'Scala', '#c22d40', 'code'),
  groovy: L('groovy', 'Groovy', '#4298b8', 'code'),
  csharp: L('csharp', 'C#', '#178600', 'code'),
  fsharp: L('fsharp', 'F#', '#b845fc', 'code'),
  vb: L('vb', 'Visual Basic', '#945db7', 'code'),
  c: L('c', 'C', '#555555', 'code'),
  cpp: L('cpp', 'C++', '#f34b7d', 'code'),
  objc: L('objective-c', 'Objective-C', '#438eff', 'code'),
  swift: L('swift', 'Swift', '#F05138', 'code'),
  ruby: L('ruby', 'Ruby', '#701516', 'code'),
  php: L('php', 'PHP', '#4F5D95', 'code'),
  dart: L('dart', 'Dart', '#00B4AB', 'code'),
  lua: L('lua', 'Lua', '#000080', 'code'),
  elixir: L('elixir', 'Elixir', '#6e4a7e', 'code'),
  erlang: L('erlang', 'Erlang', '#B83998', 'code'),
  haskell: L('haskell', 'Haskell', '#5e5086', 'code'),
  ocaml: L('ocaml', 'OCaml', '#ef7a08', 'code'),
  clojure: L('clojure', 'Clojure', '#db5855', 'code'),
  perl: L('perl', 'Perl', '#0298c3', 'code'),
  r: L('r', 'R', '#198CE7', 'code'),
  julia: L('julia', 'Julia', '#a270ba', 'code'),
  zig: L('zig', 'Zig', '#ec915c', 'code'),
  nim: L('nim', 'Nim', '#ffc200', 'code'),
  solidity: L('solidity', 'Solidity', '#AA6746', 'code'),
  shell: L('shellscript', 'Shell', '#89e051', 'code'),
  powershell: L('powershell', 'PowerShell', '#012456', 'code'),
  batch: L('bat', 'Batch', '#C1F12E', 'code'),
  sql: L('sql', 'SQL', '#e38c00', 'code'),
  vue: L('vue', 'Vue', '#41b883', 'code'),
  svelte: L('svelte', 'Svelte', '#ff3e00', 'code'),
  astro: L('astro', 'Astro', '#ff5a03', 'code'),
  html: L('html', 'HTML', '#e34c26', 'markup'),
  xml: L('xml', 'XML', '#0060ac', 'data'),
  svg: L('svg', 'SVG', '#ff9900', 'asset'),
  css: L('css', 'CSS', '#663399', 'style'),
  scss: L('scss', 'SCSS', '#c6538c', 'style'),
  less: L('less', 'Less', '#1d365d', 'style'),
  json: L('json', 'JSON', '#cbcb41', 'data'),
  yaml: L('yaml', 'YAML', '#cb171e', 'data'),
  toml: L('toml', 'TOML', '#9c4221', 'config'),
  ini: L('ini', 'INI', '#d1dbe0', 'config'),
  env: L('dotenv', 'Env', '#e5d559', 'config'),
  csv: L('csv', 'CSV', '#237346', 'data'),
  markdown: L('markdown', 'Markdown', '#083fa1', 'docs'),
  rst: L('restructuredtext', 'reStructuredText', '#141414', 'docs'),
  text: L('plaintext', 'Text', '#8b949e', 'docs'),
  protobuf: L('proto', 'Protocol Buffers', '#6a8ab6', 'code'),
  graphql: L('graphql', 'GraphQL', '#e10098', 'code'),
  dockerfile: L('dockerfile', 'Dockerfile', '#384d54', 'build'),
  makefile: L('makefile', 'Makefile', '#427819', 'build'),
  cmake: L('cmake', 'CMake', '#DA3434', 'build'),
  gradle: L('gradle', 'Gradle', '#02303a', 'build'),
  terraform: L('terraform', 'HCL', '#844FBA', 'config'),
  nix: L('nix', 'Nix', '#7e7eff', 'config'),
  notebook: L('jupyter', 'Jupyter Notebook', '#DA5B0B', 'code'),
  image: L('image', 'Image', '#a371f7', 'asset'),
  font: L('font', 'Font', '#7d8590', 'asset'),
  media: L('media', 'Media', '#db61a2', 'asset'),
  archive: L('archive', 'Archive', '#6e7681', 'binary'),
  binary: L('binary', 'Binary', '#484f58', 'binary'),
  lock: L('lock', 'Lockfile', '#6e7681', 'build'),
  license: L('license', 'License', '#8b949e', 'docs'),
};

const EXT: Record<string, keyof typeof LANGS> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python', pyi: 'python', ipynb: 'notebook',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  groovy: 'groovy', gradle: 'gradle', cs: 'csharp', csx: 'csharp', fs: 'fsharp', fsx: 'fsharp', vb: 'vb',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ipp: 'cpp', ino: 'cpp',
  m: 'objc', mm: 'objc', swift: 'swift', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php', phtml: 'php',
  dart: 'dart', lua: 'lua', ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang', hs: 'haskell', ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', pl: 'perl', pm: 'perl', r: 'r', jl: 'julia', zig: 'zig', nim: 'nim',
  sol: 'solidity', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'batch', cmd: 'batch', sql: 'sql', vue: 'vue', svelte: 'svelte', astro: 'astro',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', csproj: 'xml',
  fsproj: 'xml', vbproj: 'xml', vcxproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', xaml: 'xml', svg: 'svg',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'css',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', webmanifest: 'json', map: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'env',
  csv: 'csv', tsv: 'csv', md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'rst', txt: 'text', adoc: 'text',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql', tf: 'terraform', tfvars: 'terraform', hcl: 'terraform', nix: 'nix',
  cmake: 'cmake', mk: 'makefile', lock: 'lock',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', tif: 'image', tiff: 'image', avif: 'image', heic: 'image', psd: 'image',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
  mp3: 'media', mp4: 'media', wav: 'media', ogg: 'media', webm: 'media', mov: 'media', avi: 'media', flac: 'media', m4a: 'media',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', rar: 'archive', '7z': 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', vsix: 'archive', jar: 'archive', whl: 'archive',
  exe: 'binary', dll: 'binary', so: 'binary', dylib: 'binary', o: 'binary', a: 'binary', lib: 'binary', obj: 'binary', class: 'binary',
  pyc: 'binary', wasm: 'binary', bin: 'binary', dat: 'binary', db: 'binary', sqlite: 'binary', pdf: 'binary', doc: 'binary', docx: 'binary',
  xls: 'binary', xlsx: 'binary', ppt: 'binary', pptx: 'binary', pdb: 'binary', node: 'binary',
};

const NAMES: Record<string, keyof typeof LANGS> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', rakefile: 'ruby', gemfile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', jenkinsfile: 'groovy',
  'build.gradle': 'gradle', 'settings.gradle': 'gradle', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.env': 'env', '.gitignore': 'ini', '.gitattributes': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini',
  license: 'license', 'license.md': 'license', 'license.txt': 'license', copying: 'license',
  'package-lock.json': 'lock', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock', 'cargo.lock': 'lock', 'poetry.lock': 'lock',
  'composer.lock': 'lock', 'gemfile.lock': 'lock', 'go.sum': 'lock', 'uv.lock': 'lock', 'bun.lockb': 'lock',
  'go.mod': 'go', pipfile: 'toml',
};

export const UNKNOWN_LANGUAGE: FileLanguage = L('other', 'Other', '#6e7681', 'other');

export function fileLanguage(name: string): FileLanguage {
  const lower = name.toLowerCase();
  const byName = NAMES[lower];
  if (byName) return LANGS[byName];
  if (lower.startsWith('.env')) return LANGS.env;
  if (lower.startsWith('dockerfile') || lower.endsWith('.dockerfile')) return LANGS.dockerfile;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    const hit = EXT[ext];
    if (hit) return LANGS[hit];
  }
  return UNKNOWN_LANGUAGE;
}

/** Test files by common naming conventions (used to tag the category). */
export function isTestPath(relPath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|specs)\//i.test(relPath) || /[._-](test|spec)\.[a-z0-9]+$/i.test(relPath) || /(^|\/)test_[^/]+\.py$/.test(relPath);
}

/** Text files we can count lines in (skip binaries/assets). */
export function isTextLanguage(lang: FileLanguage): boolean {
  return lang.category !== 'binary' && lang.id !== 'image' && lang.id !== 'font' && lang.id !== 'media' && lang.id !== 'archive';
}

/** NUL byte in the first 8 KB means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
