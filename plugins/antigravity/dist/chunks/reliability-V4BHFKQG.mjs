import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  pluginSourceDir
} from "./chunk-IRP5OBTX.mjs";
import {
  AjvJsonSchemaValidator,
  CallToolResultSchema,
  CompleteResultSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  CreateTaskResultSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  EmptyResultSchema,
  ErrorCode,
  GetPromptResultSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListChangedOptionsBaseSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  McpError,
  PromptListChangedNotificationSchema,
  Protocol,
  ReadBuffer,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  ToolListChangedNotificationSchema,
  assertClientRequestTaskCapability,
  assertToolsCallTaskCapability,
  getLiteralValue,
  getObjectShape,
  mergeCapabilities,
  safeParse,
  serializeMessage
} from "./chunk-DDASK4CX.mjs";
import {
  codexPermissionHookTrusted
} from "./chunk-IOGZQ3DT.mjs";
import {
  createWorktree,
  finishWorktree
} from "./chunk-WK4T53Z5.mjs";
import {
  PermissionRelay,
  delegateToAntigravity,
  delegateToClaude,
  delegateToCodex,
  delegateToCodexAppServer,
  delegateToOpencode,
  delegateToOpencodeServed,
  readStore,
  resolveBinary
} from "./chunk-7KRAJNI6.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-HGNNXUUG.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveHome
} from "./chunk-35H7HOLN.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-O3D4XOXC.mjs";
import "./chunk-6HI567DZ.mjs";
import "./chunk-22I6GVQM.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-C3IT2QV3.mjs";
import "./chunk-KIW2YSIK.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-D26YRNXK.mjs";
import "./chunk-JJWO6ADJ.mjs";
import "./chunk-TFQZM67X.mjs";
import "./chunk-OHCADHNH.mjs";
import "./chunk-GY7VUHKV.mjs";
import {
  DEFAULT_CLAUDE_BIN,
  DEFAULT_CODEX_BIN,
  DEFAULT_OPENCODE_BIN,
  LOG_DIR_NAME,
  MAX_WAIT_SEC
} from "./chunk-GWP4RZPO.mjs";
import {
  __commonJS,
  __require,
  __toESM
} from "./chunk-HHAVWD7J.mjs";

// node_modules/isexe/windows.js
var require_windows = __commonJS({
  "node_modules/isexe/windows.js"(exports, module) {
    module.exports = isexe;
    isexe.sync = sync;
    var fs = __require("fs");
    function checkPathExt(path, options) {
      var pathext = options.pathExt !== void 0 ? options.pathExt : process.env.PATHEXT;
      if (!pathext) {
        return true;
      }
      pathext = pathext.split(";");
      if (pathext.indexOf("") !== -1) {
        return true;
      }
      for (var i = 0; i < pathext.length; i++) {
        var p = pathext[i].toLowerCase();
        if (p && path.substr(-p.length).toLowerCase() === p) {
          return true;
        }
      }
      return false;
    }
    function checkStat(stat, path, options) {
      if (!stat.isSymbolicLink() && !stat.isFile()) {
        return false;
      }
      return checkPathExt(path, options);
    }
    function isexe(path, options, cb) {
      fs.stat(path, function(er, stat) {
        cb(er, er ? false : checkStat(stat, path, options));
      });
    }
    function sync(path, options) {
      return checkStat(fs.statSync(path), path, options);
    }
  }
});

// node_modules/isexe/mode.js
var require_mode = __commonJS({
  "node_modules/isexe/mode.js"(exports, module) {
    module.exports = isexe;
    isexe.sync = sync;
    var fs = __require("fs");
    function isexe(path, options, cb) {
      fs.stat(path, function(er, stat) {
        cb(er, er ? false : checkStat(stat, options));
      });
    }
    function sync(path, options) {
      return checkStat(fs.statSync(path), options);
    }
    function checkStat(stat, options) {
      return stat.isFile() && checkMode(stat, options);
    }
    function checkMode(stat, options) {
      var mod = stat.mode;
      var uid = stat.uid;
      var gid = stat.gid;
      var myUid = options.uid !== void 0 ? options.uid : process.getuid && process.getuid();
      var myGid = options.gid !== void 0 ? options.gid : process.getgid && process.getgid();
      var u = parseInt("100", 8);
      var g = parseInt("010", 8);
      var o = parseInt("001", 8);
      var ug = u | g;
      var ret = mod & o || mod & g && gid === myGid || mod & u && uid === myUid || mod & ug && myUid === 0;
      return ret;
    }
  }
});

// node_modules/isexe/index.js
var require_isexe = __commonJS({
  "node_modules/isexe/index.js"(exports, module) {
    var fs = __require("fs");
    var core;
    if (process.platform === "win32" || global.TESTING_WINDOWS) {
      core = require_windows();
    } else {
      core = require_mode();
    }
    module.exports = isexe;
    isexe.sync = sync;
    function isexe(path, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = {};
      }
      if (!cb) {
        if (typeof Promise !== "function") {
          throw new TypeError("callback not provided");
        }
        return new Promise(function(resolve, reject) {
          isexe(path, options || {}, function(er, is) {
            if (er) {
              reject(er);
            } else {
              resolve(is);
            }
          });
        });
      }
      core(path, options || {}, function(er, is) {
        if (er) {
          if (er.code === "EACCES" || options && options.ignoreErrors) {
            er = null;
            is = false;
          }
        }
        cb(er, is);
      });
    }
    function sync(path, options) {
      try {
        return core.sync(path, options || {});
      } catch (er) {
        if (options && options.ignoreErrors || er.code === "EACCES") {
          return false;
        } else {
          throw er;
        }
      }
    }
  }
});

// node_modules/which/which.js
var require_which = __commonJS({
  "node_modules/which/which.js"(exports, module) {
    var isWindows = process.platform === "win32" || process.env.OSTYPE === "cygwin" || process.env.OSTYPE === "msys";
    var path = __require("path");
    var COLON = isWindows ? ";" : ":";
    var isexe = require_isexe();
    var getNotFoundError = (cmd) => Object.assign(new Error(`not found: ${cmd}`), { code: "ENOENT" });
    var getPathInfo = (cmd, opt) => {
      const colon = opt.colon || COLON;
      const pathEnv = cmd.match(/\//) || isWindows && cmd.match(/\\/) ? [""] : [
        // windows always checks the cwd first
        ...isWindows ? [process.cwd()] : [],
        ...(opt.path || process.env.PATH || /* istanbul ignore next: very unusual */
        "").split(colon)
      ];
      const pathExtExe = isWindows ? opt.pathExt || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM" : "";
      const pathExt = isWindows ? pathExtExe.split(colon) : [""];
      if (isWindows) {
        if (cmd.indexOf(".") !== -1 && pathExt[0] !== "")
          pathExt.unshift("");
      }
      return {
        pathEnv,
        pathExt,
        pathExtExe
      };
    };
    var which = (cmd, opt, cb) => {
      if (typeof opt === "function") {
        cb = opt;
        opt = {};
      }
      if (!opt)
        opt = {};
      const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);
      const found = [];
      const step = (i) => new Promise((resolve, reject) => {
        if (i === pathEnv.length)
          return opt.all && found.length ? resolve(found) : reject(getNotFoundError(cmd));
        const ppRaw = pathEnv[i];
        const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;
        const pCmd = path.join(pathPart, cmd);
        const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd;
        resolve(subStep(p, i, 0));
      });
      const subStep = (p, i, ii) => new Promise((resolve, reject) => {
        if (ii === pathExt.length)
          return resolve(step(i + 1));
        const ext = pathExt[ii];
        isexe(p + ext, { pathExt: pathExtExe }, (er, is) => {
          if (!er && is) {
            if (opt.all)
              found.push(p + ext);
            else
              return resolve(p + ext);
          }
          return resolve(subStep(p, i, ii + 1));
        });
      });
      return cb ? step(0).then((res) => cb(null, res), cb) : step(0);
    };
    var whichSync = (cmd, opt) => {
      opt = opt || {};
      const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);
      const found = [];
      for (let i = 0; i < pathEnv.length; i++) {
        const ppRaw = pathEnv[i];
        const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;
        const pCmd = path.join(pathPart, cmd);
        const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd;
        for (let j = 0; j < pathExt.length; j++) {
          const cur = p + pathExt[j];
          try {
            const is = isexe.sync(cur, { pathExt: pathExtExe });
            if (is) {
              if (opt.all)
                found.push(cur);
              else
                return cur;
            }
          } catch (ex) {
          }
        }
      }
      if (opt.all && found.length)
        return found;
      if (opt.nothrow)
        return null;
      throw getNotFoundError(cmd);
    };
    module.exports = which;
    which.sync = whichSync;
  }
});

