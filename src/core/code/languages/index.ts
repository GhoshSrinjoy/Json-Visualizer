/** Registers every grammar-backed language adapter. Import for side effects. */

import { registerLanguage } from '../registry';
import { c, cpp } from './cpp';
import { csharp } from './csharp';
import { go } from './go';
import { java } from './java';
import { javascript, tsx, typescript } from './javascript';
import { php } from './php';
import { python } from './python';
import { ruby } from './ruby';
import { rust } from './rust';

for (const spec of [javascript, typescript, tsx, python, java, csharp, go, rust, cpp, c, ruby, php]) registerLanguage(spec);
