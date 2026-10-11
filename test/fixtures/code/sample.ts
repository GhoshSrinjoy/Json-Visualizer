import { readFile } from 'node:fs/promises';
import * as path from 'path';
import Default, { helper as h } from './util';
export { other } from './other';

export interface Shape { area(): number }
type Id = string | number;
export enum Color { Red, Green }

/** Loads users and keeps the active ones. */
export async function loadUsers(file: string, limit = 10): Promise<User[]> {
  const raw = await readFile(file, 'utf8');
  const data = JSON.parse(raw);
  let result: User[] = [];
  if (!Array.isArray(data)) {
    throw new Error('bad data');
  } else if (data.length === 0) {
    return [];
  } else {
    for (const item of data) {
      if (item.disabled) continue;
      const user = new User(item.name, item.age);
      result.push(user);
      if (result.length >= limit) break;
    }
  }
  try {
    validate(result);
  } catch (err) {
    console.error(err);
  } finally {
    h(result);
  }
  return result;
}

export class User extends Base implements Shape {
  private static count = 0;
  constructor(public name: string, private age: number) {
    super();
    User.count++;
  }
  area(): number { return this.age * 2; }
  get label() { return `${this.name} (${this.age})`; }
  describe(kind: string): string {
    switch (kind) {
      case 'short':
        return this.name;
      case 'long':
      case 'full':
        return this.label;
      default:
        return format(this.name, kind);
    }
  }
}

const validate = (users: User[]) => {
  let i = 0;
  while (i < users.length) {
    i++;
  }
  do { i--; } while (i > 0);
  return users.every((u) => u.area() > 0);
};

function format(a: string, b: string) { return a + b; }