// node_modules/path-key/index.js
var require_path_key = __commonJS({
  "node_modules/path-key/index.js"(exports, module) {
    "use strict";
    var pathKey = (options = {}) => {
      const environment = options.env || process.env;
      const platform = options.platform || process.platform;
      if (platform !== "win32") {
        return "PATH";
      }
      return Object.keys(environment).reverse().find((key) => key.toUpperCase() === "PATH") || "Path";
    };
    module.exports = pathKey;
    module.exports.default = pathKey;
  }
});

// node_modules/cross-spawn/lib/util/resolveCommand.js
var require_resolveCommand = __commonJS({
  "node_modules/cross-spawn/lib/util/resolveCommand.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var which = require_which();
    var getPathKey = require_path_key();
    function resolveCommandAttempt(parsed, withoutPathExt) {
      const env = parsed.options.env || process.env;
      const cwd = process.cwd();
      const hasCustomCwd = parsed.options.cwd != null;
      const shouldSwitchCwd = hasCustomCwd && process.chdir !== void 0 && !process.chdir.disabled;
      if (shouldSwitchCwd) {
        try {
          process.chdir(parsed.options.cwd);
        } catch (err) {
        }
      }
      let resolved;
      try {
        resolved = which.sync(parsed.command, {
          path: env[getPathKey({ env })],
          pathExt: withoutPathExt ? path.delimiter : void 0
        });
      } catch (e) {
      } finally {
        if (shouldSwitchCwd) {
          process.chdir(cwd);
        }
      }
      if (resolved) {
        resolved = path.resolve(hasCustomCwd ? parsed.options.cwd : "", resolved);
      }
      return resolved;
    }
    function resolveCommand(parsed) {
      return resolveCommandAttempt(parsed) || resolveCommandAttempt(parsed, true);
    }
    module.exports = resolveCommand;
  }
});

// node_modules/cross-spawn/lib/util/escape.js
var require_escape = __commonJS({
  "node_modules/cross-spawn/lib/util/escape.js"(exports, module) {
    "use strict";
    var metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
    function escapeCommand(arg) {
      arg = arg.replace(metaCharsRegExp, "^$1");
      return arg;
    }
    function escapeArgument(arg, doubleEscapeMetaChars) {
      arg = `${arg}`;
      arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
      arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
      arg = `"${arg}"`;
      arg = arg.replace(metaCharsRegExp, "^$1");
      if (doubleEscapeMetaChars) {
        arg = arg.replace(metaCharsRegExp, "^$1");
      }
      return arg;
    }
    module.exports.command = escapeCommand;
    module.exports.argument = escapeArgument;
  }
});

// node_modules/shebang-regex/index.js
var require_shebang_regex = __commonJS({
  "node_modules/shebang-regex/index.js"(exports, module) {
    "use strict";
    module.exports = /^#!(.*)/;
  }
});

// node_modules/shebang-command/index.js
var require_shebang_command = __commonJS({
  "node_modules/shebang-command/index.js"(exports, module) {
    "use strict";
    var shebangRegex = require_shebang_regex();
    module.exports = (string = "") => {
      const match = string.match(shebangRegex);
      if (!match) {
        return null;
      }
      const [path, argument] = match[0].replace(/#! ?/, "").split(" ");
      const binary = path.split("/").pop();
      if (binary === "env") {
        return argument;
      }
      return argument ? `${binary} ${argument}` : binary;
    };
  }
});

// node_modules/cross-spawn/lib/util/readShebang.js
var require_readShebang = __commonJS({
  "node_modules/cross-spawn/lib/util/readShebang.js"(exports, module) {
    "use strict";
    var fs = __require("fs");
    var shebangCommand = require_shebang_command();
    function readShebang(command) {
      const size = 150;
      const buffer = Buffer.alloc(size);
      let fd;
      try {
        fd = fs.openSync(command, "r");
        fs.readSync(fd, buffer, 0, size, 0);
        fs.closeSync(fd);
      } catch (e) {
      }
      return shebangCommand(buffer.toString());
    }
    module.exports = readShebang;
  }
});

// node_modules/cross-spawn/lib/parse.js
var require_parse = __commonJS({
  "node_modules/cross-spawn/lib/parse.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var resolveCommand = require_resolveCommand();
    var escape = require_escape();
    var readShebang = require_readShebang();
    var isWin = process.platform === "win32";
    var isExecutableRegExp = /\.(?:com|exe)$/i;
    var isCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
    function detectShebang(parsed) {
      parsed.file = resolveCommand(parsed);
      const shebang = parsed.file && readShebang(parsed.file);
      if (shebang) {
        parsed.args.unshift(parsed.file);
        parsed.command = shebang;
        return resolveCommand(parsed);
      }
      return parsed.file;
    }
    function parseNonShell(parsed) {
      if (!isWin) {
        return parsed;
      }
      const commandFile = detectShebang(parsed);
      const needsShell = !isExecutableRegExp.test(commandFile);
      if (parsed.options.forceShell || needsShell) {
        const needsDoubleEscapeMetaChars = isCmdShimRegExp.test(commandFile);
        parsed.command = path.normalize(parsed.command);
        parsed.command = escape.command(parsed.command);
        parsed.args = parsed.args.map((arg) => escape.argument(arg, needsDoubleEscapeMetaChars));
        const shellCommand = [parsed.command].concat(parsed.args).join(" ");
        parsed.args = ["/d", "/s", "/c", `"${shellCommand}"`];
        parsed.command = process.env.comspec || "cmd.exe";
        parsed.options.windowsVerbatimArguments = true;
      }
      return parsed;
    }
    function parse(command, args, options) {
      if (args && !Array.isArray(args)) {
        options = args;
        args = null;
      }
      args = args ? args.slice(0) : [];
      options = Object.assign({}, options);
      const parsed = {
        command,
        args,
        options,
        file: void 0,
        original: {
          command,
          args
        }
      };
      return options.shell ? parsed : parseNonShell(parsed);
    }
    module.exports = parse;
  }
});

// node_modules/cross-spawn/lib/enoent.js
var require_enoent = __commonJS({
  "node_modules/cross-spawn/lib/enoent.js"(exports, module) {
    "use strict";
    var isWin = process.platform === "win32";
    function notFoundError(original, syscall) {
      return Object.assign(new Error(`${syscall} ${original.command} ENOENT`), {
        code: "ENOENT",
        errno: "ENOENT",
        syscall: `${syscall} ${original.command}`,
        path: original.command,
        spawnargs: original.args
      });
    }
    function hookChildProcess(cp, parsed) {
      if (!isWin) {
        return;
      }
      const originalEmit = cp.emit;
      cp.emit = function(name, arg1) {
        if (name === "exit") {
          const err = verifyENOENT(arg1, parsed);
          if (err) {
            return originalEmit.call(cp, "error", err);
          }
        }
        return originalEmit.apply(cp, arguments);
      };
    }
    function verifyENOENT(status, parsed) {
      if (isWin && status === 1 && !parsed.file) {
        return notFoundError(parsed.original, "spawn");
      }
      return null;
    }
    function verifyENOENTSync(status, parsed) {
      if (isWin && status === 1 && !parsed.file) {
        return notFoundError(parsed.original, "spawnSync");
      }
      return null;
    }
    module.exports = {
      hookChildProcess,
      verifyENOENT,
      verifyENOENTSync,
      notFoundError
    };
  }
});

