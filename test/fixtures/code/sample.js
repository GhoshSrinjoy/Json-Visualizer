const fs = require('fs');
const { join } = require('path');
import('./lazy.js').then((m) => m.run());

class Cache extends Map {
  constructor(limit) {
    super();
    this.limit = limit;
  }
  set(key, value) {
    if (this.size >= this.limit) {
      const first = this.keys().next().value;
      this.delete(first);
    }
    return super.set(key, value);
  }
}

function readAll(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith('.')) continue;
    out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

module.exports = { Cache, readAll };
