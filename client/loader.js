/*
    DiepCustom - custom tank game server that shares diep.io's WebSocket protocol
    Copyright (C) 2022 ABCxFF (github.com/ABCxFF)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>
*/

// make module globally accessable
window.Module = {};

// todolist
Module.todo = [];

// todo status
Module.status = null;

// is the todo list done?
Module.isRunning = false;

// has the module been aborted?
Module.isAborted = false;

// exception name
Module.exception = null;

// function index for dynamic calling of the main func
Module.mainFunc = null;

// content contexts
Module.cp5 = null;

// client input
window.input = null;

// arenas
Module.servers = null;

// tanks
Module.tankDefinitions = null;
Module.tankDefinitionsTable = null;

// commands
Module.executeCommandFunctionIndex = null;
Module.executionCallbackMap = {};
Module.commandDefinitions = null;

// name input
Module.textInput = document.getElementById("textInput");
Module.textInputContainer = document.getElementById("textInputContainer");

// permission level is sent to client in the accept packet
Module.permissionLevel = -1;

// (polling) intervals, can be a number (ms), -1 aka never or -2 aka whenever a new connection is initiated  
Module.reloadServersInterval = 60000;
Module.reloadTanksInterval = -1;
Module.reloadCommandsInterval = -2;

// abort client
Module.abort = cause => {
  Module.isAborted = true;
  Module.isRunning = false;
  throw new WebAssembly.RuntimeError(`abort(${cause})`);
};

// run ASMConst method, basically replaces a lot of "real wasm imports"
Module.runASMConst = (code, sigPtr, argbuf) => {
  const args = [];
  let char;
  argbuf >>= 2;
  while (char = Module.HEAPU8[sigPtr++]) {
    const double = char < 105;
    if (double && argbuf & 1) argbuf++;
    args.push(double ? Module.HEAPF64[argbuf++ >> 1] : Module.HEAP32[argbuf])
    ++argbuf;
  }
  return ASMConsts[ASM_CONSTS[code]].apply(null, args);
};

// initializing the looper
Module.setLoop = func => {
  if (!Module.isRunning || Module.isAborted || Module.exception === "quit") return;
  Module.mainFunc = func;
  window.requestAnimationFrame(Module.loop);
};

// process todo
Module.run = async () => {
  let args = [];
  while (Module.todo.length) {
    const [func, isAsync] = Module.todo.shift();
    if (isAsync) args = await Promise.all(func(...args));
    else args = func(...args);
    console.log(`Running stage ${Module.status} done`);
  }
};

// looper, 1 animation frame = 1 main call, except for stack unwinds
Module.loop = () => {
  if (!Module.isRunning || Module.isAborted || Module.exception === "quit") return;
  switch (Module.exception) {
    case null:
      Module.exports.dynCallV(Module.mainFunc);
      return window.requestAnimationFrame(Module.loop);
    case "quit":
      return;
    case "unwind":
      Module.exception = null;
      return window.requestAnimationFrame(Module.loop);
  }
};

// exit runtime (no unwind, originally unwind would be catched here)
Module.exit = status => {
  Module.exception = "quit";
  Module.isRunning = false;
  throw `Stopped runtime with status ${status}`;
};

// read utf8 from memory
Module.UTF8ToString = ptr => ptr ? new TextDecoder().decode(Module.HEAPU8.subarray(ptr, Module.HEAPU8.indexOf(0, ptr))) : "";

// i/o write used for console, not fully understood
Module.fdWrite = (stream, ptr, count, res) => {
  let out = 0;
  for (let i = 0; i < count; i++) out += Module.HEAP32[(ptr + (i * 8 + 4)) >> 2];
  Module.HEAP32[res >> 2] = out;
};

// write utf8 to memory
Module.allocateUTF8 = str => {
  if (!str) return 0;
  const encoded = new TextEncoder().encode(str);
  const ptr = Module.exports.malloc(encoded.byteLength + 1); // stringNT aka *char[]
  if (!ptr) return;
  Module.HEAPU8.set(encoded, ptr);
  Module.HEAPU8[ptr + encoded.byteLength] = 0;
  return ptr;
};

// Refreshes UI Components
Module.loadGamemodeButtons = () => {
  const vec = new $.Vector(MOD_CONFIG.memory.gamemodeButtons, "struct", 28);
  if (vec.start) vec.destroy(); // remove old arenas
  // map server response to memory struct
  vec.push(...Module.servers.map(server => ([
    { offset: 0, type: "cstr", value: server.gamemode },
    { offset: 12, type: "cstr", value: server.name },
    { offset: 24, type: "i32", value: 0 }
  ])));
  // placeholders to prevent single/no gamemode bugs
  const placeholderId = Module.servers.find(e => e.gamemode === 'ffa') ? 'survival' : 'ffa'
  for (let i = 0; i < 2 - Module.servers.length; ++i) {
    vec.push(...[[
      { offset: 0, type: "cstr", value: placeholderId },
      { offset: 12, type: "cstr", value: "Closed." },
      { offset: 24, type: "i32", value: 1 }
    ]]);
  }
  Module.rawExports.loadVectorDone(MOD_CONFIG.memory.gamemodeButtons + 12); // not understood
};

// Refreshes UI Components
Module.loadChangelog = (changelog) => {
  const vec = new $.Vector(MOD_CONFIG.memory.changelog, "cstr", 12);
  if (vec.start) vec.destroy(); // remove old changelog
  vec.push(...(changelog || CHANGELOG)); // either load custom or default
  $(MOD_CONFIG.memory.changelogLoaded).i8 = 1; // not understood
};

// Ignore Hashtable, instead read from custom table
Module.getTankDefinition = tankId => {
  if (!Module.tankDefinitions) return 0;
  if (!Module.tankDefinitionsTable) Module.loadTankDefinitions(); // load tankdefs dynmically when requested
  if (!Module.tankDefinitionsTable[tankId]) return 0;
  return Module.tankDefinitionsTable[tankId] + 12; // 12 bytes for tankIds
};

Module.getCommand = cmdIdPtr => COMMANDS_LOOKUP[$(cmdIdPtr).cstr] || 0;

Module.loadTankDefinitions = () => {
  const writeTankDef = (ptr, tank) => {
    // Please note that this is not the full tank/barrel struct but just the portion needed for the client to function properly
    const barrels = tank.barrels ? tank.barrels.map(barrel => { // barrel fields
      return [
        { offset: 0, type: "f32", value: barrel.angle },
        { offset: 4, type: "f32", value: barrel.delay },
        { offset: 8, type: "f32", value: barrel.size },
        { offset: 12, type: "f32", value: barrel.offset },
        { offset: 16, type: "u8", value: Number(barrel.isTrapezoid) },
        { offset: 24, type: "f32", value: barrel.width / 42 },
        { offset: 56, type: "f32", value: barrel.bullet.sizeRatio },
        { offset: 60, type: "f32", value: barrel.trapezoidDirection },
        { offset: 64, type: "f32", value: barrel.reload },
        { offset: 96, type: "u32", value: ADDON_MAP.barrelAddons[barrel.addon] || 0 }
      ];
    }) : [];

    const fields = [ // tankdef fields
      { offset: 4, type: "u32", value: tank.id },
      { offset: 8, type: "u32", value: tank.id },
      { offset: 12, type: "u32", value: tank.id },
      { offset: 16, type: "cstr", value: tank.name.toString() || "" },
      { offset: 28, type: "cstr", value: tank.upgradeMessage.toString() || "" },
      { offset: 40, type: "vector", value: { type: "u32", typeSize: 4, entries: tank.upgrades || [] } },
      { offset: 52, type: "vector", value: { type: "struct", typeSize: 100, entries: barrels } },
      { offset: 64, type: "u32", value: tank.levelRequirement || 0 },
      { offset: 76, type: "u8", value: Number(tank.sides === 4) },
      { offset: 93, type: "u8", value: Number(tank.sides === 16) },
      { offset: 96, type: "u32", value: ADDON_MAP.tankAddons[tank.preAddon] || 0 },
      { offset: 100, type: "u32", value: ADDON_MAP.tankAddons[tank.postAddon] || 0 },
    ];

    $.writeStruct(ptr, fields);
  };

  // TODO Rewrite with new $.List datastructure
  Module.tankDefinitionsTable = new Array(Module.tankDefinitions.length).fill(0); // clear memory
  let lastPtr = MOD_CONFIG.memory.tankDefinitions;
  for (const tank of Module.tankDefinitions) {
    if (!tank) continue;
    const ptr = Module.exports.malloc(244); // length of a tankdef
    Module.HEAPU8.subarray(ptr, ptr + 244).fill(0);
    $(lastPtr).i32 = ptr;
    writeTankDef(ptr, tank);
    Module.tankDefinitionsTable[tank.id] = ptr;
    lastPtr = ptr;
  }

  $(MOD_CONFIG.memory.tankDefinitionsCount).i32 = Module.tankDefinitions.filter(e => Boolean(e)).length; // tankId xor based off this
};

// Executes a command callback from a command context
Module.executeCommand = execCtx => {
  const cmd = $(execCtx)[0].cstr;
  const tokens = $(execCtx)[12].vector("cstr", 12);

  if (!cmd || !tokens.length) throw `Invalid execution context (ptr: ${execCtx}) received`;
  if (typeof Module.executionCallbackMap[tokens[0]] !== "function") {
    if (!Module.commandDefinitions.find(({ id }) => id === tokens[0])) {
      throw `${Module.executionCallbackMap[tokens]} for command ${cmd} is an invalid callback`;
    }
    const encoder = new TextEncoder();
    return Game.socket.send(new Uint8Array([
      6,
      ...encoder.encode(tokens[0]), 0,
      tokens.slice(1).length,
      ...tokens.slice(1).flatMap(token => [...encoder.encode(token), 0])
    ]));
  }

  // [id, ...args], we only need args
  Module.executionCallbackMap[tokens[0]](tokens.slice(1));
};

/*
    Command object: { id, usage, description, callback }
    The execute command function will not check for validity of arguments, you need to do that on your own
*/
Module.loadCommands = (commands = CUSTOM_COMMANDS) => {
  const cmdList = new $.List(MOD_CONFIG.memory.commandList, "struct", 24);
  for (let { id, usage, description, callback, permissionLevel } of commands) {
    if (COMMANDS_LOOKUP[id] || permissionLevel > Module.permissionLevel) continue; // ignore duplicates

    // allocate Command
    const cmdPtr = Module.exports.malloc(40);
    $.writeStruct(cmdPtr, [
      { offset: 0, type: "cstr", value: id },
      { offset: 12, type: "cstr", value: usage || "" },
      { offset: 24, type: "cstr", value: description || "" },
      { offset: 36, type: "u32", value: Module.executeCommandFunctionIndex } // we handle every custom command with the same function
    ]);

    COMMANDS_LOOKUP[id] = cmdPtr;
    if (callback) Module.executionCallbackMap[id] = callback;

    // allocate HashNode
    cmdList.push([
      { offset: 0, type: "u32", value: 0 }, // next node
      { offset: 4, type: "u32", value: 0 }, // hash
      { offset: 8, type: "cstr", value: id }, // command id
      { offset: 20, type: "$", value: cmdPtr } // command def ptr
    ]);
  }
};

const wasmImports = {
  assertFail: (condition, filename, line, func) => Module.abort("Assertion failed: " + UTF8ToString(condition) + ", at: " + [filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function"]),
  mapFile: () => -1, // unused
  sysMunmap: (addr, len) => addr === -1 || !len ? -28 : 0, // not really used
  abort: Module.abort,
  asmConstsDII: Module.runASMConst,
  asmConstsIII: Module.runASMConst,
  exitLive: () => Module.exception = "unwind", // unwind stack
  exitForce: () => Module.exit(1), // exit / quit
  getNow: () => performance.now(),
  memCopyBig: (dest, src, num) => { Module.HEAPU8.copyWithin(dest, src, src + num) }, // for large packets
  random: () => Math.random(),
  resizeHeap: () => Module.abort("OOM"), // unable to resize wasm memory
  setMainLoop: Module.setLoop,
  envGet: () => 0, // unused
  envSize: () => 0, // unused
  fdWrite: Module.fdWrite, // used for diep client console
  roundF: d => d >= 0 ? Math.floor(d + 0.5) : Math.ceil(d - 0.5), // no, default Math.round doesn't work :D
  timeString: () => 0, // unused
  wasmMemory: new WebAssembly.Memory(WASM_MEMORY),
  wasmTable: new WebAssembly.Table(WASM_TABLE)
};

Module.todo.push([() => {
  Module.status = "PREPARE";
  // map imports to config
  Module.imports = { a: Object.fromEntries(Object.entries(WASM_IMPORTS).map(([key, name]) => [key, wasmImports[name]])) };
  return [];
}, false]);

Module.todo.push([() => {
  Module.status = "FETCH";
  // fetch necessary info and build
  return [fetch(`${CDN}build_${BUILD}.wasm.wasm`).then(res => res.arrayBuffer()), fetch(`${API_URL}servers`).then(res => res.json()), fetch(`${API_URL}tanks`).then(res => res.json())];
}, true]);

Module.todo.push([(dependency, servers, tanks) => {
  Module.status = "INSTANTIATE";
  Module.servers = servers;
  Module.tankDefinitions = tanks;

  const parser = new WailParser(new Uint8Array(dependency));

  // original function, we want to modify these
  const originalVectorDone = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadVectorDone);
  const originalLoadChangelog = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadChangelog);
  const originalLoadGamemodeButtons = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadGamemodeButtons);
  const originalLoadTankDefs = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadTankDefinitions);
  const originalGetTankDef = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.getTankDefinition);
  const originalFindCommand = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.findCommand);

  // function types
  const types = {
    // void []
    vn: parser.addTypeEntry({
      form: "func",
      params: [],
      returnType: null
    }),
    // void [int]
    vi: parser.addTypeEntry({
      form: "func",
      params: ["i32"],
      returnType: null
    }),
    // int [int]
    ii: parser.addTypeEntry({
      form: "func",
      params: ["i32"],
      returnType: "i32"
    })
  }

  // custom imports
  const imports = {
    loadGamemodeButtons: parser.addImportEntry({
      moduleStr: "mods",
      fieldStr: "loadGamemodeButtons",
      kind: "func",
      type: types.vn
    }),
    loadChangelog: parser.addImportEntry({
      moduleStr: "mods",
      fieldStr: "loadChangelog",
      kind: "func",
      type: types.vn
    }),
    getTankDefinition: parser.addImportEntry({
      moduleStr: "mods",
      fieldStr: "getTankDefinition",
      kind: "func",
      type: types.ii
    }),
    findCommand: parser.addImportEntry({
      moduleStr: "mods",
      fieldStr: "findCommand",
      kind: "func",
      type: types.ii
    }),
    executeCommand: parser.addImportEntry({
      moduleStr: "mods",
      fieldStr: "executeCommand",
      kind: "func",
      type: types.vi
    })
  }


  // Modded imports, see above
  Module.imports.mods = {
    loadGamemodeButtons: Module.loadGamemodeButtons,
    loadChangelog: Module.loadChangelog,
    getTankDefinition: Module.getTankDefinition,
    findCommand: Module.getCommand,
    executeCommand: Module.executeCommand
  };

  // export to be able to add as a function table element
  parser.addExportEntry(imports.executeCommand, {
    fieldStr: "executeCommand",
    kind: "func"
  });

  // not understood entirely
  parser.addExportEntry(originalVectorDone, {
    fieldStr: "loadVectorDone",
    kind: "func"
  });

  // parses & modifies code function by function
  parser.addCodeElementParser(null, function({ index, bytes }) {
    switch (index) {
      // modify load changelog function
      case originalLoadChangelog.i32(): // we only need the part where it checks if the changelog is already loaded to avoid too many import calls
        return new Uint8Array([
          ...bytes.subarray(0, MOD_CONFIG.wasmFunctionHookOffset.changelog),
          OP_CALL, ...VarUint32ToArray(imports.loadChangelog.i32()),
          OP_RETURN,
          ...bytes.subarray(MOD_CONFIG.wasmFunctionHookOffset.changelog)
        ]);
      // modify load gamemode buttons function
      case originalLoadGamemodeButtons.i32(): // we only need the part where it checks if the buttons are already loaded to avoid too many import calls
        return new Uint8Array([
          ...bytes.subarray(0, MOD_CONFIG.wasmFunctionHookOffset.gamemodeButtons),
          OP_CALL, ...VarUint32ToArray(imports.loadGamemodeButtons.i32()),
          OP_RETURN,
          ...bytes.subarray(MOD_CONFIG.wasmFunctionHookOffset.gamemodeButtons)
        ]);
      // overwrite get tankdef function
      case originalGetTankDef.i32(): // we modify this to call a js function which then returns the tank def ptr from a table
        return new Uint8Array([
          OP_GET_LOCAL, 0,
          OP_CALL, ...VarUint32ToArray(imports.getTankDefinition.i32()),
          OP_RETURN,
          OP_END
        ]);
      // overwrite find command function
      case originalFindCommand.i32():
        return new Uint8Array([
          OP_GET_LOCAL, 0,
          OP_CALL, ...VarUint32ToArray(imports.findCommand.i32()),
          OP_RETURN,
          OP_END
        ]);
      // delete tankdefs loading function
      case originalLoadTankDefs.i32(): // we dont want this to run anymore because it will call the original tank wrapper function
        return new Uint8Array([
          OP_END
        ]);
      // no interesting index
      default:
        return false;
    }
  });

  // parse modded wasm
  parser.parse();
  // instantiate
  return [new Promise(resolve => WebAssembly.instantiate(parser.write(), Module.imports).then(res => resolve(res.instance), reason => Module.abort(reason)))];
}, true]);

