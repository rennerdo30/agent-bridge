import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("src/assets", {recursive: true});
await mkdir("public", {recursive: true});
await copyFile("../assets/logo.svg", "src/assets/logo.svg");
await copyFile("../assets/logo.svg", "public/favicon.svg");
await cp("images", "public/images", {recursive: true});