// node_modules/cross-spawn/index.js
var require_cross_spawn = __commonJS({
  "node_modules/cross-spawn/index.js"(exports, module) {
    "use strict";
    var cp = __require("child_process");
    var parse = require_parse();
    var enoent = require_enoent();
    function spawn2(command, args, options) {
      const parsed = parse(command, args, options);
      const spawned = cp.spawn(parsed.command, parsed.args, parsed.options);
      enoent.hookChildProcess(spawned, parsed);
      return spawned;
    }
    function spawnSync(command, args, options) {
      const parsed = parse(command, args, options);
      const result = cp.spawnSync(parsed.command, parsed.args, parsed.options);
      result.error = result.error || enoent.verifyENOENTSync(result.status, parsed);
      return result;
    }
    module.exports = spawn2;
    module.exports.spawn = spawn2;
    module.exports.sync = spawnSync;
    module.exports._parse = parse;
    module.exports._enoent = enoent;
  }
});

// src/cli/reliability.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync as mkdtempSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";

// src/cli/reliability-live.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/client.js
var ExperimentalClientTasks = class {
  constructor(_client) {
    this._client = _client;
  }
  /**
   * Calls a tool and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * This method provides streaming access to tool execution, allowing you to
   * observe intermediate task status updates for long-running tool calls.
   * Automatically validates structured output if the tool has an outputSchema.
   *
   * @example
   * ```typescript
   * const stream = client.experimental.tasks.callToolStream({ name: 'myTool', arguments: {} });
   * for await (const message of stream) {
   *   switch (message.type) {
   *     case 'taskCreated':
   *       console.log('Tool execution started:', message.task.taskId);
   *       break;
   *     case 'taskStatus':
   *       console.log('Tool status:', message.task.status);
   *       break;
   *     case 'result':
   *       console.log('Tool result:', message.result);
   *       break;
   *     case 'error':
   *       console.error('Tool error:', message.error);
   *       break;
   *   }
   * }
   * ```
   *
   * @param params - Tool call parameters (name and arguments)
   * @param resultSchema - Zod schema for validating the result (defaults to CallToolResultSchema)
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  async *callToolStream(params, resultSchema = CallToolResultSchema, options) {
    const clientInternal = this._client;
    const optionsWithTask = {
      ...options,
      // We check if the tool is known to be a task during auto-configuration, but assume
      // the caller knows what they're doing if they pass this explicitly
      task: options?.task ?? (clientInternal.isToolTask(params.name) ? {} : void 0)
    };
    const stream = clientInternal.requestStream({ method: "tools/call", params }, resultSchema, optionsWithTask);
    const validator = clientInternal.getToolOutputValidator(params.name);
    for await (const message of stream) {
      if (message.type === "result" && validator) {
        const result = message.result;
        if (!result.structuredContent && !result.isError) {
          yield {
            type: "error",
            error: new McpError(ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`)
          };
          return;
        }
        if (result.structuredContent) {
          try {
            const validationResult = validator(result.structuredContent);
            if (!validationResult.valid) {
              yield {
                type: "error",
                error: new McpError(ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`)
              };
              return;
            }
          } catch (error) {
            if (error instanceof McpError) {
              yield { type: "error", error };
              return;
            }
            yield {
              type: "error",
              error: new McpError(ErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`)
            };
            return;
          }
        }
      }
      yield message;
    }
  }
  /**
   * Gets the current status of a task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   * @returns The task status
   *
   * @experimental
   */
  async getTask(taskId, options) {
    return this._client.getTask({ taskId }, options);
  }
  /**
   * Retrieves the result of a completed task.
   *
   * @param taskId - The task identifier
   * @param resultSchema - Zod schema for validating the result
   * @param options - Optional request options
   * @returns The task result
   *
   * @experimental
   */
  async getTaskResult(taskId, resultSchema, options) {
    return this._client.getTaskResult({ taskId }, resultSchema, options);
  }
  /**
   * Lists tasks with optional pagination.
   *
   * @param cursor - Optional pagination cursor
   * @param options - Optional request options
   * @returns List of tasks with optional next cursor
   *
   * @experimental
   */
  async listTasks(cursor, options) {
    return this._client.listTasks(cursor ? { cursor } : void 0, options);
  }
  /**
   * Cancels a running task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   *
   * @experimental
   */
  async cancelTask(taskId, options) {
    return this._client.cancelTask({ taskId }, options);
  }
  /**
   * Sends a request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * This method provides streaming access to request processing, allowing you to
   * observe intermediate task status updates for task-augmented requests.
   *
   * @param request - The request to send
   * @param resultSchema - Zod schema for validating the result
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  requestStream(request, resultSchema, options) {
    return this._client.requestStream(request, resultSchema, options);
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js
function applyElicitationDefaults(schema, data) {
  if (!schema || data === null || typeof data !== "object")
    return;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const obj = data;
    const props = schema.properties;
    for (const key of Object.keys(props)) {
      const propSchema = props[key];
      if (obj[key] === void 0 && Object.prototype.hasOwnProperty.call(propSchema, "default")) {
        obj[key] = propSchema.default;
      }
      if (obj[key] !== void 0) {
        applyElicitationDefaults(propSchema, obj[key]);
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    for (const sub of schema.anyOf) {
      if (typeof sub !== "boolean") {
        applyElicitationDefaults(sub, data);
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    for (const sub of schema.oneOf) {
      if (typeof sub !== "boolean") {
        applyElicitationDefaults(sub, data);
      }
    }
  }
}
function getSupportedElicitationModes(capabilities) {
  if (!capabilities) {
    return { supportsFormMode: false, supportsUrlMode: false };
  }
  const hasFormCapability = capabilities.form !== void 0;
  const hasUrlCapability = capabilities.url !== void 0;
  const supportsFormMode = hasFormCapability || !hasFormCapability && !hasUrlCapability;
  const supportsUrlMode = hasUrlCapability;
  return { supportsFormMode, supportsUrlMode };
}
var Client = class extends Protocol {
  /**
   * Initializes this client with the given name and version information.
   */
  constructor(_clientInfo, options) {
    super(options);
    this._clientInfo = _clientInfo;
    this._cachedToolOutputValidators = /* @__PURE__ */ new Map();
    this._cachedKnownTaskTools = /* @__PURE__ */ new Set();
    this._cachedRequiredTaskTools = /* @__PURE__ */ new Set();
    this._listChangedDebounceTimers = /* @__PURE__ */ new Map();
    this._capabilities = options?.capabilities ?? {};
    this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();
    if (options?.listChanged) {
      this._pendingListChangedConfig = options.listChanged;
    }
  }
  /**
   * Set up handlers for list changed notifications based on config and server capabilities.
   * This should only be called after initialization when server capabilities are known.
   * Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability.
   * @internal
   */
  _setupListChangedHandlers(config) {
    if (config.tools && this._serverCapabilities?.tools?.listChanged) {
      this._setupListChangedHandler("tools", ToolListChangedNotificationSchema, config.tools, async () => {
        const result = await this.listTools();
        return result.tools;
      });
    }
    if (config.prompts && this._serverCapabilities?.prompts?.listChanged) {
      this._setupListChangedHandler("prompts", PromptListChangedNotificationSchema, config.prompts, async () => {
        const result = await this.listPrompts();
        return result.prompts;
      });
    }
    if (config.resources && this._serverCapabilities?.resources?.listChanged) {
      this._setupListChangedHandler("resources", ResourceListChangedNotificationSchema, config.resources, async () => {
        const result = await this.listResources();
        return result.resources;
      });
    }
  }
  /**
   * Access experimental features.
   *
   * WARNING: These APIs are experimental and may change without notice.
   *
   * @experimental
   */
  get experimental() {
    if (!this._experimental) {
      this._experimental = {
        tasks: new ExperimentalClientTasks(this)
      };
    }
    return this._experimental;
  }
  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  registerCapabilities(capabilities) {
    if (this.transport) {
      throw new Error("Cannot register capabilities after connecting to transport");
    }
    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }
  /**
   * Override request handler registration to enforce client-side validation for elicitation.
   */
  setRequestHandler(requestSchema, handler) {
    const shape = getObjectShape(requestSchema);
    const methodSchema = shape?.method;
    if (!methodSchema) {
      throw new Error("Schema is missing a method literal");
    }
    const methodValue = getLiteralValue(methodSchema);
    if (typeof methodValue !== "string") {
      throw new Error("Schema method literal must be a string");
    }
    const method = methodValue;
    if (method === "elicitation/create") {
      const wrappedHandler = async (request, extra) => {
        const validatedRequest = safeParse(ElicitRequestSchema, request);
        if (!validatedRequest.success) {
          const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation request: ${errorMessage}`);
        }
        const { params } = validatedRequest.data;
        params.mode = params.mode ?? "form";
        const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);
        if (params.mode === "form" && !supportsFormMode) {
          throw new McpError(ErrorCode.InvalidParams, "Client does not support form-mode elicitation requests");
        }
        if (params.mode === "url" && !supportsUrlMode) {
          throw new McpError(ErrorCode.InvalidParams, "Client does not support URL-mode elicitation requests");
        }
        const result = await Promise.resolve(handler(request, extra));
        if (params.task) {
          const taskValidationResult = safeParse(CreateTaskResultSchema, result);
          if (!taskValidationResult.success) {
            const errorMessage = taskValidationResult.error instanceof Error ? taskValidationResult.error.message : String(taskValidationResult.error);
            throw new McpError(ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
          }
          return taskValidationResult.data;
        }
        const validationResult = safeParse(ElicitResultSchema, result);
        if (!validationResult.success) {
          const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid elicitation result: ${errorMessage}`);
        }
        const validatedResult = validationResult.data;
        const requestedSchema = params.mode === "form" ? params.requestedSchema : void 0;
        if (params.mode === "form" && validatedResult.action === "accept" && validatedResult.content && requestedSchema) {
          if (this._capabilities.elicitation?.form?.applyDefaults) {
            try {
              applyElicitationDefaults(requestedSchema, validatedResult.content);
            } catch {
            }
          }
        }
        return validatedResult;
      };
      return super.setRequestHandler(requestSchema, wrappedHandler);
    }
    if (method === "sampling/createMessage") {
      const wrappedHandler = async (request, extra) => {
        const validatedRequest = safeParse(CreateMessageRequestSchema, request);
        if (!validatedRequest.success) {
          const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid sampling request: ${errorMessage}`);
        }
        const { params } = validatedRequest.data;
        const result = await Promise.resolve(handler(request, extra));
        if (params.task) {
          const taskValidationResult = safeParse(CreateTaskResultSchema, result);
          if (!taskValidationResult.success) {
            const errorMessage = taskValidationResult.error instanceof Error ? taskValidationResult.error.message : String(taskValidationResult.error);
            throw new McpError(ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
          }
          return taskValidationResult.data;
        }
        const hasTools = params.tools || params.toolChoice;
        const resultSchema = hasTools ? CreateMessageResultWithToolsSchema : CreateMessageResultSchema;
        const validationResult = safeParse(resultSchema, result);
        if (!validationResult.success) {
          const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid sampling result: ${errorMessage}`);
        }
        return validationResult.data;
      };
      return super.setRequestHandler(requestSchema, wrappedHandler);
    }
    return super.setRequestHandler(requestSchema, handler);
  }
  assertCapability(capability, method) {
    if (!this._serverCapabilities?.[capability]) {
      throw new Error(`Server does not support ${capability} (required for ${method})`);
    }
  }
  async connect(transport, options) {
    await super.connect(transport);
    if (transport.sessionId !== void 0) {
      return;
    }
    try {
      const result = await this.request({
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: this._capabilities,
          clientInfo: this._clientInfo
        }
      }, InitializeResultSchema, options);
      if (result === void 0) {
        throw new Error(`Server sent invalid initialize result: ${result}`);
      }
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
      }
      this._serverCapabilities = result.capabilities;
      this._serverVersion = result.serverInfo;
      if (transport.setProtocolVersion) {
        transport.setProtocolVersion(result.protocolVersion);
      }
      this._instructions = result.instructions;
      await this.notification({
        method: "notifications/initialized"
      });
      if (this._pendingListChangedConfig) {
        this._setupListChangedHandlers(this._pendingListChangedConfig);
        this._pendingListChangedConfig = void 0;
      }
    } catch (error) {
      void this.close();
      throw error;
    }
  }
  /**
   * After initialization has completed, this will be populated with the server's reported capabilities.
   */
  getServerCapabilities() {
    return this._serverCapabilities;
  }
  /**
   * After initialization has completed, this will be populated with information about the server's name and version.
   */
  getServerVersion() {
    return this._serverVersion;
  }
  /**
   * After initialization has completed, this may be populated with information about the server's instructions.
   */
  getInstructions() {
    return this._instructions;
  }
  assertCapabilityForMethod(method) {
    switch (method) {
      case "logging/setLevel":
        if (!this._serverCapabilities?.logging) {
          throw new Error(`Server does not support logging (required for ${method})`);
        }
        break;
      case "prompts/get":
      case "prompts/list":
        if (!this._serverCapabilities?.prompts) {
          throw new Error(`Server does not support prompts (required for ${method})`);
        }
        break;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        if (!this._serverCapabilities?.resources) {
          throw new Error(`Server does not support resources (required for ${method})`);
        }
        if (method === "resources/subscribe" && !this._serverCapabilities.resources.subscribe) {
          throw new Error(`Server does not support resource subscriptions (required for ${method})`);
        }
        break;
      case "tools/call":
      case "tools/list":
        if (!this._serverCapabilities?.tools) {
          throw new Error(`Server does not support tools (required for ${method})`);
        }
        break;
      case "completion/complete":
        if (!this._serverCapabilities?.completions) {
          throw new Error(`Server does not support completions (required for ${method})`);
        }
        break;
      case "initialize":
        break;
      case "ping":
        break;
    }
  }
  assertNotificationCapability(method) {
    switch (method) {
      case "notifications/roots/list_changed":
        if (!this._capabilities.roots?.listChanged) {
          throw new Error(`Client does not support roots list changed notifications (required for ${method})`);
        }
        break;
      case "notifications/initialized":
        break;
      case "notifications/cancelled":
        break;
      case "notifications/progress":
        break;
    }
  }
  assertRequestHandlerCapability(method) {
    if (!this._capabilities) {
      return;
    }
    switch (method) {
      case "sampling/createMessage":
        if (!this._capabilities.sampling) {
          throw new Error(`Client does not support sampling capability (required for ${method})`);
        }
        break;
      case "elicitation/create":
        if (!this._capabilities.elicitation) {
          throw new Error(`Client does not support elicitation capability (required for ${method})`);
        }
        break;
      case "roots/list":
        if (!this._capabilities.roots) {
          throw new Error(`Client does not support roots capability (required for ${method})`);
        }
        break;
      case "tasks/get":
      case "tasks/list":
      case "tasks/result":
      case "tasks/cancel":
        if (!this._capabilities.tasks) {
          throw new Error(`Client does not support tasks capability (required for ${method})`);
        }
        break;
      case "ping":
        break;
    }
  }
  assertTaskCapability(method) {
    assertToolsCallTaskCapability(this._serverCapabilities?.tasks?.requests, method, "Server");
  }
  assertTaskHandlerCapability(method) {
    if (!this._capabilities) {
      return;
    }
    assertClientRequestTaskCapability(this._capabilities.tasks?.requests, method, "Client");
  }
  async ping(options) {
    return this.request({ method: "ping" }, EmptyResultSchema, options);
  }
  async complete(params, options) {
    return this.request({ method: "completion/complete", params }, CompleteResultSchema, options);
  }
  async setLoggingLevel(level, options) {
    return this.request({ method: "logging/setLevel", params: { level } }, EmptyResultSchema, options);
  }
  async getPrompt(params, options) {
    return this.request({ method: "prompts/get", params }, GetPromptResultSchema, options);
  }
  async listPrompts(params, options) {
    return this.request({ method: "prompts/list", params }, ListPromptsResultSchema, options);
  }
  async listResources(params, options) {
    return this.request({ method: "resources/list", params }, ListResourcesResultSchema, options);
  }
  async listResourceTemplates(params, options) {
    return this.request({ method: "resources/templates/list", params }, ListResourceTemplatesResultSchema, options);
  }
  async readResource(params, options) {
    return this.request({ method: "resources/read", params }, ReadResourceResultSchema, options);
  }
  async subscribeResource(params, options) {
    return this.request({ method: "resources/subscribe", params }, EmptyResultSchema, options);
  }
  async unsubscribeResource(params, options) {
    return this.request({ method: "resources/unsubscribe", params }, EmptyResultSchema, options);
  }
  /**
   * Calls a tool and waits for the result. Automatically validates structured output if the tool has an outputSchema.
   *
   * For task-based execution with streaming behavior, use client.experimental.tasks.callToolStream() instead.
   */
  async callTool(params, resultSchema = CallToolResultSchema, options) {
    if (this.isToolTaskRequired(params.name)) {
      throw new McpError(ErrorCode.InvalidRequest, `Tool "${params.name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`);
    }
    const result = await this.request({ method: "tools/call", params }, resultSchema, options);
    const validator = this.getToolOutputValidator(params.name);
    if (validator) {
      if (!result.structuredContent && !result.isError) {
        throw new McpError(ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
      }
      if (result.structuredContent) {
        try {
          const validationResult = validator(result.structuredContent);
          if (!validationResult.valid) {
            throw new McpError(ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`);
          }
        } catch (error) {
          if (error instanceof McpError) {
            throw error;
          }
          throw new McpError(ErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return result;
  }
  isToolTask(toolName) {
    if (!this._serverCapabilities?.tasks?.requests?.tools?.call) {
      return false;
    }
    return this._cachedKnownTaskTools.has(toolName);
  }
  /**
   * Check if a tool requires task-based execution.
   * Unlike isToolTask which includes 'optional' tools, this only checks for 'required'.
   */
  isToolTaskRequired(toolName) {
    return this._cachedRequiredTaskTools.has(toolName);
  }
  /**
   * Cache validators for tool output schemas.
   * Called after listTools() to pre-compile validators for better performance.
   */
  cacheToolMetadata(tools) {
    this._cachedToolOutputValidators.clear();
    this._cachedKnownTaskTools.clear();
    this._cachedRequiredTaskTools.clear();
    for (const tool of tools) {
      if (tool.outputSchema) {
        const toolValidator = this._jsonSchemaValidator.getValidator(tool.outputSchema);
        this._cachedToolOutputValidators.set(tool.name, toolValidator);
      }
      const taskSupport = tool.execution?.taskSupport;
      if (taskSupport === "required" || taskSupport === "optional") {
        this._cachedKnownTaskTools.add(tool.name);
      }
      if (taskSupport === "required") {
        this._cachedRequiredTaskTools.add(tool.name);
      }
    }
  }
  /**
   * Get cached validator for a tool
   */
  getToolOutputValidator(toolName) {
    return this._cachedToolOutputValidators.get(toolName);
  }
  async listTools(params, options) {
    const result = await this.request({ method: "tools/list", params }, ListToolsResultSchema, options);
    this.cacheToolMetadata(result.tools);
    return result;
  }
  /**
   * Set up a single list changed handler.
   * @internal
   */
  _setupListChangedHandler(listType, notificationSchema, options, fetcher) {
    const parseResult = ListChangedOptionsBaseSchema.safeParse(options);
    if (!parseResult.success) {
      throw new Error(`Invalid ${listType} listChanged options: ${parseResult.error.message}`);
    }
    if (typeof options.onChanged !== "function") {
      throw new Error(`Invalid ${listType} listChanged options: onChanged must be a function`);
    }
    const { autoRefresh, debounceMs } = parseResult.data;
    const { onChanged } = options;
    const refresh = async () => {
      if (!autoRefresh) {
        onChanged(null, null);
        return;
      }
      try {
        const items = await fetcher();
        onChanged(null, items);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        onChanged(error, null);
      }
    };
    const handler = () => {
      if (debounceMs) {
        const existingTimer = this._listChangedDebounceTimers.get(listType);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timer = setTimeout(refresh, debounceMs);
        this._listChangedDebounceTimers.set(listType, timer);
      } else {
        refresh();
      }
    };
    this.setNotificationHandler(notificationSchema, handler);
  }
  async sendRootsListChanged() {
    return this.notification({ method: "notifications/roots/list_changed" });
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js
var import_cross_spawn = __toESM(require_cross_spawn(), 1);
import process2 from "node:process";
import { PassThrough } from "node:stream";
var DEFAULT_INHERITED_ENV_VARS = process2.platform === "win32" ? [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES"
] : (
  /* list inspired by the default env inheritance of sudo */
  ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
);
function getDefaultEnvironment() {
  const env = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process2.env[key];
    if (value === void 0) {
      continue;
    }
    if (value.startsWith("()")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}
var StdioClientTransport = class {
  constructor(server) {
    this._stderrStream = null;
    this._serverParams = server;
    this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
    if (server.stderr === "pipe" || server.stderr === "overlapped") {
      this._stderrStream = new PassThrough();
    }
  }
  /**
   * Starts the server process and prepares to communicate with it.
   */
  async start() {
    if (this._process) {
      throw new Error("StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.");
    }
    return new Promise((resolve, reject) => {
      this._process = (0, import_cross_spawn.default)(this._serverParams.command, this._serverParams.args ?? [], {
        // merge default env with server env because mcp server needs some env vars
        env: {
          ...getDefaultEnvironment(),
          ...this._serverParams.env
        },
        stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
        shell: false,
        windowsHide: process2.platform === "win32",
        cwd: this._serverParams.cwd
      });
      this._process.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      this._process.on("spawn", () => {
        resolve();
      });
      this._process.on("close", (_code) => {
        this._process = void 0;
        this.onclose?.();
      });
      this._process.stdin?.on("error", (error) => {
        this.onerror?.(error);
      });
      this._process.stdout?.on("data", (chunk) => {
        try {
          this._readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error);
          this.close().catch(() => {
          });
        }
      });
      this._process.stdout?.on("error", (error) => {
        this.onerror?.(error);
      });
      if (this._stderrStream && this._process.stderr) {
        this._process.stderr.pipe(this._stderrStream);
      }
    });
  }
  /**
   * The stderr stream of the child process, if `StdioServerParameters.stderr` was set to "pipe" or "overlapped".
   *
   * If stderr piping was requested, a PassThrough stream is returned _immediately_, allowing callers to
   * attach listeners before the start method is invoked. This prevents loss of any early
   * error output emitted by the child process.
   */
  get stderr() {
    if (this._stderrStream) {
      return this._stderrStream;
    }
    return this._process?.stderr ?? null;
  }
  /**
   * The child process pid spawned by this transport.
   *
   * This is only available after the transport has been started.
   */
  get pid() {
    return this._process?.pid ?? null;
  }
  processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }
  async close() {
    if (this._process) {
      const processToClose = this._process;
      this._process = void 0;
      const closePromise = new Promise((resolve) => {
        processToClose.once("close", () => {
          resolve();
        });
      });
      try {
        processToClose.stdin?.end();
      } catch {
      }
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2e3).unref())]);
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGTERM");
        } catch {
        }
        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2e3).unref())]);
      }
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGKILL");
        } catch {
        }
      }
    }
    this._readBuffer.clear();
  }
  send(message) {
    return new Promise((resolve) => {
      if (!this._process?.stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once("drain", resolve);
      }
    });
  }
};

// src/cli/reliability-live.ts
var SERVER_BUNDLE = join("dist", "server.mjs");
var JOBS_FILE = "jobs.json";
var NOTE_COUNT = 12;
var NOTES_DIR = "notes";
var LONG_TASK = `Read the files ${NOTES_DIR}/note-01.txt to ${NOTES_DIR}/note-${String(NOTE_COUNT).padStart(2, "0")}.txt one at a time, in order. Use a separate tool call for each file; never read several files in one call. After each file, write one sentence that summarizes it before you read the next one. At the end, list all your summaries.`;
var LIVE_QUESTION = "Quick question while you work: how many of the note files have you read so far? Answer in one short sentence, then continue the task.";
var FACT = "pineapple-42";
var FACT_PROMPT = `Remember this for later: the fixture for this task is called ${FACT}. Reply with only the word OK.`;
var FACT_QUESTION = "What is the fixture for this task called? Reply with only its name.";
var JOB_TIMEOUT_SEC = 900;
var SERVER_START_TIMEOUT_MS = 3e4;
var WORKING_TIMEOUT_MS = 18e4;
var ANSWER_TIMEOUT_MS = 3e5;
var RESULT_TIMEOUT_MS = 9e5;
var SESSION_TIMEOUT_MS = 18e4;
var SERVER_EXIT_TIMEOUT_MS = 2e4;
var POLL_MS = 1e3;
var CALL_SLACK_MS = 3e4;
var PROCESS_LIST_TIMEOUT_MS = 3e4;
var APPROVAL_TIMEOUT_SEC = 300;
var DETAIL_CHARS = 80;
var FEED_START = "started \xB7";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var short = (s) => JSON.stringify(s.trim().replace(/\s+/g, " ").slice(0, DETAIL_CHARS));
function hostFor(target) {
  return target === "codex" ? "claude" : "codex";
}
function serverBundle(host, fromFile) {
  const dir = pluginSourceDir(host, SERVER_BUNDLE, fromFile);
  return dir ? join(dir, SERVER_BUNDLE) : null;
}
function jobNameIn(text) {
  return /Subagent (\S+-job-[0-9a-f]+) started/.exec(text)?.[1] ?? /message_subagent\(job="([^"]+)"/.exec(text)?.[1] ?? null;
}
function finalStatusOf(job, body) {
  const m = new RegExp(`^Subagent ${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^)]*\\) (done|failed|cancelled) after \\d+s\\.`).exec(body.trim());
  return m?.[1] ?? null;
}
function messageBody(text) {
  return /<agent-bridge-message [^>]*>\n([\s\S]*)\n<\/agent-bridge-message>/.exec(text)?.[1] ?? text;
}
var isApprovalQuestion = (job, body) => body.trim().startsWith(`Subagent ${job} asks for approval`);
function listProcesses() {
  const win = process.platform === "win32";
  const [file, args] = win ? [
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }'
    ]
  ] : ["ps", ["-A", "-o", "pid=,ppid=,pgid="]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const procs = [];
      for (const line of stdout.split(/\r?\n/)) {
        const [a, b, c] = line.trim().split(/\s+/);
        if (!a || !b || !/^\d+$/.test(a)) continue;
        procs.push(win ? { pid: Number(a), ppid: Number(b), started: c } : { pid: Number(a), ppid: Number(b), pgid: Number(c) });
      }
      resolve(procs);
    });
  });
}
function processTree(procs, root) {
  const tree = procs.filter((p) => p.pid === root);
  for (let i = 0; i < tree.length; i++) {
    const parent = tree[i];
    for (const p of procs) if (p.ppid === parent.pid && p.pid !== parent.pid && !tree.includes(p)) tree.push(p);
  }
  return tree;
}
function leftovers(tree, now, ownGroup) {
  const same = (a, b) => a.pid === b.pid && (a.started === void 0 || a.started === b.started);
  const groups = new Set(tree.map((p) => p.pgid).filter((g) => g !== void 0 && g !== ownGroup));
  return now.filter((p) => tree.some((t) => same(t, p)) || p.pgid !== void 0 && groups.has(p.pgid));
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function storedJob(home, job) {
  try {
    const all = readStore(join(home, JOBS_FILE));
    return all.find((j) => j.name === job) ?? null;
  } catch {
    return null;
  }
}
var PICKED_UP_LOG = "subagent picked up messages";
function logsMention(home, text) {
  try {
    const dir = join(home, LOG_DIR_NAME);
    return readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes(text));
  } catch {
    return false;
  }
}
async function until(timeoutMs, fn) {
  const end = Date.now() + timeoutMs;
  for (; ; ) {
    const v = await fn();
    if (v !== null && v !== void 0) return v;
    if (Date.now() > end) return null;
    await sleep(POLL_MS);
  }
}
var LiveHost = class _LiveHost {
  constructor(client, transport, pid) {
    this.client = client;
    this.transport = transport;
    this.pid = pid;
  }
  client;
  transport;
  pid;
  static async start(bundle, host, home, cwd) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, `--agent=${host}`],
      cwd,
      env: {
        ...process.env,
        AGENT_BRIDGE_HOME: home,
        CLAUDE_PROJECT_DIR: cwd,
        AGENT_BRIDGE_DASHBOARD: "off",
        AGENT_BRIDGE_DELIVERY: "hooks",
        AGENT_BRIDGE_AUTO_WAKE: "off"
      },
      stderr: "ignore"
    });
    const client = new Client({ name: "agent-bridge-reliability", version: "0.0.0" });
    await client.connect(transport, { timeout: SERVER_START_TIMEOUT_MS });
    return new _LiveHost(client, transport, transport.pid ?? 0);
  }
  async call(name, args, timeoutMs = CALL_SLACK_MS) {
    const r = await this.client.callTool({ name, arguments: args }, void 0, { timeout: timeoutMs });
    return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: Boolean(r.isError) };
  }
  /** The next message from the job (approval questions it asks are denied), or null after the timeout. */
  async next(job, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const sec = Math.max(1, Math.min(MAX_WAIT_SEC, Math.ceil((end - Date.now()) / 1e3)));
      const r = await this.call("wait_for_message", { from: job, timeout_sec: sec }, sec * 1e3 + CALL_SLACK_MS);
      if (r.isError) await sleep(POLL_MS);
      if (r.isError || /^No message arrived/.test(r.text)) continue;
      const body = messageBody(r.text);
      if (isApprovalQuestion(job, body)) {
        await this.call("decide", { approval_id: /approval_id="([0-9a-f-]{36})"/.exec(body)?.[1], decision: "deny", reason: "the reliability suite allows nothing here" });
        continue;
      }
      return body;
    }
    return null;
  }
  /** Wait for the job's final result, skipping other messages. */
  async result(job, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (; ; ) {
      const body = await this.next(job, end - Date.now());
      if (body === null) return null;
      const status = finalStatusOf(job, body);
      if (status) return { status, body };
    }
  }
  /** Progress line of a running job in `peers`, once it reports a real step (not just its start). */
  async working(job) {
    const peers = await this.call("peers", {});
    const line = peers.text.split("\n").find((l) => l.startsWith(`- ${job} (`));
    const progress = line?.slice(line.indexOf("): ") + 3).trim();
    return progress && progress !== "starting" && !progress.startsWith(FEED_START) ? progress : null;
  }
  /** Status of a finished (or interrupted) job as `peers` lists it. */
  async listedStatus(job) {
    const peers = await this.call("peers", {});
    return new RegExp(`^- ${job}: (\\w+)`, "m").exec(peers.text)?.[1] ?? null;
  }
  async close() {
    await this.client.close().catch(() => {
    });
    await until(SERVER_EXIT_TIMEOUT_MS, () => alive(this.pid) ? null : true);
  }
};
function writeNotes(dir) {
  mkdirSync(join(dir, NOTES_DIR), { recursive: true });
  for (let i = 1; i <= NOTE_COUNT; i++) {
    writeFileSync(join(dir, NOTES_DIR, `note-${String(i).padStart(2, "0")}.txt`), `Note ${i}: the garden bed number ${i} gets ${i * 2} liters of water on day ${i}.
`);
  }
}
async function killLeft(procs) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
    }
  }
}
async function runLiveChecks(o) {
  const homes = [];
  const newHome = () => {
    const h = mkdtempSync(join(tmpdir(), "agent-bridge-rel-live-"));
    homes.push(h);
    return h;
  };
  const model = (agent) => o.models[agent] ? { model: o.models[agent] } : {};
  const spawnLong = async (host, agent) => {
    const r = await host.call(`spawn_${agent}`, { title: "Reliability: read notes", prompt: LONG_TASK, timeout_sec: JOB_TIMEOUT_SEC, ...model(agent) });
    const job = jobNameIn(r.text);
    if (r.isError || !job) throw new Error(`spawn_${agent} failed: ${short(r.text)}`);
    return job;
  };
  try {
    for (const agent of o.agents) {
      const host = hostFor(agent);
      const bundle = serverBundle(host);
      o.out(`${agent} (live, via a ${host} MCP server):`);
      if (!bundle) {
        o.out(`  SKIP  ${agent} live checks: no bundled server (plugins/${host}/${SERVER_BUNDLE.replace(/\\/g, "/")}) found`);
        continue;
      }
      {
        const home = newHome();
        const cwd = o.repo();
        writeNotes(cwd);
        const server = await LiveHost.start(bundle, host, home, cwd);
        try {
          await o.check(`${agent} live message to a running subagent`, async () => {
            const job = await spawnLong(server, agent);
            try {
              const progress = await until(WORKING_TIMEOUT_MS, () => server.working(job));
              if (!progress) return { pass: false, detail: `${job} never reported working within ${WORKING_TIMEOUT_MS / 1e3}s` };
              const sent = await server.call("message_subagent", { job, message: LIVE_QUESTION });
              if (!/still working/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
              const first = await server.next(job, ANSWER_TIMEOUT_MS);
              if (first === null) return { pass: false, detail: `no message from ${job} within ${ANSWER_TIMEOUT_MS / 1e3}s` };
              const status = finalStatusOf(job, first);
              if (status) {
                const seen = logsMention(home, PICKED_UP_LOG) ? "it picked up the message but did not answer before finishing" : "it never picked up the message";
                return { pass: false, detail: `the final result (${status}) arrived before any answer: ${seen}; working was: ${short(progress)}` };
              }
              const final = await server.result(job, RESULT_TIMEOUT_MS);
              return {
                pass: final !== null,
                detail: `answer before the result: ${short(first)}; result: ${final ? final.status : "none in time"}`
              };
            } finally {
              await server.call("cancel_subagent", { job }).catch(() => {
              });
            }
          });
          await o.check(`${agent} follow-up keeps context`, async () => {
            const asked = await server.call(`ask_${agent}`, { title: "Reliability: remember a fact", prompt: FACT_PROMPT, ...model(agent) }, RESULT_TIMEOUT_MS);
            const job = jobNameIn(asked.text);
            if (asked.isError || !job) return { pass: false, detail: `ask_${agent}: ${short(asked.text)}` };
            const sent = await server.call("message_subagent", { job, message: FACT_QUESTION });
            if (!/^Sent to/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
            const final = await server.result(job, RESULT_TIMEOUT_MS);
            if (!final) return { pass: false, detail: `no answer from ${job} within ${RESULT_TIMEOUT_MS / 1e3}s` };
            const answer = final.body.split("\n").slice(2).join(" ");
            return { pass: final.status === "done" && final.body.includes(FACT), detail: `${final.status}: ${short(answer)}` };
          });
        } finally {
          await server.close();
        }
      }
      {
        const home = newHome();
        const cwd = o.repo();
        writeNotes(cwd);
        let server = await LiveHost.start(bundle, host, home, cwd);
        let job = null;
        let before = null;
        try {
          await o.check(`${agent} clean exit`, async () => {
            job = await spawnLong(server, agent);
            const name = job;
            before = await until(SESSION_TIMEOUT_MS, () => {
              const s = storedJob(home, name);
              return s?.sessionId ? s : null;
            });
            if (!before) return { pass: false, detail: `${name} has no session in ${JOBS_FILE} after ${SESSION_TIMEOUT_MS / 1e3}s` };
            const all = await listProcesses();
            const tree = processTree(all, server.pid);
            const ownGroup = all.find((p) => p.pid === process.pid)?.pgid;
            await server.close();
            server = null;
            const left = leftovers(tree, await listProcesses(), ownGroup);
            await killLeft(left);
            return {
              pass: tree.length > 1 && left.length === 0,
              detail: tree.length <= 1 ? "the server had no child processes to check (the job was not running)" : left.length ? `${left.length} of ${tree.length} processes left running: pids ${left.map((p) => p.pid).join(", ")}` : `all ${tree.length} processes of the server's tree ended`
            };
          });
          await o.check(`${agent} recovery after a restart`, async () => {
            const name = job;
            const kept = before;
            if (!name || !kept?.sessionId) return { pass: false, detail: "no running job with a session to recover (see clean exit)" };
            await server?.close();
            const onDisk = storedJob(home, name)?.status ?? "missing";
            server = await LiveHost.start(bundle, host, home, cwd);
            const listed = await server.listedStatus(name);
            const sent = await server.call("message_subagent", { job: name });
            if (!/^Sent to/.test(sent.text)) return { pass: false, detail: `${JOBS_FILE}: ${onDisk}, listed as ${listed}; message_subagent: ${short(sent.text)}` };
            const final = await server.result(name, RESULT_TIMEOUT_MS);
            const after = storedJob(home, name);
            const sameSession = after?.sessionId === kept.sessionId;
            const recovered = listed === "interrupted" || listed === "failed";
            return {
              pass: recovered && final?.status === "done" && sameSession,
              detail: `${JOBS_FILE}: ${onDisk}, restored as ${listed ?? "unlisted"} -> started; result ${final?.status ?? "none in time"}; session ${sameSession ? "same" : `changed ${kept.sessionId} -> ${after?.sessionId ?? "none"}`}`
            };
          });
        } finally {
          await server?.close();
        }
      }
    }
    if (o.agents.includes("codex")) {
      o.out("codex app-server approvals:");
      for (const allow of [true, false]) {
        await o.check(`codex app-server ask -> ${allow ? "allow" : "deny"}`, async () => {
          const dir = o.repo();
          const asked = [];
          const r = await delegateToCodexAppServer({
            prompt: "Run this shell command in the current folder: echo hi > asked.txt\nIt creates a file named asked.txt. Then reply done.",
            cwd: dir,
            sessionId: null,
            timeoutSec: APPROVAL_TIMEOUT_SEC,
            model: o.models.codex ?? null,
            log: o.log,
            bin: o.bins.codex,
            sandbox: "read-only",
            approvalsReviewer: "user",
            askMode: true,
            approve: async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability check." };
            }
          });
          const exists = existsSync(join(dir, "asked.txt"));
          const relevant = asked.filter((a) => !a.startsWith("mcp:"));
          return {
            pass: relevant.length > 0 && exists === allow,
            detail: `asked ${relevant.length}x [${relevant.join(" | ")}], file ${exists ? "created" : "not created"}; answer ${short(r.text)}`
          };
        });
      }
      await o.check("codex app-server read-only refuses escalation without asking", async () => {
        const dir = o.repo();
        const asked = [];
        const r = await delegateToCodexAppServer({
          prompt: "Create a file named should-not-exist.txt containing the word hi, for example with the shell command: echo hi > should-not-exist.txt\nIf the sandbox blocks it, request escalated permissions and try again. Then reply done.",
          cwd: dir,
          sessionId: null,
          timeoutSec: APPROVAL_TIMEOUT_SEC,
          model: o.models.codex ?? null,
          log: o.log,
          bin: o.bins.codex,
          sandbox: "read-only",
          approvalsReviewer: "user",
          approve: async (req) => {
            asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
            return { allow: true };
          }
        });
        const exists = existsSync(join(dir, "should-not-exist.txt"));
        const relevant = asked.filter((a) => !a.startsWith("mcp:"));
        return {
          pass: !exists && relevant.length === 0,
          detail: exists ? "the file WAS created" : relevant.length ? `the parent was asked ${relevant.length}x [${relevant.join(" | ")}]` : `refused without asking, no file; answer ${short(r.text)}`
        };
      });
    }
  } finally {
    for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 3 });
  }
}