Module.todo.push([instance => {
  Module.status = "INITIALIZE";
  // Exports
  Module.exports = Object.fromEntries(Object.entries(instance.exports).map(([key, func]) => [WASM_EXPORTS[key], func]));
  Module.rawExports = instance.exports;
  // Memory
  Module.memBuf = wasmImports.wasmMemory.buffer,
    Module.HEAPU8 = new Uint8Array(Module.memBuf);
  Module.HEAP8 = new Int8Array(Module.memBuf);
  Module.HEAPU16 = new Uint16Array(Module.memBuf);
  Module.HEAP16 = new Int16Array(Module.memBuf);
  Module.HEAPU32 = new Uint32Array(Module.memBuf);
  Module.HEAP32 = new Int32Array(Module.memBuf);
  Module.HEAPF32 = new Float32Array(Module.memBuf);
  Module.HEAPF64 = new Float64Array(Module.memBuf);
  Module.HEAPU64 = new BigUint64Array(Module.memBuf);
  Module.HEAP64 = new BigInt64Array(Module.memBuf);
  // Cp5 Contexts
  Module.cp5 = {
    contexts: [],
    images: [],
    sockets: [],
    patterns: []
  };
  // window.input & misc, see input.js
  window.setupInput();
  // Diep Memory Analyzer, see dma.js
  window.setupDMA();
  return [];
}, false]);

Module.todo.push([() => {
  window.Game = {
    // refetches servers & resets gamemode buttons
    reloadServers: async () => {
      Module.servers = await fetch(`${API_URL}servers`).then(res => res.json());
      Module.loadGamemodeButtons();
    },
    // refetches tankdefs & resets them
    reloadTanks: async () => {
      Module.tankDefinitions = await fetch(`${API_URL}tanks`).then(res => res.json());
      for (const tankDef of Module.tankDefinitionsTable) Module.exports.free(tankDef);
      Module.loadTankDefinitions();
    },
    reloadCommands: async () => {
      Module.commandDefinitions = await fetch(`${API_URL}commands`).then(res => res.json());
      Module.loadCommands(Module.commandDefinitions); // remote
      Module.loadCommands(); // local
    },
    // sets changelog (input: [...""])
    changeChangelog: (lines) => Module.loadChangelog(lines),
    // main socket, see also Module.cp5.sockets[0]
    get socket() {
      return Module.cp5.sockets[0];
    },
    // executes spawn command
    spawn: name => window.input.execute(`game_spawn ${name}`),
    // executes reconnect command
    reconnect: () => window.input.execute(`lb_reconnect`)
  };

  // custom commands
  Module.executeCommandFunctionIndex = Module.imports.a.table.grow(1);
  Module.imports.a.table.set(Module.executeCommandFunctionIndex, Module.rawExports.executeCommand);

  Module.status = "START";
  // emscripten requirements
  Module.HEAP32[DYNAMIC_TOP_PTR >> 2] = DYNAMIC_BASE;
  Module.isRunning = true;
  Module.exports.wasmCallCtors();
  Module.exports.main();


  const reloadServersInterval = () => setTimeout(() => {
    reloadServersInterval();
    if (Module.reloadServersInterval < 0) return;
    Game.reloadServers();
  }, Module.reloadServersInterval);
  reloadServersInterval();

  const reloadTanksInterval = () => setTimeout(() => {
    reloadTanksInterval();
    if (Module.reloadCommandsInterval < 0) return;
    Game.reloadTanks();
  }, Module.reloadTanksInterval);
  reloadTanksInterval();

  const reloadCommandsInterval = () => setTimeout(() => {
    reloadCommandsInterval();
    if (Module.reloadCommandsInterval < 0) return;
    Game.reloadCommands();
  }, Module.reloadCommandsInterval);
  reloadCommandsInterval();
}, false]);


