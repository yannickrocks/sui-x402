import { readFileSync } from "node:fs";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

export const fixtureText = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8").trim();