// src/cli/reliability.ts
var RUN_TIMEOUT_SEC = 300;
var REPEATS = 3;
var CANCEL_AFTER_MS = 8e3;
var CANCEL_GRACE_MS = 1e4;
var BINS = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN, antigravity: "agy" };
var RELIABILITY_SECTIONS = ["core", "live"];
var models = {};
function run(agent, prompt, cwd, access, log, signal) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, signal, model: models[agent] ?? null };
  if (agent === "antigravity") return delegateToAntigravity({ ...base, bin: BINS.antigravity, access });
  if (agent === "codex") return delegateToCodex({ ...base, bin: BINS.codex, sandbox: access === "edit" ? "workspace-write" : "read-only" });
  if (agent === "claude") return delegateToClaude({ ...base, bin: BINS.claude, permissionMode: access === "edit" ? "acceptEdits" : "default" });
  return delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: access === "edit" });
}
async function runAsk(agent, prompt, cwd, decide, log) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, model: models[agent] ?? null };
  if (agent === "antigravity") return delegateToAntigravity({ ...base, bin: BINS.antigravity, access: "ask", approve: decide });
  if (agent === "opencode") return delegateToOpencodeServed({ ...base, bin: BINS.opencode, onPermission: decide });
  if (agent === "codex") {
    if (!codexPermissionHookTrusted(resolveHome())) return null;
    const relay = new PermissionRelay(decide, log);
    await relay.start();
    try {
      return await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "read-only", relayApprovals: true, extraEnv: relay.childEnv() });
    } finally {
      await relay.stop();
    }
  }
  return null;
}
async function timed(name, fn) {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, ...r, ms: Date.now() - start };
  } catch (err) {
    return { name, pass: false, detail: String(err?.message ?? err).slice(0, 160), ms: Date.now() - start };
  }
}
function makeRepo() {
  const dir = mkdtempSync2(join2(tmpdir2(), "agent-bridge-rel-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync2(join2(dir, "README.md"), "reliability sandbox\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  return dir;
}
async function runReliability(opts) {
  const sections = opts.sections ?? RELIABILITY_SECTIONS;
  models = opts.models ?? {};
  const agents = opts.agents.filter((a) => resolveBinary(BINS[a]));
  for (const a of opts.agents) if (!agents.includes(a)) opts.out(`${a}: SKIP (CLI "${BINS[a]}" not installed)`);
  const home = mkdtempSync2(join2(tmpdir2(), "agent-bridge-rel-home-"));
  const results = [];
  const record = (o) => {
    results.push(o);
    opts.out(`  ${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1e3).toFixed(1)}s)  ${o.detail}`);
  };
  const repos = [];
  const repo = () => {
    const r = makeRepo();
    repos.push(r);
    return r;
  };
  try {
    for (const agent of sections.includes("core") ? agents : []) {
      opts.out(`${agent}:`);
      for (let i = 1; i <= REPEATS; i++) {
        const n = 10 + i;
        record(
          await timed(`${agent} answer #${i}`, async () => {
            const r = await run(agent, `Reply with only the number ${n * n}. That is ${n} squared.`, repo(), "read", opts.log);
            return { pass: r.text.includes(String(n * n)) && Boolean(r.sessionId), detail: `"${r.text.trim().slice(0, 40)}"` };
          })
        );
      }
      record(
        await timed(`${agent} read-only is enforced`, async () => {
          const dir = repo();
          await run(agent, "Create a file named should-not-exist.txt containing the word hi. Then reply done.", dir, "read", opts.log);
          const exists = existsSync2(join2(dir, "should-not-exist.txt"));
          return { pass: !exists, detail: exists ? "the file WAS created despite read-only access" : "no file created" };
        })
      );
      record(
        await timed(`${agent} edit in worktree`, async () => {
          const dir = repo();
          const wt = await createWorktree({ cwd: dir, home, jobId: `${agent}-${Date.now().toString(36)}`, log: opts.log });
          const steps = [];
          const base = { prompt: "Create a file named created.txt containing the word hello. Then reply done.", cwd: wt.cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log: opts.log, model: models[agent] ?? null, onProgress: (m) => steps.push(m) };
          const r = agent === "antigravity" ? await delegateToAntigravity({ ...base, bin: BINS.antigravity, access: "edit" }) : agent === "codex" ? await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "workspace-write" }) : agent === "claude" ? await delegateToClaude({ ...base, bin: BINS.claude, permissionMode: "acceptEdits" }) : await delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: true });
          const outcome = await finishWorktree(wt, "reliability edit", opts.log);
          const leaked = existsSync2(join2(dir, "created.txt"));
          const pass = outcome.diffStat.includes("created.txt") && !leaked;
          return {
            pass,
            detail: leaked ? "file leaked into the working copy" : pass ? "created.txt committed on the worktree branch" : `no created.txt; steps: [${steps.join(" | ")}]; answer: "${r.text.trim().slice(0, 80)}"; diff: ${outcome.diffStat.split("\n").pop() ?? ""}`
          };
        })
      );
    }
    for (const agent of sections.includes("core") ? agents : []) {
      for (const allow of [false, true]) {
        const label = `${agent} ask -> ${allow ? "allow" : "deny"}`;
        const dir = repo();
        const asked = [];
        const outcome = await timed(label, async () => {
          const r = await runAsk(
            agent,
            "Create a file named asked.txt containing the word hi. Then reply done.",
            dir,
            async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability test." };
            },
            opts.log
          );
          if (r === null) return { pass: true, detail: "SKIP (not available: see README, permission requests)" };
          const exists = existsSync2(join2(dir, "asked.txt"));
          return {
            pass: asked.length > 0 && exists === allow,
            detail: `asked ${asked.length}x [${asked.join(" | ")}], file ${exists ? "created" : "not created"}`
          };
        });
        record(outcome);
      }
    }
    if (sections.includes("core") && agents.length > 1) {
      opts.out("parallel:");
      record(
        await timed(`parallel (${agents.join(", ")})`, async () => {
          const rs = await Promise.all(agents.map((a, i) => run(a, `Reply with only the word parallel${i}.`, repo(), "read", opts.log)));
          const ok = rs.map((r, i) => r.text.includes(`parallel${i}`));
          return { pass: ok.every(Boolean), detail: agents.map((a, i) => `${a}:${ok[i] ? "ok" : "bad"}`).join(" ") };
        })
      );
    }
    if (sections.includes("core") && agents.includes("codex")) {
      opts.out("cancel:");
      record(
        await timed("codex cancel", async () => {
          const ac = new AbortController();
          const started = Date.now();
          setTimeout(() => ac.abort(), CANCEL_AFTER_MS);
          const p = run("codex", "Count slowly from 1 to 400, one number per line, thinking about each number.", repo(), "read", opts.log, ac.signal);
          const r = await p.then(
            () => "finished",
            (e) => String(e.message)
          );
          const took = Date.now() - started;
          return { pass: r.includes("aborted") && took < CANCEL_AFTER_MS + CANCEL_GRACE_MS, detail: `${r}, stopped after ${(took / 1e3).toFixed(1)}s` };
        })
      );
    }
    if (sections.includes("live")) {
      await runLiveChecks({
        agents,
        bins: BINS,
        models,
        check: async (name, fn) => record(await timed(name, fn)),
        repo,
        out: opts.out,
        log: opts.log
      });
    }
  } finally {
    for (const r of repos) rmSync2(r, { recursive: true, force: true, maxRetries: 3 });
    rmSync2(home, { recursive: true, force: true, maxRetries: 3 });
  }
  const passed = results.filter((r) => r.pass).length;
  opts.out(`
${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}
export {
  RELIABILITY_SECTIONS,
  runReliability
};