// Part of the original emscripten bootstrap
class ASMConsts {
  static createCanvasCtxWithAlpha(canvasId, alpha) {
    const canvas = document.getElementById(Module.UTF8ToString(canvasId));
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d", {
      alpha: Boolean(alpha)
    });
    for (let i = 0; i < Module.cp5.contexts.length; ++i) {
      if (Module.cp5.contexts[i] !== null) continue;
      Module.cp5.contexts[i] = ctx;
      return i;
    }
    Module.cp5.contexts.push(ctx);
    return Module.cp5.contexts.length - 1;
  }

  static createImage(src) {
    const img = new Image;
    img.isLoaded = false;
    img.onload = () => img.isLoaded = true;
    img.src = `${CDN}${Module.UTF8ToString(src)}`;
    if (img.src.includes('title')) img.src = 'https://i.imgur.com/qNW1ZuP.png';
    for (let i = 0; i < Module.cp5.images.length; ++i) {
      if (Module.cp5.images[i] !== null) continue;
      Module.cp5.images[i] = img;
      return i;
    }
    Module.cp5.images.push(img);
    return Module.cp5.images.length - 1;
  }

  static websocketSend(socketId, packetStart, packetLength) {
    const socket = Module.cp5.sockets[socketId];
    if (!socket || socket.readyState !== 1) return 0;
    try {
      socket.send(Module.HEAP8.subarray(packetStart, packetStart + packetLength));
    } catch (e) { }
    return 1;
  }

  static wipeContext(index) {
    Module.cp5.contexts[index] = null;
  }

  static modulo(a, b) {
    return a % b;
  }

  static wipeSocket(index) {
    const socket = Module.cp5.sockets[index];
    socket.onopen = socket.onclose = socket.onmessage = socket.onerror = function() { };
    for (let i = 0; i < socket.events.length; ++i) Module.exports.free(socket.events[i][1]);
    socket.events = null;
    try {
      socket.close();
    } catch (e) { }
    Module.cp5.sockets[index] = null;
  }

  static setTextInput(value) {
    Module.textInput.value = Module.UTF8ToString(value);
  }

  static wipeImage(index) {
    Module.cp5.images[index] = null;
  }

  static reloadWindowTimeout() {
    //setTimeout(() => window.location.reload(), 100);
  }

  static existsInWindowObject(key) {
    return Boolean(window[Module.UTF8ToString(key)]);
  }

  // 6 (ads)

  static getQueries() {
    const queryString = window.location.href.split("?")[0];
    return Module.allocateUTF8(queryString.slice(0, queryString.lastIndexOf("/")));
  }

  // 2 (ads)

  static getLocalStorage(key, length) {
    const str = window.localStorage[Module.UTF8ToString(key)] || "";
    Module.HEAPU32[length >> 2] = str.length;
    return Module.allocateUTF8(str);
  }

  static deleteLocalStorage(key) {
    delete window.localStorage[Module.UTF8ToString(key)];
  }

  static removeChildNode(nodeId) {
    const node = document.getElementById(Module.UTF8ToString(nodeId));
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  static checkElementProperty(elementId, propertyKey, propertyIndex, value) {
    const element = document.getElementById(Module.UTF8ToString(elementId));
    const key = Module.UTF8ToString(propertyKey);
    if (!element || !element[key]) return true;
    return element[key][Module.UTF8ToString(propertyIndex)] === Module.UTF8ToString(value);
  }

  static existsQueryOrIsBlank(query) {
    const elements = document.querySelectorAll(Module.UTF8ToString(query));
    for (let i = 0; i < elements.length; ++i)
      if (elements[i].src === "about:blank") return true;
    return elements.length === 0;
  }

  // 1 (ads)

  static setLocalStorage(key, valueStart, valueLength) {
    window.localStorage[Module.UTF8ToString(key)] = new TextDecoder().decode(Module.HEAPU8.subarray(valueStart, valueStart + valueLength));
  }

  // 3 (ads)

  static getGamepad() {
    return window.navigator.getGamepads && window.navigator.getGamepads()[0]?.mapping === "standard";
  }

  static toggleFullscreen() {
    const requestMethod = document.body.requestFullScreen || document.body.webkitRequestFullScreen || document.body.mozRequestFullScreen || document.body.msRequestFullScreen;
    const cancelMethod = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (!requestMethod && !cancelMethod) return;
    requestMethod ? requestMethod.call(document.body) : cancelMethod.call(document);
  }

  static getCanvasSize(ctxId, width, height) {
    const canvas = Module.cp5.contexts[ctxId].canvas;
    Module.HEAP32[width >> 2] = canvas.width;
    Module.HEAP32[height >> 2] = canvas.height;
  }

  static setCursorDefault() {
    document.getElementById("canvas").style.cursor = "default";
  }

  static setCursorPointer() {
    document.getElementById("canvas").style.cursor = "pointer";
  }

  static setCursorText() {
    document.getElementById("canvas").style.cursor = "text";
  }

  static getTextInput() {
    return Module.allocateUTF8(Module.textInput.value);
  }

  static enableTyping(left, top, width, height, enabled) {
    window.setTyping(true);
    Module.textInputContainer.style.display = "block";
    Module.textInputContainer.style.position = "absolute";
    Module.textInputContainer.style.left = window.unscale(left) + "px";
    Module.textInputContainer.style.top = window.unscale(top) + "px";
    Module.textInput.style.width = window.unscale(width * 0.96) + "px";
    Module.textInput.style.height = window.unscale(height) + "px";
    Module.textInput.style.lineHeight = window.unscale(height * 0.9) + "px";
    Module.textInput.style.fontSize = window.unscale(height * 0.9) + "px";
    Module.textInput.style.paddingLeft = "5px";
    Module.textInput.style.paddingRight = "5px";
    Module.textInput.disabled = !enabled;
    Module.textInput.focus();
  }

  static disableTyping() {
    window.setTyping(false);
    Module.textInput.blur();
    Module.textInput.value = "";
    Module.textInputContainer.style.display = "none";
  }

  static focusCanvas() {
    const canvas = document.getElementById("canvas");
    if (document.activeElement && document.activeElement !== canvas) document.activeElement.blur()
    canvas.focus();
  }

  static setCanvasSize(ctxId, width, height) {
    const canvas = Module.cp5.contexts[ctxId].canvas;
    canvas.width = width;
    canvas.height = height;
  }

  // 1 (ads)

  static copyUTF8(original) {
    return Module.allocateUTF8(Module.UTF8ToString(original));
  }

  static alert(text) {
    window.alert(Module.UTF8ToString(text));
  }

  static saveContext(ctxId) {
    Module.cp5.contexts[ctxId].save();
  }

  static restoreContext(ctxId) {
    Module.cp5.contexts[ctxId].restore();
  }

  static scaleContextAlpha(ctxId, alpha) {
    Module.cp5.contexts[ctxId].globalAlpha *= alpha;
  }

  // 5 (ads)

  static setContextFillStyle(ctxId, r, g, b) {
    Module.cp5.contexts[ctxId].fillStyle = "rgb(" + r + "," + g + "," + b + ")";
  }

  static setContextTransform(ctxId, a, b, c, d, e, f) {
    Module.cp5.contexts[ctxId].setTransform(a, b, c, d, e, f);
  }

  static contextFillRect(ctxId) {
    Module.cp5.contexts[ctxId].fillRect(0, 0, 1, 1);
  }

  static contextBeginPath(ctxId) {
    Module.cp5.contexts[ctxId].beginPath();
  }

  static contextClip(ctxId) {
    Module.cp5.contexts[ctxId].clip();
  }

  static contextFill(ctxId) {
    Module.cp5.contexts[ctxId].fill();
  }

  static setContextLineJoinRound(ctxId) {
    Module.cp5.contexts[ctxId].lineJoin = "round";
  }

  static setContextLineJoinBevel(ctxId) {
    Module.cp5.contexts[ctxId].lineJoin = "bevel";
  }

  static setContextLineJoinMiter(ctxId) {
    Module.cp5.contexts[ctxId].lineJoin = "miter";
  }

  static setContextLineWidth(ctxId, width) {
    Module.cp5.contexts[ctxId].lineWidth = width;
  }

  static setContextStrokeStyle(ctxId, r, g, b) {
    Module.cp5.contexts[ctxId].strokeStyle = "rgb(" + r + "," + g + "," + b + ")";
  }

  static setContextTransformBounds(ctxId, a, b, c, d) {
    Module.cp5.contexts[ctxId].setTransform(a, b, c, d, 0, 0);
  }

  static contextStroke(ctxId) {
    Module.cp5.contexts[ctxId].stroke();
  }

  // draws one pixel
  static contextRect(ctxId) {
    Module.cp5.contexts[ctxId].rect(0, 0, 1, 1);
  }

  static getFontsLoaded() {
    return document.fonts.check("1px Ubuntu");
  }

  static setContextFont(ctxId, fontSize) {
    Module.cp5.contexts[ctxId].font = fontSize + "px Ubuntu";
  }

  static measureContextTextWidth(ctxId, text) {
    return Module.cp5.contexts[ctxId].measureText(Module.UTF8ToString(text)).width;
  }

  static setContextAlpha(ctxId, alpha) {
    Module.cp5.contexts[ctxId].globalAlpha = alpha;
  }

  static contextFillText(ctxId, text) {
    Module.cp5.contexts[ctxId].fillText(Module.UTF8ToString(text), 0, 0);
  }

  static contextStrokeText(ctxId, text) {
    Module.cp5.contexts[ctxId].strokeText(Module.UTF8ToString(text), 0, 0);
  }

  static setContextTextBaselineTop(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "top";
  }

  static setContextTextBaselineHanging(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "hanging";
  }

  static setContextTextBaselineMiddle(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "middle";
  }

  static setContextTextBaselineAlphabetic(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "alphabetic";
  }

  static setContextTextBaselineIdeographic(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "ideographic";
  }

  static setContextTextBaselineBottom(ctxId) {
    Module.cp5.contexts[ctxId].textBaseline = "bottom";
  }

  static setContextTransformNormalize(ctxId) {
    Module.cp5.contexts[ctxId].setTransform(1, 0, 0, 1, 0, 0);
  }

  static contextMoveTo(ctxId, x, y) {
    Module.cp5.contexts[ctxId].moveTo(x, y);
  }

  static contextLineTo(ctxId, x, y) {
    Module.cp5.contexts[ctxId].lineTo(x, y);
  }

  static contextClosePath(ctxId) {
    Module.cp5.contexts[ctxId].closePath();
  }

  static contextArc(ctxId, startAngle, endAngle, counterclockwise) {
    Module.cp5.contexts[ctxId].arc(0, 0, 1, startAngle, endAngle, counterclockwise)
  }

  static copyToKeyboard(text) {
    window?.navigator?.clipboard?.writeText(Module.UTF8ToString(text));
  }

  static setLocation(newLocation) {
    // open in new tab instead
    window.open(Module.UTF8ToString(newLocation));
  }

  static contextDrawImage(ctxId, imgId) {
    const img = Module.cp5.images[imgId];
    if (!img.isLoaded || img.width === 0 || img.height === 0) return;
    Module.cp5.contexts[ctxId].drawImage(img, 0, 0, img.width, img.height, 0, 0, 1, 1);
  }

  static getImage(imgId, isLoaded, width, height) {
    const img = Module.cp5.images[imgId];
    Module.HEAPU8[isLoaded >> 0] = img.isLoaded;
    Module.HEAP32[width >> 2] = img.width;
    Module.HEAP32[height >> 2] = img.height;
  }

  static contextDrawCanvas(ctxId, targetCtxId) {
    Module.cp5.contexts[ctxId].drawImage(Module.cp5.contexts[targetCtxId].canvas, 0, 0);
  }

  static setContextLineCapButt(ctxId) {
    Module.cp5.contexts[ctxId].lineCap = "butt";
  }

  static setContextLineCapRound(ctxId) {
    Module.cp5.contexts[ctxId].lineCap = "round";
  }

  static setContextLineCapSquare(ctxId) {
    Module.cp5.contexts[ctxId].lineCap = "square";
  }

  static contextStrokeRect(ctxId) {
    Module.cp5.contexts[ctxId].strokeRect(0, 0, 1, 1);
  }

  static contextDrawFullCanvas(ctxId, targetCtxId) {
    const canvas = Module.cp5.contexts[targetCtxId].canvas;
    Module.cp5.contexts[ctxId].drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 1, 1);
  }

  static isContextPatternAvailable() {
    return Boolean(CanvasRenderingContext2D.prototype.createPattern);
  }

  static createContextPattern(ctxId, targetCtxId) {
    const pattern = Module.cp5.contexts[ctxId].createPattern(Module.cp5.contexts[targetCtxId].canvas, null);
    for (let i = 0; i < Module.cp5.patterns.length; ++i) {
      if (Module.cp5.patterns[i] !== null) continue;
      Module.cp5.patterns[i] = pattern;
      return i;
    }
    Module.cp5.patterns.push(pattern);
    return Module.cp5.patterns.length - 1;
  }

  static contextGetPixelColor(ctxId, x, y) {
    const data = Module.cp5.contexts[ctxId].getImageData(x, y, 1, 1);
    return data.data[0] << 16 | data.data[1] << 8 | data.data[2];
  }

  static contextDrawCanvasSourceToPixel(ctxId, targetCtxId, x, y, w, h) {
    Module.cp5.contexts[ctxId].drawImage(Module.cp5.contexts[targetCtxId].canvas, x, y, w, h, 0, 0, 1, 1);
  }

  static contextFillRectWithPattern(ctxId, patternId, width, height) {
    Module.cp5.contexts[ctxId].fillStyle = Module.cp5.patterns[patternId];
    Module.cp5.contexts[ctxId].fillRect(0, 0, width, height);
  }

  static wipePattern(patternId) {
    Module.cp5.patterns[patternId] = null;
  }

  // 2 (verifying bootstrap integrity ?)

  static existsQuery(query) {
    return document.querySelector(Module.UTF8ToString(query)) !== null;
  }

  // 1 (anticheat)

  // used for shadow root
  static canvasHasSamePropertyAsDocumentBody(property) {
    const propertyKey = Module.UTF8ToString(property);
    return document.getElementById("canvas")[propertyKey] !== document.body[propertyKey];
  }

  // used for shadow root
  static existsDocumentBodyProperty(property) {
    return document.body[Module.UTF8ToString(property)] !== undefined;
  }

  // used for shadow root
  static existsDocumentBodyProperty2(property) {
    return Boolean(document.body[Module.UTF8ToString(property)]);
  }

  // used for shadow root
  static existsDivPropertyAndEqualsPropertyOnDocumentBody(propertyDiv, propertyBody) {
    const propertyDivKey = Module.UTF8ToString(propertyDiv);
    const div = document.createElement("div");
    if (!div[propertyDivKey]) return;
    return div[propertyDivKey]() === document.body[Module.UTF8ToString(propertyBody)];
  }

  // 3 (anticheat)

  // anticheat but need to be kept
  static acCheckWindow(property) {
    if (Module.UTF8ToString(property) === "navigator") return true;
  }

  static getDocumentBody() {
    return Module.allocateUTF8(document.body.innerHTML);
  }

  // 2 (anticheat)

  static getUserAgent() {
    return Module.allocateUTF8(window.navigator.userAgent);
  }

  // 1 (anticheat)

  static getQuerySelectorToString() {
    return Module.allocateUTF8("function querySelector() { [native code] }");
  }

  static getFillTextToString() {
    return Module.allocateUTF8("function fillText() { [native code] }");
  }

  static getStrokeRectToString() {
    return Module.allocateUTF8("function strokeRect() { [native code] }");
  }

  static getStrokeTextToString() {
    return Module.allocateUTF8("function strokeText() { [native code] }");
  }

  static getScaleToString() {
    return Module.allocateUTF8("function scale() { [native code] }");
  }

  static getTranslateToString() {
    return Module.allocateUTF8("function translate() { [native code] }");
  }

  static getFillRectToString() {
    return Module.allocateUTF8("function fillRect() { [native code] }");
  }

  static getRotateToString() {
    return Module.allocateUTF8("function rotate() { [native code] }");
  }

  static getGetImageDataToString() {
    return Module.allocateUTF8("function getImageData() { [native code] }");
  }

  // 1 (ads)

  static contextClearRect(ctxId) {
    const ctx = Module.cp5.contexts[ctxId];
    const canvas = ctx.canvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  static createCanvasCtx() {
    const ctx = document.createElement("canvas").getContext("2d");
    for (let i = 0; i < Module.cp5.contexts.length; ++i) {
      if (Module.cp5.contexts[i]) continue;
      Module.cp5.contexts[i] = ctx;
      return i;
    }
    Module.cp5.contexts.push(ctx);
    return Module.cp5.contexts.length - 1;
  }

  static setContextMiterLimit(ctxId, miterLimit) {
    Module.cp5.contexts[ctxId].miterLimit = miterLimit;
  }

  static getWindowLocation() {
    return Module.allocateUTF8(window.location.hash);
  }

  static setLoadingStatus(status) {
    if (window.setLoadingStatus) window.setLoadingStatus(Module.UTF8ToString(status));
  }

  static m28nReply(requestId, endpoint) {
    const id = Module.allocateUTF8(Module.UTF8ToString(endpoint));
    const ipv4 = Module.allocateUTF8(Module.UTF8ToString(endpoint));
    const ipv6 = Module.allocateUTF8(Module.UTF8ToString(endpoint));
    Module.exports.restReply(requestId, id, ipv4, ipv6);
    Module.exports.free(id);
    Module.exports.free(ipv4);
    Module.exports.free(ipv6);
  }

  static isSSL() {
    return window.location.protocol === "https:";
  }

  static createWebSocket(url) {
    url = Module.UTF8ToString(url);
    if (url.split(".").length === 4) url = `ws${location.protocol.slice(4)}//${location.host}/game/${url.slice(url.indexOf("//") + 2, url.indexOf("."))}`;
    else if (url.endsWith(":443")) url = `ws${location.protocol.slice(4)}//${location.host}/game/${url.slice(url.indexOf("//") + 2, url.length - 4)}`
    else return prompt("Error loading into game. Take a picture of this then send to our support server (github.com/ABCxFF/diepcustom)", url);

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.events = [];
    ws.onopen = function() {
      ws.events.push([2, 0, 0]);
      Module.exports.checkWS();
    };
    ws.onerror = function() {
      ws.events.push([3, 0, 0]);
      Module.exports.checkWS();
    };
    ws.onclose = function() {
      ws.events.push([4, 0, 0]);
      Module.exports.checkWS();
    };
    ws.onmessage = function(e) {
      const view = new Uint8Array(e.data);
      if (view[0] === 7) {
        let out = 0, i = 0, at = 1;
        while (view[at] & 0x80) {
          out |= (view[at++] & 0x7f) << i;
          i += 7;
        }
        out |= (view[at++] & 0x7f) << i;
        Module.permissionLevel = (0 - (out & 1)) ^ (out >>> 1);
        window.Game.reloadCommands();
      }
      const ptr = Module.exports.malloc(view.length);
      Module.HEAP8.set(view, ptr);
      ws.events.push([1, ptr, view.length]);
      Module.exports.checkWS();
    };
    for (let i = 0; i < Module.cp5.sockets.length; ++i) {
      if (Module.cp5.sockets[i] != null)
        continue;
      Module.cp5.sockets[i] = ws;
      return i;
    }

    if (Module.reloadServersInterval === -2) Game.reloadServers();
    if (Module.reloadTanksInterval === -2) Game.reloadTanks();
    if (Module.reloadCommandsInterval === -2) Game.reloadCommands();

    Module.cp5.sockets.push(ws);
    return Module.cp5.sockets.length - 1;
  }

  static findServerById(requestId, endpoint) {
    Module.exports.restReply(requestId, 0, 0, 0);
  }

  static invalidPartyId() {
    alert("Invalid party ID");
  }

  static wipeLocation() {
    window.location.hash = "";
  }

  static getGamepadAxe(axeId) {
    const axes = window.navigator.getGamepads()[0].axes;
    if (axeId >= axes.length) return;
    return axes[axeId];
  }

  static getGamepadButtonPressed(buttonId) {
    const buttons = window.navigator.getGamepads()[0].buttons;
    if (buttonId >= buttons.length) return;
    return buttons[buttonId].pressed;
  }

  static pollWebSocketEvent(socketId, msg, length) {
    const ws = Module.cp5.sockets[socketId];
    if (ws.events.length === 0) return null;
    const event = ws.events.shift();
    Module.HEAPU32[msg >> 2] = event[1]; // packet ptr
    Module.HEAP32[length >> 2] = event[2]; // packet length
    return event[0]; // type
  }

  static updateToNewVersion(version) {
    console.log(Module.UTF8ToString(version));
    setTimeout(() => window.location.reload());
  }

  // 1 (pow)

  static reloadWindow() {
    setTimeout(() => window.location.reload());
  }

  static getWindowLocationSearch() {
    return Module.allocateUTF8(window.location.search);
  }

  static getWindowReferrer() {
    return Module.allocateUTF8(window.document.referrer);
  }

  // 7 (fingerprinting)

  static empty() { }
}

Module.run();




// theme test



