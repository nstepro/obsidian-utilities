import matter from 'gray-matter';

// matter.stringify(string, ...) re-parses the string, so a body that itself starts with
// a bad '---' block throws. Pass an object to skip the parse.
export function stringifyNote(content, data) {
    return matter.stringify({ content }, data);
}

// True if the leading '---' front matter block contains a top-level publish: key
export function hasPublishKey(text) {
    const block = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    return block !== null && /^publish:/m.test(block[1]);
}
