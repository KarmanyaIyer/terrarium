// How a reply reads: real tokenizer pieces (Qwen3.5 4B sends * and - as tokens of their own), and marks split across tokens.

import assert from "node:assert/strict";
import { test } from "node:test";
import { plainLine, plainText, readable, type Run } from "../src/lib/replyText.ts";

/** Marks up runs, so a test reads like what's on screen: [b:bold] [i:italic] [bi:both]. */
const tag = (r: Run) => (r.bold && r.italic ? `[bi:${r.text}]` : r.bold ? `[b:${r.text}]` : r.italic ? `[i:${r.text}]` : r.text);
/** Neighbouring runs with one style read as one, wherever the tokens fell. */
const show = (text: string | string[]) => {
  const runs: Run[] = [];
  for (const r of readable(Array.isArray(text) ? text : [text]).flat()) {
    const last = runs.at(-1);
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else runs.push({ ...r });
  }
  return runs.map(tag).join("");
};

const BULLET = "•";

test("a line-start * or - is a bullet only with a space after it", () => {
  assert.equal(plainText("* item one\n- item two\n    * nested"), `${BULLET} item one\n${BULLET} item two\n    ${BULLET} nested`);
  assert.equal(show(["*", "Cl", "ang", "!", " Cl", "ang", "!*", " You are iron."]), "[i:Clang! Clang!] You are iron.");
  assert.equal(plainText("It was cold.\n-3 degrees at dawn."), "It was cold.\n-3 degrees at dawn.");
  assert.equal(show(["-", "3", " degrees"]), "-3 degrees");
  assert.equal(show(["-", " ", "three"]), `${BULLET} three`);
});

test("a heading needs a space after its marks", () => {
  assert.equal(show("### Heading\ntext after"), "[b:Heading]\ntext after");
  assert.equal(show("#hashtag is a tag\nnext line"), "#hashtag is a tag\nnext line");
  assert.equal(show("###Heading\ntext"), "###Heading\ntext");
  assert.equal(show(["#", "hash", "tag"]), "#hashtag");
  assert.equal(show(["#", " Real", " one"]), "[b:Real one]");
});

test("bold stays inside its pair, and a paragraph ends what it opened", () => {
  assert.equal(show("Compute 2**3 which is 8. This is normal.\n\nSo is this."), "Compute 2**3 which is 8. This is normal.\n\nSo is this.");
  assert.equal(show("**Note: never closed\n\nSecond paragraph.\n\nThird."), "Note: never closed\n\nSecond paragraph.\n\nThird.");
  assert.equal(show("This is **bold** and this is not."), "This is [b:bold] and this is not.");
  assert.equal(show("**Term**: a thing, 2**3 too"), "[b:Term]: a thing, 2**3 too");
  assert.equal(show("**One line\nand the next**"), "[b:One line\nand the next]");
  assert.equal(show("1. **Foo:** bar\n2. **Baz:** qux"), "1. [b:Foo:] bar\n2. [b:Baz:] qux");
  assert.equal(show("* **Bold:** two\n* plain"), `${BULLET} [b:Bold:] two\n${BULLET} plain`);
  assert.equal(show("* **never closed\n* next item"), `${BULLET} never closed\n${BULLET} next item`);
});

test("*** on its own is a rule, and around a word it is both", () => {
  assert.equal(show("Intro\n\n***\n\nAfter the rule."), "Intro\n\nAfter the rule.");
  assert.equal(show("Intro\n\n---\n\nAfter the rule."), "Intro\n\nAfter the rule.");
  assert.equal(show("Intro\n\n- - -\n\nAfter."), "Intro\n\nAfter.");
  assert.equal(show("This is ***very*** important. And this is not."), "This is [bi:very] important. And this is not.");
  assert.equal(show("***a** b*"), "[bi:a][i: b]");
});

test("marks split across tokens still pair", () => {
  assert.equal(show(["*", "*", "Bold", "*", "*", " rest"]), "[b:Bold] rest");
  assert.equal(show(["**", "Bold", "**", " rest\n", "*", " item"]), `[b:Bold] rest\n${BULLET} item`);
  assert.equal(show(["But I *", "can", "* help."]), "But I [i:can] help.");
});

test("italics, and stars that aren't", () => {
  assert.equal(show("But I *can* help you."), "But I [i:can] help you.");
  assert.equal(show("2*3*4 and 5 * 3 * 2"), "2*3*4 and 5 * 3 * 2");
  assert.equal(show("snake*case* stays"), "snake*case* stays");
  assert.equal(show("cut off at the *limit"), "cut off at the limit");
  assert.equal(show("cut off **"), "cut off ");
  assert.equal(show("a \\*not\\* b"), "a \\*not\\* b");
});

test("code is left as written", () => {
  assert.equal(show("Use `2 * 3 * x` and `**a**` here"), "Use `2 * 3 * x` and `**a**` here");
  assert.equal(show("```python\n# comment\n* star\nx = 2**3\n```\n# Real heading"), "```python\n# comment\n* star\nx = 2**3\n```\n[b:Real heading]");
});

test("a result per piece, and a piece of marks keeps its index", () => {
  const out = readable(["**", "Bold", "**", " rest"]);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], []);
  assert.deepEqual(out[1], [{ text: "Bold", bold: true, italic: false }]);
  assert.deepEqual(out[2], []);
  assert.deepEqual(out[3], [{ text: " rest", bold: false, italic: false }]);
  // a click on piece i names the same token whatever came before it
  const shown = readable(["The", " **", "cat", "**", " sat"]);
  assert.equal(shown.findIndex((r) => r.some((x) => x.text.includes("sat"))), 4);
  assert.equal(shown.findIndex((r) => r.some((x) => x.text.includes("cat"))), 2);
  assert.deepEqual(readable([]), []);
  assert.deepEqual(readable([""]), [[]]);
  // surrogate pairs and CJK come through whole
  assert.equal(plainText("**庆祝** 🎉"), "庆祝 🎉");
});

test("previews: one line, no marks", () => {
  assert.equal(plainLine("*Clang! Clang!* You are **iron**.\n\n* Pasta\n* Canned"), `Clang! Clang! You are iron. ${BULLET} Pasta ${BULLET} Canned`);
  assert.equal(plainLine("  ### Title\n\ntext  "), "Title text");
  assert.equal(plainText("**A**\n\nB"), "A\n\nB");
  assert.equal(plainLine(""), "");
});

test("a line ending CRLF reads the same", () => {
  assert.equal(show("**Bold**\r\n* item"), `[b:Bold]\r\n${BULLET} item`);
  assert.equal(show("One\r\n\r\n---\r\n\r\nTwo"), "One\r\n\r\nTwo");
});
