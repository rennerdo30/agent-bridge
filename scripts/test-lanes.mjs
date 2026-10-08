import { readdirSync, readFileSync } from "node:fs";

// Tests that touch real storage, sockets or native processes belong to the integration lane.
// Also include shared fixture modules, so adding a fixture cannot silently move a test to fast.
const names = readdirSync(new URL("../test/", import.meta.url)).filter(name => name.endsWith(".test.ts"));
const integrationPattern = /node:(?:child_process|sqlite|net|http|worker_threads)|makeEnv|createWorktree|mkdtemp|installTranscriptFixtures|conversation-test-fixture|BridgeNode|BridgeClient|MessageStore|startUi/;
export const integrationTests = names.filter(name => integrationPattern.test(readFileSync(new URL(`../test/${name}`, import.meta.url), "utf8"))).map(name => `test/${name}`);
export const fastTests = names.map(name => `test/${name}`).filter(name => !integrationTests.includes(name));