(function() {
  'use strict';
  var localStorage;
  var saveList;
  var nowSetting;
  var isLocal;
  var clone;
  jsInit();
  Object.defineProperty(window, "input", {
    configurable: true,
    set(v) {
      Object.defineProperty(window, "input", { configurable: true, enumerable: true, writable: true, value: v });
      pluginInit();
    }
  });

  function jsInit() {
    Storage.prototype.setObject = function(key, value) {
      this.setItem(key, JSON.stringify(value));
    }
    Storage.prototype.getObject = function(key) {
      var value = this.getItem(key);
      return value && JSON.parse(value);
    }
    clone = function(obj) {
      return JSON.parse(JSON.stringify(obj));
    }
    window.diepStyle = {};
    localStorage = window.localStorage;
    if (location.href.indexOf('file://') >= 0) {
      var warning = false;
      warning ? '' : console.warn('off warning');
      isLocal = true;
      window.input = {
        set_convar: function() {
          warning ? console.warn('block input.set_convar') : ''
        },
        execute: function() {
          warning ? console.warn('block input.set_execute') : ''
        }
      }
    }
  }

  function pluginInit() {
    storageInit();
    keyListen();
    tempInit();
    styleInit();
    diepStyle.onColor = onColor;
    diepStyle.storageInit = storageInit;
    //togglePanel(true);

    function storageInit(cmd) {
      var th = 50,
        netTH = 110;
      var colors = [{
        id: 2,
        name: 'You FFA',
        color: '00b1de'
      },
      {
        id: 15,
        name: 'Other FFA',
        color: 'f14e54'
      },
      {
        id: 3,
        name: 'Blue Team',
        color: '00b1de'
      },
      {
        id: 4,
        name: 'Red Team',
        color: 'f14e54'
      },
      {
        id: 5,
        name: 'Purple Team',
        color: 'bf7ff5'
      },
      {
        id: 6,
        name: 'Green Team',
        color: '00e16e'
      },
      {
        id: 17,
        name: 'Fallen team',
        color: 'c6c6c6'
      },
      {
        id: 12,
        name: 'Arena Closer',
        color: 'ffe869'
      },
      {
        id: 8,
        name: 'Square',
        color: 'ffe869'
      },
      {
        id: 7,
        name: 'Green Square?',
        color: '89ff69'
      },
      {
        id: 16,
        name: 'Necro Square',
        color: 'fcc376'
      },
      {
        id: 9,
        name: 'Triangle',
        color: 'fc7677'
      },
      {
        id: 10,
        name: 'Pentagon',
        color: '768dfc'
      },
      {
        id: 11,
        name: 'Crasher',
        color: 'f177dd'
      },
      {
        id: 14,
        name: 'Waze Wall',
        color: 'bbbbbb'
      },
      {
        id: 1,
        name: 'Turret',
        color: '999999'
      },
      {
        id: 0,
        name: 'Smasher',
        color: '4f4f4f'
      },
      {
        id: th++,
        name: 'All Bars',
        color: '000000',
        cmd: 'ren_bar_background_color'
      },
      {
        id: th++,
        name: 'Outline',
        color: '555555',
        cmd: 'ren_stroke_solid_color'
      },
      {
        id: 13,
        name: 'Leader Board',
        color: '64ff8c'
      },
      {
        id: th++,
        name: 'Xp Bar',
        color: 'ffde43',
        cmd: 'ren_xp_bar_fill_color'
      },
      {
        id: th++,
        name: 'Score Bar',
        color: '43ff91',
        cmd: 'ren_score_bar_fill_color'
      },
      {
        id: th++,
        name: 'Health Bar1',
        color: '85e37d',
        cmd: 'ren_health_fill_color'
      },
      {
        id: th++,
        name: 'Health Bar2',
        color: '555555',
        cmd: 'ren_health_background_color'
      },
      {
        id: th++,
        name: 'Grid Color',
        color: '000000',
        cmd: 'ren_grid_color'
      },
      {
        id: th++,
        name: 'Minimap 1',
        color: 'CDCDCD',
        cmd: 'ren_minimap_background_color'
      },
      {
        id: th++,
        name: 'Minimap 2',
        color: '797979',
        cmd: 'ren_minimap_border_color'
      },
      {
        id: th++,
        name: 'Background 1',
        color: 'CDCDCD',
        cmd: 'ren_background_color'
      },
      {
        id: th++,
        name: 'Background 2',
        color: '797979',
        cmd: 'ren_border_color'
      },
      {
        id: netTH++,
        name: 'UI Color1',
        color: 'e69f6c',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color2',
        color: 'ff73ff',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color3',
        color: 'c980ff',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color4',
        color: '71b4ff',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color5',
        color: 'ffed3f',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color6',
        color: 'ff7979',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color7',
        color: '88ff41',
        cmd: 'ui_replace_colors'
      },
      {
        id: netTH++,
        name: 'UI Color8',
        color: '41ffff',
        cmd: 'ui_replace_colors'
      },
      ]
      diepStyle.colorMap = new Map(colors.map(function(elem) {
        return [elem.id, {
          color: elem.color,
          cmd: elem.cmd || 'no cmd'
        }]
      }));

      diepStyle.uiColorMap = function(cmd) {
        var uiTH = nowSetting.colors.findIndex(elem => elem.name == 'UI Color1');
        var colorBunch = '';
        var arr = [];
        if (cmd == '0x') {
          for (var i = 0; i < 8; i++) {
            colorBunch = ' 0x' + nowSetting.colors[uiTH + i].color + colorBunch;
          }
          return colorBunch;
        }
        if (cmd == 'array') {
          for (var i = 0; i < 8; i++) {
            arr.push(nowSetting.colors[uiTH + i].color);
          }
          return arr;
        }
      }
      var renders = [{
        name: 'Grid Alpha',
        value: 0.1,
        cmd: 'grid_base_alpha'
      },
      {
        name: 'Outline Intensity',
        value: 0.25,
        cmd: 'stroke_soft_color_intensity'
      },
      {
        name: 'Show Outline',
        value: false,
        cmd: 'stroke_soft_color',
        reverse: true
      },
      {
        name: 'Border Alpha',
        value: 0.1,
        cmd: 'border_color_alpha'
      },
      {
        name: 'UI Scale',
        value: 1,
        cmd: 'ui_scale'
      },
      {
        name: 'Clear UI',
        value: false,
        cmd: 'ui',
        reverse: true
      },
      {
        name: 'Show FPS',
        value: false,
        cmd: 'fps'
      },
      {
        name: 'Show Health',
        value: false,
        cmd: 'raw_health_values'
      },
      {
        name: 'Hide Name',
        value: false,
        cmd: 'names',
        reverse: true
      },
      ];

      ;
      (function checkHasStorage() {
        var _localStorage = localStorage.getObject('diepStyle')
        var page = 1;
        if (nowSetting && nowSetting.saveTH) {
          page = nowSetting.saveTH;
        }
        if (_localStorage && _localStorage.saveList) {
          saveList = _localStorage.saveList;
          nowSetting = _localStorage.nowSetting;
        }
        if (!nowSetting || cmd == 'reset') {
          nowSetting = getBlankSetting();
          nowSetting.saveTH = page;
        }

        if (!saveList) saveList = getBlankSaveList();
        saveList[0] = getBlankSetting();;
        (function checkMissing() {
          var plain = getBlankSetting();
          plain.renders.forEach((elem, th) => {
            var index = nowSetting.renders.findIndex(now => elem.cmd == now.cmd);
            if (index < 0) {
              nowSetting.renders.splice(th, 0, elem);
              saveList[nowSetting.saveTH].renders.splice(th, 0, elem)
            }
          });
          plain.colors.forEach((elem, th) => {
            var index = nowSetting.colors.findIndex(now => {
              if (elem.cmd && elem.cmd == now.cmd) return true;
              if ((elem.id || elem.id == 0) && elem.id == now.id) return true;
            });
            if (index < 0) {
              nowSetting.colors.splice(th, 0, elem);
              saveList[nowSetting.saveTH].colors.splice(th, 0, elem);
            }
          });
        })();
      })();

      ;
      (function command() {
        diepStyle.command = {};
        renders.forEach(elem => {
          diepStyle.command[elem.cmd] = {};
          if (elem.reverse) diepStyle.command[elem.cmd].reverse = true;
        })
        diepStyle.command.fn = function(cmd, value) {
          nowSetting.renders = nowSetting.renders.map(elem => {
            if (elem.cmd == cmd) elem.value = value;
            return elem
          })
          if (diepStyle.command[cmd].reverse) value = !value;
          input.set_convar("ren_" + cmd, value);
        };
      })();

      function getBlankSetting() {
        return {
          version: 0.096,
          saveTH: 1,
          lock: false,
          colors,
          renders
        };
      }

      function getBlankSaveList() {
        var list = [];
        for (var i = 0; i < 6; i++) {
          list[i] = getBlankSetting();
          if (i == 0) list[i].isDefault = 'default,no save';
        }
        return clone(list);
      };
      Storage.prototype.pluginSave = function() {
        saveList[nowSetting.saveTH] = clone(nowSetting);
        var _storageObj = {
          nowSetting: clone(nowSetting),
          saveList: clone(saveList)
        }
        localStorage.setObject('diepStyle', _storageObj);
      };
      localStorage.pluginSave();
    }

    function keyListen() {
      var input = '';
      document.addEventListener('keyup', function(evt) {
        var that = this;
        if (that.pluginOn == undefined) that.pluginOn = false;
        var e = window.event || evt;
        var key = e.which || e.keyCode;
        input += key;
        if (input.indexOf('2727') >= 0) {
          input = '';
          that.pluginOn = !that.pluginOn
          togglePanel(that.pluginOn);
          (function save() {
            if (!that.pluginOn) {
              localStorage.pluginSave();
            };
          })();
        }
        if (input.length > 10) input = input.substring(input.length - 10);
      });
    }

    function tempInit() {

      var colorObj = {
        th: 0
      };
      var setObj = {
        th: 0
      }

      diepStyle.exportJSON = exportJSON;
      diepStyle.importJSON = importJSON;
      init1();
      loadColor();
      setTimeout(diepStyle.resetRender, 1500);
      diepStyle.resetColor = loadColor;

      function init1() {
        diepStyle.resetRender = resetRender;

        var title = `<div class="title">Diep.Style Ver 0.096<br>
                Press Esc twice to toggle this</div>`;

        var colorPlane = function(id) {
          return `{position:'left',width:300, height:200,onFineChange:'diepStyle.onColor(${id},this)'}`
        }

        colorObj.setClass = function() {
          return `colorBlock colorBlock${this.th++}`
        }
        setObj.setClass = function() {
          return `setting setting${this.th++}`
        }

        function resetRender(cmd) {
          document.querySelectorAll('#styleSetting .render').forEach(function(elem) {
            elem.outerHTML = ``
          })
          var it = document.querySelector('.renderBegin')
          it.insertAdjacentHTML('afterend', getRenderBody());
          it.remove();
          nowSetting.renders.forEach(function(elem) {
            diepStyle.command.fn(elem.cmd, elem.value);
          });
          listenerInit(cmd);

        }
        var bodyTheme = getThemeBody();
        var bodyRender = getRenderBody();
        var bodyColor = getColorBody();
        var bodyImport = getImportBody();

        function getThemeBody() {
          var th = 0;
          var html = `
                    <div class="themeBody">
                        <div class="themeBegin">Theme</div>
                        <div class="header hide themeDesc">
                            <span class="name"></span>
                            <span class="author"></span>
                        </div>
                        <div class="theme">
                            <div class="list">
                            <div data-theme="dark"><img src="https://imgur.com/bFyXqs5.jpg"><br>Dark</div>
                            <div data-theme="glass"><img src="https://imgur.com/4fnXdkE.jpg"><br>Glass</div>
                            <div data-theme="moomoo"><img src="https://imgur.com/XJwGabH.jpg"><br>Moomoo</div>
                            <div data-theme="80s"><img src="https://imgur.com/9Lma43A.jpg"><br>80s </div>
                            </div>
                        </div>
                    </div>
                    `
          return html
        }

        function getRenderBody() {
          var renders = nowSetting.renders;
          var th = -1;
          var html = `
                    <div class="renderBegin">Render</div>

                    <div class="row render">
                    <div class="cell">${renders[++th].name} <br><span class="grid_base_value">${renders[th].value}</span></div>
                    <div class="cell"><input type="range" name="grid_base_alpha" value=${renders[th].value * 100} max="200"></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name} <br><span class="stroke_intensity_value">${renders[th].value}</span></div>
                    <div class="cell"><input type="range" name="stroke_soft_color_intensity" value=${renders[th].value * 100} max="100"></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name}</div>
                    <div class="cell"><input type="checkbox" name="stroke_soft_color" ${renders[th].value ? 'checked' : ''}></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name} <br><span class="border_value">${renders[th].value}</span></div>
                    <div class="cell"><input type="range" name="border_color_alpha" value=${renders[th].value * 100} max="100"></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name} <br><span class="ui_scale_value">${renders[th].value}</span></div>
                    <div class="cell"><input type="range" name="ui_scale" value=${renders[th].value * 100} max="200"></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name}</div>
                    <div class="cell"><input type="checkbox" name="ui" ${renders[th].value ? 'checked' : ''}></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name}</div>
                    <div class="cell"><input type="checkbox" name="fps" ${renders[th].value ? 'checked' : ''}></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name}</div>
                    <div class="cell"><input type="checkbox" name="raw_health_values" ${renders[th].value ? 'checked' : ''}></div>
                    </div>
                    <div class="row render">
                    <div class="cell">${renders[++th].name}</div>
                    <div class="cell"><input type="checkbox" name="names" ${renders[th].value ? 'checked' : ''}></div>
                    </div>
                    `
          return html;
        }

        function getColorBody() {
          var it = `<div class="row colorBegin">Color</div>\n`;
          nowSetting.colors.forEach(function(elem, th) {
            var id = elem.id;
            it += `
                        <div class="row colorBlock colorBlock${th}">
                        <div class="cell"></div>
                        <div class="cell"><input class="jscolor ${colorPlane(`${id}`)}">  </div>
                        </div>
                        `;
          });
          return it
        }

        var allBody =
          `
                <div class="pluginBody">${title}
                <hr>
                ${bodyTheme}
                <div class="table">
                 ${bodyRender} ${bodyColor} <br>
                </div>
                </div>
                `;
        var getSaveBtns = function() {
          var btn = '';
          for (var i = 0; i < 6; i++) {
            if (i == 0) {
              btn += `<button>Default</button>`;
              continue;
            }
            btn += `<button>${i}</button>`;
          }
          return btn;
        }

        function getImportBody() {
          var html =
            `
                    <div class="importBegin">Import / Export Save</div>
                    <div class="row">
                    <div class="cell">
                    <button class="import">Import</button>
                    </div>
                    <div class="cell">
                    <button class="export">Export</button>
                    </div>
                    </div>
                    `
          return html
        }
        // <button class="selectTheme">Theme</button>
        var footer =
          `
                <div class="footer">
                <div class="saveBtns">${getSaveBtns()}</div>
                <div class="otherBtns">
                <span><button class="import">Import</button></span>
                <span><button class="export">Export</button></span>
                <span class="lock"><button>Lock</button></span>
                <span class="reset"><button>Reset</button></span>
                </div>
                </div>
                `
        var id = 0;
        var temp = `<div id="styleSetting"> ${allBody} ${footer} </div>`;
        document.querySelector('body').insertAdjacentHTML('afterend', temp);
        loadScript();

        function listenerInit(cmd) {
          ;
          (function() {
            var theName = "grid_base_alpha";
            document.querySelector(`input[name=${theName}]`).addEventListener('input',
              function(e) {
                var value = (e.target.value - e.target.value % 2) / 100
                document.querySelector('.grid_base_value').innerHTML = value;
                diepStyle.command.fn(theName, value);
              });
          })();;
          (function() {
            var theName = "stroke_soft_color_intensity";
            document.querySelector(`input[name=${theName}]`).addEventListener('input',
              function(e) {
                var value = (e.target.value - e.target.value % 5) / 100
                document.querySelector('.stroke_intensity_value').innerHTML = value;
                diepStyle.command.fn(theName, value);
              });
          })();;
          (function() {
            var theName = "stroke_soft_color";
            document.querySelector(`input[name=${theName}]`).addEventListener('change',
              function(e) {
                diepStyle.command.fn(theName, e.target.checked);
              });
          })();;
          (function() {
            var theName = "border_color_alpha";
            document.querySelector(`input[name=${theName}]`).addEventListener('input',
              function(e) {
                var value = (e.target.value - e.target.value % 2) / 100
                document.querySelector('.border_value').innerHTML = value;
                diepStyle.command.fn(theName, value);
              });
          })();;
          (function() {
            var theName = "ui_scale";
            document.querySelector(`input[name=${theName}]`).addEventListener('input',
              function(e) {
                var value = (e.target.value - e.target.value % 2) / 100
                document.querySelector(`.${theName}_value`).innerHTML = value;
                diepStyle.command.fn(theName, value);
              });
          })();;
          (function() {
            var theName = "ui";
            document.querySelector(`input[name=${theName}]`).addEventListener('change',
              function(e) {
                diepStyle.command.fn(theName, e.target.checked);
              });
          })();;
          (function() {
            var theName = "fps";
            document.querySelector(`input[name=${theName}]`).addEventListener('change',
              function(e) {
                diepStyle.command.fn(theName, e.target.checked);
              });
          })();;
          (function() {
            var theName = "raw_health_values";
            document.querySelector(`input[name=${theName}]`).addEventListener('change',
              function(e) {
                diepStyle.command.fn(theName, e.target.checked);
              });
          })();;
          (function() {
            var theName = "names";
            document.querySelector(`input[name=${theName}]`).addEventListener('change',
              function(e) {
                diepStyle.command.fn(theName, e.target.checked);
              });
          })();
          if (cmd == 'reset') return;
          (function() {
            document.querySelectorAll(`.theme div[data-theme]`).forEach(dom => {
              dom.addEventListener('click',
                () => {
                  const name = dom.getAttribute('data-theme');
                  const themes = diepStyle.themeJson;
                  diepStyle.importJSON(themes[name]);
                })
            })
          })();
          // document.querySelector('button.selectTheme').addEventListener('click', function(e) {
          // alert('k');
          // });
          document.querySelector('button.import').addEventListener('click', () => {
            var example = '[\n{"cmd":"ui_scale","value":"1.5"},' + '\n{"id":"8","value":"888888"}\n]';
            var gotValue = prompt('Enter The JSON\nExample:\n' + example, example.replace(/\s/g, ''));
            diepStyle.importJSON(gotValue);
          });
          document.querySelector('button.export').addEventListener('click', function(e) {
            prompt('Copy the Json', diepStyle.exportJSON('one'));
          });
          document.querySelectorAll('.saveBtns button').forEach((elem, th) => {
            elem.addEventListener('click', function() {
              localStorage.pluginSave();
              nowSetting = clone(saveList[th]);
              nowSetting.saveTH = th;
              // diepStyle.storageInit();
              // nowSetting.saveTH=th;
              diepStyle.resetColor();
              diepStyle.resetRender('reset');
              updateSaveBtns();
            })
          })
          document.querySelector('.lock button').addEventListener('click',
            function(e) {
              nowSetting.lock = !nowSetting.lock;
              updateSaveBtns();
            });
          document.querySelector('.reset button').addEventListener('click',
            function(e) {
              if (e.target.innerHTML != 'Confirm') {
                e.target.innerHTML = 'Confirm';
              } else {
                diepStyle.storageInit('reset');
                diepStyle.resetColor();
                diepStyle.resetRender('reset');
                updateSaveBtns();
              }
            });
          document.querySelector('.reset button').addEventListener('mouseleave', function(e) {
            e.target.innerHTML = 'Reset';
          })
          updateSaveBtns();

          function updateSaveBtns() {
            var theTH = nowSetting.saveTH;
            var status = saveList[theTH];
            var lockBtn = document.querySelector('.lock button');
            var resetBtn = document.querySelector('.reset button');
            if (theTH == 0) {
              lockBtn.disabled = true;
              resetBtn.disabled = true;
              nowSetting.lock = true;
            } else {
              resetBtn.disabled = nowSetting.lock;
              lockBtn.disabled = false;
            }
            if (resetBtn.disabled) {
              document.querySelector('.table').classList.add('noClicks');
              document.querySelector('.themeBody').classList.add('noClicks');
              document.querySelector('button.import').classList.add('noClicks');
              lockBtn.innerHTML = 'locked';
            } else {
              document.querySelector('.table').classList.remove('noClicks');
              document.querySelector('.themeBody').classList.remove('noClicks');
              document.querySelector('button.import').classList.remove('noClicks');
              lockBtn.innerHTML = 'no lock';
            };
            (function() {
              document.querySelectorAll('.saveBtns button').forEach(function(elem, th) {
                elem.classList.remove('chosenBtn');
                if (theTH == th) elem.classList.add('chosenBtn');
              })
            })();
          }
        }
      }

      function loadColor() {
        if (nowSetting.theme) {
          document.querySelector('.themeDesc').classList.remove('hide');
          var it = document.querySelector('.themeDesc .name');
          it.innerText = nowSetting.theme.name;
          it = document.querySelector('.themeDesc .author');
          it.innerText = 'by\n ' + nowSetting.theme.author;
        } else {
          document.querySelector('.themeDesc').classList.add('hide');
        }

        nowSetting.colors.some(function(elem, th) {
          var target = document.querySelector(`.colorBlock${th}`);
          if (!target || !target.querySelector('.cell input').jscolor) {
            setTimeout(loadColor, 500);
            return true
          }
          onColor(elem.id, elem.color);
          target.querySelector('.cell').innerHTML = elem.name;
          target.querySelector('.cell input').jscolor.fromString(elem.color);
        })
      }

      function exportJSON(cmd) {
        var toExport = [];
        if (cmd == 'one') toExport = write(nowSetting);
        if (cmd == 'all') saveList.forEach(elem => toExport.push(write(elem)));
        return JSON.stringify(toExport);

        function write(now) {
          var array = [];
          now.colors.forEach(function(elem) {
            if (elem.id && elem.id < 50) array.push({
              id: elem.id,
              value: elem.color
            });
            if (elem.id && elem.id >= 50 && elem.id < 100) array.push({
              cmd: elem.cmd,
              value: elem.color
            });
            if (!elem.id && elem.cmd) array.push({
              cmd: elem.cmd,
              value: elem.color
            });
          });
          array.push({
            cmd: 'ui_replace_colors',
            value: diepStyle.uiColorMap('array')
          });
          now.renders.forEach(function(elem) {
            array.push({
              cmd: elem.cmd,
              value: elem.value
            });
          });
          if (now.theme) {
            array.unshift({
              theme: {
                name: now.theme.name || '',
                author: now.theme.author || ''
              }
            });
          } else {
            array.unshift({
              theme: {
                name: '',
                author: ''
              }
            });
          }
          return array
        }
      }

      function importJSON(json) {
        if (!isJson(json)) {
          alert('Code Incorrect\nPlz git gud and check your JSON');
          return
        };
        var gotArr = JSON.parse(json);
        if (!gotArr) return;
        gotArr.forEach(function(elem) {
          nowSetting.colors = nowSetting.colors.map(function(now) {
            if (elem.id && now.id == elem.id) now.color = elem.value;
            if (!elem.id && elem.cmd && now.cmd == elem.cmd) now.color = elem.value;
            return now
          });
          nowSetting.renders = nowSetting.renders.map(function(now) {
            if (elem.cmd && now.cmd == elem.cmd) now.value = elem.value;
            return now
          });
          if (elem.cmd == 'ui_replace_colors') {
            var uiTH = nowSetting.colors.findIndex(elem => elem.name == 'UI Color1');
            for (var i = 0; i < 8; i++) {
              nowSetting.colors[uiTH + i].color = elem.value[i];
            }
          };
          if (elem.theme) {
            if (elem.theme.name || elem.theme.author) nowSetting.theme = elem.theme;
          } else {
            elem.theme = {};
          };
        });
        document.querySelectorAll('.saveBtns button')[nowSetting.saveTH].click();

        function isJson(str) {
          try {
            JSON.parse(str);
          } catch (e) {
            return false;
          }
          if (typeof JSON.parse(str) == 'object') return true;
        }
      }
    }

    function onColor(id, e) {
      var target = id;
      var color = e.toString();
      if (id >= 0 && id < 50) {
        input.execute(`net_replace_color ${target} 0x${color}`)
      } else if (id >= 50 && id < 100) {
        var cmd = diepStyle.colorMap.get(id).cmd
        input.set_convar(cmd, `0x${color}`);
      } else {
        input.execute('ui_replace_colors' + diepStyle.uiColorMap('0x'));
      }
      nowSetting.colors = nowSetting.colors.map(function(elem) {
        if (elem.id === id) elem.color = color;
        return elem
      })
    }

    function styleInit() {
      addGlobalStyle(`#styleSetting{padding: 0.2em; margin:0.2em; position: absolute;top: 0;right: 0;width: 35%;
                min-width:20em; background-color: rgba(200,200,200,0.8);display:none;border: 1px solid black;height: 92vh;}`);
      addGlobalStyle(".table{ display: table; text-align: center; width: 99%;}");
      addGlobalStyle(".row{ display: table-row; }");
      addGlobalStyle(`.cell{ display: table-cell;}`);
      addGlobalStyle(`.cell:not(.noBoard){ display: table-cell; padding: 0.1em 0.3em;border: 1px solid black;}`);
      addGlobalStyle("input[type=checkbox],input[type=range]{transform: scale(1.2); }");

      addGlobalStyle(`.pluginBody{height: 90%; overflow-y: auto;}`);
      addGlobalStyle(`.theme .list div{width: 48%; float: left; text-align: center; padding: 1%;}`);
      addGlobalStyle(`.theme img {width: 90%;}`);
      // addGlobalStyle(`.themeDesc .cell {width: 40vw;}`);
      addGlobalStyle(`.colorBegin, .renderBegin, .importBegin,.themeBegin,.header{font-size:1.1rem; line-height:1.3em;text-align: center;}`);
      addGlobalStyle(`.saveBtns button{margin: 0 3%; padding: 0.2em 0.5em;}`);
      addGlobalStyle(`@-moz-document url-prefix() {.saveBtns button{margin: 0 1%;padding: 0.1em 0.3em;} } }`);
      addGlobalStyle(`.otherBtns button{margin: 0 4%; padding: 0.2em 0.5em;}`);
      addGlobalStyle(`.footer{text-align:center;height:10%; border: 1px solid black;}`);
      addGlobalStyle(`.footer > *{margin: 0.2vh 0 1.3vh 0;}`);

      addGlobalStyle(`.reset button{box-shadow: 0 0 1em red;}`);
      addGlobalStyle(`.backRed{background-color:#f14e54}`);
      addGlobalStyle(`.chosenBtn{-webkit-filter: brightness(0.8);filter:brightness(0.8);}`)
      addGlobalStyle(`.noClicks{pointer-events:none; -webkit-filter: opacity(50%); filter: opacity(50%);}`)
      addGlobalStyle(`.hide{display:none}`)

      function addGlobalStyle(css) {
        var head, style;
        head = document.getElementsByTagName('head')[0];
        if (!head) {
          return;
        }
        style = document.createElement('style');
        style.type = 'text/css';
        style.innerHTML = css;
        head.appendChild(style);
      }
    }
  }

  function togglePanel(tf) {
    if (tf) {
      try {
        document.querySelector('#styleSetting').style.display = "block";
      } catch (err) {
        var warn = '\n\nYou can DELETE ALL PLUGIN SAVES to fix this' +
          '\nType delete to confirm' +
          '\nor cancel to download all saves';
        var gotValue = prompt('Got an error\n' + err + warn);
        if (gotValue == 'delete') {
          localStorage.removeItem('diepStyle');
          alert('Deleted,refresh to take effect');
          return
        } else {
          download('diep.style saves.txt', diepStyle.exportJSON('all'))
        };
      }
    } else {
      document.querySelector('#styleSetting').style.display = "none";
    }

    function download(filename, text) {
      var element = document.createElement('a');
      element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
      element.setAttribute('download', filename);

      element.style.display = 'none';
      document.body.appendChild(element);

      element.click();

      document.body.removeChild(element);
    }
  }

  function loadScript() {
    ;
    (function() { "use strict"; window.jscolor || (window.jscolor = function() { var e = { register: function() { e.attachDOMReadyEvent(e.init), e.attachEvent(document, "mousedown", e.onDocumentMouseDown), e.attachEvent(document, "touchstart", e.onDocumentTouchStart), e.attachEvent(window, "resize", e.onWindowResize) }, init: function() { e.jscolor.lookupClass && e.jscolor.installByClassName(e.jscolor.lookupClass) }, tryInstallOnElements: function(t, n) { var r = new RegExp("(^|\\s)(" + n + ")(\\s*(\\{[^}]*\\})|\\s|$)", "i"); for (var i = 0; i < t.length; i += 1) { if (t[i].type !== undefined && t[i].type.toLowerCase() == "color" && e.isColorAttrSupported) continue; var s; if (!t[i].jscolor && t[i].className && (s = t[i].className.match(r))) { var o = t[i], u = null, a = e.getDataAttr(o, "jscolor"); a !== null ? u = a : s[4] && (u = s[4]); var f = {}; if (u) try { f = (new Function("return (" + u + ")"))() } catch (l) { } o.jscolor = new e.jscolor(o, f) } } }, isColorAttrSupported: function() { var e = document.createElement("input"); if (e.setAttribute) { e.setAttribute("type", "color"); if (e.type.toLowerCase() == "color") return !0 } return !1 }(), isCanvasSupported: function() { var e = document.createElement("canvas"); return !!e.getContext && !!e.getContext("2d") }(), fetchElement: function(e) { return typeof e == "string" ? document.getElementById(e) : e }, isElementType: function(e, t) { return e.nodeName.toLowerCase() === t.toLowerCase() }, getDataAttr: function(e, t) { var n = "data-" + t, r = e.getAttribute(n); return r !== null ? r : null }, attachEvent: function(e, t, n) { e.addEventListener ? e.addEventListener(t, n, !1) : e.attachEvent && e.attachEvent("on" + t, n) }, detachEvent: function(e, t, n) { e.removeEventListener ? e.removeEventListener(t, n, !1) : e.detachEvent && e.detachEvent("on" + t, n) }, _attachedGroupEvents: {}, attachGroupEvent: function(t, n, r, i) { e._attachedGroupEvents.hasOwnProperty(t) || (e._attachedGroupEvents[t] = []), e._attachedGroupEvents[t].push([n, r, i]), e.attachEvent(n, r, i) }, detachGroupEvents: function(t) { if (e._attachedGroupEvents.hasOwnProperty(t)) { for (var n = 0; n < e._attachedGroupEvents[t].length; n += 1) { var r = e._attachedGroupEvents[t][n]; e.detachEvent(r[0], r[1], r[2]) } delete e._attachedGroupEvents[t] } }, attachDOMReadyEvent: function(e) { var t = !1, n = function() { t || (t = !0, e()) }; if (document.readyState === "complete") { setTimeout(n, 1); return } if (document.addEventListener) document.addEventListener("DOMContentLoaded", n, !1), window.addEventListener("load", n, !1); else if (document.attachEvent) { document.attachEvent("onreadystatechange", function() { document.readyState === "complete" && (document.detachEvent("onreadystatechange", arguments.callee), n()) }), window.attachEvent("onload", n); if (document.documentElement.doScroll && window == window.top) { var r = function() { if (!document.body) return; try { document.documentElement.doScroll("left"), n() } catch (e) { setTimeout(r, 1) } }; r() } } }, warn: function(e) { window.console && window.console.warn && window.console.warn(e) }, preventDefault: function(e) { e.preventDefault && e.preventDefault(), e.returnValue = !1 }, captureTarget: function(t) { t.setCapture && (e._capturedTarget = t, e._capturedTarget.setCapture()) }, releaseTarget: function() { e._capturedTarget && (e._capturedTarget.releaseCapture(), e._capturedTarget = null) }, fireEvent: function(e, t) { if (!e) return; if (document.createEvent) { var n = document.createEvent("HTMLEvents"); n.initEvent(t, !0, !0), e.dispatchEvent(n) } else if (document.createEventObject) { var n = document.createEventObject(); e.fireEvent("on" + t, n) } else e["on" + t] && e["on" + t]() }, classNameToList: function(e) { return e.replace(/^\s+|\s+$/g, "").split(/\s+/) }, hasClass: function(e, t) { return t ? -1 != (" " + e.className.replace(/\s+/g, " ") + " ").indexOf(" " + t + " ") : !1 }, setClass: function(t, n) { var r = e.classNameToList(n); for (var i = 0; i < r.length; i += 1) e.hasClass(t, r[i]) || (t.className += (t.className ? " " : "") + r[i]) }, unsetClass: function(t, n) { var r = e.classNameToList(n); for (var i = 0; i < r.length; i += 1) { var s = new RegExp("^\\s*" + r[i] + "\\s*|" + "\\s*" + r[i] + "\\s*$|" + "\\s+" + r[i] + "(\\s+)", "g"); t.className = t.className.replace(s, "$1") } }, getStyle: function(e) { return window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle }, setStyle: function() { var e = document.createElement("div"), t = function(t) { for (var n = 0; n < t.length; n += 1) if (t[n] in e.style) return t[n] }, n = { borderRadius: t(["borderRadius", "MozBorderRadius", "webkitBorderRadius"]), boxShadow: t(["boxShadow", "MozBoxShadow", "webkitBoxShadow"]) }; return function(e, t, r) { switch (t.toLowerCase()) { case "opacity": var i = Math.round(parseFloat(r) * 100); e.style.opacity = r, e.style.filter = "alpha(opacity=" + i + ")"; break; default: e.style[n[t]] = r } } }(), setBorderRadius: function(t, n) { e.setStyle(t, "borderRadius", n || "0") }, setBoxShadow: function(t, n) { e.setStyle(t, "boxShadow", n || "none") }, getElementPos: function(t, n) { var r = 0, i = 0, s = t.getBoundingClientRect(); r = s.left, i = s.top; if (!n) { var o = e.getViewPos(); r += o[0], i += o[1] } return [r, i] }, getElementSize: function(e) { return [e.offsetWidth, e.offsetHeight] }, getAbsPointerPos: function(e) { e || (e = window.event); var t = 0, n = 0; return typeof e.changedTouches != "undefined" && e.changedTouches.length ? (t = e.changedTouches[0].clientX, n = e.changedTouches[0].clientY) : typeof e.clientX == "number" && (t = e.clientX, n = e.clientY), { x: t, y: n } }, getRelPointerPos: function(e) { e || (e = window.event); var t = e.target || e.srcElement, n = t.getBoundingClientRect(), r = 0, i = 0, s = 0, o = 0; return typeof e.changedTouches != "undefined" && e.changedTouches.length ? (s = e.changedTouches[0].clientX, o = e.changedTouches[0].clientY) : typeof e.clientX == "number" && (s = e.clientX, o = e.clientY), r = s - n.left, i = o - n.top, { x: r, y: i } }, getViewPos: function() { var e = document.documentElement; return [(window.pageXOffset || e.scrollLeft) - (e.clientLeft || 0), (window.pageYOffset || e.scrollTop) - (e.clientTop || 0)] }, getViewSize: function() { var e = document.documentElement; return [window.innerWidth || e.clientWidth, window.innerHeight || e.clientHeight] }, redrawPosition: function() { if (e.picker && e.picker.owner) { var t = e.picker.owner, n, r; t.fixed ? (n = e.getElementPos(t.targetElement, !0), r = [0, 0]) : (n = e.getElementPos(t.targetElement), r = e.getViewPos()); var i = e.getElementSize(t.targetElement), s = e.getViewSize(), o = e.getPickerOuterDims(t), u, a, f; switch (t.position.toLowerCase()) { case "left": u = 1, a = 0, f = -1; break; case "right": u = 1, a = 0, f = 1; break; case "top": u = 0, a = 1, f = -1; break; default: u = 0, a = 1, f = 1 } var l = (i[a] + o[a]) / 2; if (!t.smartPosition) var c = [n[u], n[a] + i[a] - l + l * f]; else var c = [-r[u] + n[u] + o[u] > s[u] ? -r[u] + n[u] + i[u] / 2 > s[u] / 2 && n[u] + i[u] - o[u] >= 0 ? n[u] + i[u] - o[u] : n[u] : n[u], -r[a] + n[a] + i[a] + o[a] - l + l * f > s[a] ? -r[a] + n[a] + i[a] / 2 > s[a] / 2 && n[a] + i[a] - l - l * f >= 0 ? n[a] + i[a] - l - l * f : n[a] + i[a] - l + l * f : n[a] + i[a] - l + l * f >= 0 ? n[a] + i[a] - l + l * f : n[a] + i[a] - l - l * f]; var h = c[u], p = c[a], d = t.fixed ? "fixed" : "absolute", v = (c[0] + o[0] > n[0] || c[0] < n[0] + i[0]) && c[1] + o[1] < n[1] + i[1]; e._drawPosition(t, h, p, d, v) } }, _drawPosition: function(t, n, r, i, s) { var o = s ? 0 : t.shadowBlur; e.picker.wrap.style.position = i, e.picker.wrap.style.left = n + "px", e.picker.wrap.style.top = r + "px", e.setBoxShadow(e.picker.boxS, t.shadow ? new e.BoxShadow(0, o, t.shadowBlur, 0, t.shadowColor) : null) }, getPickerDims: function(t) { var n = !!e.getSliderComponent(t), r = [2 * t.insetWidth + 2 * t.padding + t.width + (n ? 2 * t.insetWidth + e.getPadToSliderPadding(t) + t.sliderSize : 0), 2 * t.insetWidth + 2 * t.padding + t.height + (t.closable ? 2 * t.insetWidth + t.padding + t.buttonHeight : 0)]; return r }, getPickerOuterDims: function(t) { var n = e.getPickerDims(t); return [n[0] + 2 * t.borderWidth, n[1] + 2 * t.borderWidth] }, getPadToSliderPadding: function(e) { return Math.max(e.padding, 1.5 * (2 * e.pointerBorderWidth + e.pointerThickness)) }, getPadYComponent: function(e) { switch (e.mode.charAt(1).toLowerCase()) { case "v": return "v" } return "s" }, getSliderComponent: function(e) { if (e.mode.length > 2) switch (e.mode.charAt(2).toLowerCase()) { case "s": return "s"; case "v": return "v" } return null }, onDocumentMouseDown: function(t) { t || (t = window.event); var n = t.target || t.srcElement; n._jscLinkedInstance ? n._jscLinkedInstance.showOnClick && n._jscLinkedInstance.show() : n._jscControlName ? e.onControlPointerStart(t, n, n._jscControlName, "mouse") : e.picker && e.picker.owner && e.picker.owner.hide() }, onDocumentTouchStart: function(t) { t || (t = window.event); var n = t.target || t.srcElement; n._jscLinkedInstance ? n._jscLinkedInstance.showOnClick && n._jscLinkedInstance.show() : n._jscControlName ? e.onControlPointerStart(t, n, n._jscControlName, "touch") : e.picker && e.picker.owner && e.picker.owner.hide() }, onWindowResize: function(t) { e.redrawPosition() }, onParentScroll: function(t) { e.picker && e.picker.owner && e.picker.owner.hide() }, _pointerMoveEvent: { mouse: "mousemove", touch: "touchmove" }, _pointerEndEvent: { mouse: "mouseup", touch: "touchend" }, _pointerOrigin: null, _capturedTarget: null, onControlPointerStart: function(t, n, r, i) { var s = n._jscInstance; e.preventDefault(t), e.captureTarget(n); var o = function(s, o) { e.attachGroupEvent("drag", s, e._pointerMoveEvent[i], e.onDocumentPointerMove(t, n, r, i, o)), e.attachGroupEvent("drag", s, e._pointerEndEvent[i], e.onDocumentPointerEnd(t, n, r, i)) }; o(document, [0, 0]); if (window.parent && window.frameElement) { var u = window.frameElement.getBoundingClientRect(), a = [-u.left, -u.top]; o(window.parent.window.document, a) } var f = e.getAbsPointerPos(t), l = e.getRelPointerPos(t); e._pointerOrigin = { x: f.x - l.x, y: f.y - l.y }; switch (r) { case "pad": switch (e.getSliderComponent(s)) { case "s": s.hsv[1] === 0 && s.fromHSV(null, 100, null); break; case "v": s.hsv[2] === 0 && s.fromHSV(null, null, 100) } e.setPad(s, t, 0, 0); break; case "sld": e.setSld(s, t, 0) } e.dispatchFineChange(s) }, onDocumentPointerMove: function(t, n, r, i, s) { return function(t) { var i = n._jscInstance; switch (r) { case "pad": t || (t = window.event), e.setPad(i, t, s[0], s[1]), e.dispatchFineChange(i); break; case "sld": t || (t = window.event), e.setSld(i, t, s[1]), e.dispatchFineChange(i) } } }, onDocumentPointerEnd: function(t, n, r, i) { return function(t) { var r = n._jscInstance; e.detachGroupEvents("drag"), e.releaseTarget(), e.dispatchChange(r) } }, dispatchChange: function(t) { t.valueElement && e.isElementType(t.valueElement, "input") && e.fireEvent(t.valueElement, "change") }, dispatchFineChange: function(e) { if (e.onFineChange) { var t; typeof e.onFineChange == "string" ? t = new Function(e.onFineChange) : t = e.onFineChange, t.call(e) } }, setPad: function(t, n, r, i) { var s = e.getAbsPointerPos(n), o = r + s.x - e._pointerOrigin.x - t.padding - t.insetWidth, u = i + s.y - e._pointerOrigin.y - t.padding - t.insetWidth, a = o * (360 / (t.width - 1)), f = 100 - u * (100 / (t.height - 1)); switch (e.getPadYComponent(t)) { case "s": t.fromHSV(a, f, null, e.leaveSld); break; case "v": t.fromHSV(a, null, f, e.leaveSld) } }, setSld: function(t, n, r) { var i = e.getAbsPointerPos(n), s = r + i.y - e._pointerOrigin.y - t.padding - t.insetWidth, o = 100 - s * (100 / (t.height - 1)); switch (e.getSliderComponent(t)) { case "s": t.fromHSV(null, o, null, e.leavePad); break; case "v": t.fromHSV(null, null, o, e.leavePad) } }, _vmlNS: "jsc_vml_", _vmlCSS: "jsc_vml_css_", _vmlReady: !1, initVML: function() { if (!e._vmlReady) { var t = document; t.namespaces[e._vmlNS] || t.namespaces.add(e._vmlNS, "urn:schemas-microsoft-com:vml"); if (!t.styleSheets[e._vmlCSS]) { var n = ["shape", "shapetype", "group", "background", "path", "formulas", "handles", "fill", "stroke", "shadow", "textbox", "textpath", "imagedata", "line", "polyline", "curve", "rect", "roundrect", "oval", "arc", "image"], r = t.createStyleSheet(); r.owningElement.id = e._vmlCSS; for (var i = 0; i < n.length; i += 1) r.addRule(e._vmlNS + "\\:" + n[i], "behavior:url(#default#VML);") } e._vmlReady = !0 } }, createPalette: function() { var t = { elm: null, draw: null }; if (e.isCanvasSupported) { var n = document.createElement("canvas"), r = n.getContext("2d"), i = function(e, t, i) { n.width = e, n.height = t, r.clearRect(0, 0, n.width, n.height); var s = r.createLinearGradient(0, 0, n.width, 0); s.addColorStop(0, "#F00"), s.addColorStop(1 / 6, "#FF0"), s.addColorStop(2 / 6, "#0F0"), s.addColorStop(.5, "#0FF"), s.addColorStop(4 / 6, "#00F"), s.addColorStop(5 / 6, "#F0F"), s.addColorStop(1, "#F00"), r.fillStyle = s, r.fillRect(0, 0, n.width, n.height); var o = r.createLinearGradient(0, 0, 0, n.height); switch (i.toLowerCase()) { case "s": o.addColorStop(0, "rgba(255,255,255,0)"), o.addColorStop(1, "rgba(255,255,255,1)"); break; case "v": o.addColorStop(0, "rgba(0,0,0,0)"), o.addColorStop(1, "rgba(0,0,0,1)") } r.fillStyle = o, r.fillRect(0, 0, n.width, n.height) }; t.elm = n, t.draw = i } else { e.initVML(); var s = document.createElement("div"); s.style.position = "relative", s.style.overflow = "hidden"; var o = document.createElement(e._vmlNS + ":fill"); o.type = "gradient", o.method = "linear", o.angle = "90", o.colors = "16.67% #F0F, 33.33% #00F, 50% #0FF, 66.67% #0F0, 83.33% #FF0"; var u = document.createElement(e._vmlNS + ":rect"); u.style.position = "absolute", u.style.left = "-1px", u.style.top = "-1px", u.stroked = !1, u.appendChild(o), s.appendChild(u); var a = document.createElement(e._vmlNS + ":fill"); a.type = "gradient", a.method = "linear", a.angle = "180", a.opacity = "0"; var f = document.createElement(e._vmlNS + ":rect"); f.style.position = "absolute", f.style.left = "-1px", f.style.top = "-1px", f.stroked = !1, f.appendChild(a), s.appendChild(f); var i = function(e, t, n) { s.style.width = e + "px", s.style.height = t + "px", u.style.width = f.style.width = e + 1 + "px", u.style.height = f.style.height = t + 1 + "px", o.color = "#F00", o.color2 = "#F00"; switch (n.toLowerCase()) { case "s": a.color = a.color2 = "#FFF"; break; case "v": a.color = a.color2 = "#000" } }; t.elm = s, t.draw = i } return t }, createSliderGradient: function() { var t = { elm: null, draw: null }; if (e.isCanvasSupported) { var n = document.createElement("canvas"), r = n.getContext("2d"), i = function(e, t, i, s) { n.width = e, n.height = t, r.clearRect(0, 0, n.width, n.height); var o = r.createLinearGradient(0, 0, 0, n.height); o.addColorStop(0, i), o.addColorStop(1, s), r.fillStyle = o, r.fillRect(0, 0, n.width, n.height) }; t.elm = n, t.draw = i } else { e.initVML(); var s = document.createElement("div"); s.style.position = "relative", s.style.overflow = "hidden"; var o = document.createElement(e._vmlNS + ":fill"); o.type = "gradient", o.method = "linear", o.angle = "180"; var u = document.createElement(e._vmlNS + ":rect"); u.style.position = "absolute", u.style.left = "-1px", u.style.top = "-1px", u.stroked = !1, u.appendChild(o), s.appendChild(u); var i = function(e, t, n, r) { s.style.width = e + "px", s.style.height = t + "px", u.style.width = e + 1 + "px", u.style.height = t + 1 + "px", o.color = n, o.color2 = r }; t.elm = s, t.draw = i } return t }, leaveValue: 1, leaveStyle: 2, leavePad: 4, leaveSld: 8, BoxShadow: function() { var e = function(e, t, n, r, i, s) { this.hShadow = e, this.vShadow = t, this.blur = n, this.spread = r, this.color = i, this.inset = !!s }; return e.prototype.toString = function() { var e = [Math.round(this.hShadow) + "px", Math.round(this.vShadow) + "px", Math.round(this.blur) + "px", Math.round(this.spread) + "px", this.color]; return this.inset && e.push("inset"), e.join(" ") }, e }(), jscolor: function(t, n) { function i(e, t, n) { e /= 255, t /= 255, n /= 255; var r = Math.min(Math.min(e, t), n), i = Math.max(Math.max(e, t), n), s = i - r; if (s === 0) return [null, 0, 100 * i]; var o = e === r ? 3 + (n - t) / s : t === r ? 5 + (e - n) / s : 1 + (t - e) / s; return [60 * (o === 6 ? 0 : o), 100 * (s / i), 100 * i] } function s(e, t, n) { var r = 255 * (n / 100); if (e === null) return [r, r, r]; e /= 60, t /= 100; var i = Math.floor(e), s = i % 2 ? e - i : 1 - (e - i), o = r * (1 - t), u = r * (1 - t * s); switch (i) { case 6: case 0: return [r, u, o]; case 1: return [u, r, o]; case 2: return [o, r, u]; case 3: return [o, u, r]; case 4: return [u, o, r]; case 5: return [r, o, u] } } function o() { e.unsetClass(d.targetElement, d.activeClass), e.picker.wrap.parentNode.removeChild(e.picker.wrap), delete e.picker.owner } function u() { function l() { var e = d.insetColor.split(/\s+/), n = e.length < 2 ? e[0] : e[1] + " " + e[0] + " " + e[0] + " " + e[1]; t.btn.style.borderColor = n } d._processParentElementsInDOM(), e.picker || (e.picker = { owner: null, wrap: document.createElement("div"), box: document.createElement("div"), boxS: document.createElement("div"), boxB: document.createElement("div"), pad: document.createElement("div"), padB: document.createElement("div"), padM: document.createElement("div"), padPal: e.createPalette(), cross: document.createElement("div"), crossBY: document.createElement("div"), crossBX: document.createElement("div"), crossLY: document.createElement("div"), crossLX: document.createElement("div"), sld: document.createElement("div"), sldB: document.createElement("div"), sldM: document.createElement("div"), sldGrad: e.createSliderGradient(), sldPtrS: document.createElement("div"), sldPtrIB: document.createElement("div"), sldPtrMB: document.createElement("div"), sldPtrOB: document.createElement("div"), btn: document.createElement("div"), btnT: document.createElement("span") }, e.picker.pad.appendChild(e.picker.padPal.elm), e.picker.padB.appendChild(e.picker.pad), e.picker.cross.appendChild(e.picker.crossBY), e.picker.cross.appendChild(e.picker.crossBX), e.picker.cross.appendChild(e.picker.crossLY), e.picker.cross.appendChild(e.picker.crossLX), e.picker.padB.appendChild(e.picker.cross), e.picker.box.appendChild(e.picker.padB), e.picker.box.appendChild(e.picker.padM), e.picker.sld.appendChild(e.picker.sldGrad.elm), e.picker.sldB.appendChild(e.picker.sld), e.picker.sldB.appendChild(e.picker.sldPtrOB), e.picker.sldPtrOB.appendChild(e.picker.sldPtrMB), e.picker.sldPtrMB.appendChild(e.picker.sldPtrIB), e.picker.sldPtrIB.appendChild(e.picker.sldPtrS), e.picker.box.appendChild(e.picker.sldB), e.picker.box.appendChild(e.picker.sldM), e.picker.btn.appendChild(e.picker.btnT), e.picker.box.appendChild(e.picker.btn), e.picker.boxB.appendChild(e.picker.box), e.picker.wrap.appendChild(e.picker.boxS), e.picker.wrap.appendChild(e.picker.boxB)); var t = e.picker, n = !!e.getSliderComponent(d), r = e.getPickerDims(d), i = 2 * d.pointerBorderWidth + d.pointerThickness + 2 * d.crossSize, s = e.getPadToSliderPadding(d), o = Math.min(d.borderRadius, Math.round(d.padding * Math.PI)), u = "crosshair"; t.wrap.style.clear = "both", t.wrap.style.width = r[0] + 2 * d.borderWidth + "px", t.wrap.style.height = r[1] + 2 * d.borderWidth + "px", t.wrap.style.zIndex = d.zIndex, t.box.style.width = r[0] + "px", t.box.style.height = r[1] + "px", t.boxS.style.position = "absolute", t.boxS.style.left = "0", t.boxS.style.top = "0", t.boxS.style.width = "100%", t.boxS.style.height = "100%", e.setBorderRadius(t.boxS, o + "px"), t.boxB.style.position = "relative", t.boxB.style.border = d.borderWidth + "px solid", t.boxB.style.borderColor = d.borderColor, t.boxB.style.background = d.backgroundColor, e.setBorderRadius(t.boxB, o + "px"), t.padM.style.background = t.sldM.style.background = "#FFF", e.setStyle(t.padM, "opacity", "0"), e.setStyle(t.sldM, "opacity", "0"), t.pad.style.position = "relative", t.pad.style.width = d.width + "px", t.pad.style.height = d.height + "px", t.padPal.draw(d.width, d.height, e.getPadYComponent(d)), t.padB.style.position = "absolute", t.padB.style.left = d.padding + "px", t.padB.style.top = d.padding + "px", t.padB.style.border = d.insetWidth + "px solid", t.padB.style.borderColor = d.insetColor, t.padM._jscInstance = d, t.padM._jscControlName = "pad", t.padM.style.position = "absolute", t.padM.style.left = "0", t.padM.style.top = "0", t.padM.style.width = d.padding + 2 * d.insetWidth + d.width + s / 2 + "px", t.padM.style.height = r[1] + "px", t.padM.style.cursor = u, t.cross.style.position = "absolute", t.cross.style.left = t.cross.style.top = "0", t.cross.style.width = t.cross.style.height = i + "px", t.crossBY.style.position = t.crossBX.style.position = "absolute", t.crossBY.style.background = t.crossBX.style.background = d.pointerBorderColor, t.crossBY.style.width = t.crossBX.style.height = 2 * d.pointerBorderWidth + d.pointerThickness + "px", t.crossBY.style.height = t.crossBX.style.width = i + "px", t.crossBY.style.left = t.crossBX.style.top = Math.floor(i / 2) - Math.floor(d.pointerThickness / 2) - d.pointerBorderWidth + "px", t.crossBY.style.top = t.crossBX.style.left = "0", t.crossLY.style.position = t.crossLX.style.position = "absolute", t.crossLY.style.background = t.crossLX.style.background = d.pointerColor, t.crossLY.style.height = t.crossLX.style.width = i - 2 * d.pointerBorderWidth + "px", t.crossLY.style.width = t.crossLX.style.height = d.pointerThickness + "px", t.crossLY.style.left = t.crossLX.style.top = Math.floor(i / 2) - Math.floor(d.pointerThickness / 2) + "px", t.crossLY.style.top = t.crossLX.style.left = d.pointerBorderWidth + "px", t.sld.style.overflow = "hidden", t.sld.style.width = d.sliderSize + "px", t.sld.style.height = d.height + "px", t.sldGrad.draw(d.sliderSize, d.height, "#000", "#000"), t.sldB.style.display = n ? "block" : "none", t.sldB.style.position = "absolute", t.sldB.style.right = d.padding + "px", t.sldB.style.top = d.padding + "px", t.sldB.style.border = d.insetWidth + "px solid", t.sldB.style.borderColor = d.insetColor, t.sldM._jscInstance = d, t.sldM._jscControlName = "sld", t.sldM.style.display = n ? "block" : "none", t.sldM.style.position = "absolute", t.sldM.style.right = "0", t.sldM.style.top = "0", t.sldM.style.width = d.sliderSize + s / 2 + d.padding + 2 * d.insetWidth + "px", t.sldM.style.height = r[1] + "px", t.sldM.style.cursor = "default", t.sldPtrIB.style.border = t.sldPtrOB.style.border = d.pointerBorderWidth + "px solid " + d.pointerBorderColor, t.sldPtrOB.style.position = "absolute", t.sldPtrOB.style.left = -(2 * d.pointerBorderWidth + d.pointerThickness) + "px", t.sldPtrOB.style.top = "0", t.sldPtrMB.style.border = d.pointerThickness + "px solid " + d.pointerColor, t.sldPtrS.style.width = d.sliderSize + "px", t.sldPtrS.style.height = m + "px", t.btn.style.display = d.closable ? "block" : "none", t.btn.style.position = "absolute", t.btn.style.left = d.padding + "px", t.btn.style.bottom = d.padding + "px", t.btn.style.padding = "0 15px", t.btn.style.height = d.buttonHeight + "px", t.btn.style.border = d.insetWidth + "px solid", l(), t.btn.style.color = d.buttonColor, t.btn.style.font = "12px sans-serif", t.btn.style.textAlign = "center"; try { t.btn.style.cursor = "pointer" } catch (c) { t.btn.style.cursor = "hand" } t.btn.onmousedown = function() { d.hide() }, t.btnT.style.lineHeight = d.buttonHeight + "px", t.btnT.innerHTML = "", t.btnT.appendChild(document.createTextNode(d.closeText)), a(), f(), e.picker.owner && e.picker.owner !== d && e.unsetClass(e.picker.owner.targetElement, d.activeClass), e.picker.owner = d, e.isElementType(v, "body") ? e.redrawPosition() : e._drawPosition(d, 0, 0, "relative", !1), t.wrap.parentNode != v && v.appendChild(t.wrap), e.setClass(d.targetElement, d.activeClass) } function a() { switch (e.getPadYComponent(d)) { case "s": var t = 1; break; case "v": var t = 2 } var n = Math.round(d.hsv[0] / 360 * (d.width - 1)), r = Math.round((1 - d.hsv[t] / 100) * (d.height - 1)), i = 2 * d.pointerBorderWidth + d.pointerThickness + 2 * d.crossSize, o = -Math.floor(i / 2); e.picker.cross.style.left = n + o + "px", e.picker.cross.style.top = r + o + "px"; switch (e.getSliderComponent(d)) { case "s": var u = s(d.hsv[0], 100, d.hsv[2]), a = s(d.hsv[0], 0, d.hsv[2]), f = "rgb(" + Math.round(u[0]) + "," + Math.round(u[1]) + "," + Math.round(u[2]) + ")", l = "rgb(" + Math.round(a[0]) + "," + Math.round(a[1]) + "," + Math.round(a[2]) + ")"; e.picker.sldGrad.draw(d.sliderSize, d.height, f, l); break; case "v": var c = s(d.hsv[0], d.hsv[1], 100), f = "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")", l = "#000"; e.picker.sldGrad.draw(d.sliderSize, d.height, f, l) } } function f() { var t = e.getSliderComponent(d); if (t) { switch (t) { case "s": var n = 1; break; case "v": var n = 2 } var r = Math.round((1 - d.hsv[n] / 100) * (d.height - 1)); e.picker.sldPtrOB.style.top = r - (2 * d.pointerBorderWidth + d.pointerThickness) - Math.floor(m / 2) + "px" } } function l() { return e.picker && e.picker.owner === d } function c() { d.importColor() } this.value = null, this.valueElement = t, this.styleElement = t, this.required = !0, this.refine = !0, this.hash = !1, this.uppercase = !0, this.onFineChange = null, this.activeClass = "jscolor-active", this.minS = 0, this.maxS = 100, this.minV = 0, this.maxV = 100, this.hsv = [0, 0, 100], this.rgb = [255, 255, 255], this.width = 181, this.height = 101, this.showOnClick = !0, this.mode = "HSV", this.position = "bottom", this.smartPosition = !0, this.sliderSize = 16, this.crossSize = 8, this.closable = !1, this.closeText = "Close", this.buttonColor = "#000000", this.buttonHeight = 18, this.padding = 12, this.backgroundColor = "#FFFFFF", this.borderWidth = 1, this.borderColor = "#BBBBBB", this.borderRadius = 8, this.insetWidth = 1, this.insetColor = "#BBBBBB", this.shadow = !0, this.shadowBlur = 15, this.shadowColor = "rgba(0,0,0,0.2)", this.pointerColor = "#4C4C4C", this.pointerBorderColor = "#FFFFFF", this.pointerBorderWidth = 1, this.pointerThickness = 2, this.zIndex = 1e3, this.container = null; for (var r in n) n.hasOwnProperty(r) && (this[r] = n[r]); this.hide = function() { l() && o() }, this.show = function() { u() }, this.redraw = function() { l() && u() }, this.importColor = function() { this.valueElement ? e.isElementType(this.valueElement, "input") ? this.refine ? !this.required && /^\s*$/.test(this.valueElement.value) ? (this.valueElement.value = "", this.styleElement && (this.styleElement.style.backgroundImage = this.styleElement._jscOrigStyle.backgroundImage, this.styleElement.style.backgroundColor = this.styleElement._jscOrigStyle.backgroundColor, this.styleElement.style.color = this.styleElement._jscOrigStyle.color), this.exportColor(e.leaveValue | e.leaveStyle)) : this.fromString(this.valueElement.value) || this.exportColor() : this.fromString(this.valueElement.value, e.leaveValue) || (this.styleElement && (this.styleElement.style.backgroundImage = this.styleElement._jscOrigStyle.backgroundImage, this.styleElement.style.backgroundColor = this.styleElement._jscOrigStyle.backgroundColor, this.styleElement.style.color = this.styleElement._jscOrigStyle.color), this.exportColor(e.leaveValue | e.leaveStyle)) : this.exportColor() : this.exportColor() }, this.exportColor = function(t) { if (!(t & e.leaveValue) && this.valueElement) { var n = this.toString(); this.uppercase && (n = n.toUpperCase()), this.hash && (n = "#" + n), e.isElementType(this.valueElement, "input") ? this.valueElement.value = n : this.valueElement.innerHTML = n } t & e.leaveStyle || this.styleElement && (this.styleElement.style.backgroundImage = "none", this.styleElement.style.backgroundColor = "#" + this.toString(), this.styleElement.style.color = this.isLight() ? "#000" : "#FFF"), !(t & e.leavePad) && l() && a(), !(t & e.leaveSld) && l() && f() }, this.fromHSV = function(e, t, n, r) { if (e !== null) { if (isNaN(e)) return !1; e = Math.max(0, Math.min(360, e)) } if (t !== null) { if (isNaN(t)) return !1; t = Math.max(0, Math.min(100, this.maxS, t), this.minS) } if (n !== null) { if (isNaN(n)) return !1; n = Math.max(0, Math.min(100, this.maxV, n), this.minV) } this.rgb = s(e === null ? this.hsv[0] : this.hsv[0] = e, t === null ? this.hsv[1] : this.hsv[1] = t, n === null ? this.hsv[2] : this.hsv[2] = n), this.exportColor(r) }, this.fromRGB = function(e, t, n, r) { if (e !== null) { if (isNaN(e)) return !1; e = Math.max(0, Math.min(255, e)) } if (t !== null) { if (isNaN(t)) return !1; t = Math.max(0, Math.min(255, t)) } if (n !== null) { if (isNaN(n)) return !1; n = Math.max(0, Math.min(255, n)) } var o = i(e === null ? this.rgb[0] : e, t === null ? this.rgb[1] : t, n === null ? this.rgb[2] : n); o[0] !== null && (this.hsv[0] = Math.max(0, Math.min(360, o[0]))), o[2] !== 0 && (this.hsv[1] = o[1] === null ? null : Math.max(0, this.minS, Math.min(100, this.maxS, o[1]))), this.hsv[2] = o[2] === null ? null : Math.max(0, this.minV, Math.min(100, this.maxV, o[2])); var u = s(this.hsv[0], this.hsv[1], this.hsv[2]); this.rgb[0] = u[0], this.rgb[1] = u[1], this.rgb[2] = u[2], this.exportColor(r) }, this.fromString = function(e, t) { var n; if (n = e.match(/^\W*([0-9A-F]{3}([0-9A-F]{3})?)\W*$/i)) return n[1].length === 6 ? this.fromRGB(parseInt(n[1].substr(0, 2), 16), parseInt(n[1].substr(2, 2), 16), parseInt(n[1].substr(4, 2), 16), t) : this.fromRGB(parseInt(n[1].charAt(0) + n[1].charAt(0), 16), parseInt(n[1].charAt(1) + n[1].charAt(1), 16), parseInt(n[1].charAt(2) + n[1].charAt(2), 16), t), !0; if (n = e.match(/^\W*rgba?\(([^)]*)\)\W*$/i)) { var r = n[1].split(","), i = /^\s*(\d*)(\.\d+)?\s*$/, s, o, u; if (r.length >= 3 && (s = r[0].match(i)) && (o = r[1].match(i)) && (u = r[2].match(i))) { var a = parseFloat((s[1] || "0") + (s[2] || "")), f = parseFloat((o[1] || "0") + (o[2] || "")), l = parseFloat((u[1] || "0") + (u[2] || "")); return this.fromRGB(a, f, l, t), !0 } } return !1 }, this.toString = function() { return (256 | Math.round(this.rgb[0])).toString(16).substr(1) + (256 | Math.round(this.rgb[1])).toString(16).substr(1) + (256 | Math.round(this.rgb[2])).toString(16).substr(1) }, this.toHEXString = function() { return "#" + this.toString().toUpperCase() }, this.toRGBString = function() { return "rgb(" + Math.round(this.rgb[0]) + "," + Math.round(this.rgb[1]) + "," + Math.round(this.rgb[2]) + ")" }, this.isLight = function() { return .213 * this.rgb[0] + .715 * this.rgb[1] + .072 * this.rgb[2] > 127.5 }, this._processParentElementsInDOM = function() { if (this._linkedElementsProcessed) return; this._linkedElementsProcessed = !0; var t = this.targetElement; do { var n = e.getStyle(t); n && n.position.toLowerCase() === "fixed" && (this.fixed = !0), t !== this.targetElement && (t._jscEventsAttached || (e.attachEvent(t, "scroll", e.onParentScroll), t._jscEventsAttached = !0)) } while ((t = t.parentNode) && !e.isElementType(t, "body")) }; if (typeof t == "string") { var h = t, p = document.getElementById(h); p ? this.targetElement = p : e.warn("Could not find target element with ID '" + h + "'") } else t ? this.targetElement = t : e.warn("Invalid target element: '" + t + "'"); if (this.targetElement._jscLinkedInstance) { e.warn("Cannot link jscolor twice to the same element. Skipping."); return } this.targetElement._jscLinkedInstance = this, this.valueElement = e.fetchElement(this.valueElement), this.styleElement = e.fetchElement(this.styleElement); var d = this, v = this.container ? e.fetchElement(this.container) : document.getElementsByTagName("body")[0], m = 3; if (e.isElementType(this.targetElement, "button")) if (this.targetElement.onclick) { var g = this.targetElement.onclick; this.targetElement.onclick = function(e) { return g.call(this, e), !1 } } else this.targetElement.onclick = function() { return !1 }; if (this.valueElement && e.isElementType(this.valueElement, "input")) { var y = function() { d.fromString(d.valueElement.value, e.leaveValue), e.dispatchFineChange(d) }; e.attachEvent(this.valueElement, "keyup", y), e.attachEvent(this.valueElement, "input", y), e.attachEvent(this.valueElement, "blur", c), this.valueElement.setAttribute("autocomplete", "off") } this.styleElement && (this.styleElement._jscOrigStyle = { backgroundImage: this.styleElement.style.backgroundImage, backgroundColor: this.styleElement.style.backgroundColor, color: this.styleElement.style.color }), this.value ? this.fromString(this.value) || this.exportColor() : this.importColor() } }; return e.jscolor.lookupClass = "jscolor", e.jscolor.installByClassName = function(t) { var n = document.getElementsByTagName("input"), r = document.getElementsByTagName("button"); e.tryInstallOnElements(n, t), e.tryInstallOnElements(r, t) }, e.register(), e.jscolor }()); })();
  }
  ; (function loadThemes() {
    diepStyle.themeJson = {
      d1ep: `[{"theme":{"name":"d1ep.0seven.repl.co","author":"0seven/float"}},{"id":2,"value":"ffffff"},{"id":15,"value":"000000"},{"id":3,"value":"1452ff"},{"id":4,"value":"ff5454"},{"id":5,"value":"c626ff"},{"id":6,"value":"b7ffbc"},{"id":17,"value":"c6c6c6"},{"id":12,"value":"fdff00"},{"id":8,"value":"FFD800"},{"id":7,"value":"89ff69"},{"id":16,"value":"fcc376"},{"id":9,"value":"ff0000"},{"id":10,"value":"5413ff"},{"id":11,"value":"ffffff"},{"id":14,"value":"000000"},{"id":1,"value":"6d6d6d"},{"cmd":"ren_bar_background_color","value":"000000"},{"cmd":"ren_stroke_solid_color","value":"000000"},{"id":13,"value":"ffffff"},{"cmd":"ren_xp_bar_fill_color","value":"ffffff"},{"cmd":"ren_score_bar_fill_color","value":"ffffff"},{"cmd":"ren_health_fill_color","value":"e3e3e3"},{"cmd":"ren_health_background_color","value":"898989"},{"cmd":"ren_grid_color","value":"000000"},{"cmd":"ren_minimap_background_color","value":"CDCDCD"},{"cmd":"ren_minimap_border_color","value":"797979"},{"cmd":"ren_background_color","value":"2e2b2f"},{"cmd":"ren_border_color","value":"ffffff"},{"cmd":"ui_replace_colors","value":["e69f6c","ff73ff","c980ff","71b4ff","ffed3f","ff7979","76de38","41ffff"]},{"cmd":"grid_base_alpha","value":0.12},{"cmd":"stroke_soft_color_intensity","value":1},{"cmd":"stroke_soft_color","value":false},{"cmd":"border_color_alpha","value":0.02},{"cmd":"ui_scale","value":0.84},{"cmd":"ui","value":false},{"cmd":"fps","value":true},{"cmd":"raw_health_values","value":true},{"cmd":"names","value":false}]`,
      dark: `[{"theme":{"name":"Dark Mode","author":"/u/162893476"}} ,{"id":2,"value":"001117"},{"id":15,"value":"140000"},{"id":3,"value":"005574"},{"id":4,"value":"540000"},{"id":5,"value":"090413"},{"id":6,"value":"00121a"},{"id":17,"value":"0D0D0D"},{"id":12,"value":"0D0D0D"},{"id":8,"value":"141400"},{"id":7,"value":"0d1500"},{"id":9,"value":"170606"},{"id":10,"value":"0a0016"},{"id":11,"value":"160517"},{"id":14,"value":"141414"},{"id":1,"value":"0f0f0f"},{"cmd":"ren_bar_background_color","value":"000000"},{"cmd":"ren_stroke_solid_color","value":"555555"},{"id":13,"value":"00bd88"},{"cmd":"ren_xp_bar_fill_color","value":"ffde43"},{"cmd":"ren_score_bar_fill_color","value":"43ff91"},{"cmd":"ren_health_fill_color","value":"85e37d"},{"cmd":"ren_health_background_color","value":"555555"},{"cmd":"ren_grid_color","value":"111111"},{"cmd":"ren_minimap_background_color","value":"323232"},{"cmd":"ren_minimap_border_color","value":"986895"},{"cmd":"ren_background_color","value":"000000"},{"cmd":"ren_border_color","value":"0f0f0f"},{"cmd":"ui_replace_colors","value":["ffe280","ff31a0","882dff","2d5aff","ffde26","ff2626","95ff26","17d2ff"]},{"cmd":"grid_base_alpha","value":2},{"cmd":"stroke_soft_color_intensity","value":-10},{"cmd":"stroke_soft_color","value":false},{"cmd":"border_color_alpha","value":0.5},{"cmd":"ui_scale","value":1},{"cmd":"ui","value":false},{"cmd":"fps","value":false},{"cmd":"raw_health_values","value":false},{"cmd":"names","value":false}] `,
      glass: `[{"theme":{"name":"Glass","author":"/u/162893476"}}, {"id":2,"value":"00627D"},{"id":15,"value":"7E0000"},{"id":3,"value":"00627D"},{"id":4,"value":"7E0000"},{"id":5,"value":"3D007E"},{"id":6,"value":"007E00"},{"id":17,"value":"464646"},{"id":12,"value":"7E7E00"},{"id":8,"value":"7E7E00"},{"id":7,"value":"457E00"},{"id":16,"value":"795C00"},{"id":9,"value":"7C0320"},{"id":10,"value":"43397d"},{"id":11,"value":"7E037A"},{"id":14,"value":"252525"},{"id":1,"value":"464646"},{"cmd":"ren_bar_background_color","value":"191919"},{"cmd":"ren_stroke_solid_color","value":"555555"},{"id":13,"value":"008B54"},{"cmd":"ren_xp_bar_fill_color","value":"666600"},{"cmd":"ren_score_bar_fill_color","value":"008B54"},{"cmd":"ren_health_fill_color","value":"85e37d"},{"cmd":"ren_health_background_color","value":"555555"},{"cmd":"ren_grid_color","value":"373737"},{"cmd":"ren_minimap_background_color","value":"464646"},{"cmd":"ren_minimap_border_color","value":"676767"},{"cmd":"ren_background_color","value":"000000"},{"cmd":"ren_border_color","value":"454545"},{"cmd":"ui_replace_colors","value":["e69f6c","ff73ff","c980ff","71b4ff","ffed3f","ff7979","88ff41","41ffff"]},{"cmd":"grid_base_alpha","value":2},{"cmd":"stroke_soft_color_intensity","value":-9},{"cmd":"stroke_soft_color","value":false},{"cmd":"border_color_alpha","value":0.5},{"cmd":"ui_scale","value":1},{"cmd":"ui","value":false},{"cmd":"fps","value":false},{"cmd":"raw_health_values","value":false},{"cmd":"names","value":false}] `,
      moomoo: `[{"theme":{"name":"Moomoo","author":"yst6zJTuKCHQvAXW4IPV"}}, {"id":2,"value":"847377"},{"id":15,"value":"7F4B63"},{"id":3,"value":"475F9E"},{"id":4,"value":"844052"},{"id":5,"value":"A330B1"},{"id":6,"value":"A66E4F"},{"id":17,"value":"6D6B84"},{"id":12,"value":"596B4A"},{"id":8,"value":"5b6b4d"},{"id":7,"value":"928150"},{"id":16,"value":"596B4A"},{"id":9,"value":"8c4256"},{"id":10,"value":"63647e"},{"id":11,"value":"5A5B72"},{"id":14,"value":"837752"},{"id":1,"value":"535377"},{"cmd":"ren_bar_background_color","value":"586B44"},{"cmd":"ren_stroke_solid_color","value":"35354E"},{"id":13,"value":"64ff8c"},{"cmd":"ren_xp_bar_fill_color","value":"FFFFFF"},{"cmd":"ren_score_bar_fill_color","value":"586B44"},{"cmd":"ren_health_fill_color","value":"8ECC51"},{"cmd":"ren_health_background_color","value":"3D3F42"},{"cmd":"ren_grid_color","value":"000000"},{"cmd":"ren_minimap_background_color","value":"586B44"},{"cmd":"ren_minimap_border_color","value":"586B44"},{"cmd":"ren_background_color","value":"768F5B"},{"cmd":"ren_border_color","value":"333333"},{"cmd":"ui_replace_colors","value":["5d4322","825d30","a8783e","bf8f54","c89e6a","d6b68f","e3ceb5","f1e7da"]},{"cmd":"grid_base_alpha","value":0.1},{"cmd":"stroke_soft_color_intensity","value":0.25},{"cmd":"stroke_soft_color","value":false},{"cmd":"border_color_alpha","value":0.1},{"cmd":"ui_scale","value":1},{"cmd":"ui","value":false},{"cmd":"fps","value":false},{"cmd":"raw_health_values","value":false},{"cmd":"names","value":false}]`,
      "80s": `[{"theme":{"name":"80s Light","author":"Road-to-100k"}}, {"id":2,"value":"00efff"},{"id":15,"value":"ff00ff"},{"id":3,"value":"00efff"},{"id":4,"value":"ff00ff"},{"id":5,"value":"ffaa00"},{"id":6,"value":"4FFFB0"},{"id":17,"value":"c6c6c6"},{"id":12,"value":"ffe869"},{"id":8,"value":"FFD800"},{"id":7,"value":"89ff69"},{"id":16,"value":"fcc376"},{"id":9,"value":"FF004F"},{"id":10,"value":"0000CD"},{"id":11,"value":"ffffff"},{"id":14,"value":"43197e"},{"id":1,"value":"999999"},{"cmd":"ren_bar_background_color","value":"1e0b38"},{"cmd":"ren_stroke_solid_color","value":"555555"},{"id":13,"value":"64ff8c"},{"cmd":"ren_xp_bar_fill_color","value":"ffde43"},{"cmd":"ren_score_bar_fill_color","value":"43ff91"},{"cmd":"ren_health_fill_color","value":"85e37d"},{"cmd":"ren_health_background_color","value":"555555"},{"cmd":"ren_grid_color","value":"ff00ff"},{"cmd":"ren_minimap_background_color","value":"CDCDCD"},{"cmd":"ren_minimap_border_color","value":"797979"},{"cmd":"ren_background_color","value":"1e0b38"},{"cmd":"ren_border_color","value":"000000"},{"cmd":"ui_replace_colors","value":["e69f6c","ff73ff","c980ff","71b4ff","ffed3f","ff7979","88ff41","41ffff"]},{"cmd":"grid_base_alpha","value":1.1},{"cmd":"stroke_soft_color_intensity","value":0.3},{"cmd":"stroke_soft_color","value":false},{"cmd":"border_color_alpha","value":0.6},{"cmd":"ui_scale","value":1},{"cmd":"ui","value":false},{"cmd":"fps","value":false},{"cmd":"raw_health_values","value":false},{"cmd":"names","value":false}] `,
    }
  })();
})();
