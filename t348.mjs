// https://github.com/wizzard0/t348-loader CHANGELOG
// MIT license. Includes code from https://github.com/alangpierce/sucrase and https://github.com/paulmillr/noble-hashes
// p3702: node20 support
// p3217: public release
// p3115: resolve "./something" -> "./something.ts" too
// p2a22: path in syntax error message
// p2808: log caching events
// p2723: don't nag unknownCommand (require t348 prefix for arg0)
// p2720: node18 support
// p2628: correct sourceURL in browser
// p2621: handle empty publish urls
// p2423: browser support for non-t348 .js/.ts imports;
//        ignore commented out imports
//        maybe fix relative URLs for path imports
//        fix loading t348 urns from different base paths. browser, node...
// p2421: browser support, omg. p2422: fixes.
// p2411: correct stack traces and noEmit!
// p2410: typescript! (via sucrase)
// added notes p2401, package.json skip 1220
// copied p2321, fix 1634, refactor 1656
//
// important: keep this single-file because this is a bootstrapper
// see usage BELOW
//
// UNSUPPORTED: CommonJS, import cycles
// detect cycles: madge --warning --circular --extensions ts,js --image deps-circular.svg <ENTRYPOINT/FOLDER>
// https://github.com/pahen/madge

/* USAGE
download everything in ./t348repo if T348CACHE, logs if TEST/DEBUG/VERBOSE is set
  "via348": "node --experimental-loader=./t348.mjs index.js param1",
  "cache348": "T348CACHE=1 DEBUG=1 node --experimental-loader=./t348.mjs index.js param1",
upload file (idempotent, can also re-upload from repo though this will kill meta filename)
  node ./t348.mjs t348pack something.js
change local repo in package.json: use .ts extension if you need IDE to eat typescript
  "type": "module",
  "t348": { "repo": "./t348repo/t0$HASH.js" },
assumes node v16/v18. use mjs extension if no package.json present.

BROWSER USAGE:
  note: only 1 script tag with type="text/typescript" is supported
  default global url is $T348_GLOBAL_REPO ($HASH will be replaced with h48)
  TRACE and T348_GLOBAL_REPO can be set in localStorage as t348_trace, t348_global_repo etc.
<head>
  <script type="module" src="https://website.com/path/t0lYxZJvli.js#t348"></script>
  <!-- OR -->
  <script src="t348.mjs" type="module" data-global-repo="./t348repo/t0$HASH.ts"></script>
  <script src="app.js" type="text/typescript"> (OR CODE WITH NEWLINES HERE) </script>
</head>

PLAN
  + read t348repo folder from package.json
  + try repoPath, then ~/.t348repo/v1, then hash-store
  + cache in ~/.t348repo/v1 (implicit)
    - and t348repo-folder (explicit)
  + t348pack subcommand (publishes normalized to './t0aaa1bbb2.js')
  + pack to ~/.t348repo/v1/t0aaa1bbb2.js
  + pack to hash-store
  - config USE_HASH_STORE, USE_MACHINE, T348_GLOBAL_REPO etc
  - pack from browser
  + boot from browser
  - fix import '" regexes
  - redesign so .ts browser import won't require js>ts 404
 */

let isBrowser = !!(globalThis.window && globalThis.document);
let importedModules; // don't access directly, use imports()
let importStarted;

function imports(){
  if(!importedModules){throw new Error('performNodeImports() must be called first')}
  return importedModules;
}

function findBrowserEnv(){
  let goodName = name => name.substring(5).toUpperCase().replace('-','_')
  let selfTags = document.querySelectorAll('script[type="module"][src*="t348"]');
  if(selfTags.length!==1){throw new Error(`T348: Expected exactly one script tag with type="module" src='...t348...' but found ${selfTags.length}`);}
  let moduleAttrs = [...selfTags[0].attributes].filter(x=>x.name.startsWith('data-')).map(x=>[goodName(x.name),x.value]);
  let storageAttrs = Object.entries(localStorage).filter(x=>x[0].match(/^t348[-_].+/i)).map(x=>[goodName(x[0]),x[1]]);
  return Object.fromEntries([...moduleAttrs,...storageAttrs]);
}

async function performNodeImports(){
  //console.log({performNodeImports:true})
  importStarted=true;
  //console.warn({T348:1,isBrowser,performNodeImports:!!importedModules}) // direct log as conSole is still dummy at this point
  let modules;
  if(isBrowser){
    let scriptTags = document.querySelectorAll('script[type="text/typescript"]');
    if(scriptTags.length!==1){throw new Error(`T348: Expected exactly one script tag with type="text/typescript" but found ${scriptTags.length}`);}
    let appEntryPoint = scriptTags[0].src || scriptTags[0].innerHTML;
    modules = ({
      env:{ /* add overrides here if you fancy */
        'IS_BROWSER':'1',
        ...findBrowserEnv(),
      },
      fs:{
        readFileSync:(path) => {let e = new Error('no files exist in the browser: '+path); e.code = 'ENOENT';throw e;},
        writeFileSync:(path,data) => {xlog({writeFileSync:path,ignored:1})},
      },
      argv:['browser',appEntryPoint,'t348run'],
    })
  }else {
    let {get: secureGet, request: secureRequest} = await import('https');
    let {get} = await import('http');
    let fs = await import('fs');
    let path = await import('path');
    let {homedir} = await import('os');
    modules = ({
      get,
      secureGet,
      secureRequest,
      fs,
      path,
      homedir,
      env:globalThis.process?.env || {},
      argv:globalThis.process?.argv || [],
    });
  }
  let {TEST, DEBUG, VERBOSE, TRACE} = modules.env;
  if (TEST || DEBUG || VERBOSE || TRACE) {conSole = console}

  log({t348:'done imports',argv:modules.argv}) // todo remove this
  importedModules = modules;
  return modules;
}


let isT348spec = (url) => url.startsWith('https://') || url.startsWith('http://127.0.0.1') || h48FromUrl(url);
// logger
let id = x => x;
let conSole = {log: id};
let xlog = id; // one-letter disable
// log is enabled when modules are imported, so we don't access `process` global here.
let log = (...args) => {
  conSole.log('T348', ...args);
  return id;
}

// NODE LOADER API

let nodeNativeSpecifierRegex = /^[a-z0-9/-]+$/
let redirected = {}

function processResolveError(e, specifier, parentURL) {
  // log({defaultResolveError: e,specifier,parentURL})
  // try to replace .js with .ts
  if (e.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.match(/^\.|\.js$/)) {
    log({defaultResolveError: e,specifier,parentURL})
    throw e
  }
  // console.log({specifier,parentURL});
  // attempt our own resolution
  let urlObject = parentURL ? new URL(specifier, parentURL) : new URL(specifier);
  let url = urlObject.href.replace(/(\.js)?$/, '.ts')
  if (!redirected[url]) {log({redirectToTypeScript: url}); redirected[url] = true;}
  return ({url})
}

// noinspection JSUnusedGlobalSymbols
export function resolve(specifier, context, defaultResolve) {
  log({resolve:specifier});

  const {parentURL = null} = context;
  // Normally Node.js would error on specifiers starting with 'https://', so
  // this hook intercepts them and converts them into absolute URLs to be
  // passed along to the hooks below.
  if (isT348spec(specifier)) {
    let url = h48FromUrl(specifier)?buildGlobalUrl(h48FromUrl(specifier)):specifier;
    return log({t348Direct: url})({url, shortCircuit:true});
  }
  if (parentURL && isT348spec(parentURL) && !specifier.match(nodeNativeSpecifierRegex)) {
    log({specifier,parentURL,willCombine:true})
    let url = new URL(specifier, parentURL).href
    return log({t348Parent: url})({url, shortCircuit:true})
  }
  log({defaultResolve: specifier})
  try {
    let drr= defaultResolve(specifier, context, defaultResolve)
    if(drr.then){
      return drr.then(x=>x,e=>processResolveError(e,specifier,parentURL))
    }else {
      return drr
    }
  }catch(e){
    return processResolveError(e, specifier, parentURL);
  }
}

let importInProgress;

// noinspection JSUnusedGlobalSymbols
export function load(url, context, defaultLoad) {
  //console.log({load:url});
  // hits when loader is operational
  if(!!importedModules){return loadImpl(url, context, defaultLoad)}
  if(url.startsWith('node:')) {
    //console.log({nodeDefaultLoad:url});
    return defaultLoad(url, context, defaultLoad)
  }
  // if(!importInProgress){ // first hit
  //   importInProgress = performNodeImports();
  // }
  // otherwise
  return importInProgress.then(()=>loadImpl(url, context, defaultLoad))
}

let _transpiler;

function getTranspiler(){
  if(!_transpiler) {
    let {env} = imports();
    let {DISABLE_SUCRASE} = env;
    _transpiler = DISABLE_SUCRASE ? id : (code, originalUrl) => `${transform(code, {
      transforms: ["typescript"],
      filePath: originalUrl,
      disableESTransforms: true
    }).code}
    //# sourceURL=${originalUrl}
    //# sourceURL=${originalUrl}`;
    // one of them will get removed by the loader, second is at the end so line numbers match
    // todo keep file paths where the blobs were originally loaded from, if available
  }
  return _transpiler;
}

export function loadImpl(url, context, defaultLoad) {
  log({loadImpl:url});
  let {fs} = imports();
  let transpiler = getTranspiler();

  if (!isT348spec(url) && !isBrowser) { // AND IF NODE ONLY
    if(url.endsWith('.ts')){
      let filePath = url.replace('file://',''); let code;
      log({url,filePath, willTranspile:true});
      try {
        code = fs.readFileSync(filePath).toString() // force modules lol
      } catch (e) {
        if(e.code==='ENOENT'){
          code = fs.readFileSync(filePath.replace(/\.js$/,'.ts')).toString() // force modules lol
        }else{
          throw e;
        }
      }
      return ({format:'module', source: transpiler(code, url), shortCircuit: true})
    }else {
      log({defaultLoad: url});
      return defaultLoad(url, context, defaultLoad)
    }
  }
  // note we get here only if not h348. need to refactor this out
  let hash = h48FromUrl(url);
  if (hash) {return loadAndMaybeCache(hash, transpiler)}
  log({t348UrlFetch: url})
  // NOTE: cannot check without hash, maybe log warning? assumes ESM
  return miniGetJsTs(url).then(code => ({format: 'module', source: transpiler(code, url), shortCircuit:true}))
}

// todo real ugly hack, need to redesign so we don't do 2x the requests
async function miniGetJsTs(url){
  try {
    return await miniGet(url);
  }catch(e){
    if(e.code==='ENOENT' && url.endsWith('.js')){
      return await miniGet(url.replace(/\.js$/,'.ts'))
    }else{
      throw e;
    }
  }
}

// END NODE API

const fc = path => imports().fs.readFileSync(path).toString('utf-8');

let packageJsonData;

function packageJson() {
  // todo search starting from jsPath
  if (!packageJsonData) {packageJsonData = JSON.parse(fc('package.json'))}
  return packageJsonData
}

let t348MetaRegex = /^\s*\/\*\s+t348meta:\s+({.*})\s+\*\/\s*$/
let t348MetaPlaceholder = "/* t348meta: $JSON */"

// PACK FUNCTION
export async function packModule(argv) {
  let {fs,path}=imports();
  // normalize module, put it to t348repo
  let [node, index, arg0pack, jsPath] = argv; // prefix and suffix so that idea imports work
//  let suffix = '.js'; if(jsPath.endsWith('.ts')) {suffix = '.ts'}
  // TODO: hash request is without suffix but repo stores files with suffix > either make everything .ts or not.
  let [hash, normalized] = normalizeModuleAndHash(fc(jsPath), './t0', '.js');
  // insert source path + date... oops this means normalized must skip comments like these
  // /* t348meta: {"name":file.js "date":"2020-01-01"} */ to be replaced with /* t348meta: {} */
  let name = path.basename(jsPath);
  let date = new Date().toISOString()
  let all = [t348MetaPlaceholder.replace('$JSON', JSON.stringify({hash, name, date})), normalized].join('\n')

  let pathInRepo;
  try{
    pathInRepo = repoPath(hash)
  }catch (e){
    if(e.code==='ENOENT'){console.warn({noPackageJsonFound:1})}else{throw e}
  }
  if(pathInRepo) { fs.writeFileSync(pathInRepo, all) }
  fs.writeFileSync(machineRepoPath(hash), all)
  await postT227HashStore(hash, all);
  let exports = detectExports(all).join(', ');
  console.info({
    jsPath, pathInRepo, hash,
    import: pathInRepo? `import {${exports}} from '${pathInRepo}'` : undefined,
    global: `import {${exports}} from '${buildGlobalUrl(hash)}'`
  })
}

function detectExports(source) {
  // https://developer.mozilla.org/en-US/docs/web/javascript/reference/statements/export
  // return list of exports, ignore default export and export {}
  return [...source.matchAll(/export\s+(?:let|const|function|class)\s+(\w+)/g)].map(x=>x[1]);
}

// BROWSER LOADER
async function t348run(){
  let {argv}=imports();
  let [browser, index, arg0run] = argv;
  log({t348run:index});

  let session = {
    getBlob: async (session, id)=>{
      log({getBlob:id});
      // TODO implement this lol
      //nyi('getBlob');
      let {format,source} =await loadImpl(id, null, (id, ctx, _) => err('no defaultLoad in the browser for id='+id+' ctx='+ctx))
      return source;
    }
  } // todo
  // fetch and transpile
  let convertedObjectUrl = await reallyLoadIntoBlobURL(session, index)
  // run
  return import(convertedObjectUrl); // it should be sufficient to trigger import of the index module
  // nope sadly we can't rely on dynamic import as it won't fire our hooks.
  // and we must remap blobs after sucrase processing.
}

// copied from t352
async function entryPoint(argv) {
  let [node, index, arg0] = argv;
  if (!(arg0+'').startsWith("t348")){return}
  let commands = [];
  log({arg0})
  let cc = (command, fn) => check(arg0, commands, command, fn);
  if (cc("t348pack", packModule)) {return}
  if(cc("t348run", t348run)) {return}
  if (arg0) {console.error({unknownCommand: arg0, allCommands: commands})}
}

// copied from t352
function check(arg, commands, command, fn) {
  let {argv}=imports();
  if (arg === command) {fn(argv);return true;}
  commands.push(command);
  return false
}

function repoPath(hash) {
  // noinspection JSUnresolvedVariable
  return (packageJson()?.t348?.repo || "./t348repo/t0$HASH.js").replace('$HASH', hash);
}

function machineRepoPath(hash) {
  let{path,homedir}=imports();
  if(!path){xlog({machineRepoPath:'no path module'});return}
  let machinePath = path.resolve(homedir(), ".t348repo/v1/t0$HASH.js").replace('$HASH', hash)
  return log({machinePath})(machinePath)
}

function buildGlobalUrl(hash) {
  // data-global-repo="./t348repo/t0$HASH.ts"
  // noinspection JSUnresolvedVariable
  let {T348_GLOBAL_REPO, GLOBAL_REPO}=imports().env;
  let url = T348_GLOBAL_REPO || GLOBAL_REPO || "t348:t0$HASH.js"; // was "https://localhost/t0$HASH.js" but that was causing ERR_NETWORK_IMPORT_DISALLOWED
  return url.replace('$HASH', hash)
}

async function postT227HashStore(hash, data) {
  let{secureRequest,env}=imports();
  // something like https://website.com/path/?version=1&mime=text/javascript&source=t348publish&name=t0$HASH.js
  // noinspection JSUnresolvedVariable
  let {T348_GLOBAL_REPO_PUBLISH, GLOBAL_REPO_PUBLISH}=imports().env;
  let url = (T348_GLOBAL_REPO_PUBLISH||GLOBAL_REPO_PUBLISH||"").replace('$HASH', hash);
  if(!url){console.error({noPublishUrl:'please set T348_GLOBAL_REPO_PUBLISH or GLOBAL_REPO_PUBLISH'})}
  // accessible at https://website.com/path/t0SfTi5Wrr.js
  const options = {
    method: 'POST',
    headers: {'Content-Length': Buffer.byteLength(data), 'Content-Type': 'text/javascript'}
  };
  return new Promise((resolve, reject) => {
    const req = secureRequest(url, options, (res) => {
      log(`STATUS: ${res.statusCode}`);
      let data = {c: ''};
      res.setEncoding('utf8');
      res.on('data', (chunk) => { log(`BODY: ${chunk}`); data.c += chunk});
      res.on('end', () => resolve(log('request completed')(data.c)));
    }).on('error', reject);
    req.write(data);
    req.end();
  })
}

async function loadAndMaybeCache(hash, transpiler) {
  let{fs,env}=imports();
  let {IGNORE_HASHES,T348CACHE}=env;

  let localSourceCode = loadFromRepoSync(hash);
  let fetchRequired = false;
  if (localSourceCode === false) {
    let globalUrl = buildGlobalUrl(hash);
    localSourceCode = await miniGet(log({globalUrl})(globalUrl));
    fetchRequired = true
  }
  let [fileHash, normalized, nameHint] = normalizeModuleAndHash(localSourceCode, 't0')
  if (fileHash !== hash && !IGNORE_HASHES) { throw new Error(`repo damaged for hash: ${hash} => ${fileHash} DATA: ${normalized}`)}
  // localSourceCode has meta, normalized has not. keep it.
  if (fetchRequired) {fs.writeFileSync(machineRepoPath(hash), localSourceCode);}
  if (T348CACHE) {
    log({t348cache:hash})
    fs.writeFileSync(repoPath(hash), localSourceCode)}
  let nameHintSuffix = nameHint ? `#${nameHint}` : ''
  let byHash = ({format: 'module', source: transpiler(normalized, 't0:'+hash+nameHintSuffix), shortCircuit:true});/*log*/
  id({byHash});
  return byHash;
}

function miniGet(url) {
  let{secureGet,get}=imports();
  if(!secureGet){
    return fetch(url).then(response => response.status<300? response.text():err(`cannot fetch: ${response.status} ${response.statusText}`, {code:response.status===404?'ENOENT':'EIO'}))
  }
  return new Promise((resolve, reject) => {
    let getter = url.startsWith('https://') ? secureGet : get;
    getter(url, (res) => {
      let data = {c: ''}; res.setEncoding('utf8');
      res.on('data', (chunk) => data.c += chunk);
      res.on('end', () => resolve(data.c));
    }).on('error', (err) => reject(err));
  })
}

function loadFromRepoSync(hash) {
  try {return fc(repoPath(hash))} catch (e) {if (e.code !== 'ENOENT') {throw e}}
  try {return fc(machineRepoPath(hash))} catch (e) {if (e.code !== 'ENOENT') {throw e}}
  return false
}

export function normalizeModuleAndHash(codeString, prefix = '', suffix = '') {
  let lines = codeString.split('\n')
  let normalized = lines.map(x => normalizeImportLine(x)).filter(x => x !== false).join('\n');
  let hash = h48(normalized)
  if (prefix + suffix) {
    normalized = lines.map(x => normalizeImportLine(x, prefix, suffix)).filter(x => x !== false).join('\n')
  }
  let nameHint = lines.find(x => x.match(t348MetaRegex))?.match(t348MetaRegex)?.[1];
  if(nameHint){
    try {
      nameHint = JSON.parse(nameHint).name // todo maybe date too
    }catch (e) {
      nameHint = 'parseError'
    }
  }
//  console.log({nameHint})
  return [hash, normalized, nameHint]
}

function normalizeImportLine(line, prefix = '', suffix = '') {
  // to be used only in normalizeModuleAndHash. false = line should be ignored
  if (line.match(t348MetaRegex)) {return false}
  let specifier = line.match(importRegex)?.[1];
  if (!specifier) {return line}
  let specHash = h48FromUrl(specifier);
  if (!specHash) {return line}
  return line.replace(specifier, prefix + specHash + suffix)
}

// import {c
// } from 'http://127.0.0.1:7348/c.js'; // so track from 'STRING'
// it's fine to replace commented out imports here
let importRegex = /\bfrom\s+['"]([^'"]+)['"]/;

// like bech32 but base64$_ because I want 6*8, not 5*10. two-byte prefix is passable.
let h48Regex = /.*\bt0([a-zA-Z0-9$_]{8})(\.m?js)?\b/ // remove .* to match first
export const h48FromUrl = url => url.match(h48Regex)?.[1];

// BEGIN stuff copied from t352 module-loader, discover-dependencies.js

export function nyi(message = 'nyi') {
  throw new Error(message)
}

export function err(message = 'error', props = {}) {
  let err = new Error(message);
  for(let k in props){err[k]=props[k]}
  throw err;
}

// holy shit, our id should be absolute if we resolve paths not just ids.
export async function discoverDependencies(session, id, depth) {
  let sourceCode = await loadOriginalModuleSource(session, id)
  // todo proper parsing later, now let's match from 'blob:BlobId' and from '/path/module.js'
  // (?:^|\n)(?:(?!\/\/).)* means "does not contain // since start of file or line"
  let importRegex = /(?:^|\n)(?:(?!\/\/).)*?from ['"]([^'"\n\s]+)['"]/g // todo this will match from 'a"
  let importRegex2 = /(?:^|\n)(?:(?!\/\/).)*?from ['"]([^'"\n\s]+)['"]/
  let importList = sourceCode.match(importRegex) || []
  log({id, importList})

  let map = {}
  for (let importKey of importList) {
    let detailMatch = importKey.match(importRegex2)
    log({detailMatch:detailMatch?.[1]})
    let importKey2 = detailMatch[1];
    // for each one, find true url
    map[importKey2] = await reallyLoadIntoBlobURL(session, importKey2, [...depth, id])
  }
  log({sourceCode, map})
  let remappedCode = sourceCode
  for (let importKey in map) {
    remappedCode = remappedCode.replaceAll(importKey, map[importKey])
    // todo add comments on what was replaced
  }
  return [sourceCode, remappedCode, map];
}


// hash to blob url
let moduleToUrl = {}
// hash to source
let originalSources = {}
// debug only
let remappedSources = {}

export async function loadOriginalModuleSource(session, id) {
  if (!originalSources[id]) {
    originalSources[id] = await session.getBlob(session, id)
  }
  return originalSources[id]
}

// todo: remove them?
let staticRemaps = {
  'mini-react': '/react/mini-html.js',
  'widget-frame': '/src/ui/widget-frame.js',
  'use-async-value': '/src/ui/use-async-value.js',
  'connected': '/src/vm/connected.js',
}
// holy crap, we're going to mix modules from different sessions together.
// but if blobs are content-keyed then it's okay!
export async function reallyLoadIntoBlobURL(session, source, depth = []) {
  if (staticRemaps[source]) {
    source = staticRemaps[source]
  }
  if (source.length > 100 || source.indexOf('\n') !== -1) {
    log("assuming it's direct source code. still need to transpile.")
    let id = h48(source)
    log({directSourceId:id});
    let fullId = new URL(id,document.location.href).href;
    originalSources[fullId] = getTranspiler()(source, fullId);
    return reallyLoadIntoBlobURL(session, fullId, [...depth, fullId])
  }
  // somewhere here we need to absolutize the url.

  let sourceHash = h48FromUrl(source)
  if(sourceHash){ // all hashes are equal regardless of baseURI
    source = new URL(buildGlobalUrl(sourceHash),document.location.href).href;
    log({sourceHash, source})
  }else {
    let prev = (depth.length > 1) ? depth[depth.length - 1] : document.location.href;
    let absolute = new URL(source, prev).href
    log({source, prev, absolute, depth});
    source = absolute;
  }
  if (moduleToUrl[source]) {
    log({returningExisting: source}); return moduleToUrl[source]
  }

  if (source.match(/^\/.*\.js$/)) { // it's our existing module, don't transcode
    // todo really?
    log({skipTranscode: source});
    moduleToUrl[source] = document.location.href + source.slice(1);
    return moduleToUrl[source];
  }
  log({reallyLoadIntoBlobURL: source, depth})
  if (depth.length > 90) { // 100 is collapsed by devtools
    err('dependency chain too deep')
  }
  // if already loaded - return
  // otherwise, go depth-first.
  let [code, remapped, remaps] = await discoverDependencies(session, source, depth)
  log({code, remapped, remaps})
  log(remapped);
  remappedSources[source] = remapped;
  // build
  // todo maybe inject logger on load event?
  moduleToUrl[source] = URL.createObjectURL(new Blob([remapped], {type: 'application/javascript'}))
  // return URL!
  return moduleToUrl[source]
}

//window.debugReallyLoadIntoBlobURL = reallyLoadIntoBlobURL;
//window.debugLoaderTables = {moduleToUrl, originalSources, remappedSources}


// END stuff copied from t352 module-loader, discover-dependencies.js


// todo: maybe re-do h48 via node/web crypto? or keep inline?
// copying stuff from t352
export function h48(v) {
  // 48 is 6 bytes or 8 bytes of base64, 50% on 16M items is fine.
  let h = sha256(v).slice(0, 6);
  // $_ is variable-name-safe, -_ is url-safe, but I don't like it
  // $ also breaks word-select in browsers though... abc$def
  return u8b64(h).replaceAll('+', '$').replaceAll('/', '_')
}

// h48 deps
export const u8b64 = uint8array => {
  const output = []; // note maybe rewrite this, not utf8 etc
  for (let i = 0, {length} = uint8array; i < length; i++) {
    output.push(String.fromCharCode(uint8array[i]));
  }
  return btoa(output.join(''));
}

// Uint8Array.from(arrayLike, mapFn, thisArg)
export const b64u8 = chars => Uint8Array.from(atob(chars), c => c.charCodeAt(0));

// lib/noble/sha256.js imports below
//import {SHA2} from './_sha2.js';
// lib/noble/_sha2.js imports below
//import {Hash, createView, toBytes} from './utils.js';
export const isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
// There is almost no big endian hardware, but js typed arrays uses platform specific endianness.
// So, just to be sure not to corrupt anything.
if (!isLE) {throw new Error('Non little-endian hardware is not supported')}

// For runtime check if class implements interface
export class Hash {
  // Safe version that clones internal state
  clone() { // noinspection JSUnresolvedFunction
    return this._cloneInto();}
}

// Cast array to view
export const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);

export function toBytes(data) {
  if (typeof data === 'string') {data = new TextEncoder().encode(data);}
  if (!(data instanceof Uint8Array)) {
    throw new TypeError(`Expected input type is Uint8Array (got ${typeof data}) `);
  }
  return data;
}

// Polyfill for Safari 14
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === 'function') {
    return view.setBigUint64(byteOffset, value, isLE);
  }
  const _32n = BigInt(32);
  const _u32_max = BigInt(0xffffffff);
  const wh = Number((value >> _32n) & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}

// Base SHA2 class (RFC 6234)
export class SHA2 extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }

  update(data) {
    if (this.destroyed) {throw new Error('instance is destroyed');}
    const {view, buffer, blockLen, finished} = this;
    if (finished) {throw new Error('digest() was already called');}
    data = toBytes(data);
    const len = data.length;
    for (let pos = 0; pos < len;) {
      const take = Math.min(blockLen - this.pos, len - pos);
      // Fast path: we have at least one block in input, cast it to view and process
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen) this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }

  digestInto(out) {
    if (this.destroyed) {throw new Error('instance is destroyed');}
    if (!(out instanceof Uint8Array) || out.length < this.outputLen) {
      throw new Error('_Sha2: Invalid output buffer');
    }
    if (this.finished) {throw new Error('digest() was already called');}
    this.finished = true;
    // Padding
    // We can avoid allocation of buffer for padding completely if it
    // was previously not allocated here. But it won't change performance.
    const {buffer, view, blockLen, isLE} = this;
    let {pos} = this;
    // append the bit '1' to the message
    buffer[pos++] = 0b10000000;
    this.buffer.subarray(pos).fill(0);
    // we have less than padOffset left in buffer, so we cannot put length in current block, need process it and pad again
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    // Pad until full block byte with zeros
    for (let i = pos; i < blockLen; i++) buffer[i] = 0;
    // NOTE: sha512 requires length to be 128bit integer, but length in JS will overflow before that
    // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
    // So we just write lowest 64bit of that value.
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    this.get().forEach((v, i) => oview.setUint32(4 * i, v, isLE));
  }

  digest() {
    const {buffer, outputLen} = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }

  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const {blockLen, buffer, length, finished, destroyed, pos} = this;
    to.length = length;
    to.pos = pos;
    to.finished = finished;
    to.destroyed = destroyed;
    if (length % blockLen) {to.buffer.set(buffer);}
    return to;
  }
}

//import {rotr, wrapConstructor} from './utils.js';
// The rotate right (circular right shift) operation for uint32
export const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);

export function wrapConstructor(hashConstructor) {
  const hashC = (message) => hashConstructor().update(toBytes(message)).digest();
  const tmp = hashConstructor();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashConstructor();
  hashC.init = hashC.create;
  return hashC;
}

// lib/noble/sha256.js imports end, body below

// Choice: a ? b : c
const Chi = (a, b, c) => (a & b) ^ (~a & c);
// Majority function, true if any two inpust is true
const Maj = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
// Round constants:
// first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
// prettier-ignore
const SHA256_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3,
  0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
  0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa,
  0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
// Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
// prettier-ignore
const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19]);
// Temporary buffer, not used to store anything between runs
// Named this way because it matches specification.
const SHA256_W = new Uint32Array(64);

class SHA256 extends SHA2 {
  constructor() {
    super(64, 32, 8, false);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }

  get() {
    const {A, B, C, D, E, F, G, H} = this;
    return [A, B, C, D, E, F, G, H];
  }

  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }

  process(view, offset) {
    // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
    for (let i = 0; i < 16; i++, offset += 4) SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ (W15 >>> 3);
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ (W2 >>> 10);
      SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
    }
    // Compression function main loop, 64 rounds
    let {A, B, C, D, E, F, G, H} = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = (sigma0 + Maj(A, B, C)) | 0;
      H = G;
      G = F;
      F = E;
      E = (D + T1) | 0;
      D = C;
      C = B;
      B = A;
      A = (T1 + T2) | 0;
    }
    // Add the compressed chunk to the current hash value
    A = (A + this.A) | 0;
    B = (B + this.B) | 0;
    C = (C + this.C) | 0;
    D = (D + this.D) | 0;
    E = (E + this.E) | 0;
    F = (F + this.F) | 0;
    G = (G + this.G) | 0;
    H = (H + this.H) | 0;
    this.set(A, B, C, D, E, F, G, H);
  }

  roundClean() {SHA256_W.fill(0);}

  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    this.buffer.fill(0);
  }
}

export const sha256 = wrapConstructor(() => new SHA256());

// BEGIN INLINE sucrase@3.21.0

const transform=(()=>{
  const HELPERS = {
    interopRequireWildcard: `
    function interopRequireWildcard(obj) {
      if (obj && obj.__esModule) {
        return obj;
      } else {
        var newObj = {};
        if (obj != null) {
          for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              newObj[key] = obj[key];
            }
          }
        }
        newObj.default = obj;
        return newObj;
      }
    }
  `,
    interopRequireDefault: `
    function interopRequireDefault(obj) {
      return obj && obj.__esModule ? obj : { default: obj };
    }
  `,
    createNamedExportFrom: `
    function createNamedExportFrom(obj, localName, importedName) {
      Object.defineProperty(exports, localName, {enumerable: true, get: () => obj[importedName]});
    }
  `,
    // Note that TypeScript and Babel do this differently; TypeScript does a simple existence
    // check in the exports object and does a plain assignment, whereas Babel uses
    // defineProperty and builds an object of explicitly-exported names so that star exports can
    // always take lower precedence. For now, we do the easier TypeScript thing.
    createStarExport: `
    function createStarExport(obj) {
      Object.keys(obj)
        .filter((key) => key !== "default" && key !== "__esModule")
        .forEach((key) => {
          if (exports.hasOwnProperty(key)) {
            return;
          }
          Object.defineProperty(exports, key, {enumerable: true, get: () => obj[key]});
        });
    }
  `,
    nullishCoalesce: `
    function nullishCoalesce(lhs, rhsFn) {
      if (lhs != null) {
        return lhs;
      } else {
        return rhsFn();
      }
    }
  `,
    asyncNullishCoalesce: `
    async function asyncNullishCoalesce(lhs, rhsFn) {
      if (lhs != null) {
        return lhs;
      } else {
        return await rhsFn();
      }
    }
  `,
    optionalChain: `
    function optionalChain(ops) {
      let lastAccessLHS = undefined;
      let value = ops[0];
      let i = 1;
      while (i < ops.length) {
        const op = ops[i];
        const fn = ops[i + 1];
        i += 2;
        if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) {
          return undefined;
        }
        if (op === 'access' || op === 'optionalAccess') {
          lastAccessLHS = value;
          value = fn(value);
        } else if (op === 'call' || op === 'optionalCall') {
          value = fn((...args) => value.call(lastAccessLHS, ...args));
          lastAccessLHS = undefined;
        }
      }
      return value;
    }
  `,
    asyncOptionalChain: `
    async function asyncOptionalChain(ops) {
      let lastAccessLHS = undefined;
      let value = ops[0];
      let i = 1;
      while (i < ops.length) {
        const op = ops[i];
        const fn = ops[i + 1];
        i += 2;
        if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) {
          return undefined;
        }
        if (op === 'access' || op === 'optionalAccess') {
          lastAccessLHS = value;
          value = await fn(value);
        } else if (op === 'call' || op === 'optionalCall') {
          value = await fn((...args) => value.call(lastAccessLHS, ...args));
          lastAccessLHS = undefined;
        }
      }
      return value;
    }
  `,
    optionalChainDelete: `
    function optionalChainDelete(ops) {
      const result = OPTIONAL_CHAIN_NAME(ops);
      return result == null ? true : result;
    }
  `,
    asyncOptionalChainDelete: `
    async function asyncOptionalChainDelete(ops) {
      const result = await ASYNC_OPTIONAL_CHAIN_NAME(ops);
      return result == null ? true : result;
    }
  `,
  };

  class HelperManager {
    __init() {this.helperNames = {};}
    constructor( nameManager) {this.nameManager = nameManager;HelperManager.prototype.__init.call(this);}

    getHelperName(baseName) {
      let helperName = this.helperNames[baseName];
      if (helperName) {
        return helperName;
      }
      helperName = this.nameManager.claimFreeName(`_${baseName}`);
      this.helperNames[baseName] = helperName;
      return helperName;
    }

    emitHelpers() {
      let resultCode = "";
      if (this.helperNames.optionalChainDelete) {
        this.getHelperName("optionalChain");
      }
      if (this.helperNames.asyncOptionalChainDelete) {
        this.getHelperName("asyncOptionalChain");
      }
      for (const [baseName, helperCodeTemplate] of Object.entries(HELPERS)) {
        const helperName = this.helperNames[baseName];
        let helperCode = helperCodeTemplate;
        if (baseName === "optionalChainDelete") {
          helperCode = helperCode.replace("OPTIONAL_CHAIN_NAME", this.helperNames.optionalChain);
        } else if (baseName === "asyncOptionalChainDelete") {
          helperCode = helperCode.replace(
            "ASYNC_OPTIONAL_CHAIN_NAME",
            this.helperNames.asyncOptionalChain,
          );
        }
        if (helperName) {
          resultCode += " ";
          resultCode += helperCode.replace(baseName, helperName).replace(/\s+/g, " ").trim();
        }
      }
      return resultCode;
    }
  }

  var ContextualKeyword; (function (ContextualKeyword) {
    const NONE = 0; ContextualKeyword[ContextualKeyword["NONE"] = NONE] = "NONE";
    const _abstract = NONE + 1; ContextualKeyword[ContextualKeyword["_abstract"] = _abstract] = "_abstract";
    const _as = _abstract + 1; ContextualKeyword[ContextualKeyword["_as"] = _as] = "_as";
    const _asserts = _as + 1; ContextualKeyword[ContextualKeyword["_asserts"] = _asserts] = "_asserts";
    const _async = _asserts + 1; ContextualKeyword[ContextualKeyword["_async"] = _async] = "_async";
    const _await = _async + 1; ContextualKeyword[ContextualKeyword["_await"] = _await] = "_await";
    const _checks = _await + 1; ContextualKeyword[ContextualKeyword["_checks"] = _checks] = "_checks";
    const _constructor = _checks + 1; ContextualKeyword[ContextualKeyword["_constructor"] = _constructor] = "_constructor";
    const _declare = _constructor + 1; ContextualKeyword[ContextualKeyword["_declare"] = _declare] = "_declare";
    const _enum = _declare + 1; ContextualKeyword[ContextualKeyword["_enum"] = _enum] = "_enum";
    const _exports = _enum + 1; ContextualKeyword[ContextualKeyword["_exports"] = _exports] = "_exports";
    const _from = _exports + 1; ContextualKeyword[ContextualKeyword["_from"] = _from] = "_from";
    const _get = _from + 1; ContextualKeyword[ContextualKeyword["_get"] = _get] = "_get";
    const _global = _get + 1; ContextualKeyword[ContextualKeyword["_global"] = _global] = "_global";
    const _implements = _global + 1; ContextualKeyword[ContextualKeyword["_implements"] = _implements] = "_implements";
    const _infer = _implements + 1; ContextualKeyword[ContextualKeyword["_infer"] = _infer] = "_infer";
    const _interface = _infer + 1; ContextualKeyword[ContextualKeyword["_interface"] = _interface] = "_interface";
    const _is = _interface + 1; ContextualKeyword[ContextualKeyword["_is"] = _is] = "_is";
    const _keyof = _is + 1; ContextualKeyword[ContextualKeyword["_keyof"] = _keyof] = "_keyof";
    const _mixins = _keyof + 1; ContextualKeyword[ContextualKeyword["_mixins"] = _mixins] = "_mixins";
    const _module = _mixins + 1; ContextualKeyword[ContextualKeyword["_module"] = _module] = "_module";
    const _namespace = _module + 1; ContextualKeyword[ContextualKeyword["_namespace"] = _namespace] = "_namespace";
    const _of = _namespace + 1; ContextualKeyword[ContextualKeyword["_of"] = _of] = "_of";
    const _opaque = _of + 1; ContextualKeyword[ContextualKeyword["_opaque"] = _opaque] = "_opaque";
    const _override = _opaque + 1; ContextualKeyword[ContextualKeyword["_override"] = _override] = "_override";
    const _private = _override + 1; ContextualKeyword[ContextualKeyword["_private"] = _private] = "_private";
    const _protected = _private + 1; ContextualKeyword[ContextualKeyword["_protected"] = _protected] = "_protected";
    const _proto = _protected + 1; ContextualKeyword[ContextualKeyword["_proto"] = _proto] = "_proto";
    const _public = _proto + 1; ContextualKeyword[ContextualKeyword["_public"] = _public] = "_public";
    const _readonly = _public + 1; ContextualKeyword[ContextualKeyword["_readonly"] = _readonly] = "_readonly";
    const _require = _readonly + 1; ContextualKeyword[ContextualKeyword["_require"] = _require] = "_require";
    const _set = _require + 1; ContextualKeyword[ContextualKeyword["_set"] = _set] = "_set";
    const _static = _set + 1; ContextualKeyword[ContextualKeyword["_static"] = _static] = "_static";
    const _type = _static + 1; ContextualKeyword[ContextualKeyword["_type"] = _type] = "_type";
    const _unique = _type + 1; ContextualKeyword[ContextualKeyword["_unique"] = _unique] = "_unique";
  })(ContextualKeyword || (ContextualKeyword = {}));

// Generated file, do not edit! Run "yarn generate" to re-generate this file.
  /**
   * Enum of all token types, with bit fields to signify meaningful properties.
   */
  var TokenType; (function (TokenType) {
    // Precedence 0 means not an operator; otherwise it is a positive number up to 12.
    const PRECEDENCE_MASK = 0xf; TokenType[TokenType["PRECEDENCE_MASK"] = PRECEDENCE_MASK] = "PRECEDENCE_MASK";
    const IS_KEYWORD = 1 << 4; TokenType[TokenType["IS_KEYWORD"] = IS_KEYWORD] = "IS_KEYWORD";
    const IS_ASSIGN = 1 << 5; TokenType[TokenType["IS_ASSIGN"] = IS_ASSIGN] = "IS_ASSIGN";
    const IS_RIGHT_ASSOCIATIVE = 1 << 6; TokenType[TokenType["IS_RIGHT_ASSOCIATIVE"] = IS_RIGHT_ASSOCIATIVE] = "IS_RIGHT_ASSOCIATIVE";
    const IS_PREFIX = 1 << 7; TokenType[TokenType["IS_PREFIX"] = IS_PREFIX] = "IS_PREFIX";
    const IS_POSTFIX = 1 << 8; TokenType[TokenType["IS_POSTFIX"] = IS_POSTFIX] = "IS_POSTFIX";

    const num = 0; TokenType[TokenType["num"] = num] = "num"; // num
    const bigint = 512; TokenType[TokenType["bigint"] = bigint] = "bigint"; // bigint
    const decimal = 1024; TokenType[TokenType["decimal"] = decimal] = "decimal"; // decimal
    const regexp = 1536; TokenType[TokenType["regexp"] = regexp] = "regexp"; // regexp
    const string = 2048; TokenType[TokenType["string"] = string] = "string"; // string
    const name = 2560; TokenType[TokenType["name"] = name] = "name"; // name
    const eof = 3072; TokenType[TokenType["eof"] = eof] = "eof"; // eof
    const bracketL = 3584; TokenType[TokenType["bracketL"] = bracketL] = "bracketL"; // [
    const bracketR = 4096; TokenType[TokenType["bracketR"] = bracketR] = "bracketR"; // ]
    const braceL = 4608; TokenType[TokenType["braceL"] = braceL] = "braceL"; // {
    const braceBarL = 5120; TokenType[TokenType["braceBarL"] = braceBarL] = "braceBarL"; // {|
    const braceR = 5632; TokenType[TokenType["braceR"] = braceR] = "braceR"; // }
    const braceBarR = 6144; TokenType[TokenType["braceBarR"] = braceBarR] = "braceBarR"; // |}
    const parenL = 6656; TokenType[TokenType["parenL"] = parenL] = "parenL"; // (
    const parenR = 7168; TokenType[TokenType["parenR"] = parenR] = "parenR"; // )
    const comma = 7680; TokenType[TokenType["comma"] = comma] = "comma"; // ,
    const semi = 8192; TokenType[TokenType["semi"] = semi] = "semi"; // ;
    const colon = 8704; TokenType[TokenType["colon"] = colon] = "colon"; // :
    const doubleColon = 9216; TokenType[TokenType["doubleColon"] = doubleColon] = "doubleColon"; // ::
    const dot = 9728; TokenType[TokenType["dot"] = dot] = "dot"; // .
    const question = 10240; TokenType[TokenType["question"] = question] = "question"; // ?
    const questionDot = 10752; TokenType[TokenType["questionDot"] = questionDot] = "questionDot"; // ?.
    const arrow = 11264; TokenType[TokenType["arrow"] = arrow] = "arrow"; // =>
    const template = 11776; TokenType[TokenType["template"] = template] = "template"; // template
    const ellipsis = 12288; TokenType[TokenType["ellipsis"] = ellipsis] = "ellipsis"; // ...
    const backQuote = 12800; TokenType[TokenType["backQuote"] = backQuote] = "backQuote"; // `
    const dollarBraceL = 13312; TokenType[TokenType["dollarBraceL"] = dollarBraceL] = "dollarBraceL"; // ${
    const at = 13824; TokenType[TokenType["at"] = at] = "at"; // @
    const hash = 14336; TokenType[TokenType["hash"] = hash] = "hash"; // #
    const eq = 14880; TokenType[TokenType["eq"] = eq] = "eq"; // = isAssign
    const assign = 15392; TokenType[TokenType["assign"] = assign] = "assign"; // _= isAssign
    const preIncDec = 16256; TokenType[TokenType["preIncDec"] = preIncDec] = "preIncDec"; // ++/-- prefix postfix
    const postIncDec = 16768; TokenType[TokenType["postIncDec"] = postIncDec] = "postIncDec"; // ++/-- prefix postfix
    const bang = 17024; TokenType[TokenType["bang"] = bang] = "bang"; // ! prefix
    const tilde = 17536; TokenType[TokenType["tilde"] = tilde] = "tilde"; // ~ prefix
    const pipeline = 17921; TokenType[TokenType["pipeline"] = pipeline] = "pipeline"; // |> prec:1
    const nullishCoalescing = 18434; TokenType[TokenType["nullishCoalescing"] = nullishCoalescing] = "nullishCoalescing"; // ?? prec:2
    const logicalOR = 18946; TokenType[TokenType["logicalOR"] = logicalOR] = "logicalOR"; // || prec:2
    const logicalAND = 19459; TokenType[TokenType["logicalAND"] = logicalAND] = "logicalAND"; // && prec:3
    const bitwiseOR = 19972; TokenType[TokenType["bitwiseOR"] = bitwiseOR] = "bitwiseOR"; // | prec:4
    const bitwiseXOR = 20485; TokenType[TokenType["bitwiseXOR"] = bitwiseXOR] = "bitwiseXOR"; // ^ prec:5
    const bitwiseAND = 20998; TokenType[TokenType["bitwiseAND"] = bitwiseAND] = "bitwiseAND"; // & prec:6
    const equality = 21511; TokenType[TokenType["equality"] = equality] = "equality"; // ==/!= prec:7
    const lessThan = 22024; TokenType[TokenType["lessThan"] = lessThan] = "lessThan"; // < prec:8
    const greaterThan = 22536; TokenType[TokenType["greaterThan"] = greaterThan] = "greaterThan"; // > prec:8
    const relationalOrEqual = 23048; TokenType[TokenType["relationalOrEqual"] = relationalOrEqual] = "relationalOrEqual"; // <=/>= prec:8
    const bitShift = 23561; TokenType[TokenType["bitShift"] = bitShift] = "bitShift"; // <</>> prec:9
    const plus = 24202; TokenType[TokenType["plus"] = plus] = "plus"; // + prec:10 prefix
    const minus = 24714; TokenType[TokenType["minus"] = minus] = "minus"; // - prec:10 prefix
    const modulo = 25099; TokenType[TokenType["modulo"] = modulo] = "modulo"; // % prec:11
    const star = 25611; TokenType[TokenType["star"] = star] = "star"; // * prec:11
    const slash = 26123; TokenType[TokenType["slash"] = slash] = "slash"; // / prec:11
    const exponent = 26700; TokenType[TokenType["exponent"] = exponent] = "exponent"; // ** prec:12 rightAssociative
    const jsxName = 27136; TokenType[TokenType["jsxName"] = jsxName] = "jsxName"; // jsxName
    const jsxText = 27648; TokenType[TokenType["jsxText"] = jsxText] = "jsxText"; // jsxText
    const jsxTagStart = 28160; TokenType[TokenType["jsxTagStart"] = jsxTagStart] = "jsxTagStart"; // jsxTagStart
    const jsxTagEnd = 28672; TokenType[TokenType["jsxTagEnd"] = jsxTagEnd] = "jsxTagEnd"; // jsxTagEnd
    const typeParameterStart = 29184; TokenType[TokenType["typeParameterStart"] = typeParameterStart] = "typeParameterStart"; // typeParameterStart
    const nonNullAssertion = 29696; TokenType[TokenType["nonNullAssertion"] = nonNullAssertion] = "nonNullAssertion"; // nonNullAssertion
    const _break = 30224; TokenType[TokenType["_break"] = _break] = "_break"; // break keyword
    const _case = 30736; TokenType[TokenType["_case"] = _case] = "_case"; // case keyword
    const _catch = 31248; TokenType[TokenType["_catch"] = _catch] = "_catch"; // catch keyword
    const _continue = 31760; TokenType[TokenType["_continue"] = _continue] = "_continue"; // continue keyword
    const _debugger = 32272; TokenType[TokenType["_debugger"] = _debugger] = "_debugger"; // debugger keyword
    const _default = 32784; TokenType[TokenType["_default"] = _default] = "_default"; // default keyword
    const _do = 33296; TokenType[TokenType["_do"] = _do] = "_do"; // do keyword
    const _else = 33808; TokenType[TokenType["_else"] = _else] = "_else"; // else keyword
    const _finally = 34320; TokenType[TokenType["_finally"] = _finally] = "_finally"; // finally keyword
    const _for = 34832; TokenType[TokenType["_for"] = _for] = "_for"; // for keyword
    const _function = 35344; TokenType[TokenType["_function"] = _function] = "_function"; // function keyword
    const _if = 35856; TokenType[TokenType["_if"] = _if] = "_if"; // if keyword
    const _return = 36368; TokenType[TokenType["_return"] = _return] = "_return"; // return keyword
    const _switch = 36880; TokenType[TokenType["_switch"] = _switch] = "_switch"; // switch keyword
    const _throw = 37520; TokenType[TokenType["_throw"] = _throw] = "_throw"; // throw keyword prefix
    const _try = 37904; TokenType[TokenType["_try"] = _try] = "_try"; // try keyword
    const _var = 38416; TokenType[TokenType["_var"] = _var] = "_var"; // var keyword
    const _let = 38928; TokenType[TokenType["_let"] = _let] = "_let"; // let keyword
    const _const = 39440; TokenType[TokenType["_const"] = _const] = "_const"; // const keyword
    const _while = 39952; TokenType[TokenType["_while"] = _while] = "_while"; // while keyword
    const _with = 40464; TokenType[TokenType["_with"] = _with] = "_with"; // with keyword
    const _new = 40976; TokenType[TokenType["_new"] = _new] = "_new"; // new keyword
    const _this = 41488; TokenType[TokenType["_this"] = _this] = "_this"; // this keyword
    const _super = 42000; TokenType[TokenType["_super"] = _super] = "_super"; // super keyword
    const _class = 42512; TokenType[TokenType["_class"] = _class] = "_class"; // class keyword
    const _extends = 43024; TokenType[TokenType["_extends"] = _extends] = "_extends"; // extends keyword
    const _export = 43536; TokenType[TokenType["_export"] = _export] = "_export"; // export keyword
    const _import = 44048; TokenType[TokenType["_import"] = _import] = "_import"; // import keyword
    const _yield = 44560; TokenType[TokenType["_yield"] = _yield] = "_yield"; // yield keyword
    const _null = 45072; TokenType[TokenType["_null"] = _null] = "_null"; // null keyword
    const _true = 45584; TokenType[TokenType["_true"] = _true] = "_true"; // true keyword
    const _false = 46096; TokenType[TokenType["_false"] = _false] = "_false"; // false keyword
    const _in = 46616; TokenType[TokenType["_in"] = _in] = "_in"; // in prec:8 keyword
    const _instanceof = 47128; TokenType[TokenType["_instanceof"] = _instanceof] = "_instanceof"; // instanceof prec:8 keyword
    const _typeof = 47760; TokenType[TokenType["_typeof"] = _typeof] = "_typeof"; // typeof keyword prefix
    const _void = 48272; TokenType[TokenType["_void"] = _void] = "_void"; // void keyword prefix
    const _delete = 48784; TokenType[TokenType["_delete"] = _delete] = "_delete"; // delete keyword prefix
    const _async = 49168; TokenType[TokenType["_async"] = _async] = "_async"; // async keyword
    const _get = 49680; TokenType[TokenType["_get"] = _get] = "_get"; // get keyword
    const _set = 50192; TokenType[TokenType["_set"] = _set] = "_set"; // set keyword
    const _declare = 50704; TokenType[TokenType["_declare"] = _declare] = "_declare"; // declare keyword
    const _readonly = 51216; TokenType[TokenType["_readonly"] = _readonly] = "_readonly"; // readonly keyword
    const _abstract = 51728; TokenType[TokenType["_abstract"] = _abstract] = "_abstract"; // abstract keyword
    const _static = 52240; TokenType[TokenType["_static"] = _static] = "_static"; // static keyword
    const _public = 52752; TokenType[TokenType["_public"] = _public] = "_public"; // public keyword
    const _private = 53264; TokenType[TokenType["_private"] = _private] = "_private"; // private keyword
    const _protected = 53776; TokenType[TokenType["_protected"] = _protected] = "_protected"; // protected keyword
    const _override = 54288; TokenType[TokenType["_override"] = _override] = "_override"; // override keyword
    const _as = 54800; TokenType[TokenType["_as"] = _as] = "_as"; // as keyword
    const _enum = 55312; TokenType[TokenType["_enum"] = _enum] = "_enum"; // enum keyword
    const _type = 55824; TokenType[TokenType["_type"] = _type] = "_type"; // type keyword
    const _implements = 56336; TokenType[TokenType["_implements"] = _implements] = "_implements"; // implements keyword
  })(TokenType || (TokenType = {}));
  function formatTokenType(tokenType) {
    switch (tokenType) {
      case TokenType.num:
        return "num";
      case TokenType.bigint:
        return "bigint";
      case TokenType.decimal:
        return "decimal";
      case TokenType.regexp:
        return "regexp";
      case TokenType.string:
        return "string";
      case TokenType.name:
        return "name";
      case TokenType.eof:
        return "eof";
      case TokenType.bracketL:
        return "[";
      case TokenType.bracketR:
        return "]";
      case TokenType.braceL:
        return "{";
      case TokenType.braceBarL:
        return "{|";
      case TokenType.braceR:
        return "}";
      case TokenType.braceBarR:
        return "|}";
      case TokenType.parenL:
        return "(";
      case TokenType.parenR:
        return ")";
      case TokenType.comma:
        return ",";
      case TokenType.semi:
        return ";";
      case TokenType.colon:
        return ":";
      case TokenType.doubleColon:
        return "::";
      case TokenType.dot:
        return ".";
      case TokenType.question:
        return "?";
      case TokenType.questionDot:
        return "?.";
      case TokenType.arrow:
        return "=>";
      case TokenType.template:
        return "template";
      case TokenType.ellipsis:
        return "...";
      case TokenType.backQuote:
        return "`";
      case TokenType.dollarBraceL:
        return "${";
      case TokenType.at:
        return "@";
      case TokenType.hash:
        return "#";
      case TokenType.eq:
        return "=";
      case TokenType.assign:
        return "_=";
      case TokenType.preIncDec:
        return "++/--";
      case TokenType.postIncDec:
        return "++/--";
      case TokenType.bang:
        return "!";
      case TokenType.tilde:
        return "~";
      case TokenType.pipeline:
        return "|>";
      case TokenType.nullishCoalescing:
        return "??";
      case TokenType.logicalOR:
        return "||";
      case TokenType.logicalAND:
        return "&&";
      case TokenType.bitwiseOR:
        return "|";
      case TokenType.bitwiseXOR:
        return "^";
      case TokenType.bitwiseAND:
        return "&";
      case TokenType.equality:
        return "==/!=";
      case TokenType.lessThan:
        return "<";
      case TokenType.greaterThan:
        return ">";
      case TokenType.relationalOrEqual:
        return "<=/>=";
      case TokenType.bitShift:
        return "<</>>";
      case TokenType.plus:
        return "+";
      case TokenType.minus:
        return "-";
      case TokenType.modulo:
        return "%";
      case TokenType.star:
        return "*";
      case TokenType.slash:
        return "/";
      case TokenType.exponent:
        return "**";
      case TokenType.jsxName:
        return "jsxName";
      case TokenType.jsxText:
        return "jsxText";
      case TokenType.jsxTagStart:
        return "jsxTagStart";
      case TokenType.jsxTagEnd:
        return "jsxTagEnd";
      case TokenType.typeParameterStart:
        return "typeParameterStart";
      case TokenType.nonNullAssertion:
        return "nonNullAssertion";
      case TokenType._break:
        return "break";
      case TokenType._case:
        return "case";
      case TokenType._catch:
        return "catch";
      case TokenType._continue:
        return "continue";
      case TokenType._debugger:
        return "debugger";
      case TokenType._default:
        return "default";
      case TokenType._do:
        return "do";
      case TokenType._else:
        return "else";
      case TokenType._finally:
        return "finally";
      case TokenType._for:
        return "for";
      case TokenType._function:
        return "function";
      case TokenType._if:
        return "if";
      case TokenType._return:
        return "return";
      case TokenType._switch:
        return "switch";
      case TokenType._throw:
        return "throw";
      case TokenType._try:
        return "try";
      case TokenType._var:
        return "var";
      case TokenType._let:
        return "let";
      case TokenType._const:
        return "const";
      case TokenType._while:
        return "while";
      case TokenType._with:
        return "with";
      case TokenType._new:
        return "new";
      case TokenType._this:
        return "this";
      case TokenType._super:
        return "super";
      case TokenType._class:
        return "class";
      case TokenType._extends:
        return "extends";
      case TokenType._export:
        return "export";
      case TokenType._import:
        return "import";
      case TokenType._yield:
        return "yield";
      case TokenType._null:
        return "null";
      case TokenType._true:
        return "true";
      case TokenType._false:
        return "false";
      case TokenType._in:
        return "in";
      case TokenType._instanceof:
        return "instanceof";
      case TokenType._typeof:
        return "typeof";
      case TokenType._void:
        return "void";
      case TokenType._delete:
        return "delete";
      case TokenType._async:
        return "async";
      case TokenType._get:
        return "get";
      case TokenType._set:
        return "set";
      case TokenType._declare:
        return "declare";
      case TokenType._readonly:
        return "readonly";
      case TokenType._abstract:
        return "abstract";
      case TokenType._static:
        return "static";
      case TokenType._public:
        return "public";
      case TokenType._private:
        return "private";
      case TokenType._protected:
        return "protected";
      case TokenType._override:
        return "override";
      case TokenType._as:
        return "as";
      case TokenType._enum:
        return "enum";
      case TokenType._type:
        return "type";
      case TokenType._implements:
        return "implements";
      default:
        return "";
    }
  }

  class Scope {




    constructor(startTokenIndex, endTokenIndex, isFunctionScope) {
      this.startTokenIndex = startTokenIndex;
      this.endTokenIndex = endTokenIndex;
      this.isFunctionScope = isFunctionScope;
    }
  }

  class StateSnapshot {
    constructor(
      potentialArrowAt,
      noAnonFunctionType,
      tokensLength,
      scopesLength,
      pos,
      type,
      contextualKeyword,
      start,
      end,
      isType,
      scopeDepth,
      error,
    ) {this.potentialArrowAt = potentialArrowAt;this.noAnonFunctionType = noAnonFunctionType;this.tokensLength = tokensLength;this.scopesLength = scopesLength;this.pos = pos;this.type = type;this.contextualKeyword = contextualKeyword;this.start = start;this.end = end;this.isType = isType;this.scopeDepth = scopeDepth;this.error = error;}
  }

  class State {constructor() { State.prototype.__init.call(this);State.prototype.__init2.call(this);State.prototype.__init3.call(this);State.prototype.__init4.call(this);State.prototype.__init5.call(this);State.prototype.__init6.call(this);State.prototype.__init7.call(this);State.prototype.__init8.call(this);State.prototype.__init9.call(this);State.prototype.__init10.call(this);State.prototype.__init11.call(this);State.prototype.__init12.call(this); }
    // Used to signify the start of a potential arrow function
    __init() {this.potentialArrowAt = -1;}

    // Used by Flow to handle an edge case involving function type parsing.
    __init2() {this.noAnonFunctionType = false;}

    // Token store.
    __init3() {this.tokens = [];}

    // Array of all observed scopes, ordered by their ending position.
    __init4() {this.scopes = [];}

    // The current position of the tokenizer in the input.
    __init5() {this.pos = 0;}

    // Information about the current token.
    __init6() {this.type = TokenType.eof;}
    __init7() {this.contextualKeyword = ContextualKeyword.NONE;}
    __init8() {this.start = 0;}
    __init9() {this.end = 0;}

    __init10() {this.isType = false;}
    __init11() {this.scopeDepth = 0;}

    /**
     * If the parser is in an error state, then the token is always tt.eof and all functions can
     * keep executing but should be written so they don't get into an infinite loop in this situation.
     *
     * This approach, combined with the ability to snapshot and restore state, allows us to implement
     * backtracking without exceptions and without needing to explicitly propagate error states
     * everywhere.
     */
    __init12() {this.error = null;}

    snapshot() {
      return new StateSnapshot(
        this.potentialArrowAt,
        this.noAnonFunctionType,
        this.tokens.length,
        this.scopes.length,
        this.pos,
        this.type,
        this.contextualKeyword,
        this.start,
        this.end,
        this.isType,
        this.scopeDepth,
        this.error,
      );
    }

    restoreFromSnapshot(snapshot) {
      this.potentialArrowAt = snapshot.potentialArrowAt;
      this.noAnonFunctionType = snapshot.noAnonFunctionType;
      this.tokens.length = snapshot.tokensLength;
      this.scopes.length = snapshot.scopesLength;
      this.pos = snapshot.pos;
      this.type = snapshot.type;
      this.contextualKeyword = snapshot.contextualKeyword;
      this.start = snapshot.start;
      this.end = snapshot.end;
      this.isType = snapshot.isType;
      this.scopeDepth = snapshot.scopeDepth;
      this.error = snapshot.error;
    }
  }

  var charCodes; (function (charCodes) {
    const backSpace = 8; charCodes[charCodes["backSpace"] = backSpace] = "backSpace";
    const lineFeed = 10; charCodes[charCodes["lineFeed"] = lineFeed] = "lineFeed"; //  '\n'
    const carriageReturn = 13; charCodes[charCodes["carriageReturn"] = carriageReturn] = "carriageReturn"; //  '\r'
    const shiftOut = 14; charCodes[charCodes["shiftOut"] = shiftOut] = "shiftOut";
    const space = 32; charCodes[charCodes["space"] = space] = "space";
    const exclamationMark = 33; charCodes[charCodes["exclamationMark"] = exclamationMark] = "exclamationMark"; //  '!'
    const quotationMark = 34; charCodes[charCodes["quotationMark"] = quotationMark] = "quotationMark"; //  '"'
    const numberSign = 35; charCodes[charCodes["numberSign"] = numberSign] = "numberSign"; //  '#'
    const dollarSign = 36; charCodes[charCodes["dollarSign"] = dollarSign] = "dollarSign"; //  '$'
    const percentSign = 37; charCodes[charCodes["percentSign"] = percentSign] = "percentSign"; //  '%'
    const ampersand = 38; charCodes[charCodes["ampersand"] = ampersand] = "ampersand"; //  '&'
    const apostrophe = 39; charCodes[charCodes["apostrophe"] = apostrophe] = "apostrophe"; //  '''
    const leftParenthesis = 40; charCodes[charCodes["leftParenthesis"] = leftParenthesis] = "leftParenthesis"; //  '('
    const rightParenthesis = 41; charCodes[charCodes["rightParenthesis"] = rightParenthesis] = "rightParenthesis"; //  ')'
    const asterisk = 42; charCodes[charCodes["asterisk"] = asterisk] = "asterisk"; //  '*'
    const plusSign = 43; charCodes[charCodes["plusSign"] = plusSign] = "plusSign"; //  '+'
    const comma = 44; charCodes[charCodes["comma"] = comma] = "comma"; //  ','
    const dash = 45; charCodes[charCodes["dash"] = dash] = "dash"; //  '-'
    const dot = 46; charCodes[charCodes["dot"] = dot] = "dot"; //  '.'
    const slash = 47; charCodes[charCodes["slash"] = slash] = "slash"; //  '/'
    const digit0 = 48; charCodes[charCodes["digit0"] = digit0] = "digit0"; //  '0'
    const digit1 = 49; charCodes[charCodes["digit1"] = digit1] = "digit1"; //  '1'
    const digit2 = 50; charCodes[charCodes["digit2"] = digit2] = "digit2"; //  '2'
    const digit3 = 51; charCodes[charCodes["digit3"] = digit3] = "digit3"; //  '3'
    const digit4 = 52; charCodes[charCodes["digit4"] = digit4] = "digit4"; //  '4'
    const digit5 = 53; charCodes[charCodes["digit5"] = digit5] = "digit5"; //  '5'
    const digit6 = 54; charCodes[charCodes["digit6"] = digit6] = "digit6"; //  '6'
    const digit7 = 55; charCodes[charCodes["digit7"] = digit7] = "digit7"; //  '7'
    const digit8 = 56; charCodes[charCodes["digit8"] = digit8] = "digit8"; //  '8'
    const digit9 = 57; charCodes[charCodes["digit9"] = digit9] = "digit9"; //  '9'
    const colon = 58; charCodes[charCodes["colon"] = colon] = "colon"; //  ':'
    const semicolon = 59; charCodes[charCodes["semicolon"] = semicolon] = "semicolon"; //  ';'
    const lessThan = 60; charCodes[charCodes["lessThan"] = lessThan] = "lessThan"; //  '<'
    const equalsTo = 61; charCodes[charCodes["equalsTo"] = equalsTo] = "equalsTo"; //  '='
    const greaterThan = 62; charCodes[charCodes["greaterThan"] = greaterThan] = "greaterThan"; //  '>'
    const questionMark = 63; charCodes[charCodes["questionMark"] = questionMark] = "questionMark"; //  '?'
    const atSign = 64; charCodes[charCodes["atSign"] = atSign] = "atSign"; //  '@'
    const uppercaseA = 65; charCodes[charCodes["uppercaseA"] = uppercaseA] = "uppercaseA"; //  'A'
    const uppercaseB = 66; charCodes[charCodes["uppercaseB"] = uppercaseB] = "uppercaseB"; //  'B'
    const uppercaseC = 67; charCodes[charCodes["uppercaseC"] = uppercaseC] = "uppercaseC"; //  'C'
    const uppercaseD = 68; charCodes[charCodes["uppercaseD"] = uppercaseD] = "uppercaseD"; //  'D'
    const uppercaseE = 69; charCodes[charCodes["uppercaseE"] = uppercaseE] = "uppercaseE"; //  'E'
    const uppercaseF = 70; charCodes[charCodes["uppercaseF"] = uppercaseF] = "uppercaseF"; //  'F'
    const uppercaseG = 71; charCodes[charCodes["uppercaseG"] = uppercaseG] = "uppercaseG"; //  'G'
    const uppercaseH = 72; charCodes[charCodes["uppercaseH"] = uppercaseH] = "uppercaseH"; //  'H'
    const uppercaseI = 73; charCodes[charCodes["uppercaseI"] = uppercaseI] = "uppercaseI"; //  'I'
    const uppercaseJ = 74; charCodes[charCodes["uppercaseJ"] = uppercaseJ] = "uppercaseJ"; //  'J'
    const uppercaseK = 75; charCodes[charCodes["uppercaseK"] = uppercaseK] = "uppercaseK"; //  'K'
    const uppercaseL = 76; charCodes[charCodes["uppercaseL"] = uppercaseL] = "uppercaseL"; //  'L'
    const uppercaseM = 77; charCodes[charCodes["uppercaseM"] = uppercaseM] = "uppercaseM"; //  'M'
    const uppercaseN = 78; charCodes[charCodes["uppercaseN"] = uppercaseN] = "uppercaseN"; //  'N'
    const uppercaseO = 79; charCodes[charCodes["uppercaseO"] = uppercaseO] = "uppercaseO"; //  'O'
    const uppercaseP = 80; charCodes[charCodes["uppercaseP"] = uppercaseP] = "uppercaseP"; //  'P'
    const uppercaseQ = 81; charCodes[charCodes["uppercaseQ"] = uppercaseQ] = "uppercaseQ"; //  'Q'
    const uppercaseR = 82; charCodes[charCodes["uppercaseR"] = uppercaseR] = "uppercaseR"; //  'R'
    const uppercaseS = 83; charCodes[charCodes["uppercaseS"] = uppercaseS] = "uppercaseS"; //  'S'
    const uppercaseT = 84; charCodes[charCodes["uppercaseT"] = uppercaseT] = "uppercaseT"; //  'T'
    const uppercaseU = 85; charCodes[charCodes["uppercaseU"] = uppercaseU] = "uppercaseU"; //  'U'
    const uppercaseV = 86; charCodes[charCodes["uppercaseV"] = uppercaseV] = "uppercaseV"; //  'V'
    const uppercaseW = 87; charCodes[charCodes["uppercaseW"] = uppercaseW] = "uppercaseW"; //  'W'
    const uppercaseX = 88; charCodes[charCodes["uppercaseX"] = uppercaseX] = "uppercaseX"; //  'X'
    const uppercaseY = 89; charCodes[charCodes["uppercaseY"] = uppercaseY] = "uppercaseY"; //  'Y'
    const uppercaseZ = 90; charCodes[charCodes["uppercaseZ"] = uppercaseZ] = "uppercaseZ"; //  'Z'
    const leftSquareBracket = 91; charCodes[charCodes["leftSquareBracket"] = leftSquareBracket] = "leftSquareBracket"; //  '['
    const backslash = 92; charCodes[charCodes["backslash"] = backslash] = "backslash"; //  '\    '
    const rightSquareBracket = 93; charCodes[charCodes["rightSquareBracket"] = rightSquareBracket] = "rightSquareBracket"; //  ']'
    const caret = 94; charCodes[charCodes["caret"] = caret] = "caret"; //  '^'
    const underscore = 95; charCodes[charCodes["underscore"] = underscore] = "underscore"; //  '_'
    const graveAccent = 96; charCodes[charCodes["graveAccent"] = graveAccent] = "graveAccent"; //  '`'
    const lowercaseA = 97; charCodes[charCodes["lowercaseA"] = lowercaseA] = "lowercaseA"; //  'a'
    const lowercaseB = 98; charCodes[charCodes["lowercaseB"] = lowercaseB] = "lowercaseB"; //  'b'
    const lowercaseC = 99; charCodes[charCodes["lowercaseC"] = lowercaseC] = "lowercaseC"; //  'c'
    const lowercaseD = 100; charCodes[charCodes["lowercaseD"] = lowercaseD] = "lowercaseD"; //  'd'
    const lowercaseE = 101; charCodes[charCodes["lowercaseE"] = lowercaseE] = "lowercaseE"; //  'e'
    const lowercaseF = 102; charCodes[charCodes["lowercaseF"] = lowercaseF] = "lowercaseF"; //  'f'
    const lowercaseG = 103; charCodes[charCodes["lowercaseG"] = lowercaseG] = "lowercaseG"; //  'g'
    const lowercaseH = 104; charCodes[charCodes["lowercaseH"] = lowercaseH] = "lowercaseH"; //  'h'
    const lowercaseI = 105; charCodes[charCodes["lowercaseI"] = lowercaseI] = "lowercaseI"; //  'i'
    const lowercaseJ = 106; charCodes[charCodes["lowercaseJ"] = lowercaseJ] = "lowercaseJ"; //  'j'
    const lowercaseK = 107; charCodes[charCodes["lowercaseK"] = lowercaseK] = "lowercaseK"; //  'k'
    const lowercaseL = 108; charCodes[charCodes["lowercaseL"] = lowercaseL] = "lowercaseL"; //  'l'
    const lowercaseM = 109; charCodes[charCodes["lowercaseM"] = lowercaseM] = "lowercaseM"; //  'm'
    const lowercaseN = 110; charCodes[charCodes["lowercaseN"] = lowercaseN] = "lowercaseN"; //  'n'
    const lowercaseO = 111; charCodes[charCodes["lowercaseO"] = lowercaseO] = "lowercaseO"; //  'o'
    const lowercaseP = 112; charCodes[charCodes["lowercaseP"] = lowercaseP] = "lowercaseP"; //  'p'
    const lowercaseQ = 113; charCodes[charCodes["lowercaseQ"] = lowercaseQ] = "lowercaseQ"; //  'q'
    const lowercaseR = 114; charCodes[charCodes["lowercaseR"] = lowercaseR] = "lowercaseR"; //  'r'
    const lowercaseS = 115; charCodes[charCodes["lowercaseS"] = lowercaseS] = "lowercaseS"; //  's'
    const lowercaseT = 116; charCodes[charCodes["lowercaseT"] = lowercaseT] = "lowercaseT"; //  't'
    const lowercaseU = 117; charCodes[charCodes["lowercaseU"] = lowercaseU] = "lowercaseU"; //  'u'
    const lowercaseV = 118; charCodes[charCodes["lowercaseV"] = lowercaseV] = "lowercaseV"; //  'v'
    const lowercaseW = 119; charCodes[charCodes["lowercaseW"] = lowercaseW] = "lowercaseW"; //  'w'
    const lowercaseX = 120; charCodes[charCodes["lowercaseX"] = lowercaseX] = "lowercaseX"; //  'x'
    const lowercaseY = 121; charCodes[charCodes["lowercaseY"] = lowercaseY] = "lowercaseY"; //  'y'
    const lowercaseZ = 122; charCodes[charCodes["lowercaseZ"] = lowercaseZ] = "lowercaseZ"; //  'z'
    const leftCurlyBrace = 123; charCodes[charCodes["leftCurlyBrace"] = leftCurlyBrace] = "leftCurlyBrace"; //  '{'
    const verticalBar = 124; charCodes[charCodes["verticalBar"] = verticalBar] = "verticalBar"; //  '|'
    const rightCurlyBrace = 125; charCodes[charCodes["rightCurlyBrace"] = rightCurlyBrace] = "rightCurlyBrace"; //  '}'
    const tilde = 126; charCodes[charCodes["tilde"] = tilde] = "tilde"; //  '~'
    const nonBreakingSpace = 160; charCodes[charCodes["nonBreakingSpace"] = nonBreakingSpace] = "nonBreakingSpace";
    // eslint-disable-next-line no-irregular-whitespace
    const oghamSpaceMark = 5760; charCodes[charCodes["oghamSpaceMark"] = oghamSpaceMark] = "oghamSpaceMark"; // ' '
    const lineSeparator = 8232; charCodes[charCodes["lineSeparator"] = lineSeparator] = "lineSeparator";
    const paragraphSeparator = 8233; charCodes[charCodes["paragraphSeparator"] = paragraphSeparator] = "paragraphSeparator";
  })(charCodes || (charCodes = {}));

//export let isFlowEnabled;
  const isFlowEnabled$1 = false;
  let state;
  let input;
  let nextContextId;

  function getNextContextId() {
    return nextContextId++;
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  function augmentError(error) {
    if ("pos" in error) {
      const loc = locationForIndex(error.pos);
      error.message += ` (${loc.line}:${loc.column})`;
      error.loc = loc;
    }
    return error;
  }

  class Loc {


    constructor(line, column) {
      this.line = line;
      this.column = column;
    }
  }

  function locationForIndex(pos) {
    let line = 1;
    let column = 1;
    for (let i = 0; i < pos; i++) {
      if (input.charCodeAt(i) === charCodes.lineFeed) {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return new Loc(line, column);
  }

  function initParser(
    inputCode,
    isJSXEnabledArg,
    isTypeScriptEnabledArg,
    isFlowEnabledArg,
  ) {
    input = inputCode;
    state = new State();
    nextContextId = 1;
//  isJSXEnabled = isJSXEnabledArg;
//  isTypeScriptEnabled = isTypeScriptEnabledArg;
//  isFlowEnabled = isFlowEnabledArg;
  }

// ## Parser utilities

// Tests whether parsed token is a contextual keyword.
  function isContextual(contextualKeyword) {
    return state.contextualKeyword === contextualKeyword;
  }

  function isLookaheadContextual(contextualKeyword) {
    const l = lookaheadTypeAndKeyword();
    return l.type === TokenType.name && l.contextualKeyword === contextualKeyword;
  }

// Consumes contextual keyword if possible.
  function eatContextual(contextualKeyword) {
    return state.contextualKeyword === contextualKeyword && eat(TokenType.name);
  }

// Asserts that following token is given contextual keyword.
  function expectContextual(contextualKeyword) {
    if (!eatContextual(contextualKeyword)) {
      unexpected();
    }
  }

// Test whether a semicolon can be inserted at the current position.
  function canInsertSemicolon() {
    return match(TokenType.eof) || match(TokenType.braceR) || hasPrecedingLineBreak();
  }

  function hasPrecedingLineBreak() {
    const prevToken = state.tokens[state.tokens.length - 1];
    const lastTokEnd = prevToken ? prevToken.end : 0;
    for (let i = lastTokEnd; i < state.start; i++) {
      const code = input.charCodeAt(i);
      if (
        code === charCodes.lineFeed ||
        code === charCodes.carriageReturn ||
        code === 0x2028 ||
        code === 0x2029
      ) {
        return true;
      }
    }
    return false;
  }

  function hasFollowingLineBreak() {
    const nextStart = nextTokenStart();
    for (let i = state.end; i < nextStart; i++) {
      const code = input.charCodeAt(i);
      if (
        code === charCodes.lineFeed ||
        code === charCodes.carriageReturn ||
        code === 0x2028 ||
        code === 0x2029
      ) {
        return true;
      }
    }
    return false;
  }

  function isLineTerminator() {
    return eat(TokenType.semi) || canInsertSemicolon();
  }

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.
  function semicolon() {
    if (!isLineTerminator()) {
      unexpected('Unexpected token, expected ";"');
    }
  }

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error at given pos.
  function expect(type) {
    const matched = eat(type);
    if (!matched) {
      unexpected(`Unexpected token, expected "${formatTokenType(type)}"`);
    }
  }

  /**
   * Transition the parser to an error state. All code needs to be written to naturally unwind in this
   * state, which allows us to backtrack without exceptions and without error plumbing everywhere.
   */
  function unexpected(message = "Unexpected token", pos = state.start) {
    if (state.error) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = new SyntaxError(message);
    err.pos = pos;
    state.error = err;
    state.pos = input.length;
    finishToken(TokenType.eof);
  }

// https://tc39.github.io/ecma262/#sec-white-space
  const WHITESPACE_CHARS = [
    0x0009,
    0x000b,
    0x000c,
    charCodes.space,
    charCodes.nonBreakingSpace,
    charCodes.oghamSpaceMark,
    0x2000, // EN QUAD
    0x2001, // EM QUAD
    0x2002, // EN SPACE
    0x2003, // EM SPACE
    0x2004, // THREE-PER-EM SPACE
    0x2005, // FOUR-PER-EM SPACE
    0x2006, // SIX-PER-EM SPACE
    0x2007, // FIGURE SPACE
    0x2008, // PUNCTUATION SPACE
    0x2009, // THIN SPACE
    0x200a, // HAIR SPACE
    0x202f, // NARROW NO-BREAK SPACE
    0x205f, // MEDIUM MATHEMATICAL SPACE
    0x3000, // IDEOGRAPHIC SPACE
    0xfeff, // ZERO WIDTH NO-BREAK SPACE
  ];

  const skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;

  const IS_WHITESPACE = new Uint8Array(65536);
  for (const char of WHITESPACE_CHARS) {
    IS_WHITESPACE[char] = 1;
  }

  function computeIsIdentifierChar(code) {
    if (code < 48) return code === 36;
    if (code < 58) return true;
    if (code < 65) return false;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123) return true;
    if (code < 128) return false;
    throw new Error("Should not be called with non-ASCII char code.");
  }

  const IS_IDENTIFIER_CHAR = new Uint8Array(65536);
  for (let i = 0; i < 128; i++) {
    IS_IDENTIFIER_CHAR[i] = computeIsIdentifierChar(i) ? 1 : 0;
  }
  for (let i = 128; i < 65536; i++) {
    IS_IDENTIFIER_CHAR[i] = 1;
  }
// Aside from whitespace and newlines, all characters outside the ASCII space are either
// identifier characters or invalid. Since we're not performing code validation, we can just
// treat all invalid characters as identifier characters.
  for (const whitespaceChar of WHITESPACE_CHARS) {
    IS_IDENTIFIER_CHAR[whitespaceChar] = 0;
  }
  IS_IDENTIFIER_CHAR[0x2028] = 0;
  IS_IDENTIFIER_CHAR[0x2029] = 0;

  const IS_IDENTIFIER_START = IS_IDENTIFIER_CHAR.slice();
  for (let numChar = charCodes.digit0; numChar <= charCodes.digit9; numChar++) {
    IS_IDENTIFIER_START[numChar] = 0;
  }

// Generated file, do not edit! Run "yarn generate" to re-generate this file.

// prettier-ignore
  const READ_WORD_TREE = new Int32Array([
    // ""
    -1, 27, 594, 729, 1566, 2187, 2673, 3294, -1, 3510, -1, 4428, 4563, 4644, 4941, 5319, 5697, -1, 6237, 6696, 7155, 7587, 7749, 7911, -1, 8127, -1,
    // "a"
    -1, -1, 54, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 243, -1, -1, -1, 486, -1, -1, -1,
    // "ab"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 81, -1, -1, -1, -1, -1, -1, -1,
    // "abs"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 108, -1, -1, -1, -1, -1, -1,
    // "abst"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 135, -1, -1, -1, -1, -1, -1, -1, -1,
    // "abstr"
    -1, 162, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "abstra"
    -1, -1, -1, 189, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "abstrac"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 216, -1, -1, -1, -1, -1, -1,
    // "abstract"
    ContextualKeyword._abstract << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "as"
    ContextualKeyword._as << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 270, -1, -1, -1, -1, -1, 405, -1,
    // "ass"
    -1, -1, -1, -1, -1, 297, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "asse"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 324, -1, -1, -1, -1, -1, -1, -1, -1,
    // "asser"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 351, -1, -1, -1, -1, -1, -1,
    // "assert"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 378, -1, -1, -1, -1, -1, -1, -1,
    // "asserts"
    ContextualKeyword._asserts << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "asy"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 432, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "asyn"
    -1, -1, -1, 459, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "async"
    ContextualKeyword._async << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "aw"
    -1, 513, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "awa"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 540, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "awai"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 567, -1, -1, -1, -1, -1, -1,
    // "await"
    ContextualKeyword._await << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "b"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 621, -1, -1, -1, -1, -1, -1, -1, -1,
    // "br"
    -1, -1, -1, -1, -1, 648, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "bre"
    -1, 675, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "brea"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 702, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "break"
    (TokenType._break << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "c"
    -1, 756, -1, -1, -1, -1, -1, -1, 918, -1, -1, -1, 1053, -1, -1, 1161, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ca"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 783, 837, -1, -1, -1, -1, -1, -1,
    // "cas"
    -1, -1, -1, -1, -1, 810, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "case"
    (TokenType._case << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "cat"
    -1, -1, -1, 864, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "catc"
    -1, -1, -1, -1, -1, -1, -1, -1, 891, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "catch"
    (TokenType._catch << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ch"
    -1, -1, -1, -1, -1, 945, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "che"
    -1, -1, -1, 972, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "chec"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 999, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "check"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1026, -1, -1, -1, -1, -1, -1, -1,
    // "checks"
    ContextualKeyword._checks << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "cl"
    -1, 1080, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "cla"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1107, -1, -1, -1, -1, -1, -1, -1,
    // "clas"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1134, -1, -1, -1, -1, -1, -1, -1,
    // "class"
    (TokenType._class << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "co"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1188, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "con"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1215, 1431, -1, -1, -1, -1, -1, -1,
    // "cons"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1242, -1, -1, -1, -1, -1, -1,
    // "const"
    (TokenType._const << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1269, -1, -1, -1, -1, -1, -1, -1, -1,
    // "constr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1296, -1, -1, -1, -1, -1,
    // "constru"
    -1, -1, -1, 1323, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "construc"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1350, -1, -1, -1, -1, -1, -1,
    // "construct"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1377, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "constructo"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1404, -1, -1, -1, -1, -1, -1, -1, -1,
    // "constructor"
    ContextualKeyword._constructor << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "cont"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 1458, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "conti"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1485, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "contin"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1512, -1, -1, -1, -1, -1,
    // "continu"
    -1, -1, -1, -1, -1, 1539, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "continue"
    (TokenType._continue << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "d"
    -1, -1, -1, -1, -1, 1593, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2160, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "de"
    -1, -1, 1620, 1782, -1, -1, 1917, -1, -1, -1, -1, -1, 2052, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "deb"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1647, -1, -1, -1, -1, -1,
    // "debu"
    -1, -1, -1, -1, -1, -1, -1, 1674, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "debug"
    -1, -1, -1, -1, -1, -1, -1, 1701, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "debugg"
    -1, -1, -1, -1, -1, 1728, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "debugge"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1755, -1, -1, -1, -1, -1, -1, -1, -1,
    // "debugger"
    (TokenType._debugger << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "dec"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1809, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "decl"
    -1, 1836, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "decla"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1863, -1, -1, -1, -1, -1, -1, -1, -1,
    // "declar"
    -1, -1, -1, -1, -1, 1890, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "declare"
    ContextualKeyword._declare << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "def"
    -1, 1944, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "defa"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1971, -1, -1, -1, -1, -1,
    // "defau"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1998, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "defaul"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2025, -1, -1, -1, -1, -1, -1,
    // "default"
    (TokenType._default << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "del"
    -1, -1, -1, -1, -1, 2079, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "dele"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2106, -1, -1, -1, -1, -1, -1,
    // "delet"
    -1, -1, -1, -1, -1, 2133, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "delete"
    (TokenType._delete << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "do"
    (TokenType._do << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "e"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2214, -1, 2295, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2376, -1, -1,
    // "el"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2241, -1, -1, -1, -1, -1, -1, -1,
    // "els"
    -1, -1, -1, -1, -1, 2268, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "else"
    (TokenType._else << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "en"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2322, -1, -1, -1, -1, -1,
    // "enu"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2349, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "enum"
    ContextualKeyword._enum << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ex"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2403, -1, -1, -1, 2538, -1, -1, -1, -1, -1, -1,
    // "exp"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2430, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "expo"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2457, -1, -1, -1, -1, -1, -1, -1, -1,
    // "expor"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2484, -1, -1, -1, -1, -1, -1,
    // "export"
    (TokenType._export << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2511, -1, -1, -1, -1, -1, -1, -1,
    // "exports"
    ContextualKeyword._exports << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ext"
    -1, -1, -1, -1, -1, 2565, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "exte"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2592, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "exten"
    -1, -1, -1, -1, 2619, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "extend"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2646, -1, -1, -1, -1, -1, -1, -1,
    // "extends"
    (TokenType._extends << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "f"
    -1, 2700, -1, -1, -1, -1, -1, -1, -1, 2808, -1, -1, -1, -1, -1, 2970, -1, -1, 3024, -1, -1, 3105, -1, -1, -1, -1, -1,
    // "fa"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2727, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fal"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2754, -1, -1, -1, -1, -1, -1, -1,
    // "fals"
    -1, -1, -1, -1, -1, 2781, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "false"
    (TokenType._false << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2835, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fin"
    -1, 2862, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fina"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2889, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "final"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2916, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "finall"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2943, -1,
    // "finally"
    (TokenType._finally << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fo"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2997, -1, -1, -1, -1, -1, -1, -1, -1,
    // "for"
    (TokenType._for << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3051, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fro"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3078, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "from"
    ContextualKeyword._from << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fu"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3132, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "fun"
    -1, -1, -1, 3159, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "func"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3186, -1, -1, -1, -1, -1, -1,
    // "funct"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 3213, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "functi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3240, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "functio"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3267, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "function"
    (TokenType._function << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "g"
    -1, -1, -1, -1, -1, 3321, -1, -1, -1, -1, -1, -1, 3375, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ge"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3348, -1, -1, -1, -1, -1, -1,
    // "get"
    ContextualKeyword._get << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "gl"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3402, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "glo"
    -1, -1, 3429, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "glob"
    -1, 3456, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "globa"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3483, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "global"
    ContextualKeyword._global << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "i"
    -1, -1, -1, -1, -1, -1, 3537, -1, -1, -1, -1, -1, -1, 3564, 3888, -1, -1, -1, -1, 4401, -1, -1, -1, -1, -1, -1, -1,
    // "if"
    (TokenType._if << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "im"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3591, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "imp"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3618, -1, -1, 3807, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "impl"
    -1, -1, -1, -1, -1, 3645, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "imple"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3672, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "implem"
    -1, -1, -1, -1, -1, 3699, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "impleme"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3726, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "implemen"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3753, -1, -1, -1, -1, -1, -1,
    // "implement"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3780, -1, -1, -1, -1, -1, -1, -1,
    // "implements"
    ContextualKeyword._implements << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "impo"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3834, -1, -1, -1, -1, -1, -1, -1, -1,
    // "impor"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3861, -1, -1, -1, -1, -1, -1,
    // "import"
    (TokenType._import << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "in"
    (TokenType._in << 1) + 1, -1, -1, -1, -1, -1, 3915, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3996, 4212, -1, -1, -1, -1, -1, -1,
    // "inf"
    -1, -1, -1, -1, -1, 3942, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "infe"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3969, -1, -1, -1, -1, -1, -1, -1, -1,
    // "infer"
    ContextualKeyword._infer << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ins"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4023, -1, -1, -1, -1, -1, -1,
    // "inst"
    -1, 4050, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "insta"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4077, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "instan"
    -1, -1, -1, 4104, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "instanc"
    -1, -1, -1, -1, -1, 4131, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "instance"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4158, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "instanceo"
    -1, -1, -1, -1, -1, -1, 4185, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "instanceof"
    (TokenType._instanceof << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "int"
    -1, -1, -1, -1, -1, 4239, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "inte"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4266, -1, -1, -1, -1, -1, -1, -1, -1,
    // "inter"
    -1, -1, -1, -1, -1, -1, 4293, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "interf"
    -1, 4320, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "interfa"
    -1, -1, -1, 4347, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "interfac"
    -1, -1, -1, -1, -1, 4374, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "interface"
    ContextualKeyword._interface << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "is"
    ContextualKeyword._is << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "k"
    -1, -1, -1, -1, -1, 4455, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ke"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4482, -1,
    // "key"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4509, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "keyo"
    -1, -1, -1, -1, -1, -1, 4536, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "keyof"
    ContextualKeyword._keyof << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "l"
    -1, -1, -1, -1, -1, 4590, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "le"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4617, -1, -1, -1, -1, -1, -1,
    // "let"
    (TokenType._let << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "m"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 4671, -1, -1, -1, -1, -1, 4806, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "mi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4698, -1, -1,
    // "mix"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 4725, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "mixi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4752, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "mixin"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4779, -1, -1, -1, -1, -1, -1, -1,
    // "mixins"
    ContextualKeyword._mixins << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "mo"
    -1, -1, -1, -1, 4833, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "mod"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4860, -1, -1, -1, -1, -1,
    // "modu"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4887, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "modul"
    -1, -1, -1, -1, -1, 4914, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "module"
    ContextualKeyword._module << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "n"
    -1, 4968, -1, -1, -1, 5184, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5238, -1, -1, -1, -1, -1,
    // "na"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4995, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "nam"
    -1, -1, -1, -1, -1, 5022, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "name"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5049, -1, -1, -1, -1, -1, -1, -1,
    // "names"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5076, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "namesp"
    -1, 5103, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "namespa"
    -1, -1, -1, 5130, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "namespac"
    -1, -1, -1, -1, -1, 5157, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "namespace"
    ContextualKeyword._namespace << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ne"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5211, -1, -1, -1,
    // "new"
    (TokenType._new << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "nu"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5265, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "nul"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5292, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "null"
    (TokenType._null << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "o"
    -1, -1, -1, -1, -1, -1, 5346, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5373, -1, -1, -1, -1, -1, 5508, -1, -1, -1, -1,
    // "of"
    ContextualKeyword._of << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "op"
    -1, 5400, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "opa"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5427, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "opaq"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5454, -1, -1, -1, -1, -1,
    // "opaqu"
    -1, -1, -1, -1, -1, 5481, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "opaque"
    ContextualKeyword._opaque << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ov"
    -1, -1, -1, -1, -1, 5535, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ove"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5562, -1, -1, -1, -1, -1, -1, -1, -1,
    // "over"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5589, -1, -1, -1, -1, -1, -1, -1, -1,
    // "overr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 5616, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "overri"
    -1, -1, -1, -1, 5643, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "overrid"
    -1, -1, -1, -1, -1, 5670, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "override"
    ContextualKeyword._override << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "p"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5724, -1, -1, 6102, -1, -1, -1, -1, -1,
    // "pr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 5751, -1, -1, -1, -1, -1, 5886, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "pri"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5778, -1, -1, -1, -1,
    // "priv"
    -1, 5805, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "priva"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5832, -1, -1, -1, -1, -1, -1,
    // "privat"
    -1, -1, -1, -1, -1, 5859, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "private"
    ContextualKeyword._private << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "pro"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5913, -1, -1, -1, -1, -1, -1,
    // "prot"
    -1, -1, -1, -1, -1, 5940, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6075, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "prote"
    -1, -1, -1, 5967, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "protec"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5994, -1, -1, -1, -1, -1, -1,
    // "protect"
    -1, -1, -1, -1, -1, 6021, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "protecte"
    -1, -1, -1, -1, 6048, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "protected"
    ContextualKeyword._protected << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "proto"
    ContextualKeyword._proto << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "pu"
    -1, -1, 6129, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "pub"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6156, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "publ"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 6183, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "publi"
    -1, -1, -1, 6210, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "public"
    ContextualKeyword._public << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "r"
    -1, -1, -1, -1, -1, 6264, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "re"
    -1, 6291, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6453, -1, -1, 6588, -1, -1, -1, -1, -1, -1,
    // "rea"
    -1, -1, -1, -1, 6318, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "read"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6345, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "reado"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6372, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "readon"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6399, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "readonl"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6426, -1,
    // "readonly"
    ContextualKeyword._readonly << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "req"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6480, -1, -1, -1, -1, -1,
    // "requ"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 6507, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "requi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6534, -1, -1, -1, -1, -1, -1, -1, -1,
    // "requir"
    -1, -1, -1, -1, -1, 6561, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "require"
    ContextualKeyword._require << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ret"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6615, -1, -1, -1, -1, -1,
    // "retu"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6642, -1, -1, -1, -1, -1, -1, -1, -1,
    // "retur"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6669, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "return"
    (TokenType._return << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "s"
    -1, -1, -1, -1, -1, 6723, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6777, 6912, -1, 7020, -1, -1, -1,
    // "se"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6750, -1, -1, -1, -1, -1, -1,
    // "set"
    ContextualKeyword._set << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "st"
    -1, 6804, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "sta"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6831, -1, -1, -1, -1, -1, -1,
    // "stat"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 6858, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "stati"
    -1, -1, -1, 6885, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "static"
    ContextualKeyword._static << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "su"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6939, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "sup"
    -1, -1, -1, -1, -1, 6966, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "supe"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 6993, -1, -1, -1, -1, -1, -1, -1, -1,
    // "super"
    (TokenType._super << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "sw"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 7047, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "swi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7074, -1, -1, -1, -1, -1, -1,
    // "swit"
    -1, -1, -1, 7101, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "switc"
    -1, -1, -1, -1, -1, -1, -1, -1, 7128, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "switch"
    (TokenType._switch << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "t"
    -1, -1, -1, -1, -1, -1, -1, -1, 7182, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7344, -1, -1, -1, -1, -1, -1, 7452, -1,
    // "th"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 7209, -1, -1, -1, -1, -1, -1, -1, -1, 7263, -1, -1, -1, -1, -1, -1, -1, -1,
    // "thi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7236, -1, -1, -1, -1, -1, -1, -1,
    // "this"
    (TokenType._this << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "thr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7290, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "thro"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7317, -1, -1, -1,
    // "throw"
    (TokenType._throw << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "tr"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7371, -1, -1, -1, 7425, -1,
    // "tru"
    -1, -1, -1, -1, -1, 7398, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "true"
    (TokenType._true << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "try"
    (TokenType._try << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "ty"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7479, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "typ"
    -1, -1, -1, -1, -1, 7506, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "type"
    ContextualKeyword._type << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7533, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "typeo"
    -1, -1, -1, -1, -1, -1, 7560, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "typeof"
    (TokenType._typeof << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "u"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7614, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "un"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 7641, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "uni"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7668, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "uniq"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7695, -1, -1, -1, -1, -1,
    // "uniqu"
    -1, -1, -1, -1, -1, 7722, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "unique"
    ContextualKeyword._unique << 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "v"
    -1, 7776, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7830, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "va"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7803, -1, -1, -1, -1, -1, -1, -1, -1,
    // "var"
    (TokenType._var << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "vo"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 7857, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "voi"
    -1, -1, -1, -1, 7884, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "void"
    (TokenType._void << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "w"
    -1, -1, -1, -1, -1, -1, -1, -1, 7938, 8046, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "wh"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 7965, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "whi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7992, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "whil"
    -1, -1, -1, -1, -1, 8019, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "while"
    (TokenType._while << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "wi"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 8073, -1, -1, -1, -1, -1, -1,
    // "wit"
    -1, -1, -1, -1, -1, -1, -1, -1, 8100, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "with"
    (TokenType._with << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "y"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 8154, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "yi"
    -1, -1, -1, -1, -1, 8181, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "yie"
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 8208, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "yiel"
    -1, -1, -1, -1, 8235, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    // "yield"
    (TokenType._yield << 1) + 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  ]);

  /**
   * Read an identifier, producing either a name token or matching on one of the existing keywords.
   * For performance, we pre-generate big decision tree that we traverse. Each node represents a
   * prefix and has 27 values, where the first value is the token or contextual token, if any (-1 if
   * not), and the other 26 values are the transitions to other nodes, or -1 to stop.
   */
  function readWord() {
    let treePos = 0;
    let code = 0;
    let pos = state.pos;
    while (pos < input.length) {
      code = input.charCodeAt(pos);
      if (code < charCodes.lowercaseA || code > charCodes.lowercaseZ) {
        break;
      }
      const next = READ_WORD_TREE[treePos + (code - charCodes.lowercaseA) + 1];
      if (next === -1) {
        break;
      } else {
        treePos = next;
        pos++;
      }
    }

    const keywordValue = READ_WORD_TREE[treePos];
    if (keywordValue > -1 && !IS_IDENTIFIER_CHAR[code]) {
      state.pos = pos;
      if (keywordValue & 1) {
        finishToken(keywordValue >>> 1);
      } else {
        finishToken(TokenType.name, keywordValue >>> 1);
      }
      return;
    }

    while (pos < input.length) {
      const ch = input.charCodeAt(pos);
      if (IS_IDENTIFIER_CHAR[ch]) {
        pos++;
      } else if (ch === charCodes.backslash) {
        // \u
        pos += 2;
        if (input.charCodeAt(pos) === charCodes.leftCurlyBrace) {
          while (pos < input.length && input.charCodeAt(pos) !== charCodes.rightCurlyBrace) {
            pos++;
          }
          pos++;
        }
      } else if (ch === charCodes.atSign && input.charCodeAt(pos + 1) === charCodes.atSign) {
        pos += 2;
      } else {
        break;
      }
    }
    state.pos = pos;
    finishToken(TokenType.name);
  }

  /* eslint max-len: 0 */

  var IdentifierRole; (function (IdentifierRole) {
    const Access = 0; IdentifierRole[IdentifierRole["Access"] = Access] = "Access";
    const ExportAccess = Access + 1; IdentifierRole[IdentifierRole["ExportAccess"] = ExportAccess] = "ExportAccess";
    const TopLevelDeclaration = ExportAccess + 1; IdentifierRole[IdentifierRole["TopLevelDeclaration"] = TopLevelDeclaration] = "TopLevelDeclaration";
    const FunctionScopedDeclaration = TopLevelDeclaration + 1; IdentifierRole[IdentifierRole["FunctionScopedDeclaration"] = FunctionScopedDeclaration] = "FunctionScopedDeclaration";
    const BlockScopedDeclaration = FunctionScopedDeclaration + 1; IdentifierRole[IdentifierRole["BlockScopedDeclaration"] = BlockScopedDeclaration] = "BlockScopedDeclaration";
    const ObjectShorthandTopLevelDeclaration = BlockScopedDeclaration + 1; IdentifierRole[IdentifierRole["ObjectShorthandTopLevelDeclaration"] = ObjectShorthandTopLevelDeclaration] = "ObjectShorthandTopLevelDeclaration";
    const ObjectShorthandFunctionScopedDeclaration = ObjectShorthandTopLevelDeclaration + 1; IdentifierRole[IdentifierRole["ObjectShorthandFunctionScopedDeclaration"] = ObjectShorthandFunctionScopedDeclaration] = "ObjectShorthandFunctionScopedDeclaration";
    const ObjectShorthandBlockScopedDeclaration = ObjectShorthandFunctionScopedDeclaration + 1; IdentifierRole[IdentifierRole["ObjectShorthandBlockScopedDeclaration"] = ObjectShorthandBlockScopedDeclaration] = "ObjectShorthandBlockScopedDeclaration";
    const ObjectShorthand = ObjectShorthandBlockScopedDeclaration + 1; IdentifierRole[IdentifierRole["ObjectShorthand"] = ObjectShorthand] = "ObjectShorthand";
    // Any identifier bound in an import statement, e.g. both A and b from
    // `import A, * as b from 'A';`
    const ImportDeclaration = ObjectShorthand + 1; IdentifierRole[IdentifierRole["ImportDeclaration"] = ImportDeclaration] = "ImportDeclaration";
    const ObjectKey = ImportDeclaration + 1; IdentifierRole[IdentifierRole["ObjectKey"] = ObjectKey] = "ObjectKey";
    // The `foo` in `import {foo as bar} from "./abc";`.
    const ImportAccess = ObjectKey + 1; IdentifierRole[IdentifierRole["ImportAccess"] = ImportAccess] = "ImportAccess";
  })(IdentifierRole || (IdentifierRole = {}));

  function isNonTopLevelDeclaration(token) {
    const role = token.identifierRole;
    return (
      role === IdentifierRole.FunctionScopedDeclaration ||
      role === IdentifierRole.BlockScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandFunctionScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandBlockScopedDeclaration
    );
  }

  function isTopLevelDeclaration(token) {
    const role = token.identifierRole;
    return (
      role === IdentifierRole.TopLevelDeclaration ||
      role === IdentifierRole.ObjectShorthandTopLevelDeclaration ||
      role === IdentifierRole.ImportDeclaration
    );
  }

  function isBlockScopedDeclaration(token) {
    const role = token.identifierRole;
    // Treat top-level declarations as block scope since the distinction doesn't matter here.
    return (
      role === IdentifierRole.TopLevelDeclaration ||
      role === IdentifierRole.BlockScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandTopLevelDeclaration ||
      role === IdentifierRole.ObjectShorthandBlockScopedDeclaration
    );
  }

  function isFunctionScopedDeclaration(token) {
    const role = token.identifierRole;
    return (
      role === IdentifierRole.FunctionScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandFunctionScopedDeclaration
    );
  }

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.
  class Token {
    constructor() {
      this.type = state.type;
      this.contextualKeyword = state.contextualKeyword;
      this.start = state.start;
      this.end = state.end;
      this.scopeDepth = state.scopeDepth;
      this.isType = state.isType;
      this.identifierRole = null;
      this.shadowsGlobal = false;
      this.isAsyncOperation = false;
      this.contextId = null;
      this.rhsEndIndex = null;
      this.isExpression = false;
      this.numNullishCoalesceStarts = 0;
      this.numNullishCoalesceEnds = 0;
      this.isOptionalChainStart = false;
      this.isOptionalChainEnd = false;
      this.subscriptStartIndex = null;
      this.nullishStartIndex = null;
    }








    // Initially false for all tokens, then may be computed in a follow-up step that does scope
    // analysis.

    // Initially false for all tokens, but may be set during transform to mark it as containing an
    // await operation.


    // For assignments, the index of the RHS. For export tokens, the end of the export.

    // For class tokens, records if the class is a class expression or a class statement.

    // Number of times to insert a `nullishCoalesce(` snippet before this token.

    // Number of times to insert a `)` snippet after this token.

    // If true, insert an `optionalChain([` snippet before this token.

    // If true, insert a `])` snippet after this token.

    // Tag for `.`, `?.`, `[`, `?.[`, `(`, and `?.(` to denote the "root" token for this
    // subscript chain. This can be used to determine if this chain is an optional chain.

    // Tag for `??` operators to denote the root token for this nullish coalescing call.

  }

// ## Tokenizer

// Move to the next token
  function next() {
    state.tokens.push(new Token());
    nextToken();
  }

// Call instead of next when inside a template, since that needs to be handled differently.
  function nextTemplateToken() {
    state.tokens.push(new Token());
    state.start = state.pos;
    readTmplToken();
  }

// The tokenizer never parses regexes by default. Instead, the parser is responsible for
// instructing it to parse a regex when we see a slash at the start of an expression.
  function retokenizeSlashAsRegex() {
    if (state.type === TokenType.assign) {
      --state.pos;
    }
    readRegexp();
  }

  function pushTypeContext(existingTokensInType) {
    for (let i = state.tokens.length - existingTokensInType; i < state.tokens.length; i++) {
      state.tokens[i].isType = true;
    }
    const oldIsType = state.isType;
    state.isType = true;
    return oldIsType;
  }

  function popTypeContext(oldIsType) {
    state.isType = oldIsType;
  }

  function eat(type) {
    if (match(type)) {
      next();
      return true;
    } else {
      return false;
    }
  }

  function eatTypeToken(tokenType) {
    const oldIsType = state.isType;
    state.isType = true;
    eat(tokenType);
    state.isType = oldIsType;
  }

  function match(type) {
    return state.type === type;
  }

  function lookaheadType() {
    const snapshot = state.snapshot();
    next();
    const type = state.type;
    state.restoreFromSnapshot(snapshot);
    return type;
  }

  class TypeAndKeyword {


    constructor(type, contextualKeyword) {
      this.type = type;
      this.contextualKeyword = contextualKeyword;
    }
  }

  function lookaheadTypeAndKeyword() {
    const snapshot = state.snapshot();
    next();
    const type = state.type;
    const contextualKeyword = state.contextualKeyword;
    state.restoreFromSnapshot(snapshot);
    return new TypeAndKeyword(type, contextualKeyword);
  }

  function nextTokenStart() {
    return nextTokenStartSince(state.pos);
  }

  function nextTokenStartSince(pos) {
    skipWhiteSpace.lastIndex = pos;
    const skip = skipWhiteSpace.exec(input);
    return pos + skip[0].length;
  }

  function lookaheadCharCode() {
    return input.charCodeAt(nextTokenStart());
  }

// Read a single token, updating the parser object's token-related
// properties.
  function nextToken() {
    skipSpace();
    state.start = state.pos;
    if (state.pos >= input.length) {
      const tokens = state.tokens;
      // We normally run past the end a bit, but if we're way past the end, avoid an infinite loop.
      // Also check the token positions rather than the types since sometimes we rewrite the token
      // type to something else.
      if (
        tokens.length >= 2 &&
        tokens[tokens.length - 1].start >= input.length &&
        tokens[tokens.length - 2].start >= input.length
      ) {
        unexpected("Unexpectedly reached the end of input.");
      }
      finishToken(TokenType.eof);
      return;
    }
    readToken(input.charCodeAt(state.pos));
  }

  function readToken(code) {
    // Identifier or keyword. '\uXXXX' sequences are allowed in
    // identifiers, so '\' also dispatches to that.
    if (
      IS_IDENTIFIER_START[code] ||
      code === charCodes.backslash ||
      (code === charCodes.atSign && input.charCodeAt(state.pos + 1) === charCodes.atSign)
    ) {
      readWord();
    } else {
      getTokenFromCode(code);
    }
  }

  function skipBlockComment() {
    while (
      input.charCodeAt(state.pos) !== charCodes.asterisk ||
      input.charCodeAt(state.pos + 1) !== charCodes.slash
      ) {
      state.pos++;
      if (state.pos > input.length) {
        unexpected("Unterminated comment", state.pos - 2);
        return;
      }
    }
    state.pos += 2;
  }

  function skipLineComment(startSkip) {
    let ch = input.charCodeAt((state.pos += startSkip));
    if (state.pos < input.length) {
      while (
        ch !== charCodes.lineFeed &&
        ch !== charCodes.carriageReturn &&
        ch !== charCodes.lineSeparator &&
        ch !== charCodes.paragraphSeparator &&
        ++state.pos < input.length
        ) {
        ch = input.charCodeAt(state.pos);
      }
    }
  }

// Called at the start of the parse and after every token. Skips
// whitespace and comments.
  function skipSpace() {
    while (state.pos < input.length) {
      const ch = input.charCodeAt(state.pos);
      switch (ch) {
        case charCodes.carriageReturn:
          if (input.charCodeAt(state.pos + 1) === charCodes.lineFeed) {
            ++state.pos;
          }

        case charCodes.lineFeed:
        case charCodes.lineSeparator:
        case charCodes.paragraphSeparator:
          ++state.pos;
          break;

        case charCodes.slash:
          switch (input.charCodeAt(state.pos + 1)) {
            case charCodes.asterisk:
              state.pos += 2;
              skipBlockComment();
              break;

            case charCodes.slash:
              skipLineComment(2);
              break;

            default:
              return;
          }
          break;

        default:
          if (IS_WHITESPACE[ch]) {
            ++state.pos;
          } else {
            return;
          }
      }
    }
  }

// Called at the end of every token. Sets various fields, and skips the space after the token, so
// that the next one's `start` will point at the right position.
  function finishToken(
    type,
    contextualKeyword = ContextualKeyword.NONE,
  ) {
    state.end = state.pos;
    state.type = type;
    state.contextualKeyword = contextualKeyword;
  }

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
  function readToken_dot() {
    const nextChar = input.charCodeAt(state.pos + 1);
    if (nextChar >= charCodes.digit0 && nextChar <= charCodes.digit9) {
      readNumber(true);
      return;
    }

    if (nextChar === charCodes.dot && input.charCodeAt(state.pos + 2) === charCodes.dot) {
      state.pos += 3;
      finishToken(TokenType.ellipsis);
    } else {
      ++state.pos;
      finishToken(TokenType.dot);
    }
  }

  function readToken_slash() {
    const nextChar = input.charCodeAt(state.pos + 1);
    if (nextChar === charCodes.equalsTo) {
      finishOp(TokenType.assign, 2);
    } else {
      finishOp(TokenType.slash, 1);
    }
  }

  function readToken_mult_modulo(code) {
    // '%*'
    let tokenType = code === charCodes.asterisk ? TokenType.star : TokenType.modulo;
    let width = 1;
    let nextChar = input.charCodeAt(state.pos + 1);

    // Exponentiation operator **
    if (code === charCodes.asterisk && nextChar === charCodes.asterisk) {
      width++;
      nextChar = input.charCodeAt(state.pos + 2);
      tokenType = TokenType.exponent;
    }

    // Match *= or %=, disallowing *=> which can be valid in flow.
    if (
      nextChar === charCodes.equalsTo &&
      input.charCodeAt(state.pos + 2) !== charCodes.greaterThan
    ) {
      width++;
      tokenType = TokenType.assign;
    }

    finishOp(tokenType, width);
  }

  function readToken_pipe_amp(code) {
    // '|&'
    const nextChar = input.charCodeAt(state.pos + 1);

    if (nextChar === code) {
      if (input.charCodeAt(state.pos + 2) === charCodes.equalsTo) {
        // ||= or &&=
        finishOp(TokenType.assign, 3);
      } else {
        // || or &&
        finishOp(code === charCodes.verticalBar ? TokenType.logicalOR : TokenType.logicalAND, 2);
      }
      return;
    }

    if (code === charCodes.verticalBar) {
      // '|>'
      if (nextChar === charCodes.greaterThan) {
        finishOp(TokenType.pipeline, 2);
        return;
      } else if (nextChar === charCodes.rightCurlyBrace && isFlowEnabled$1) {
        // '|}'
        finishOp(TokenType.braceBarR, 2);
        return;
      }
    }

    if (nextChar === charCodes.equalsTo) {
      finishOp(TokenType.assign, 2);
      return;
    }

    finishOp(code === charCodes.verticalBar ? TokenType.bitwiseOR : TokenType.bitwiseAND, 1);
  }

  function readToken_caret() {
    // '^'
    const nextChar = input.charCodeAt(state.pos + 1);
    if (nextChar === charCodes.equalsTo) {
      finishOp(TokenType.assign, 2);
    } else {
      finishOp(TokenType.bitwiseXOR, 1);
    }
  }

  function readToken_plus_min(code) {
    // '+-'
    const nextChar = input.charCodeAt(state.pos + 1);

    if (nextChar === code) {
      // Tentatively call this a prefix operator, but it might be changed to postfix later.
      finishOp(TokenType.preIncDec, 2);
      return;
    }

    if (nextChar === charCodes.equalsTo) {
      finishOp(TokenType.assign, 2);
    } else if (code === charCodes.plusSign) {
      finishOp(TokenType.plus, 1);
    } else {
      finishOp(TokenType.minus, 1);
    }
  }

// '<>'
  function readToken_lt_gt(code) {
    const nextChar = input.charCodeAt(state.pos + 1);

    if (nextChar === code) {
      const size =
        code === charCodes.greaterThan && input.charCodeAt(state.pos + 2) === charCodes.greaterThan
          ? 3
          : 2;
      if (input.charCodeAt(state.pos + size) === charCodes.equalsTo) {
        finishOp(TokenType.assign, size + 1);
        return;
      }
      // Avoid right-shift for things like Array<Array<string>>.
      if (code === charCodes.greaterThan && state.isType) {
        finishOp(TokenType.greaterThan, 1);
        return;
      }
      finishOp(TokenType.bitShift, size);
      return;
    }

    if (nextChar === charCodes.equalsTo) {
      // <= | >=
      finishOp(TokenType.relationalOrEqual, 2);
    } else if (code === charCodes.lessThan) {
      finishOp(TokenType.lessThan, 1);
    } else {
      finishOp(TokenType.greaterThan, 1);
    }
  }

  function readToken_eq_excl(code) {
    // '=!'
    const nextChar = input.charCodeAt(state.pos + 1);
    if (nextChar === charCodes.equalsTo) {
      finishOp(TokenType.equality, input.charCodeAt(state.pos + 2) === charCodes.equalsTo ? 3 : 2);
      return;
    }
    if (code === charCodes.equalsTo && nextChar === charCodes.greaterThan) {
      // '=>'
      state.pos += 2;
      finishToken(TokenType.arrow);
      return;
    }
    finishOp(code === charCodes.equalsTo ? TokenType.eq : TokenType.bang, 1);
  }

  function readToken_question() {
    // '?'
    const nextChar = input.charCodeAt(state.pos + 1);
    const nextChar2 = input.charCodeAt(state.pos + 2);
    if (nextChar === charCodes.questionMark && !state.isType) {
      if (nextChar2 === charCodes.equalsTo) {
        // '??='
        finishOp(TokenType.assign, 3);
      } else {
        // '??'
        finishOp(TokenType.nullishCoalescing, 2);
      }
    } else if (
      nextChar === charCodes.dot &&
      !(nextChar2 >= charCodes.digit0 && nextChar2 <= charCodes.digit9)
    ) {
      // '.' not followed by a number
      state.pos += 2;
      finishToken(TokenType.questionDot);
    } else {
      ++state.pos;
      finishToken(TokenType.question);
    }
  }

  function getTokenFromCode(code) {
    switch (code) {
      case charCodes.numberSign:
        ++state.pos;
        finishToken(TokenType.hash);
        return;

      // The interpretation of a dot depends on whether it is followed
      // by a digit or another two dots.

      case charCodes.dot:
        readToken_dot();
        return;

      // Punctuation tokens.
      case charCodes.leftParenthesis:
        ++state.pos;
        finishToken(TokenType.parenL);
        return;
      case charCodes.rightParenthesis:
        ++state.pos;
        finishToken(TokenType.parenR);
        return;
      case charCodes.semicolon:
        ++state.pos;
        finishToken(TokenType.semi);
        return;
      case charCodes.comma:
        ++state.pos;
        finishToken(TokenType.comma);
        return;
      case charCodes.leftSquareBracket:
        ++state.pos;
        finishToken(TokenType.bracketL);
        return;
      case charCodes.rightSquareBracket:
        ++state.pos;
        finishToken(TokenType.bracketR);
        return;

      case charCodes.leftCurlyBrace:
      {
        ++state.pos;
        finishToken(TokenType.braceL);
      }
        return;

      case charCodes.rightCurlyBrace:
        ++state.pos;
        finishToken(TokenType.braceR);
        return;

      case charCodes.colon:
        if (input.charCodeAt(state.pos + 1) === charCodes.colon) {
          finishOp(TokenType.doubleColon, 2);
        } else {
          ++state.pos;
          finishToken(TokenType.colon);
        }
        return;

      case charCodes.questionMark:
        readToken_question();
        return;
      case charCodes.atSign:
        ++state.pos;
        finishToken(TokenType.at);
        return;

      case charCodes.graveAccent:
        ++state.pos;
        finishToken(TokenType.backQuote);
        return;

      case charCodes.digit0: {
        const nextChar = input.charCodeAt(state.pos + 1);
        // '0x', '0X', '0o', '0O', '0b', '0B'
        if (
          nextChar === charCodes.lowercaseX ||
          nextChar === charCodes.uppercaseX ||
          nextChar === charCodes.lowercaseO ||
          nextChar === charCodes.uppercaseO ||
          nextChar === charCodes.lowercaseB ||
          nextChar === charCodes.uppercaseB
        ) {
          readRadixNumber();
          return;
        }
      }
      // Anything else beginning with a digit is an integer, octal
      // number, or float.
      case charCodes.digit1:
      case charCodes.digit2:
      case charCodes.digit3:
      case charCodes.digit4:
      case charCodes.digit5:
      case charCodes.digit6:
      case charCodes.digit7:
      case charCodes.digit8:
      case charCodes.digit9:
        readNumber(false);
        return;

      // Quotes produce strings.
      case charCodes.quotationMark:
      case charCodes.apostrophe:
        readString(code);
        return;

      // Operators are parsed inline in tiny state machines. '=' (charCodes.equalsTo) is
      // often referred to. `finishOp` simply skips the amount of
      // characters it is given as second argument, and returns a token
      // of the type given by its first argument.

      case charCodes.slash:
        readToken_slash();
        return;

      case charCodes.percentSign:
      case charCodes.asterisk:
        readToken_mult_modulo(code);
        return;

      case charCodes.verticalBar:
      case charCodes.ampersand:
        readToken_pipe_amp(code);
        return;

      case charCodes.caret:
        readToken_caret();
        return;

      case charCodes.plusSign:
      case charCodes.dash:
        readToken_plus_min(code);
        return;

      case charCodes.lessThan:
      case charCodes.greaterThan:
        readToken_lt_gt(code);
        return;

      case charCodes.equalsTo:
      case charCodes.exclamationMark:
        readToken_eq_excl(code);
        return;

      case charCodes.tilde:
        finishOp(TokenType.tilde, 1);
        return;
    }

    unexpected(`Unexpected character '${String.fromCharCode(code)}'`, state.pos);
  }

  function finishOp(type, size) {
    state.pos += size;
    finishToken(type);
  }

  function readRegexp() {
    const start = state.pos;
    let escaped = false;
    let inClass = false;
    for (;;) {
      if (state.pos >= input.length) {
        unexpected("Unterminated regular expression", start);
        return;
      }
      const code = input.charCodeAt(state.pos);
      if (escaped) {
        escaped = false;
      } else {
        if (code === charCodes.leftSquareBracket) {
          inClass = true;
        } else if (code === charCodes.rightSquareBracket && inClass) {
          inClass = false;
        } else if (code === charCodes.slash && !inClass) {
          break;
        }
        escaped = code === charCodes.backslash;
      }
      ++state.pos;
    }
    ++state.pos;
    // Need to use `skipWord` because '\uXXXX' sequences are allowed here (don't ask).
    skipWord();

    finishToken(TokenType.regexp);
  }

// Read an integer. We allow any valid digit, including hex digits, plus numeric separators, and
// stop at any other character.
  function readInt() {
    while (true) {
      const code = input.charCodeAt(state.pos);
      if (
        (code >= charCodes.digit0 && code <= charCodes.digit9) ||
        (code >= charCodes.lowercaseA && code <= charCodes.lowercaseF) ||
        (code >= charCodes.uppercaseA && code <= charCodes.uppercaseF) ||
        code === charCodes.underscore
      ) {
        state.pos++;
      } else {
        break;
      }
    }
  }

  function readRadixNumber() {
    let isBigInt = false;
    const start = state.pos;

    state.pos += 2; // 0x
    readInt();

    const nextChar = input.charCodeAt(state.pos);
    if (nextChar === charCodes.lowercaseN) {
      ++state.pos;
      isBigInt = true;
    } else if (nextChar === charCodes.lowercaseM) {
      unexpected("Invalid decimal", start);
    }

    if (isBigInt) {
      finishToken(TokenType.bigint);
      return;
    }

    finishToken(TokenType.num);
  }

// Read an integer, octal integer, or floating-point number.
  function readNumber(startsWithDot) {
    let isBigInt = false;
    let isDecimal = false;

    if (!startsWithDot) {
      readInt();
    }

    let nextChar = input.charCodeAt(state.pos);
    if (nextChar === charCodes.dot) {
      ++state.pos;
      readInt();
      nextChar = input.charCodeAt(state.pos);
    }

    if (nextChar === charCodes.uppercaseE || nextChar === charCodes.lowercaseE) {
      nextChar = input.charCodeAt(++state.pos);
      if (nextChar === charCodes.plusSign || nextChar === charCodes.dash) {
        ++state.pos;
      }
      readInt();
      nextChar = input.charCodeAt(state.pos);
    }

    if (nextChar === charCodes.lowercaseN) {
      ++state.pos;
      isBigInt = true;
    } else if (nextChar === charCodes.lowercaseM) {
      ++state.pos;
      isDecimal = true;
    }

    if (isBigInt) {
      finishToken(TokenType.bigint);
      return;
    }

    if (isDecimal) {
      finishToken(TokenType.decimal);
      return;
    }

    finishToken(TokenType.num);
  }

  function readString(quote) {
    state.pos++;
    for (;;) {
      if (state.pos >= input.length) {
        unexpected("Unterminated string constant");
        return;
      }
      const ch = input.charCodeAt(state.pos);
      if (ch === charCodes.backslash) {
        state.pos++;
      } else if (ch === quote) {
        break;
      }
      state.pos++;
    }
    state.pos++;
    finishToken(TokenType.string);
  }

// Reads template string tokens.
  function readTmplToken() {
    for (;;) {
      if (state.pos >= input.length) {
        unexpected("Unterminated template");
        return;
      }
      const ch = input.charCodeAt(state.pos);
      if (
        ch === charCodes.graveAccent ||
        (ch === charCodes.dollarSign && input.charCodeAt(state.pos + 1) === charCodes.leftCurlyBrace)
      ) {
        if (state.pos === state.start && match(TokenType.template)) {
          if (ch === charCodes.dollarSign) {
            state.pos += 2;
            finishToken(TokenType.dollarBraceL);
            return;
          } else {
            ++state.pos;
            finishToken(TokenType.backQuote);
            return;
          }
        }
        finishToken(TokenType.template);
        return;
      }
      if (ch === charCodes.backslash) {
        state.pos++;
      }
      state.pos++;
    }
  }

// Skip to the end of the current word. Note that this is the same as the snippet at the end of
// readWord, but calling skipWord from readWord seems to slightly hurt performance from some rough
// measurements.
  function skipWord() {
    while (state.pos < input.length) {
      const ch = input.charCodeAt(state.pos);
      if (IS_IDENTIFIER_CHAR[ch]) {
        state.pos++;
      } else if (ch === charCodes.backslash) {
        // \u
        state.pos += 2;
        if (input.charCodeAt(state.pos) === charCodes.leftCurlyBrace) {
          while (
            state.pos < input.length &&
            input.charCodeAt(state.pos) !== charCodes.rightCurlyBrace
            ) {
            state.pos++;
          }
          state.pos++;
        }
      } else {
        break;
      }
    }
  }

  /**
   * Traverse the given tokens and modify them if necessary to indicate that some names shadow global
   * variables.
   */
  function identifyShadowedGlobals(
    tokens,
    scopes,
    globalNames,
  ) {
    if (!hasShadowedGlobals(tokens, globalNames)) {
      return;
    }
    markShadowedGlobals(tokens, scopes, globalNames);
  }

  /**
   * We can do a fast up-front check to see if there are any declarations to global names. If not,
   * then there's no point in computing scope assignments.
   */
// Exported for testing.
  function hasShadowedGlobals(tokens, globalNames) {
    for (const token of tokens.tokens) {
      if (
        token.type === TokenType.name &&
        isNonTopLevelDeclaration(token) &&
        globalNames.has(tokens.identifierNameForToken(token))
      ) {
        return true;
      }
    }
    return false;
  }

  function markShadowedGlobals(
    tokens,
    scopes,
    globalNames,
  ) {
    const scopeStack = [];
    let scopeIndex = scopes.length - 1;
    // Scopes were generated at completion time, so they're sorted by end index, so we can maintain a
    // good stack by going backwards through them.
    for (let i = tokens.tokens.length - 1; ; i--) {
      while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].startTokenIndex === i + 1) {
        scopeStack.pop();
      }
      while (scopeIndex >= 0 && scopes[scopeIndex].endTokenIndex === i + 1) {
        scopeStack.push(scopes[scopeIndex]);
        scopeIndex--;
      }
      // Process scopes after the last iteration so we can make sure we pop all of them.
      if (i < 0) {
        break;
      }

      const token = tokens.tokens[i];
      const name = tokens.identifierNameForToken(token);
      if (scopeStack.length > 1 && token.type === TokenType.name && globalNames.has(name)) {
        if (isBlockScopedDeclaration(token)) {
          markShadowedForScope(scopeStack[scopeStack.length - 1], tokens, name);
        } else if (isFunctionScopedDeclaration(token)) {
          let stackIndex = scopeStack.length - 1;
          while (stackIndex > 0 && !scopeStack[stackIndex].isFunctionScope) {
            stackIndex--;
          }
          if (stackIndex < 0) {
            throw new Error("Did not find parent function scope.");
          }
          markShadowedForScope(scopeStack[stackIndex], tokens, name);
        }
      }
    }
    if (scopeStack.length > 0) {
      throw new Error("Expected empty scope stack after processing file.");
    }
  }

  function markShadowedForScope(scope, tokens, name) {
    for (let i = scope.startTokenIndex; i < scope.endTokenIndex; i++) {
      const token = tokens.tokens[i];
      if (
        (token.type === TokenType.name || token.type === TokenType.jsxName) &&
        tokens.identifierNameForToken(token) === name
      ) {
        token.shadowsGlobal = true;
      }
    }
  }

  /**
   * Get all identifier names in the code, in order, including duplicates.
   */
  function getIdentifierNames(code, tokens) {
    const names = [];
    for (const token of tokens) {
      if (token.type === TokenType.name) {
        names.push(code.slice(token.start, token.end));
      }
    }
    return names;
  }

  class NameManager {
    __init() {this.usedNames = new Set();}

    constructor(code, tokens) {NameManager.prototype.__init.call(this);
      this.usedNames = new Set(getIdentifierNames(code, tokens));
    }

    claimFreeName(name) {
      const newName = this.findFreeName(name);
      this.usedNames.add(newName);
      return newName;
    }

    findFreeName(name) {
      if (!this.usedNames.has(name)) {
        return name;
      }
      let suffixNum = 2;
      while (this.usedNames.has(name + String(suffixNum))) {
        suffixNum++;
      }
      return name + String(suffixNum);
    }
  }

  function parseSpread() {
    next();
    parseMaybeAssign(false);
  }

  function parseRest(isBlockScope) {
    next();
    parseBindingAtom(isBlockScope);
  }

  function parseBindingIdentifier(isBlockScope) {
    parseIdentifier();
    markPriorBindingIdentifier(isBlockScope);
  }

  function parseImportedIdentifier() {
    parseIdentifier();
    state.tokens[state.tokens.length - 1].identifierRole = IdentifierRole.ImportDeclaration;
  }

  function markPriorBindingIdentifier(isBlockScope) {
    let identifierRole;
    if (state.scopeDepth === 0) {
      identifierRole = IdentifierRole.TopLevelDeclaration;
    } else if (isBlockScope) {
      identifierRole = IdentifierRole.BlockScopedDeclaration;
    } else {
      identifierRole = IdentifierRole.FunctionScopedDeclaration;
    }
    state.tokens[state.tokens.length - 1].identifierRole = identifierRole;
  }

// Parses lvalue (assignable) atom.
  function parseBindingAtom(isBlockScope) {
    switch (state.type) {
      case TokenType._this: {
        // In TypeScript, "this" may be the name of a parameter, so allow it.
        const oldIsType = pushTypeContext(0);
        next();
        popTypeContext(oldIsType);
        return;
      }

      case TokenType._yield:
      case TokenType.name: {
        state.type = TokenType.name;
        parseBindingIdentifier(isBlockScope);
        return;
      }

      case TokenType.bracketL: {
        next();
        parseBindingList(TokenType.bracketR, isBlockScope, true /* allowEmpty */);
        return;
      }

      case TokenType.braceL:
        parseObj(true, isBlockScope);
        return;

      default:
        unexpected();
    }
  }

  function parseBindingList(
    close,
    isBlockScope,
    allowEmpty = false,
    allowModifiers = false,
    contextId = 0,
  ) {
    let first = true;

    let hasRemovedComma = false;
    const firstItemTokenIndex = state.tokens.length;

    while (!eat(close) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        state.tokens[state.tokens.length - 1].contextId = contextId;
        // After a "this" type in TypeScript, we need to set the following comma (if any) to also be
        // a type token so that it will be removed.
        if (!hasRemovedComma && state.tokens[firstItemTokenIndex].isType) {
          state.tokens[state.tokens.length - 1].isType = true;
          hasRemovedComma = true;
        }
      }
      if (allowEmpty && match(TokenType.comma)) ; else if (eat(close)) {
        break;
      } else if (match(TokenType.ellipsis)) {
        parseRest(isBlockScope);
        parseAssignableListItemTypes();
        // Support rest element trailing commas allowed by TypeScript <2.9.
        eat(TokenType.comma);
        expect(close);
        break;
      } else {
        parseAssignableListItem(allowModifiers, isBlockScope);
      }
    }
  }

  function parseAssignableListItem(allowModifiers, isBlockScope) {
    if (allowModifiers) {
      tsParseModifiers([
        ContextualKeyword._public,
        ContextualKeyword._protected,
        ContextualKeyword._private,
        ContextualKeyword._readonly,
        ContextualKeyword._override,
      ]);
    }

    parseMaybeDefault(isBlockScope);
    parseAssignableListItemTypes();
    parseMaybeDefault(isBlockScope, true /* leftAlreadyParsed */);
  }

  function parseAssignableListItemTypes() {
    {
      tsParseAssignableListItemTypes();
    }
  }

// Parses assignment pattern around given atom if possible.
  function parseMaybeDefault(isBlockScope, leftAlreadyParsed = false) {
    if (!leftAlreadyParsed) {
      parseBindingAtom(isBlockScope);
    }
    if (!eat(TokenType.eq)) {
      return;
    }
    const eqIndex = state.tokens.length - 1;
    parseMaybeAssign();
    state.tokens[eqIndex].rhsEndIndex = state.tokens.length;
  }

  function tsIsIdentifier() {
    // TODO: actually a bit more complex in TypeScript, but shouldn't matter.
    // See https://github.com/Microsoft/TypeScript/issues/15008
    return match(TokenType.name);
  }

  function isLiteralPropertyName() {
    return (
      match(TokenType.name) ||
      Boolean(state.type & TokenType.IS_KEYWORD) ||
      match(TokenType.string) ||
      match(TokenType.num) ||
      match(TokenType.bigint) ||
      match(TokenType.decimal)
    );
  }

  function tsNextTokenCanFollowModifier() {
    // Note: TypeScript's implementation is much more complicated because
    // more things are considered modifiers there.
    // This implementation only handles modifiers not handled by babylon itself. And "static".
    // TODO: Would be nice to avoid lookahead. Want a hasLineBreakUpNext() method...
    const snapshot = state.snapshot();

    next();
    const canFollowModifier =
      (match(TokenType.bracketL) ||
        match(TokenType.braceL) ||
        match(TokenType.star) ||
        match(TokenType.ellipsis) ||
        match(TokenType.hash) ||
        isLiteralPropertyName()) &&
      !hasPrecedingLineBreak();

    if (canFollowModifier) {
      return true;
    } else {
      state.restoreFromSnapshot(snapshot);
      return false;
    }
  }

  function tsParseModifiers(allowedModifiers) {
    while (true) {
      const modifier = tsParseModifier(allowedModifiers);
      if (modifier === null) {
        break;
      }
    }
  }

  /** Parses a modifier matching one the given modifier names. */
  function tsParseModifier(
    allowedModifiers,
  ) {
    if (!match(TokenType.name)) {
      return null;
    }

    const modifier = state.contextualKeyword;
    if (allowedModifiers.indexOf(modifier) !== -1 && tsNextTokenCanFollowModifier()) {
      switch (modifier) {
        case ContextualKeyword._readonly:
          state.tokens[state.tokens.length - 1].type = TokenType._readonly;
          break;
        case ContextualKeyword._abstract:
          state.tokens[state.tokens.length - 1].type = TokenType._abstract;
          break;
        case ContextualKeyword._static:
          state.tokens[state.tokens.length - 1].type = TokenType._static;
          break;
        case ContextualKeyword._public:
          state.tokens[state.tokens.length - 1].type = TokenType._public;
          break;
        case ContextualKeyword._private:
          state.tokens[state.tokens.length - 1].type = TokenType._private;
          break;
        case ContextualKeyword._protected:
          state.tokens[state.tokens.length - 1].type = TokenType._protected;
          break;
        case ContextualKeyword._override:
          state.tokens[state.tokens.length - 1].type = TokenType._override;
          break;
        case ContextualKeyword._declare:
          state.tokens[state.tokens.length - 1].type = TokenType._declare;
          break;
      }
      return modifier;
    }
    return null;
  }

  function tsParseEntityName() {
    parseIdentifier();
    while (eat(TokenType.dot)) {
      parseIdentifier();
    }
  }

  function tsParseTypeReference() {
    tsParseEntityName();
    if (!hasPrecedingLineBreak() && match(TokenType.lessThan)) {
      tsParseTypeArguments();
    }
  }

  function tsParseThisTypePredicate() {
    next();
    tsParseTypeAnnotation();
  }

  function tsParseThisTypeNode() {
    next();
  }

  function tsParseTypeQuery() {
    expect(TokenType._typeof);
    if (match(TokenType._import)) {
      tsParseImportType();
    } else {
      tsParseEntityName();
    }
  }

  function tsParseImportType() {
    expect(TokenType._import);
    expect(TokenType.parenL);
    expect(TokenType.string);
    expect(TokenType.parenR);
    if (eat(TokenType.dot)) {
      tsParseEntityName();
    }
    if (match(TokenType.lessThan)) {
      tsParseTypeArguments();
    }
  }

  function tsParseTypeParameter() {
    parseIdentifier();
    if (eat(TokenType._extends)) {
      tsParseType();
    }
    if (eat(TokenType.eq)) {
      tsParseType();
    }
  }

  function tsTryParseTypeParameters() {
    if (match(TokenType.lessThan)) {
      tsParseTypeParameters();
    }
  }

  function tsParseTypeParameters() {
    const oldIsType = pushTypeContext(0);
    if (match(TokenType.lessThan) || match(TokenType.typeParameterStart)) {
      next();
    } else {
      unexpected();
    }

    while (!eat(TokenType.greaterThan) && !state.error) {
      tsParseTypeParameter();
      eat(TokenType.comma);
    }
    popTypeContext(oldIsType);
  }

// Note: In TypeScript implementation we must provide `yieldContext` and `awaitContext`,
// but here it's always false, because this is only used for types.
  function tsFillSignature(returnToken) {
    // Arrow fns *must* have return token (`=>`). Normal functions can omit it.
    const returnTokenRequired = returnToken === TokenType.arrow;
    tsTryParseTypeParameters();
    expect(TokenType.parenL);
    // Create a scope even though we're doing type parsing so we don't accidentally
    // treat params as top-level bindings.
    state.scopeDepth++;
    tsParseBindingListForSignature(false /* isBlockScope */);
    state.scopeDepth--;
    if (returnTokenRequired) {
      tsParseTypeOrTypePredicateAnnotation(returnToken);
    } else if (match(returnToken)) {
      tsParseTypeOrTypePredicateAnnotation(returnToken);
    }
  }

  function tsParseBindingListForSignature(isBlockScope) {
    parseBindingList(TokenType.parenR, isBlockScope);
  }

  function tsParseTypeMemberSemicolon() {
    if (!eat(TokenType.comma)) {
      semicolon();
    }
  }

  function tsParseSignatureMember() {
    tsFillSignature(TokenType.colon);
    tsParseTypeMemberSemicolon();
  }

  function tsIsUnambiguouslyIndexSignature() {
    const snapshot = state.snapshot();
    next(); // Skip '{'
    const isIndexSignature = eat(TokenType.name) && match(TokenType.colon);
    state.restoreFromSnapshot(snapshot);
    return isIndexSignature;
  }

  function tsTryParseIndexSignature() {
    if (!(match(TokenType.bracketL) && tsIsUnambiguouslyIndexSignature())) {
      return false;
    }

    const oldIsType = pushTypeContext(0);

    expect(TokenType.bracketL);
    parseIdentifier();
    tsParseTypeAnnotation();
    expect(TokenType.bracketR);

    tsTryParseTypeAnnotation();
    tsParseTypeMemberSemicolon();

    popTypeContext(oldIsType);
    return true;
  }

  function tsParsePropertyOrMethodSignature(isReadonly) {
    eat(TokenType.question);

    if (!isReadonly && (match(TokenType.parenL) || match(TokenType.lessThan))) {
      tsFillSignature(TokenType.colon);
      tsParseTypeMemberSemicolon();
    } else {
      tsTryParseTypeAnnotation();
      tsParseTypeMemberSemicolon();
    }
  }

  function tsParseTypeMember() {
    if (match(TokenType.parenL) || match(TokenType.lessThan)) {
      // call signature
      tsParseSignatureMember();
      return;
    }
    if (match(TokenType._new)) {
      next();
      if (match(TokenType.parenL) || match(TokenType.lessThan)) {
        // constructor signature
        tsParseSignatureMember();
      } else {
        tsParsePropertyOrMethodSignature(false);
      }
      return;
    }
    const readonly = !!tsParseModifier([ContextualKeyword._readonly]);

    const found = tsTryParseIndexSignature();
    if (found) {
      return;
    }
    if (
      (isContextual(ContextualKeyword._get) || isContextual(ContextualKeyword._set)) &&
      tsNextTokenCanFollowModifier()
    ) ;
    parsePropertyName(-1 /* Types don't need context IDs. */);
    tsParsePropertyOrMethodSignature(readonly);
  }

  function tsParseTypeLiteral() {
    tsParseObjectTypeMembers();
  }

  function tsParseObjectTypeMembers() {
    expect(TokenType.braceL);
    while (!eat(TokenType.braceR) && !state.error) {
      tsParseTypeMember();
    }
  }

  function tsLookaheadIsStartOfMappedType() {
    const snapshot = state.snapshot();
    const isStartOfMappedType = tsIsStartOfMappedType();
    state.restoreFromSnapshot(snapshot);
    return isStartOfMappedType;
  }

  function tsIsStartOfMappedType() {
    next();
    if (eat(TokenType.plus) || eat(TokenType.minus)) {
      return isContextual(ContextualKeyword._readonly);
    }
    if (isContextual(ContextualKeyword._readonly)) {
      next();
    }
    if (!match(TokenType.bracketL)) {
      return false;
    }
    next();
    if (!tsIsIdentifier()) {
      return false;
    }
    next();
    return match(TokenType._in);
  }

  function tsParseMappedTypeParameter() {
    parseIdentifier();
    expect(TokenType._in);
    tsParseType();
  }

  function tsParseMappedType() {
    expect(TokenType.braceL);
    if (match(TokenType.plus) || match(TokenType.minus)) {
      next();
      expectContextual(ContextualKeyword._readonly);
    } else {
      eatContextual(ContextualKeyword._readonly);
    }
    expect(TokenType.bracketL);
    tsParseMappedTypeParameter();
    if (eatContextual(ContextualKeyword._as)) {
      tsParseType();
    }
    expect(TokenType.bracketR);
    if (match(TokenType.plus) || match(TokenType.minus)) {
      next();
      expect(TokenType.question);
    } else {
      eat(TokenType.question);
    }
    tsTryParseType();
    semicolon();
    expect(TokenType.braceR);
  }

  function tsParseTupleType() {
    expect(TokenType.bracketL);
    while (!eat(TokenType.bracketR) && !state.error) {
      // Do not validate presence of either none or only labeled elements
      tsParseTupleElementType();
      eat(TokenType.comma);
    }
  }

  function tsParseTupleElementType() {
    // parses `...TsType[]`
    if (eat(TokenType.ellipsis)) {
      tsParseType();
    } else {
      // parses `TsType?`
      tsParseType();
      eat(TokenType.question);
    }

    // The type we parsed above was actually a label
    if (eat(TokenType.colon)) {
      // Labeled tuple types must affix the label with `...` or `?`, so no need to handle those here
      tsParseType();
    }
  }

  function tsParseParenthesizedType() {
    expect(TokenType.parenL);
    tsParseType();
    expect(TokenType.parenR);
  }

  function tsParseTemplateLiteralType() {
    // Finish `, read quasi
    nextTemplateToken();
    // Finish quasi, read ${
    nextTemplateToken();
    while (!match(TokenType.backQuote) && !state.error) {
      expect(TokenType.dollarBraceL);
      tsParseType();
      // Finish }, read quasi
      nextTemplateToken();
      // Finish quasi, read either ${ or `
      nextTemplateToken();
    }
    next();
  }

  var FunctionType; (function (FunctionType) {
    const TSFunctionType = 0; FunctionType[FunctionType["TSFunctionType"] = TSFunctionType] = "TSFunctionType";
    const TSConstructorType = TSFunctionType + 1; FunctionType[FunctionType["TSConstructorType"] = TSConstructorType] = "TSConstructorType";
    const TSAbstractConstructorType = TSConstructorType + 1; FunctionType[FunctionType["TSAbstractConstructorType"] = TSAbstractConstructorType] = "TSAbstractConstructorType";
  })(FunctionType || (FunctionType = {}));

  function tsParseFunctionOrConstructorType(type) {
    if (type === FunctionType.TSAbstractConstructorType) {
      expectContextual(ContextualKeyword._abstract);
    }
    if (type === FunctionType.TSConstructorType || type === FunctionType.TSAbstractConstructorType) {
      expect(TokenType._new);
    }
    tsFillSignature(TokenType.arrow);
  }

  function tsParseNonArrayType() {
    switch (state.type) {
      case TokenType.name:
        tsParseTypeReference();
        return;
      case TokenType._void:
      case TokenType._null:
        next();
        return;
      case TokenType.string:
      case TokenType.num:
      case TokenType.bigint:
      case TokenType.decimal:
      case TokenType._true:
      case TokenType._false:
        parseLiteral();
        return;
      case TokenType.minus:
        next();
        parseLiteral();
        return;
      case TokenType._this: {
        tsParseThisTypeNode();
        if (isContextual(ContextualKeyword._is) && !hasPrecedingLineBreak()) {
          tsParseThisTypePredicate();
        }
        return;
      }
      case TokenType._typeof:
        tsParseTypeQuery();
        return;
      case TokenType._import:
        tsParseImportType();
        return;
      case TokenType.braceL:
        if (tsLookaheadIsStartOfMappedType()) {
          tsParseMappedType();
        } else {
          tsParseTypeLiteral();
        }
        return;
      case TokenType.bracketL:
        tsParseTupleType();
        return;
      case TokenType.parenL:
        tsParseParenthesizedType();
        return;
      case TokenType.backQuote:
        tsParseTemplateLiteralType();
        return;
      default:
        if (state.type & TokenType.IS_KEYWORD) {
          next();
          state.tokens[state.tokens.length - 1].type = TokenType.name;
          return;
        }
        break;
    }

    unexpected();
  }

  function tsParseArrayTypeOrHigher() {
    tsParseNonArrayType();
    while (!hasPrecedingLineBreak() && eat(TokenType.bracketL)) {
      if (!eat(TokenType.bracketR)) {
        // If we hit ] immediately, this is an array type, otherwise it's an indexed access type.
        tsParseType();
        expect(TokenType.bracketR);
      }
    }
  }

  function tsParseInferType() {
    expectContextual(ContextualKeyword._infer);
    parseIdentifier();
  }

  function tsParseTypeOperatorOrHigher() {
    if (
      isContextual(ContextualKeyword._keyof) ||
      isContextual(ContextualKeyword._unique) ||
      isContextual(ContextualKeyword._readonly)
    ) {
      next();
      tsParseTypeOperatorOrHigher();
    } else if (isContextual(ContextualKeyword._infer)) {
      tsParseInferType();
    } else {
      tsParseArrayTypeOrHigher();
    }
  }

  function tsParseIntersectionTypeOrHigher() {
    eat(TokenType.bitwiseAND);
    tsParseTypeOperatorOrHigher();
    if (match(TokenType.bitwiseAND)) {
      while (eat(TokenType.bitwiseAND)) {
        tsParseTypeOperatorOrHigher();
      }
    }
  }

  function tsParseUnionTypeOrHigher() {
    eat(TokenType.bitwiseOR);
    tsParseIntersectionTypeOrHigher();
    if (match(TokenType.bitwiseOR)) {
      while (eat(TokenType.bitwiseOR)) {
        tsParseIntersectionTypeOrHigher();
      }
    }
  }

  function tsIsStartOfFunctionType() {
    if (match(TokenType.lessThan)) {
      return true;
    }
    return match(TokenType.parenL) && tsLookaheadIsUnambiguouslyStartOfFunctionType();
  }

  function tsSkipParameterStart() {
    if (match(TokenType.name) || match(TokenType._this)) {
      next();
      return true;
    }
    // If this is a possible array/object destructure, walk to the matching bracket/brace.
    // The next token after will tell us definitively whether this is a function param.
    if (match(TokenType.braceL) || match(TokenType.bracketL)) {
      let depth = 1;
      next();
      while (depth > 0 && !state.error) {
        if (match(TokenType.braceL) || match(TokenType.bracketL)) {
          depth++;
        } else if (match(TokenType.braceR) || match(TokenType.bracketR)) {
          depth--;
        }
        next();
      }
      return true;
    }
    return false;
  }

  function tsLookaheadIsUnambiguouslyStartOfFunctionType() {
    const snapshot = state.snapshot();
    const isUnambiguouslyStartOfFunctionType = tsIsUnambiguouslyStartOfFunctionType();
    state.restoreFromSnapshot(snapshot);
    return isUnambiguouslyStartOfFunctionType;
  }

  function tsIsUnambiguouslyStartOfFunctionType() {
    next();
    if (match(TokenType.parenR) || match(TokenType.ellipsis)) {
      // ( )
      // ( ...
      return true;
    }
    if (tsSkipParameterStart()) {
      if (match(TokenType.colon) || match(TokenType.comma) || match(TokenType.question) || match(TokenType.eq)) {
        // ( xxx :
        // ( xxx ,
        // ( xxx ?
        // ( xxx =
        return true;
      }
      if (match(TokenType.parenR)) {
        next();
        if (match(TokenType.arrow)) {
          // ( xxx ) =>
          return true;
        }
      }
    }
    return false;
  }

  function tsParseTypeOrTypePredicateAnnotation(returnToken) {
    const oldIsType = pushTypeContext(0);
    expect(returnToken);
    const finishedReturn = tsParseTypePredicateOrAssertsPrefix();
    if (!finishedReturn) {
      tsParseType();
    }
    popTypeContext(oldIsType);
  }

  function tsTryParseTypeOrTypePredicateAnnotation() {
    if (match(TokenType.colon)) {
      tsParseTypeOrTypePredicateAnnotation(TokenType.colon);
    }
  }

  function tsTryParseTypeAnnotation() {
    if (match(TokenType.colon)) {
      tsParseTypeAnnotation();
    }
  }

  function tsTryParseType() {
    if (eat(TokenType.colon)) {
      tsParseType();
    }
  }

  /**
   * Detect a few special return syntax cases: `x is T`, `asserts x`, `asserts x is T`,
   * `asserts this is T`.
   *
   * Returns true if we parsed the return type, false if there's still a type to be parsed.
   */
  function tsParseTypePredicateOrAssertsPrefix() {
    const snapshot = state.snapshot();
    if (isContextual(ContextualKeyword._asserts) && !hasPrecedingLineBreak()) {
      // Normally this is `asserts x is T`, but at this point, it might be `asserts is T` (a user-
      // defined type guard on the `asserts` variable) or just a type called `asserts`.
      next();
      if (eatContextual(ContextualKeyword._is)) {
        // If we see `asserts is`, then this must be of the form `asserts is T`, since
        // `asserts is is T` isn't valid.
        tsParseType();
        return true;
      } else if (tsIsIdentifier() || match(TokenType._this)) {
        next();
        if (eatContextual(ContextualKeyword._is)) {
          // If we see `is`, then this is `asserts x is T`. Otherwise, it's `asserts x`.
          tsParseType();
        }
        return true;
      } else {
        // Regular type, so bail out and start type parsing from scratch.
        state.restoreFromSnapshot(snapshot);
        return false;
      }
    } else if (tsIsIdentifier() || match(TokenType._this)) {
      // This is a regular identifier, which may or may not have "is" after it.
      next();
      if (isContextual(ContextualKeyword._is) && !hasPrecedingLineBreak()) {
        next();
        tsParseType();
        return true;
      } else {
        // Regular type, so bail out and start type parsing from scratch.
        state.restoreFromSnapshot(snapshot);
        return false;
      }
    }
    return false;
  }

  function tsParseTypeAnnotation() {
    const oldIsType = pushTypeContext(0);
    expect(TokenType.colon);
    tsParseType();
    popTypeContext(oldIsType);
  }

  function tsParseType() {
    tsParseNonConditionalType();
    if (hasPrecedingLineBreak() || !eat(TokenType._extends)) {
      return;
    }
    // extends type
    tsParseNonConditionalType();
    expect(TokenType.question);
    // true type
    tsParseType();
    expect(TokenType.colon);
    // false type
    tsParseType();
  }

  function isAbstractConstructorSignature() {
    return isContextual(ContextualKeyword._abstract) && lookaheadType() === TokenType._new;
  }

  function tsParseNonConditionalType() {
    if (tsIsStartOfFunctionType()) {
      tsParseFunctionOrConstructorType(FunctionType.TSFunctionType);
      return;
    }
    if (match(TokenType._new)) {
      // As in `new () => Date`
      tsParseFunctionOrConstructorType(FunctionType.TSConstructorType);
      return;
    } else if (isAbstractConstructorSignature()) {
      // As in `abstract new () => Date`
      tsParseFunctionOrConstructorType(FunctionType.TSAbstractConstructorType);
      return;
    }
    tsParseUnionTypeOrHigher();
  }

  function tsParseTypeAssertion() {
    const oldIsType = pushTypeContext(1);
    tsParseType();
    expect(TokenType.greaterThan);
    popTypeContext(oldIsType);
    parseMaybeUnary();
  }

  function tsParseHeritageClause() {
    while (!match(TokenType.braceL) && !state.error) {
      tsParseExpressionWithTypeArguments();
      eat(TokenType.comma);
    }
  }

  function tsParseExpressionWithTypeArguments() {
    // Note: TS uses parseLeftHandSideExpressionOrHigher,
    // then has grammar errors later if it's not an EntityName.
    tsParseEntityName();
    if (match(TokenType.lessThan)) {
      tsParseTypeArguments();
    }
  }

  function tsParseInterfaceDeclaration() {
    parseBindingIdentifier(false);
    tsTryParseTypeParameters();
    if (eat(TokenType._extends)) {
      tsParseHeritageClause();
    }
    tsParseObjectTypeMembers();
  }

  function tsParseTypeAliasDeclaration() {
    parseBindingIdentifier(false);
    tsTryParseTypeParameters();
    expect(TokenType.eq);
    tsParseType();
    semicolon();
  }

  function tsParseEnumMember() {
    // Computed property names are grammar errors in an enum, so accept just string literal or identifier.
    if (match(TokenType.string)) {
      parseLiteral();
    } else {
      parseIdentifier();
    }
    if (eat(TokenType.eq)) {
      const eqIndex = state.tokens.length - 1;
      parseMaybeAssign();
      state.tokens[eqIndex].rhsEndIndex = state.tokens.length;
    }
  }

  function tsParseEnumDeclaration() {
    parseBindingIdentifier(false);
    expect(TokenType.braceL);
    while (!eat(TokenType.braceR) && !state.error) {
      tsParseEnumMember();
      eat(TokenType.comma);
    }
  }

  function tsParseModuleBlock() {
    expect(TokenType.braceL);
    parseBlockBody(/* end */ TokenType.braceR);
  }

  function tsParseModuleOrNamespaceDeclaration() {
    parseBindingIdentifier(false);
    if (eat(TokenType.dot)) {
      tsParseModuleOrNamespaceDeclaration();
    } else {
      tsParseModuleBlock();
    }
  }

  function tsParseAmbientExternalModuleDeclaration() {
    if (isContextual(ContextualKeyword._global)) {
      parseIdentifier();
    } else if (match(TokenType.string)) {
      parseExprAtom();
    } else {
      unexpected();
    }

    if (match(TokenType.braceL)) {
      tsParseModuleBlock();
    } else {
      semicolon();
    }
  }

  function tsParseImportEqualsDeclaration() {
    parseImportedIdentifier();
    expect(TokenType.eq);
    tsParseModuleReference();
    semicolon();
  }

  function tsIsExternalModuleReference() {
    return isContextual(ContextualKeyword._require) && lookaheadType() === TokenType.parenL;
  }

  function tsParseModuleReference() {
    if (tsIsExternalModuleReference()) {
      tsParseExternalModuleReference();
    } else {
      tsParseEntityName();
    }
  }

  function tsParseExternalModuleReference() {
    expectContextual(ContextualKeyword._require);
    expect(TokenType.parenL);
    if (!match(TokenType.string)) {
      unexpected();
    }
    parseLiteral();
    expect(TokenType.parenR);
  }

// Utilities

// Returns true if a statement matched.
  function tsTryParseDeclare() {
    if (isLineTerminator()) {
      return false;
    }
    switch (state.type) {
      case TokenType._function: {
        const oldIsType = pushTypeContext(1);
        next();
        // We don't need to precisely get the function start here, since it's only used to mark
        // the function as a type if it's bodiless, and it's already a type here.
        const functionStart = state.start;
        parseFunction(functionStart, /* isStatement */ true);
        popTypeContext(oldIsType);
        return true;
      }
      case TokenType._class: {
        const oldIsType = pushTypeContext(1);
        parseClass(/* isStatement */ true, /* optionalId */ false);
        popTypeContext(oldIsType);
        return true;
      }
      case TokenType._const: {
        if (match(TokenType._const) && isLookaheadContextual(ContextualKeyword._enum)) {
          const oldIsType = pushTypeContext(1);
          // `const enum = 0;` not allowed because "enum" is a strict mode reserved word.
          expect(TokenType._const);
          expectContextual(ContextualKeyword._enum);
          state.tokens[state.tokens.length - 1].type = TokenType._enum;
          tsParseEnumDeclaration();
          popTypeContext(oldIsType);
          return true;
        }
      }
      // falls through
      case TokenType._var:
      case TokenType._let: {
        const oldIsType = pushTypeContext(1);
        parseVarStatement(state.type);
        popTypeContext(oldIsType);
        return true;
      }
      case TokenType.name: {
        const oldIsType = pushTypeContext(1);
        const contextualKeyword = state.contextualKeyword;
        let matched = false;
        if (contextualKeyword === ContextualKeyword._global) {
          tsParseAmbientExternalModuleDeclaration();
          matched = true;
        } else {
          matched = tsParseDeclaration(contextualKeyword, /* isBeforeToken */ true);
        }
        popTypeContext(oldIsType);
        return matched;
      }
      default:
        return false;
    }
  }

// Note: this won't be called unless the keyword is allowed in `shouldParseExportDeclaration`.
// Returns true if it matched a declaration.
  function tsTryParseExportDeclaration() {
    return tsParseDeclaration(state.contextualKeyword, /* isBeforeToken */ true);
  }

// Returns true if it matched a statement.
  function tsParseExpressionStatement(contextualKeyword) {
    switch (contextualKeyword) {
      case ContextualKeyword._declare: {
        const declareTokenIndex = state.tokens.length - 1;
        const matched = tsTryParseDeclare();
        if (matched) {
          state.tokens[declareTokenIndex].type = TokenType._declare;
          return true;
        }
        break;
      }
      case ContextualKeyword._global:
        // `global { }` (with no `declare`) may appear inside an ambient module declaration.
        // Would like to use tsParseAmbientExternalModuleDeclaration here, but already ran past "global".
        if (match(TokenType.braceL)) {
          tsParseModuleBlock();
          return true;
        }
        break;

      default:
        return tsParseDeclaration(contextualKeyword, /* isBeforeToken */ false);
    }
    return false;
  }

  /**
   * Common code for parsing a declaration.
   *
   * isBeforeToken indicates that the current parser state is at the contextual
   * keyword (and that it is not yet emitted) rather than reading the token after
   * it. When isBeforeToken is true, we may be preceded by an `export` token and
   * should include that token in a type context we create, e.g. to handle
   * `export interface` or `export type`. (This is a bit of a hack and should be
   * cleaned up at some point.)
   *
   * Returns true if it matched a declaration.
   */
  function tsParseDeclaration(contextualKeyword, isBeforeToken) {
    switch (contextualKeyword) {
      case ContextualKeyword._abstract:
        if (tsCheckLineTerminator(isBeforeToken) && match(TokenType._class)) {
          state.tokens[state.tokens.length - 1].type = TokenType._abstract;
          parseClass(/* isStatement */ true, /* optionalId */ false);
          return true;
        }
        break;

      case ContextualKeyword._enum:
        if (tsCheckLineTerminator(isBeforeToken) && match(TokenType.name)) {
          state.tokens[state.tokens.length - 1].type = TokenType._enum;
          tsParseEnumDeclaration();
          return true;
        }
        break;

      case ContextualKeyword._interface:
        if (tsCheckLineTerminator(isBeforeToken) && match(TokenType.name)) {
          // `next` is true in "export" and "declare" contexts, so we want to remove that token
          // as well.
          const oldIsType = pushTypeContext(isBeforeToken ? 2 : 1);
          tsParseInterfaceDeclaration();
          popTypeContext(oldIsType);
          return true;
        }
        break;

      case ContextualKeyword._module:
        if (tsCheckLineTerminator(isBeforeToken)) {
          if (match(TokenType.string)) {
            const oldIsType = pushTypeContext(isBeforeToken ? 2 : 1);
            tsParseAmbientExternalModuleDeclaration();
            popTypeContext(oldIsType);
            return true;
          } else if (match(TokenType.name)) {
            const oldIsType = pushTypeContext(isBeforeToken ? 2 : 1);
            tsParseModuleOrNamespaceDeclaration();
            popTypeContext(oldIsType);
            return true;
          }
        }
        break;

      case ContextualKeyword._namespace:
        if (tsCheckLineTerminator(isBeforeToken) && match(TokenType.name)) {
          const oldIsType = pushTypeContext(isBeforeToken ? 2 : 1);
          tsParseModuleOrNamespaceDeclaration();
          popTypeContext(oldIsType);
          return true;
        }
        break;

      case ContextualKeyword._type:
        if (tsCheckLineTerminator(isBeforeToken) && match(TokenType.name)) {
          const oldIsType = pushTypeContext(isBeforeToken ? 2 : 1);
          tsParseTypeAliasDeclaration();
          popTypeContext(oldIsType);
          return true;
        }
        break;
    }
    return false;
  }

  function tsCheckLineTerminator(isBeforeToken) {
    if (isBeforeToken) {
      // Babel checks hasFollowingLineBreak here and returns false, but this
      // doesn't actually come up, e.g. `export interface` can never be on its own
      // line in valid code.
      next();
      return true;
    } else {
      return !isLineTerminator();
    }
  }

// Returns true if there was a generic async arrow function.
  function tsTryParseGenericAsyncArrowFunction() {
    const snapshot = state.snapshot();

    tsParseTypeParameters();
    parseFunctionParams();
    tsTryParseTypeOrTypePredicateAnnotation();
    expect(TokenType.arrow);

    if (state.error) {
      state.restoreFromSnapshot(snapshot);
      return false;
    }

    parseFunctionBody(true);
    return true;
  }

  function tsParseTypeArguments() {
    const oldIsType = pushTypeContext(0);
    expect(TokenType.lessThan);
    while (!eat(TokenType.greaterThan) && !state.error) {
      tsParseType();
      eat(TokenType.comma);
    }
    popTypeContext(oldIsType);
  }

  function tsIsDeclarationStart() {
    if (match(TokenType.name)) {
      switch (state.contextualKeyword) {
        case ContextualKeyword._abstract:
        case ContextualKeyword._declare:
        case ContextualKeyword._enum:
        case ContextualKeyword._interface:
        case ContextualKeyword._module:
        case ContextualKeyword._namespace:
        case ContextualKeyword._type:
          return true;
      }
    }

    return false;
  }

// ======================================================
// OVERRIDES
// ======================================================

  function tsParseFunctionBodyAndFinish(functionStart, funcContextId) {
    // For arrow functions, `parseArrow` handles the return type itself.
    if (match(TokenType.colon)) {
      tsParseTypeOrTypePredicateAnnotation(TokenType.colon);
    }

    // The original code checked the node type to make sure this function type allows a missing
    // body, but we skip that to avoid sending around the node type. We instead just use the
    // allowExpressionBody boolean to make sure it's not an arrow function.
    if (!match(TokenType.braceL) && isLineTerminator()) {
      // Retroactively mark the function declaration as a type.
      let i = state.tokens.length - 1;
      while (
        i >= 0 &&
        (state.tokens[i].start >= functionStart ||
          state.tokens[i].type === TokenType._default ||
          state.tokens[i].type === TokenType._export)
        ) {
        state.tokens[i].isType = true;
        i--;
      }
      return;
    }

    parseFunctionBody(false, funcContextId);
  }

  function tsParseSubscript(
    startTokenIndex,
    noCalls,
    stopState,
  ) {
    if (!hasPrecedingLineBreak() && eat(TokenType.bang)) {
      state.tokens[state.tokens.length - 1].type = TokenType.nonNullAssertion;
      return;
    }

    if (match(TokenType.lessThan)) {
      // There are number of things we are going to "maybe" parse, like type arguments on
      // tagged template expressions. If any of them fail, walk it back and continue.
      const snapshot = state.snapshot();

      if (!noCalls && atPossibleAsync()) {
        // Almost certainly this is a generic async function `async <T>() => ...
        // But it might be a call with a type argument `async<T>();`
        const asyncArrowFn = tsTryParseGenericAsyncArrowFunction();
        if (asyncArrowFn) {
          return;
        }
      }
      tsParseTypeArguments();
      if (!noCalls && eat(TokenType.parenL)) {
        // With f<T>(), the subscriptStartIndex marker is on the ( token.
        state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;
        parseCallExpressionArguments();
      } else if (match(TokenType.backQuote)) {
        // Tagged template with a type argument.
        parseTemplate();
      } else {
        unexpected();
      }

      if (state.error) {
        state.restoreFromSnapshot(snapshot);
      } else {
        return;
      }
    } else if (!noCalls && match(TokenType.questionDot) && lookaheadType() === TokenType.lessThan) {
      // If we see f?.<, then this must be an optional call with a type argument.
      next();
      state.tokens[startTokenIndex].isOptionalChainStart = true;
      // With f?.<T>(), the subscriptStartIndex marker is on the ?. token.
      state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;

      tsParseTypeArguments();
      expect(TokenType.parenL);
      parseCallExpressionArguments();
    }
    baseParseSubscript(startTokenIndex, noCalls, stopState);
  }

  function tsStartParseNewArguments() {
    if (match(TokenType.lessThan)) {
      // 99% certain this is `new C<T>();`. But may be `new C < T;`, which is also legal.
      const snapshot = state.snapshot();

      state.type = TokenType.typeParameterStart;
      tsParseTypeArguments();
      if (!match(TokenType.parenL)) {
        unexpected();
      }

      if (state.error) {
        state.restoreFromSnapshot(snapshot);
      }
    }
  }

  function tsTryParseExport() {
    if (eat(TokenType._import)) {
      // One of these cases:
      // export import A = B;
      // export import type A = require("A");
      if (isContextual(ContextualKeyword._type) && lookaheadType() !== TokenType.eq) {
        // Eat a `type` token, unless it's actually an identifier name.
        expectContextual(ContextualKeyword._type);
      }
      tsParseImportEqualsDeclaration();
      return true;
    } else if (eat(TokenType.eq)) {
      // `export = x;`
      parseExpression();
      semicolon();
      return true;
    } else if (eatContextual(ContextualKeyword._as)) {
      // `export as namespace A;`
      // See `parseNamespaceExportDeclaration` in TypeScript's own parser
      expectContextual(ContextualKeyword._namespace);
      parseIdentifier();
      semicolon();
      return true;
    } else {
      if (isContextual(ContextualKeyword._type) && lookaheadType() === TokenType.braceL) {
        next();
      }
      return false;
    }
  }

  function tsTryParseExportDefaultExpression() {
    if (isContextual(ContextualKeyword._abstract) && lookaheadType() === TokenType._class) {
      state.type = TokenType._abstract;
      next(); // Skip "abstract"
      parseClass(true, true);
      return true;
    }
    if (isContextual(ContextualKeyword._interface)) {
      // Make sure "export default" are considered type tokens so the whole thing is removed.
      const oldIsType = pushTypeContext(2);
      tsParseDeclaration(ContextualKeyword._interface, true);
      popTypeContext(oldIsType);
      return true;
    }
    return false;
  }

  function tsTryParseStatementContent() {
    if (state.type === TokenType._const) {
      const ahead = lookaheadTypeAndKeyword();
      if (ahead.type === TokenType.name && ahead.contextualKeyword === ContextualKeyword._enum) {
        expect(TokenType._const);
        expectContextual(ContextualKeyword._enum);
        state.tokens[state.tokens.length - 1].type = TokenType._enum;
        tsParseEnumDeclaration();
        return true;
      }
    }
    return false;
  }

  function tsTryParseClassMemberWithIsStatic(isStatic) {
    const memberStartIndexAfterStatic = state.tokens.length;
    tsParseModifiers([
      ContextualKeyword._abstract,
      ContextualKeyword._readonly,
      ContextualKeyword._declare,
      ContextualKeyword._static,
      ContextualKeyword._override,
    ]);

    const modifiersEndIndex = state.tokens.length;
    const found = tsTryParseIndexSignature();
    if (found) {
      // Index signatures are type declarations, so set the modifier tokens as
      // type tokens. Most tokens could be assumed to be type tokens, but `static`
      // is ambiguous unless we set it explicitly here.
      const memberStartIndex = isStatic
        ? memberStartIndexAfterStatic - 1
        : memberStartIndexAfterStatic;
      for (let i = memberStartIndex; i < modifiersEndIndex; i++) {
        state.tokens[i].isType = true;
      }
      return true;
    }
    return false;
  }

// Note: The reason we do this in `parseIdentifierStatement` and not `parseStatement`
// is that e.g. `type()` is valid JS, so we must try parsing that first.
// If it's really a type, we will parse `type` as the statement, and can correct it here
// by parsing the rest.
  function tsParseIdentifierStatement(contextualKeyword) {
    const matched = tsParseExpressionStatement(contextualKeyword);
    if (!matched) {
      semicolon();
    }
  }

  function tsParseExportDeclaration() {
    // "export declare" is equivalent to just "export".
    const isDeclare = eatContextual(ContextualKeyword._declare);
    if (isDeclare) {
      state.tokens[state.tokens.length - 1].type = TokenType._declare;
    }

    let matchedDeclaration = false;
    if (match(TokenType.name)) {
      if (isDeclare) {
        const oldIsType = pushTypeContext(2);
        matchedDeclaration = tsTryParseExportDeclaration();
        popTypeContext(oldIsType);
      } else {
        matchedDeclaration = tsTryParseExportDeclaration();
      }
    }
    if (!matchedDeclaration) {
      if (isDeclare) {
        const oldIsType = pushTypeContext(2);
        parseStatement(true);
        popTypeContext(oldIsType);
      } else {
        parseStatement(true);
      }
    }
  }

  function tsAfterParseClassSuper(hasSuper) {
    if (hasSuper && match(TokenType.lessThan)) {
      tsParseTypeArguments();
    }
    if (eatContextual(ContextualKeyword._implements)) {
      state.tokens[state.tokens.length - 1].type = TokenType._implements;
      const oldIsType = pushTypeContext(1);
      tsParseHeritageClause();
      popTypeContext(oldIsType);
    }
  }

  function tsStartParseObjPropValue() {
    tsTryParseTypeParameters();
  }

  function tsStartParseFunctionParams() {
    tsTryParseTypeParameters();
  }

// `let x: number;`
  function tsAfterParseVarHead() {
    const oldIsType = pushTypeContext(0);
    eat(TokenType.bang);
    tsTryParseTypeAnnotation();
    popTypeContext(oldIsType);
  }

// parse the return type of an async arrow function - let foo = (async (): number => {});
  function tsStartParseAsyncArrowFromCallExpression() {
    if (match(TokenType.colon)) {
      tsParseTypeAnnotation();
    }
  }

// Returns true if the expression was an arrow function.
  function tsParseMaybeAssign(noIn, isWithinParens) {
    // Note: When the JSX plugin is on, type assertions (`<T> x`) aren't valid syntax.
    {
      return tsParseMaybeAssignWithoutJSX(noIn, isWithinParens);
    }
  }

  function tsParseMaybeAssignWithoutJSX(noIn, isWithinParens) {
    if (!match(TokenType.lessThan)) {
      return baseParseMaybeAssign(noIn, isWithinParens);
    }

    const snapshot = state.snapshot();
    // This is similar to TypeScript's `tryParseParenthesizedArrowFunctionExpression`.
    tsParseTypeParameters();
    const wasArrow = baseParseMaybeAssign(noIn, isWithinParens);
    if (!wasArrow) {
      unexpected();
    }
    if (state.error) {
      state.restoreFromSnapshot(snapshot);
    } else {
      return wasArrow;
    }

    // Try parsing a type cast instead of an arrow function.
    // This will start with a type assertion (via parseMaybeUnary).
    // But don't directly call `tsParseTypeAssertion` because we want to handle any binary after it.
    return baseParseMaybeAssign(noIn, isWithinParens);
  }

  function tsParseArrow() {
    if (match(TokenType.colon)) {
      // This is different from how the TS parser does it.
      // TS uses lookahead. Babylon parses it as a parenthesized expression and converts.
      const snapshot = state.snapshot();

      tsParseTypeOrTypePredicateAnnotation(TokenType.colon);
      if (canInsertSemicolon()) unexpected();
      if (!match(TokenType.arrow)) unexpected();

      if (state.error) {
        state.restoreFromSnapshot(snapshot);
      }
    }
    return eat(TokenType.arrow);
  }

// Allow type annotations inside of a parameter list.
  function tsParseAssignableListItemTypes() {
    const oldIsType = pushTypeContext(0);
    eat(TokenType.question);
    tsTryParseTypeAnnotation();
    popTypeContext(oldIsType);
  }

  function tsParseMaybeDecoratorArguments() {
    if (match(TokenType.lessThan)) {
      tsParseTypeArguments();
    }
    baseParseMaybeDecoratorArguments();
  }

  /**
   * Common parser code for TypeScript and Flow.
   */

// An apparent conditional expression could actually be an optional parameter in an arrow function.
  function typedParseConditional(noIn) {
    // If we see ?:, this can't possibly be a valid conditional. typedParseParenItem will be called
    // later to finish off the arrow parameter. We also need to handle bare ? tokens for optional
    // parameters without type annotations, i.e. ?, and ?) .
    if (match(TokenType.question)) {
      const nextType = lookaheadType();
      if (nextType === TokenType.colon || nextType === TokenType.comma || nextType === TokenType.parenR) {
        return;
      }
    }
    baseParseConditional(noIn);
  }

// Note: These "type casts" are *not* valid TS expressions.
// But we parse them here and change them when completing the arrow function.
  function typedParseParenItem() {
    eatTypeToken(TokenType.question);
    if (match(TokenType.colon)) {
      {
        tsParseTypeAnnotation();
      }
    }
  }

  /* eslint max-len: 0 */
  const isJSXEnabled=false;

  class StopState {

    constructor(stop) {
      this.stop = stop;
    }
  }

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function (s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.
  function parseExpression(noIn = false) {
    parseMaybeAssign(noIn);
    if (match(TokenType.comma)) {
      while (eat(TokenType.comma)) {
        parseMaybeAssign(noIn);
      }
    }
  }

  /**
   * noIn is used when parsing a for loop so that we don't interpret a following "in" as the binary
   * operatior.
   * isWithinParens is used to indicate that we're parsing something that might be a comma expression
   * or might be an arrow function or might be a Flow type assertion (which requires explicit parens).
   * In these cases, we should allow : and ?: after the initial "left" part.
   */
  function parseMaybeAssign(noIn = false, isWithinParens = false) {
    {
      return tsParseMaybeAssign(noIn, isWithinParens);
    }
  }

// Parse an assignment expression. This includes applications of
// operators like `+=`.
// Returns true if the expression was an arrow function.
  function baseParseMaybeAssign(noIn, isWithinParens) {
    if (match(TokenType._yield)) {
      parseYield();
      return false;
    }

    if (match(TokenType.parenL) || match(TokenType.name) || match(TokenType._yield)) {
      state.potentialArrowAt = state.start;
    }

    const wasArrow = parseMaybeConditional(noIn);
    if (isWithinParens) {
      parseParenItem();
    }
    if (state.type & TokenType.IS_ASSIGN) {
      next();
      parseMaybeAssign(noIn);
      return false;
    }
    return wasArrow;
  }

// Parse a ternary conditional (`?:`) operator.
// Returns true if the expression was an arrow function.
  function parseMaybeConditional(noIn) {
    const wasArrow = parseExprOps(noIn);
    if (wasArrow) {
      return true;
    }
    parseConditional(noIn);
    return false;
  }

  function parseConditional(noIn) {
    {
      typedParseConditional(noIn);
    }
  }

  function baseParseConditional(noIn) {
    if (eat(TokenType.question)) {
      parseMaybeAssign();
      expect(TokenType.colon);
      parseMaybeAssign(noIn);
    }
  }

// Start the precedence parser.
// Returns true if this was an arrow function
  function parseExprOps(noIn) {
    const startTokenIndex = state.tokens.length;
    const wasArrow = parseMaybeUnary();
    if (wasArrow) {
      return true;
    }
    parseExprOp(startTokenIndex, -1, noIn);
    return false;
  }

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.
  function parseExprOp(startTokenIndex, minPrec, noIn) {
    if (
      (TokenType._in & TokenType.PRECEDENCE_MASK) > minPrec &&
      !hasPrecedingLineBreak() &&
      eatContextual(ContextualKeyword._as)
    ) {
      state.tokens[state.tokens.length - 1].type = TokenType._as;
      const oldIsType = pushTypeContext(1);
      tsParseType();
      popTypeContext(oldIsType);
      parseExprOp(startTokenIndex, minPrec, noIn);
      return;
    }

    const prec = state.type & TokenType.PRECEDENCE_MASK;
    if (prec > 0 && (!noIn || !match(TokenType._in))) {
      if (prec > minPrec) {
        const op = state.type;
        next();
        if (op === TokenType.nullishCoalescing) {
          state.tokens[state.tokens.length - 1].nullishStartIndex = startTokenIndex;
        }

        const rhsStartTokenIndex = state.tokens.length;
        parseMaybeUnary();
        // Extend the right operand of this operator if possible.
        parseExprOp(rhsStartTokenIndex, op & TokenType.IS_RIGHT_ASSOCIATIVE ? prec - 1 : prec, noIn);
        if (op === TokenType.nullishCoalescing) {
          state.tokens[startTokenIndex].numNullishCoalesceStarts++;
          state.tokens[state.tokens.length - 1].numNullishCoalesceEnds++;
        }
        // Continue with any future operator holding this expression as the left operand.
        parseExprOp(startTokenIndex, minPrec, noIn);
      }
    }
  }

// Parse unary operators, both prefix and postfix.
// Returns true if this was an arrow function.
  function parseMaybeUnary() {
    if (eat(TokenType.lessThan)) {
      tsParseTypeAssertion();
      return false;
    }
    if (
      isContextual(ContextualKeyword._module) &&
      lookaheadCharCode() === charCodes.leftCurlyBrace &&
      !hasFollowingLineBreak()
    ) {
      parseModuleExpression();
      return false;
    }
    if (state.type & TokenType.IS_PREFIX) {
      next();
      parseMaybeUnary();
      return false;
    }

    const wasArrow = parseExprSubscripts();
    if (wasArrow) {
      return true;
    }
    while (state.type & TokenType.IS_POSTFIX && !canInsertSemicolon()) {
      // The tokenizer calls everything a preincrement, so make it a postincrement when
      // we see it in that context.
      if (state.type === TokenType.preIncDec) {
        state.type = TokenType.postIncDec;
      }
      next();
    }
    return false;
  }

// Parse call, dot, and `[]`-subscript expressions.
// Returns true if this was an arrow function.
  function parseExprSubscripts() {
    const startTokenIndex = state.tokens.length;
    const wasArrow = parseExprAtom();
    if (wasArrow) {
      return true;
    }
    parseSubscripts(startTokenIndex);
    // If there was any optional chain operation, the start token would be marked
    // as such, so also mark the end now.
    if (state.tokens.length > startTokenIndex && state.tokens[startTokenIndex].isOptionalChainStart) {
      state.tokens[state.tokens.length - 1].isOptionalChainEnd = true;
    }
    return false;
  }

  function parseSubscripts(startTokenIndex, noCalls = false) {
    {
      baseParseSubscripts(startTokenIndex, noCalls);
    }
  }

  function baseParseSubscripts(startTokenIndex, noCalls = false) {
    const stopState = new StopState(false);
    do {
      parseSubscript(startTokenIndex, noCalls, stopState);
    } while (!stopState.stop && !state.error);
  }

  function parseSubscript(startTokenIndex, noCalls, stopState) {
    {
      tsParseSubscript(startTokenIndex, noCalls, stopState);
    }
  }

  /** Set 'state.stop = true' to indicate that we should stop parsing subscripts. */
  function baseParseSubscript(
    startTokenIndex,
    noCalls,
    stopState,
  ) {
    if (!noCalls && eat(TokenType.doubleColon)) {
      parseNoCallExpr();
      stopState.stop = true;
      // Propagate startTokenIndex so that `a::b?.()` will keep `a` as the first token. We may want
      // to revisit this in the future when fully supporting bind syntax.
      parseSubscripts(startTokenIndex, noCalls);
    } else if (match(TokenType.questionDot)) {
      state.tokens[startTokenIndex].isOptionalChainStart = true;
      if (noCalls && lookaheadType() === TokenType.parenL) {
        stopState.stop = true;
        return;
      }
      next();
      state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;

      if (eat(TokenType.bracketL)) {
        parseExpression();
        expect(TokenType.bracketR);
      } else if (eat(TokenType.parenL)) {
        parseCallExpressionArguments();
      } else {
        parseMaybePrivateName();
      }
    } else if (eat(TokenType.dot)) {
      state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;
      parseMaybePrivateName();
    } else if (eat(TokenType.bracketL)) {
      state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;
      parseExpression();
      expect(TokenType.bracketR);
    } else if (!noCalls && match(TokenType.parenL)) {
      if (atPossibleAsync()) {
        // We see "async", but it's possible it's a usage of the name "async". Parse as if it's a
        // function call, and if we see an arrow later, backtrack and re-parse as a parameter list.
        const snapshot = state.snapshot();
        const asyncStartTokenIndex = state.tokens.length;
        next();
        state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;

        const callContextId = getNextContextId();

        state.tokens[state.tokens.length - 1].contextId = callContextId;
        parseCallExpressionArguments();
        state.tokens[state.tokens.length - 1].contextId = callContextId;

        if (shouldParseAsyncArrow()) {
          // We hit an arrow, so backtrack and start again parsing function parameters.
          state.restoreFromSnapshot(snapshot);
          stopState.stop = true;
          state.scopeDepth++;

          parseFunctionParams();
          parseAsyncArrowFromCallExpression(asyncStartTokenIndex);
        }
      } else {
        next();
        state.tokens[state.tokens.length - 1].subscriptStartIndex = startTokenIndex;
        const callContextId = getNextContextId();
        state.tokens[state.tokens.length - 1].contextId = callContextId;
        parseCallExpressionArguments();
        state.tokens[state.tokens.length - 1].contextId = callContextId;
      }
    } else if (match(TokenType.backQuote)) {
      // Tagged template expression.
      parseTemplate();
    } else {
      stopState.stop = true;
    }
  }

  function atPossibleAsync() {
    // This was made less strict than the original version to avoid passing around nodes, but it
    // should be safe to have rare false positives here.
    return (
      state.tokens[state.tokens.length - 1].contextualKeyword === ContextualKeyword._async &&
      !canInsertSemicolon()
    );
  }

  function parseCallExpressionArguments() {
    let first = true;
    while (!eat(TokenType.parenR) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        if (eat(TokenType.parenR)) {
          break;
        }
      }

      parseExprListItem(false);
    }
  }

  function shouldParseAsyncArrow() {
    return match(TokenType.colon) || match(TokenType.arrow);
  }

  function parseAsyncArrowFromCallExpression(startTokenIndex) {
    {
      tsStartParseAsyncArrowFromCallExpression();
    }
    expect(TokenType.arrow);
    parseArrowExpression(startTokenIndex);
  }

// Parse a no-call expression (like argument of `new` or `::` operators).

  function parseNoCallExpr() {
    const startTokenIndex = state.tokens.length;
    parseExprAtom();
    parseSubscripts(startTokenIndex, true);
  }

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.
// Returns true if the parsed expression was an arrow function.
  function parseExprAtom() {
    if (eat(TokenType.modulo)) {
      // V8 intrinsic expression. Just parse the identifier, and the function invocation is parsed
      // naturally.
      parseIdentifier();
      return false;
    }

    if (match(TokenType.jsxText)) {
      parseLiteral();
      return false;
    } else if (match(TokenType.lessThan) && isJSXEnabled) {
      // isJSXenabled false
      // state.type = tt.jsxTagStart;
      // jsxParseElement();
      // next();
      return false;
    }

    const canBeArrow = state.potentialArrowAt === state.start;
    switch (state.type) {
      case TokenType.slash:
      case TokenType.assign:
        retokenizeSlashAsRegex();
      // Fall through.

      case TokenType._super:
      case TokenType._this:
      case TokenType.regexp:
      case TokenType.num:
      case TokenType.bigint:
      case TokenType.decimal:
      case TokenType.string:
      case TokenType._null:
      case TokenType._true:
      case TokenType._false:
        next();
        return false;

      case TokenType._import:
        next();
        if (match(TokenType.dot)) {
          // import.meta
          state.tokens[state.tokens.length - 1].type = TokenType.name;
          next();
          parseIdentifier();
        }
        return false;

      case TokenType.name: {
        const startTokenIndex = state.tokens.length;
        const functionStart = state.start;
        const contextualKeyword = state.contextualKeyword;
        parseIdentifier();
        if (contextualKeyword === ContextualKeyword._await) {
          parseAwait();
          return false;
        } else if (
          contextualKeyword === ContextualKeyword._async &&
          match(TokenType._function) &&
          !canInsertSemicolon()
        ) {
          next();
          parseFunction(functionStart, false);
          return false;
        } else if (
          canBeArrow &&
          contextualKeyword === ContextualKeyword._async &&
          !canInsertSemicolon() &&
          match(TokenType.name)
        ) {
          state.scopeDepth++;
          parseBindingIdentifier(false);
          expect(TokenType.arrow);
          // let foo = async bar => {};
          parseArrowExpression(startTokenIndex);
          return true;
        } else if (match(TokenType._do) && !canInsertSemicolon()) {
          next();
          parseBlock();
          return false;
        }

        if (canBeArrow && !canInsertSemicolon() && match(TokenType.arrow)) {
          state.scopeDepth++;
          markPriorBindingIdentifier(false);
          expect(TokenType.arrow);
          parseArrowExpression(startTokenIndex);
          return true;
        }

        state.tokens[state.tokens.length - 1].identifierRole = IdentifierRole.Access;
        return false;
      }

      case TokenType._do: {
        next();
        parseBlock();
        return false;
      }

      case TokenType.parenL: {
        const wasArrow = parseParenAndDistinguishExpression(canBeArrow);
        return wasArrow;
      }

      case TokenType.bracketL:
        next();
        parseExprList(TokenType.bracketR, true);
        return false;

      case TokenType.braceL:
        parseObj(false, false);
        return false;

      case TokenType._function:
        parseFunctionExpression();
        return false;

      case TokenType.at:
        parseDecorators();
      // Fall through.

      case TokenType._class:
        parseClass(false);
        return false;

      case TokenType._new:
        parseNew();
        return false;

      case TokenType.backQuote:
        parseTemplate();
        return false;

      case TokenType.doubleColon: {
        next();
        parseNoCallExpr();
        return false;
      }

      case TokenType.hash: {
        const code = lookaheadCharCode();
        if (IS_IDENTIFIER_START[code] || code === charCodes.backslash) {
          parseMaybePrivateName();
        } else {
          next();
        }
        // Smart pipeline topic reference.
        return false;
      }

      default:
        unexpected();
        return false;
    }
  }

  function parseMaybePrivateName() {
    eat(TokenType.hash);
    parseIdentifier();
  }

  function parseFunctionExpression() {
    const functionStart = state.start;
    parseIdentifier();
    if (eat(TokenType.dot)) {
      // function.sent
      parseIdentifier();
    }
    parseFunction(functionStart, false);
  }

  function parseLiteral() {
    next();
  }

  function parseParenExpression() {
    expect(TokenType.parenL);
    parseExpression();
    expect(TokenType.parenR);
  }

// Returns true if this was an arrow expression.
  function parseParenAndDistinguishExpression(canBeArrow) {
    // Assume this is a normal parenthesized expression, but if we see an arrow, we'll bail and
    // start over as a parameter list.
    const snapshot = state.snapshot();

    const startTokenIndex = state.tokens.length;
    expect(TokenType.parenL);

    let first = true;

    while (!match(TokenType.parenR) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        if (match(TokenType.parenR)) {
          break;
        }
      }

      if (match(TokenType.ellipsis)) {
        parseRest(false /* isBlockScope */);
        parseParenItem();
        break;
      } else {
        parseMaybeAssign(false, true);
      }
    }

    expect(TokenType.parenR);

    if (canBeArrow && shouldParseArrow()) {
      const wasArrow = parseArrow();
      if (wasArrow) {
        // It was an arrow function this whole time, so start over and parse it as params so that we
        // get proper token annotations.
        state.restoreFromSnapshot(snapshot);
        state.scopeDepth++;
        // Don't specify a context ID because arrow functions don't need a context ID.
        parseFunctionParams();
        parseArrow();
        parseArrowExpression(startTokenIndex);
        return true;
      }
    }

    return false;
  }

  function shouldParseArrow() {
    return match(TokenType.colon) || !canInsertSemicolon();
  }

// Returns whether there was an arrow token.
  function parseArrow() {
    {
      return tsParseArrow();
    }
  }

  function parseParenItem() {
    {
      typedParseParenItem();
    }
  }

// New's precedence is slightly tricky. It must allow its argument to
// be a `[]` or dot subscript expression, but not a call — at least,
// not without wrapping it in parentheses. Thus, it uses the noCalls
// argument to parseSubscripts to prevent it from consuming the
// argument list.
  function parseNew() {
    expect(TokenType._new);
    if (eat(TokenType.dot)) {
      // new.target
      parseIdentifier();
      return;
    }
    parseNoCallExpr();
    eat(TokenType.questionDot);
    parseNewArguments();
  }

  function parseNewArguments() {
    {
      tsStartParseNewArguments();
    }
    if (eat(TokenType.parenL)) {
      parseExprList(TokenType.parenR);
    }
  }

  function parseTemplate() {
    // Finish `, read quasi
    nextTemplateToken();
    // Finish quasi, read ${
    nextTemplateToken();
    while (!match(TokenType.backQuote) && !state.error) {
      expect(TokenType.dollarBraceL);
      parseExpression();
      // Finish }, read quasi
      nextTemplateToken();
      // Finish quasi, read either ${ or `
      nextTemplateToken();
    }
    next();
  }

// Parse an object literal or binding pattern.
  function parseObj(isPattern, isBlockScope) {
    // Attach a context ID to the object open and close brace and each object key.
    const contextId = getNextContextId();
    let first = true;

    next();
    state.tokens[state.tokens.length - 1].contextId = contextId;

    while (!eat(TokenType.braceR) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        if (eat(TokenType.braceR)) {
          break;
        }
      }

      let isGenerator = false;
      if (match(TokenType.ellipsis)) {
        const previousIndex = state.tokens.length;
        parseSpread();
        if (isPattern) {
          // Mark role when the only thing being spread over is an identifier.
          if (state.tokens.length === previousIndex + 2) {
            markPriorBindingIdentifier(isBlockScope);
          }
          if (eat(TokenType.braceR)) {
            break;
          }
        }
        continue;
      }

      if (!isPattern) {
        isGenerator = eat(TokenType.star);
      }

      if (!isPattern && isContextual(ContextualKeyword._async)) {
        if (isGenerator) unexpected();

        parseIdentifier();
        if (
          match(TokenType.colon) ||
          match(TokenType.parenL) ||
          match(TokenType.braceR) ||
          match(TokenType.eq) ||
          match(TokenType.comma)
        ) ; else {
          if (match(TokenType.star)) {
            next();
            isGenerator = true;
          }
          parsePropertyName(contextId);
        }
      } else {
        parsePropertyName(contextId);
      }

      parseObjPropValue(isPattern, isBlockScope, contextId);
    }

    state.tokens[state.tokens.length - 1].contextId = contextId;
  }

  function isGetterOrSetterMethod(isPattern) {
    // We go off of the next and don't bother checking if the node key is actually "get" or "set".
    // This lets us avoid generating a node, and should only make the validation worse.
    return (
      !isPattern &&
      (match(TokenType.string) || // get "string"() {}
        match(TokenType.num) || // get 1() {}
        match(TokenType.bracketL) || // get ["string"]() {}
        match(TokenType.name) || // get foo() {}
        !!(state.type & TokenType.IS_KEYWORD)) // get debugger() {}
    );
  }

// Returns true if this was a method.
  function parseObjectMethod(isPattern, objectContextId) {
    // We don't need to worry about modifiers because object methods can't have optional bodies, so
    // the start will never be used.
    const functionStart = state.start;
    if (match(TokenType.parenL)) {
      if (isPattern) unexpected();
      parseMethod(functionStart, /* isConstructor */ false);
      return true;
    }

    if (isGetterOrSetterMethod(isPattern)) {
      parsePropertyName(objectContextId);
      parseMethod(functionStart, /* isConstructor */ false);
      return true;
    }
    return false;
  }

  function parseObjectProperty(isPattern, isBlockScope) {
    if (eat(TokenType.colon)) {
      if (isPattern) {
        parseMaybeDefault(isBlockScope);
      } else {
        parseMaybeAssign(false);
      }
      return;
    }

    // Since there's no colon, we assume this is an object shorthand.

    // If we're in a destructuring, we've now discovered that the key was actually an assignee, so
    // we need to tag it as a declaration with the appropriate scope. Otherwise, we might need to
    // transform it on access, so mark it as a normal object shorthand.
    let identifierRole;
    if (isPattern) {
      if (state.scopeDepth === 0) {
        identifierRole = IdentifierRole.ObjectShorthandTopLevelDeclaration;
      } else if (isBlockScope) {
        identifierRole = IdentifierRole.ObjectShorthandBlockScopedDeclaration;
      } else {
        identifierRole = IdentifierRole.ObjectShorthandFunctionScopedDeclaration;
      }
    } else {
      identifierRole = IdentifierRole.ObjectShorthand;
    }
    state.tokens[state.tokens.length - 1].identifierRole = identifierRole;

    // Regardless of whether we know this to be a pattern or if we're in an ambiguous context, allow
    // parsing as if there's a default value.
    parseMaybeDefault(isBlockScope, true);
  }

  function parseObjPropValue(
    isPattern,
    isBlockScope,
    objectContextId,
  ) {
    {
      tsStartParseObjPropValue();
    }
    const wasMethod = parseObjectMethod(isPattern, objectContextId);
    if (!wasMethod) {
      parseObjectProperty(isPattern, isBlockScope);
    }
  }

  function parsePropertyName(objectContextId) {
    if (eat(TokenType.bracketL)) {
      state.tokens[state.tokens.length - 1].contextId = objectContextId;
      parseMaybeAssign();
      expect(TokenType.bracketR);
      state.tokens[state.tokens.length - 1].contextId = objectContextId;
    } else {
      if (match(TokenType.num) || match(TokenType.string) || match(TokenType.bigint) || match(TokenType.decimal)) {
        parseExprAtom();
      } else {
        parseMaybePrivateName();
      }

      state.tokens[state.tokens.length - 1].identifierRole = IdentifierRole.ObjectKey;
      state.tokens[state.tokens.length - 1].contextId = objectContextId;
    }
  }

// Parse object or class method.
  function parseMethod(functionStart, isConstructor) {
    const funcContextId = getNextContextId();

    state.scopeDepth++;
    const startTokenIndex = state.tokens.length;
    const allowModifiers = isConstructor; // For TypeScript parameter properties
    parseFunctionParams(allowModifiers, funcContextId);
    parseFunctionBodyAndFinish(functionStart, funcContextId);
    const endTokenIndex = state.tokens.length;
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, true));
    state.scopeDepth--;
  }

// Parse arrow function expression.
// If the parameters are provided, they will be converted to an
// assignable list.
  function parseArrowExpression(startTokenIndex) {
    parseFunctionBody(true);
    const endTokenIndex = state.tokens.length;
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, true));
    state.scopeDepth--;
  }

  function parseFunctionBodyAndFinish(functionStart, funcContextId = 0) {
    {
      tsParseFunctionBodyAndFinish(functionStart, funcContextId);
    }
  }

  function parseFunctionBody(allowExpression, funcContextId = 0) {
    const isExpression = allowExpression && !match(TokenType.braceL);

    if (isExpression) {
      parseMaybeAssign();
    } else {
      parseBlock(true /* isFunctionScope */, funcContextId);
    }
  }

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

  function parseExprList(close, allowEmpty = false) {
    let first = true;
    while (!eat(close) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        if (eat(close)) break;
      }
      parseExprListItem(allowEmpty);
    }
  }

  function parseExprListItem(allowEmpty) {
    if (allowEmpty && match(TokenType.comma)) ; else if (match(TokenType.ellipsis)) {
      parseSpread();
      parseParenItem();
    } else if (match(TokenType.question)) {
      // Partial function application proposal.
      next();
    } else {
      parseMaybeAssign(false, true);
    }
  }

// Parse the next token as an identifier.
  function parseIdentifier() {
    next();
    state.tokens[state.tokens.length - 1].type = TokenType.name;
  }

// Parses await expression inside async function.
  function parseAwait() {
    parseMaybeUnary();
  }

// Parses yield expression inside generator.
  function parseYield() {
    next();
    if (!match(TokenType.semi) && !canInsertSemicolon()) {
      eat(TokenType.star);
      parseMaybeAssign();
    }
  }

// https://github.com/tc39/proposal-js-module-blocks
  function parseModuleExpression() {
    expectContextual(ContextualKeyword._module);
    expect(TokenType.braceL);
    // For now, just call parseBlockBody to parse the block. In the future when we
    // implement full support, we'll want to emit scopes and possibly other
    // information.
    parseBlockBody(TokenType.braceR);
  }

  /* eslint max-len: 0 */
  const isFlowEnabled=false;

  function parseTopLevel() {
    parseBlockBody(TokenType.eof);
    state.scopes.push(new Scope(0, state.tokens.length, true));
    if (state.scopeDepth !== 0) {
      throw new Error(`Invalid scope depth at end of file: ${state.scopeDepth}`);
    }
    return new File(state.tokens, state.scopes);
  }

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

  function parseStatement(declaration) {
    if (match(TokenType.at)) {
      parseDecorators();
    }
    parseStatementContent(declaration);
  }

  function parseStatementContent(declaration) {
    {
      if (tsTryParseStatementContent()) {
        return;
      }
    }

    const starttype = state.type;

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (starttype) {
      case TokenType._break:
      case TokenType._continue:
        parseBreakContinueStatement();
        return;
      case TokenType._debugger:
        parseDebuggerStatement();
        return;
      case TokenType._do:
        parseDoStatement();
        return;
      case TokenType._for:
        parseForStatement();
        return;
      case TokenType._function:
        if (lookaheadType() === TokenType.dot) break;
        if (!declaration) unexpected();
        parseFunctionStatement();
        return;

      case TokenType._class:
        if (!declaration) unexpected();
        parseClass(true);
        return;

      case TokenType._if:
        parseIfStatement();
        return;
      case TokenType._return:
        parseReturnStatement();
        return;
      case TokenType._switch:
        parseSwitchStatement();
        return;
      case TokenType._throw:
        parseThrowStatement();
        return;
      case TokenType._try:
        parseTryStatement();
        return;

      case TokenType._let:
      case TokenType._const:
        if (!declaration) unexpected(); // NOTE: falls through to _var

      case TokenType._var:
        parseVarStatement(starttype);
        return;

      case TokenType._while:
        parseWhileStatement();
        return;
      case TokenType.braceL:
        parseBlock();
        return;
      case TokenType.semi:
        parseEmptyStatement();
        return;
      case TokenType._export:
      case TokenType._import: {
        const nextType = lookaheadType();
        if (nextType === TokenType.parenL || nextType === TokenType.dot) {
          break;
        }
        next();
        if (starttype === TokenType._import) {
          parseImport();
        } else {
          parseExport();
        }
        return;
      }
      case TokenType.name:
        if (state.contextualKeyword === ContextualKeyword._async) {
          const functionStart = state.start;
          // peek ahead and see if next token is a function
          const snapshot = state.snapshot();
          next();
          if (match(TokenType._function) && !canInsertSemicolon()) {
            expect(TokenType._function);
            parseFunction(functionStart, true);
            return;
          } else {
            state.restoreFromSnapshot(snapshot);
          }
        }
    }

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    const initialTokensLength = state.tokens.length;
    parseExpression();
    let simpleName = null;
    if (state.tokens.length === initialTokensLength + 1) {
      const token = state.tokens[state.tokens.length - 1];
      if (token.type === TokenType.name) {
        simpleName = token.contextualKeyword;
      }
    }
    if (simpleName == null) {
      semicolon();
      return;
    }
    if (eat(TokenType.colon)) {
      parseLabeledStatement();
    } else {
      // This was an identifier, so we might want to handle flow/typescript-specific cases.
      parseIdentifierStatement(simpleName);
    }
  }

  function parseDecorators() {
    while (match(TokenType.at)) {
      parseDecorator();
    }
  }

  function parseDecorator() {
    next();
    if (eat(TokenType.parenL)) {
      parseExpression();
      expect(TokenType.parenR);
    } else {
      parseIdentifier();
      while (eat(TokenType.dot)) {
        parseIdentifier();
      }
    }
    parseMaybeDecoratorArguments();
  }

  function parseMaybeDecoratorArguments() {
    {
      tsParseMaybeDecoratorArguments();
    }
  }

  function baseParseMaybeDecoratorArguments() {
    if (eat(TokenType.parenL)) {
      parseCallExpressionArguments();
    }
  }

  function parseBreakContinueStatement() {
    next();
    if (!isLineTerminator()) {
      parseIdentifier();
      semicolon();
    }
  }

  function parseDebuggerStatement() {
    next();
    semicolon();
  }

  function parseDoStatement() {
    next();
    parseStatement(false);
    expect(TokenType._while);
    parseParenExpression();
    eat(TokenType.semi);
  }

  function parseForStatement() {
    state.scopeDepth++;
    const startTokenIndex = state.tokens.length;
    parseAmbiguousForStatement();
    const endTokenIndex = state.tokens.length;
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, false));
    state.scopeDepth--;
  }

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.
  function parseAmbiguousForStatement() {
    next();

    let forAwait = false;
    if (isContextual(ContextualKeyword._await)) {
      forAwait = true;
      next();
    }
    expect(TokenType.parenL);

    if (match(TokenType.semi)) {
      if (forAwait) {
        unexpected();
      }
      parseFor();
      return;
    }

    if (match(TokenType._var) || match(TokenType._let) || match(TokenType._const)) {
      const varKind = state.type;
      next();
      parseVar(true, varKind);
      if (match(TokenType._in) || isContextual(ContextualKeyword._of)) {
        parseForIn(forAwait);
        return;
      }
      parseFor();
      return;
    }

    parseExpression(true);
    if (match(TokenType._in) || isContextual(ContextualKeyword._of)) {
      parseForIn(forAwait);
      return;
    }
    if (forAwait) {
      unexpected();
    }
    parseFor();
  }

  function parseFunctionStatement() {
    const functionStart = state.start;
    next();
    parseFunction(functionStart, true);
  }

  function parseIfStatement() {
    next();
    parseParenExpression();
    parseStatement(false);
    if (eat(TokenType._else)) {
      parseStatement(false);
    }
  }

  function parseReturnStatement() {
    next();

    // In `return` (and `break`/`continue`), the keywords with
    // optional arguments, we eagerly look for a semicolon or the
    // possibility to insert one.

    if (!isLineTerminator()) {
      parseExpression();
      semicolon();
    }
  }

  function parseSwitchStatement() {
    next();
    parseParenExpression();
    state.scopeDepth++;
    const startTokenIndex = state.tokens.length;
    expect(TokenType.braceL);

    // Don't bother validation; just go through any sequence of cases, defaults, and statements.
    while (!match(TokenType.braceR) && !state.error) {
      if (match(TokenType._case) || match(TokenType._default)) {
        const isCase = match(TokenType._case);
        next();
        if (isCase) {
          parseExpression();
        }
        expect(TokenType.colon);
      } else {
        parseStatement(true);
      }
    }
    next(); // Closing brace
    const endTokenIndex = state.tokens.length;
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, false));
    state.scopeDepth--;
  }

  function parseThrowStatement() {
    next();
    parseExpression();
    semicolon();
  }

  function parseCatchClauseParam() {
    parseBindingAtom(true /* isBlockScope */);

    {
      tsTryParseTypeAnnotation();
    }
  }

  function parseTryStatement() {
    next();

    parseBlock();

    if (match(TokenType._catch)) {
      next();
      let catchBindingStartTokenIndex = null;
      if (match(TokenType.parenL)) {
        state.scopeDepth++;
        catchBindingStartTokenIndex = state.tokens.length;
        expect(TokenType.parenL);
        parseCatchClauseParam();
        expect(TokenType.parenR);
      }
      parseBlock();
      if (catchBindingStartTokenIndex != null) {
        // We need a special scope for the catch binding which includes the binding itself and the
        // catch block.
        const endTokenIndex = state.tokens.length;
        state.scopes.push(new Scope(catchBindingStartTokenIndex, endTokenIndex, false));
        state.scopeDepth--;
      }
    }
    if (eat(TokenType._finally)) {
      parseBlock();
    }
  }

  function parseVarStatement(kind) {
    next();
    parseVar(false, kind);
    semicolon();
  }

  function parseWhileStatement() {
    next();
    parseParenExpression();
    parseStatement(false);
  }

  function parseEmptyStatement() {
    next();
  }

  function parseLabeledStatement() {
    parseStatement(true);
  }

  /**
   * Parse a statement starting with an identifier of the given name. Subclasses match on the name
   * to handle statements like "declare".
   */
  function parseIdentifierStatement(contextualKeyword) {
    {
      tsParseIdentifierStatement(contextualKeyword);
    }
  }

// Parse a semicolon-enclosed block of statements.
  function parseBlock(isFunctionScope = false, contextId = 0) {
    const startTokenIndex = state.tokens.length;
    state.scopeDepth++;
    expect(TokenType.braceL);
    if (contextId) {
      state.tokens[state.tokens.length - 1].contextId = contextId;
    }
    parseBlockBody(TokenType.braceR);
    if (contextId) {
      state.tokens[state.tokens.length - 1].contextId = contextId;
    }
    const endTokenIndex = state.tokens.length;
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, isFunctionScope));
    state.scopeDepth--;
  }

  function parseBlockBody(end) {
    while (!eat(end) && !state.error) {
      parseStatement(true);
    }
  }

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

  function parseFor() {
    expect(TokenType.semi);
    if (!match(TokenType.semi)) {
      parseExpression();
    }
    expect(TokenType.semi);
    if (!match(TokenType.parenR)) {
      parseExpression();
    }
    expect(TokenType.parenR);
    parseStatement(false);
  }

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

  function parseForIn(forAwait) {
    if (forAwait) {
      eatContextual(ContextualKeyword._of);
    } else {
      next();
    }
    parseExpression();
    expect(TokenType.parenR);
    parseStatement(false);
  }

// Parse a list of variable declarations.

  function parseVar(isFor, kind) {
    while (true) {
      const isBlockScope = kind === TokenType._const || kind === TokenType._let;
      parseVarHead(isBlockScope);
      if (eat(TokenType.eq)) {
        const eqIndex = state.tokens.length - 1;
        parseMaybeAssign(isFor);
        state.tokens[eqIndex].rhsEndIndex = state.tokens.length;
      }
      if (!eat(TokenType.comma)) {
        break;
      }
    }
  }

  function parseVarHead(isBlockScope) {
    parseBindingAtom(isBlockScope);
    {
      tsAfterParseVarHead();
    }
  }

// Parse a function declaration or literal (depending on the
// `isStatement` parameter).

  function parseFunction(
    functionStart,
    isStatement,
    optionalId = false,
  ) {
    if (match(TokenType.star)) {
      next();
    }

    if (isStatement && !optionalId && !match(TokenType.name) && !match(TokenType._yield)) {
      unexpected();
    }

    let nameScopeStartTokenIndex = null;

    if (match(TokenType.name)) {
      // Expression-style functions should limit their name's scope to the function body, so we make
      // a new function scope to enforce that.
      if (!isStatement) {
        nameScopeStartTokenIndex = state.tokens.length;
        state.scopeDepth++;
      }
      parseBindingIdentifier(false);
    }

    const startTokenIndex = state.tokens.length;
    state.scopeDepth++;
    parseFunctionParams();
    parseFunctionBodyAndFinish(functionStart);
    const endTokenIndex = state.tokens.length;
    // In addition to the block scope of the function body, we need a separate function-style scope
    // that includes the params.
    state.scopes.push(new Scope(startTokenIndex, endTokenIndex, true));
    state.scopeDepth--;
    if (nameScopeStartTokenIndex !== null) {
      state.scopes.push(new Scope(nameScopeStartTokenIndex, endTokenIndex, true));
      state.scopeDepth--;
    }
  }

  function parseFunctionParams(
    allowModifiers = false,
    funcContextId = 0,
  ) {
    {
      tsStartParseFunctionParams();
    }

    expect(TokenType.parenL);
    if (funcContextId) {
      state.tokens[state.tokens.length - 1].contextId = funcContextId;
    }
    parseBindingList(
      TokenType.parenR,
      false /* isBlockScope */,
      false /* allowEmpty */,
      allowModifiers,
      funcContextId,
    );
    if (funcContextId) {
      state.tokens[state.tokens.length - 1].contextId = funcContextId;
    }
  }

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

  function parseClass(isStatement, optionalId = false) {
    // Put a context ID on the class keyword, the open-brace, and the close-brace, so that later
    // code can easily navigate to meaningful points on the class.
    const contextId = getNextContextId();

    next();
    state.tokens[state.tokens.length - 1].contextId = contextId;
    state.tokens[state.tokens.length - 1].isExpression = !isStatement;
    // Like with functions, we declare a special "name scope" from the start of the name to the end
    // of the class, but only with expression-style classes, to represent the fact that the name is
    // available to the body of the class but not an outer declaration.
    let nameScopeStartTokenIndex = null;
    if (!isStatement) {
      nameScopeStartTokenIndex = state.tokens.length;
      state.scopeDepth++;
    }
    parseClassId(isStatement, optionalId);
    parseClassSuper();
    const openBraceIndex = state.tokens.length;
    parseClassBody(contextId);
    if (state.error) {
      return;
    }
    state.tokens[openBraceIndex].contextId = contextId;
    state.tokens[state.tokens.length - 1].contextId = contextId;
    if (nameScopeStartTokenIndex !== null) {
      const endTokenIndex = state.tokens.length;
      state.scopes.push(new Scope(nameScopeStartTokenIndex, endTokenIndex, false));
      state.scopeDepth--;
    }
  }

  function isClassProperty() {
    return match(TokenType.eq) || match(TokenType.semi) || match(TokenType.braceR) || match(TokenType.bang) || match(TokenType.colon);
  }

  function isClassMethod() {
    return match(TokenType.parenL) || match(TokenType.lessThan);
  }

  function parseClassBody(classContextId) {
    expect(TokenType.braceL);

    while (!eat(TokenType.braceR) && !state.error) {
      if (eat(TokenType.semi)) {
        continue;
      }

      if (match(TokenType.at)) {
        parseDecorator();
        continue;
      }
      const memberStart = state.start;
      parseClassMember(memberStart, classContextId);
    }
  }

  function parseClassMember(memberStart, classContextId) {
    {
      tsParseModifiers([
        ContextualKeyword._declare,
        ContextualKeyword._public,
        ContextualKeyword._protected,
        ContextualKeyword._private,
        ContextualKeyword._override,
      ]);
    }
    let isStatic = false;
    if (match(TokenType.name) && state.contextualKeyword === ContextualKeyword._static) {
      parseIdentifier(); // eats 'static'
      if (isClassMethod()) {
        parseClassMethod(memberStart, /* isConstructor */ false);
        return;
      } else if (isClassProperty()) {
        parseClassProperty();
        return;
      }
      // otherwise something static
      state.tokens[state.tokens.length - 1].type = TokenType._static;
      isStatic = true;

      if (match(TokenType.braceL)) {
        // This is a static block. Mark the word "static" with the class context ID for class element
        // detection and parse as a regular block.
        state.tokens[state.tokens.length - 1].contextId = classContextId;
        parseBlock();
        return;
      }
    }

    parseClassMemberWithIsStatic(memberStart, isStatic, classContextId);
  }

  function parseClassMemberWithIsStatic(
    memberStart,
    isStatic,
    classContextId,
  ) {
    {
      if (tsTryParseClassMemberWithIsStatic(isStatic)) {
        return;
      }
    }
    if (eat(TokenType.star)) {
      // a generator
      parseClassPropertyName(classContextId);
      parseClassMethod(memberStart, /* isConstructor */ false);
      return;
    }

    // Get the identifier name so we can tell if it's actually a keyword like "async", "get", or
    // "set".
    parseClassPropertyName(classContextId);
    let isConstructor = false;
    const token = state.tokens[state.tokens.length - 1];
    // We allow "constructor" as either an identifier or a string.
    if (token.contextualKeyword === ContextualKeyword._constructor) {
      isConstructor = true;
    }
    parsePostMemberNameModifiers();

    if (isClassMethod()) {
      parseClassMethod(memberStart, isConstructor);
    } else if (isClassProperty()) {
      parseClassProperty();
    } else if (token.contextualKeyword === ContextualKeyword._async && !isLineTerminator()) {
      state.tokens[state.tokens.length - 1].type = TokenType._async;
      // an async method
      const isGenerator = match(TokenType.star);
      if (isGenerator) {
        next();
      }

      // The so-called parsed name would have been "async": get the real name.
      parseClassPropertyName(classContextId);
      parsePostMemberNameModifiers();
      parseClassMethod(memberStart, false /* isConstructor */);
    } else if (
      (token.contextualKeyword === ContextualKeyword._get ||
        token.contextualKeyword === ContextualKeyword._set) &&
      !(isLineTerminator() && match(TokenType.star))
    ) {
      if (token.contextualKeyword === ContextualKeyword._get) {
        state.tokens[state.tokens.length - 1].type = TokenType._get;
      } else {
        state.tokens[state.tokens.length - 1].type = TokenType._set;
      }
      // `get\n*` is an uninitialized property named 'get' followed by a generator.
      // a getter or setter
      // The so-called parsed name would have been "get/set": get the real name.
      parseClassPropertyName(classContextId);
      parseClassMethod(memberStart, /* isConstructor */ false);
    } else if (isLineTerminator()) {
      // an uninitialized class property (due to ASI, since we don't otherwise recognize the next token)
      parseClassProperty();
    } else {
      unexpected();
    }
  }

  function parseClassMethod(functionStart, isConstructor) {
    {
      tsTryParseTypeParameters();
    }
    parseMethod(functionStart, isConstructor);
  }

// Return the name of the class property, if it is a simple identifier.
  function parseClassPropertyName(classContextId) {
    parsePropertyName(classContextId);
  }

  function parsePostMemberNameModifiers() {
    {
      const oldIsType = pushTypeContext(0);
      eat(TokenType.question);
      popTypeContext(oldIsType);
    }
  }

  function parseClassProperty() {
    {
      eatTypeToken(TokenType.bang);
      tsTryParseTypeAnnotation();
    }

    if (match(TokenType.eq)) {
      const equalsTokenIndex = state.tokens.length;
      next();
      parseMaybeAssign();
      state.tokens[equalsTokenIndex].rhsEndIndex = state.tokens.length;
    }
    semicolon();
  }

  function parseClassId(isStatement, optionalId = false) {
    if (
      (!isStatement || optionalId) &&
      isContextual(ContextualKeyword._implements)
    ) {
      return;
    }

    if (match(TokenType.name)) {
      parseBindingIdentifier(true);
    }

    {
      tsTryParseTypeParameters();
    }
  }

// Returns true if there was a superclass.
  function parseClassSuper() {
    let hasSuper = false;
    if (eat(TokenType._extends)) {
      parseExprSubscripts();
      hasSuper = true;
    } else {
      hasSuper = false;
    }
    {
      tsAfterParseClassSuper(hasSuper);
    }
  }

// Parses module export declaration.

  function parseExport() {
    const exportIndex = state.tokens.length - 1;
    {
      if (tsTryParseExport()) {
        return;
      }
    }
    // export * from '...'
    if (shouldParseExportStar()) {
      parseExportStar();
    } else if (isExportDefaultSpecifier()) {
      // export default from
      parseIdentifier();
      if (match(TokenType.comma) && lookaheadType() === TokenType.star) {
        expect(TokenType.comma);
        expect(TokenType.star);
        expectContextual(ContextualKeyword._as);
        parseIdentifier();
      } else {
        parseExportSpecifiersMaybe();
      }
      parseExportFrom();
    } else if (eat(TokenType._default)) {
      // export default ...
      parseExportDefaultExpression();
    } else if (shouldParseExportDeclaration()) {
      parseExportDeclaration();
    } else {
      // export { x, y as z } [from '...']
      parseExportSpecifiers();
      parseExportFrom();
    }
    state.tokens[exportIndex].rhsEndIndex = state.tokens.length;
  }

  function parseExportDefaultExpression() {
    {
      if (tsTryParseExportDefaultExpression()) {
        return;
      }
    }
    const functionStart = state.start;
    if (eat(TokenType._function)) {
      parseFunction(functionStart, true, true);
    } else if (isContextual(ContextualKeyword._async) && lookaheadType() === TokenType._function) {
      // async function declaration
      eatContextual(ContextualKeyword._async);
      eat(TokenType._function);
      parseFunction(functionStart, true, true);
    } else if (match(TokenType._class)) {
      parseClass(true, true);
    } else if (match(TokenType.at)) {
      parseDecorators();
      parseClass(true, true);
    } else {
      parseMaybeAssign();
      semicolon();
    }
  }

  function parseExportDeclaration() {
    {
      tsParseExportDeclaration();
    }
  }

  function isExportDefaultSpecifier() {
    if (tsIsDeclarationStart()) {
      return false;
    }
    if (match(TokenType.name)) {
      return state.contextualKeyword !== ContextualKeyword._async;
    }

    if (!match(TokenType._default)) {
      return false;
    }

    const _next = nextTokenStart();
    const lookahead = lookaheadTypeAndKeyword();
    const hasFrom =
      lookahead.type === TokenType.name && lookahead.contextualKeyword === ContextualKeyword._from;
    if (lookahead.type === TokenType.comma) {
      return true;
    }
    // lookahead again when `export default from` is seen
    if (hasFrom) {
      const nextAfterFrom = input.charCodeAt(nextTokenStartSince(_next + 4));
      return nextAfterFrom === charCodes.quotationMark || nextAfterFrom === charCodes.apostrophe;
    }
    return false;
  }

  function parseExportSpecifiersMaybe() {
    if (eat(TokenType.comma)) {
      parseExportSpecifiers();
    }
  }

  function parseExportFrom() {
    if (eatContextual(ContextualKeyword._from)) {
      parseExprAtom();
    }
    semicolon();
  }

  function shouldParseExportStar() {
    {
      return match(TokenType.star);
    }
  }

  function parseExportStar() {
    {
      baseParseExportStar();
    }
  }

  function baseParseExportStar() {
    expect(TokenType.star);

    if (isContextual(ContextualKeyword._as)) {
      parseExportNamespace();
    } else {
      parseExportFrom();
    }
  }

  function parseExportNamespace() {
    next();
    state.tokens[state.tokens.length - 1].type = TokenType._as;
    parseIdentifier();
    parseExportSpecifiersMaybe();
    parseExportFrom();
  }

  function shouldParseExportDeclaration() {
    return (
      (tsIsDeclarationStart()) ||
      (isFlowEnabled ) ||
      state.type === TokenType._var ||
      state.type === TokenType._const ||
      state.type === TokenType._let ||
      state.type === TokenType._function ||
      state.type === TokenType._class ||
      isContextual(ContextualKeyword._async) ||
      match(TokenType.at)
    );
  }

// Parses a comma-separated list of module exports.
  function parseExportSpecifiers() {
    let first = true;

    // export { x, y as z } [from '...']
    expect(TokenType.braceL);

    while (!eat(TokenType.braceR) && !state.error) {
      if (first) {
        first = false;
      } else {
        expect(TokenType.comma);
        if (eat(TokenType.braceR)) {
          break;
        }
      }

      parseIdentifier();
      state.tokens[state.tokens.length - 1].identifierRole = IdentifierRole.ExportAccess;
      if (eatContextual(ContextualKeyword._as)) {
        parseIdentifier();
      }
    }
  }

// Parses import declaration.

  function parseImport() {
    if (match(TokenType.name) && lookaheadType() === TokenType.eq) {
      tsParseImportEqualsDeclaration();
      return;
    }
    if (isContextual(ContextualKeyword._type)) {
      const lookahead = lookaheadType();
      if (lookahead === TokenType.name) {
        // One of these `import type` cases:
        // import type T = require('T');
        // import type A from 'A';
        expectContextual(ContextualKeyword._type);
        if (lookaheadType() === TokenType.eq) {
          tsParseImportEqualsDeclaration();
          return;
        }
        // If this is an `import type...from` statement, then we already ate the
        // type token, so proceed to the regular import parser.
      } else if (lookahead === TokenType.star || lookahead === TokenType.braceL) {
        // One of these `import type` cases, in which case we can eat the type token
        // and proceed as normal:
        // import type * as A from 'A';
        // import type {a} from 'A';
        expectContextual(ContextualKeyword._type);
      }
      // Otherwise, we are importing the name "type".
    }

    // import '...'
    if (match(TokenType.string)) {
      parseExprAtom();
    } else {
      parseImportSpecifiers();
      expectContextual(ContextualKeyword._from);
      parseExprAtom();
    }
    semicolon();
  }

// eslint-disable-next-line no-unused-vars
  function shouldParseDefaultImport() {
    return match(TokenType.name);
  }

  function parseImportSpecifierLocal() {
    parseImportedIdentifier();
  }

// Parses a comma-separated list of module imports.
  function parseImportSpecifiers() {

    let first = true;
    if (shouldParseDefaultImport()) {
      // import defaultObj, { x, y as z } from '...'
      parseImportSpecifierLocal();

      if (!eat(TokenType.comma)) return;
    }

    if (match(TokenType.star)) {
      next();
      expectContextual(ContextualKeyword._as);

      parseImportSpecifierLocal();

      return;
    }

    expect(TokenType.braceL);
    while (!eat(TokenType.braceR) && !state.error) {
      if (first) {
        first = false;
      } else {
        // Detect an attempt to deep destructure
        if (eat(TokenType.colon)) {
          unexpected(
            "ES2015 named imports do not destructure. Use another statement for destructuring after the import.",
          );
        }

        expect(TokenType.comma);
        if (eat(TokenType.braceR)) {
          break;
        }
      }

      parseImportSpecifier();
    }
  }

  function parseImportSpecifier() {
    parseImportedIdentifier();
    if (isContextual(ContextualKeyword._as)) {
      state.tokens[state.tokens.length - 1].identifierRole = IdentifierRole.ImportAccess;
      next();
      parseImportedIdentifier();
    }
  }

  function parseFile() {
    // If enabled, skip leading hashbang line.
    if (
      state.pos === 0 &&
      input.charCodeAt(0) === charCodes.numberSign &&
      input.charCodeAt(1) === charCodes.exclamationMark
    ) {
      skipLineComment(2);
    }
    nextToken();
    return parseTopLevel();
  }

  class File {



    constructor(tokens, scopes) {
      this.tokens = tokens;
      this.scopes = scopes;
    }
  }

  function parse(
    input,
    isJSXEnabled,
    isTypeScriptEnabled,
    isFlowEnabled,
  ) {

    initParser(input);
    const result = parseFile();
    if (state.error) {
      throw augmentError(state.error);
    }
    return result;
  }

  /**
   * Determine whether this optional chain or nullish coalescing operation has any await statements in
   * it. If so, we'll need to transpile to an async operation.
   *
   * We compute this by walking the length of the operation and returning true if we see an await
   * keyword used as a real await (rather than an object key or property access). Nested optional
   * chain/nullish operations need to be tracked but don't silence await, but a nested async function
   * (or any other nested scope) will make the await not count.
   */
  function isAsyncOperation(tokens) {
    let index = tokens.currentIndex();
    let depth = 0;
    const startToken = tokens.currentToken();
    do {
      const token = tokens.tokens[index];
      if (token.isOptionalChainStart) {
        depth++;
      }
      if (token.isOptionalChainEnd) {
        depth--;
      }
      depth += token.numNullishCoalesceStarts;
      depth -= token.numNullishCoalesceEnds;

      if (
        token.contextualKeyword === ContextualKeyword._await &&
        token.identifierRole == null &&
        token.scopeDepth === startToken.scopeDepth
      ) {
        return true;
      }
      index += 1;
    } while (depth > 0 && index < tokens.tokens.length);
    return false;
  }

  const disableESTransforms = true;


  class TokenProcessor {
    __init() {this.resultCode = "";}
    __init2() {this.tokenIndex = 0;}

    constructor(
      code,
      tokens,
      isFlowEnabled,
      disableESTransforms,
      helperManager,
    ) {this.code = code;this.tokens = tokens;
      this.isFlowEnabled = false;
      this.disableESTransforms = true;
      this.helperManager = helperManager;TokenProcessor.prototype.__init.call(this);TokenProcessor.prototype.__init2.call(this);}

    /**
     * Make a new TokenProcessor for things like lookahead.
     */
    snapshot() {
      return {resultCode: this.resultCode, tokenIndex: this.tokenIndex};
    }

    restoreToSnapshot(snapshot) {
      this.resultCode = snapshot.resultCode;
      this.tokenIndex = snapshot.tokenIndex;
    }

    getResultCodeIndex() {
      return this.resultCode.length;
    }

    reset() {
      this.resultCode = "";
      this.tokenIndex = 0;
    }

    matchesContextualAtIndex(index, contextualKeyword) {
      return (
        this.matches1AtIndex(index, TokenType.name) &&
        this.tokens[index].contextualKeyword === contextualKeyword
      );
    }

    identifierNameAtIndex(index) {
      // TODO: We need to process escapes since technically you can have unicode escapes in variable
      // names.
      return this.identifierNameForToken(this.tokens[index]);
    }

    identifierName() {
      return this.identifierNameForToken(this.currentToken());
    }

    identifierNameForToken(token) {
      return this.code.slice(token.start, token.end);
    }

    rawCodeForToken(token) {
      return this.code.slice(token.start, token.end);
    }

    stringValueAtIndex(index) {
      return this.stringValueForToken(this.tokens[index]);
    }

    stringValue() {
      return this.stringValueForToken(this.currentToken());
    }

    stringValueForToken(token) {
      // This is used to identify when two imports are the same and to resolve TypeScript enum keys.
      // Ideally we'd process escapes within the strings, but for now we pretty much take the raw
      // code.
      return this.code.slice(token.start + 1, token.end - 1);
    }

    matches1AtIndex(index, t1) {
      return this.tokens[index].type === t1;
    }

    matches2AtIndex(index, t1, t2) {
      return this.tokens[index].type === t1 && this.tokens[index + 1].type === t2;
    }

    matches3AtIndex(index, t1, t2, t3) {
      return (
        this.tokens[index].type === t1 &&
        this.tokens[index + 1].type === t2 &&
        this.tokens[index + 2].type === t3
      );
    }

    matches1(t1) {
      return this.tokens[this.tokenIndex].type === t1;
    }

    matches2(t1, t2) {
      return this.tokens[this.tokenIndex].type === t1 && this.tokens[this.tokenIndex + 1].type === t2;
    }

    matches3(t1, t2, t3) {
      return (
        this.tokens[this.tokenIndex].type === t1 &&
        this.tokens[this.tokenIndex + 1].type === t2 &&
        this.tokens[this.tokenIndex + 2].type === t3
      );
    }

    matches4(t1, t2, t3, t4) {
      return (
        this.tokens[this.tokenIndex].type === t1 &&
        this.tokens[this.tokenIndex + 1].type === t2 &&
        this.tokens[this.tokenIndex + 2].type === t3 &&
        this.tokens[this.tokenIndex + 3].type === t4
      );
    }

    matches5(t1, t2, t3, t4, t5) {
      return (
        this.tokens[this.tokenIndex].type === t1 &&
        this.tokens[this.tokenIndex + 1].type === t2 &&
        this.tokens[this.tokenIndex + 2].type === t3 &&
        this.tokens[this.tokenIndex + 3].type === t4 &&
        this.tokens[this.tokenIndex + 4].type === t5
      );
    }

    matchesContextual(contextualKeyword) {
      return this.matchesContextualAtIndex(this.tokenIndex, contextualKeyword);
    }

    matchesContextIdAndLabel(type, contextId) {
      return this.matches1(type) && this.currentToken().contextId === contextId;
    }

    previousWhitespaceAndComments() {
      let whitespaceAndComments = this.code.slice(
        this.tokenIndex > 0 ? this.tokens[this.tokenIndex - 1].end : 0,
        this.tokenIndex < this.tokens.length ? this.tokens[this.tokenIndex].start : this.code.length,
      );
      return whitespaceAndComments;
    }

    replaceToken(newCode) {
      this.resultCode += this.previousWhitespaceAndComments();
      this.appendTokenPrefix();
      this.resultCode += newCode;
      this.appendTokenSuffix();
      this.tokenIndex++;
    }

    replaceTokenTrimmingLeftWhitespace(newCode) {
      this.resultCode += this.previousWhitespaceAndComments().replace(/[^\r\n]/g, "");
      this.appendTokenPrefix();
      this.resultCode += newCode;
      this.appendTokenSuffix();
      this.tokenIndex++;
    }

    removeInitialToken() {
      this.replaceToken("");
    }

    removeToken() {
      this.replaceTokenTrimmingLeftWhitespace("");
    }

    copyExpectedToken(tokenType) {
      if (this.tokens[this.tokenIndex].type !== tokenType) {
        throw new Error(`Expected token ${tokenType}`);
      }
      this.copyToken();
    }

    copyToken() {
      this.resultCode += this.previousWhitespaceAndComments();
      this.appendTokenPrefix();
      this.resultCode += this.code.slice(
        this.tokens[this.tokenIndex].start,
        this.tokens[this.tokenIndex].end,
      );
      this.appendTokenSuffix();
      this.tokenIndex++;
    }

    copyTokenWithPrefix(prefix) {
      this.resultCode += this.previousWhitespaceAndComments();
      this.appendTokenPrefix();
      this.resultCode += prefix;
      this.resultCode += this.code.slice(
        this.tokens[this.tokenIndex].start,
        this.tokens[this.tokenIndex].end,
      );
      this.appendTokenSuffix();
      this.tokenIndex++;
    }

    appendTokenPrefix() {
      const token = this.currentToken();
      if (token.numNullishCoalesceStarts || token.isOptionalChainStart) {
        token.isAsyncOperation = isAsyncOperation(this);
      }
      {
        return;
      }
    }

    appendTokenSuffix() {
      const token = this.currentToken();
      if (token.isOptionalChainEnd && !disableESTransforms) {
        this.resultCode += "])";
      }
      if (token.numNullishCoalesceEnds && !disableESTransforms) {
        for (let i = 0; i < token.numNullishCoalesceEnds; i++) {
          this.resultCode += "))";
        }
      }
    }

    appendCode(code) {
      this.resultCode += code;
    }

    currentToken() {
      return this.tokens[this.tokenIndex];
    }

    currentTokenCode() {
      const token = this.currentToken();
      return this.code.slice(token.start, token.end);
    }

    tokenAtRelativeIndex(relativeIndex) {
      return this.tokens[this.tokenIndex + relativeIndex];
    }

    currentIndex() {
      return this.tokenIndex;
    }

    /**
     * Move to the next token. Only suitable in preprocessing steps. When
     * generating new code, you should use copyToken or removeToken.
     */
    nextToken() {
      if (this.tokenIndex === this.tokens.length) {
        throw new Error("Unexpectedly reached end of input.");
      }
      this.tokenIndex++;
    }

    previousToken() {
      this.tokenIndex--;
    }

    finish() {
      if (this.tokenIndex !== this.tokens.length) {
        throw new Error("Tried to finish processing tokens before reaching the end.");
      }
      this.resultCode += this.previousWhitespaceAndComments();
      return this.resultCode;
    }

    isAtEnd() {
      return this.tokenIndex === this.tokens.length;
    }
  }

  /**
   * Get information about the class fields for this class, given a token processor pointing to the
   * open-brace at the start of the class.
   */
  function getClassInfo(
    rootTransformer,
    tokens,
    nameManager,
    disableESTransforms_,
  ) {
    const snapshot = tokens.snapshot();

    const headerInfo = processClassHeader(tokens);

    let constructorInitializerStatements = [];
    const instanceInitializerNames = [];
    const staticInitializerNames = [];
    let constructorInsertPos = null;
    const fields = [];
    const rangesToRemove = [];

    const classContextId = tokens.currentToken().contextId;
    if (classContextId == null) {
      throw new Error("Expected non-null class context ID on class open-brace.");
    }

    tokens.nextToken();
    while (!tokens.matchesContextIdAndLabel(TokenType.braceR, classContextId)) {
      if (tokens.matchesContextual(ContextualKeyword._constructor) && !tokens.currentToken().isType) {
        ({constructorInitializerStatements, constructorInsertPos} = processConstructor(tokens));
      } else if (tokens.matches1(TokenType.semi)) {
        tokens.nextToken();
      } else if (tokens.currentToken().isType) {
        tokens.nextToken();
      } else {
        // Either a method or a field. Skip to the identifier part.
        const statementStartIndex = tokens.currentIndex();
        let isStatic = false;
        let isESPrivate = false;
        let isDeclare = false;
        while (isAccessModifier(tokens.currentToken())) {
          if (tokens.matches1(TokenType._static)) {
            isStatic = true;
          }
          if (tokens.matches1(TokenType.hash)) {
            isESPrivate = true;
          }
          if (tokens.matches1(TokenType._declare)) {
            isDeclare = true;
          }
          tokens.nextToken();
        }
        if (isStatic && tokens.matches1(TokenType.braceL)) {
          // This is a static block, so don't process it in any special way.
          skipToNextClassElement(tokens, classContextId);
          continue;
        }
        if (isESPrivate) {
          // Sucrase doesn't attempt to transpile private fields; just leave them as-is.
          skipToNextClassElement(tokens, classContextId);
          continue;
        }
        if (
          tokens.matchesContextual(ContextualKeyword._constructor) &&
          !tokens.currentToken().isType
        ) {
          ({constructorInitializerStatements, constructorInsertPos} = processConstructor(tokens));
          continue;
        }

        const nameStartIndex = tokens.currentIndex();
        skipFieldName(tokens);
        if (tokens.matches1(TokenType.lessThan) || tokens.matches1(TokenType.parenL)) {
          // This is a method, so nothing to process.
          skipToNextClassElement(tokens, classContextId);
          continue;
        }
        // There might be a type annotation that we need to skip.
        while (tokens.currentToken().isType) {
          tokens.nextToken();
        }
        if (tokens.matches1(TokenType.eq)) {
          const equalsIndex = tokens.currentIndex();
          // This is an initializer, so we need to wrap in an initializer method.
          const valueEnd = tokens.currentToken().rhsEndIndex;
          if (valueEnd == null) {
            throw new Error("Expected rhsEndIndex on class field assignment.");
          }
          tokens.nextToken();
          while (tokens.currentIndex() < valueEnd) {
            rootTransformer.processToken();
          }
          let initializerName;
          if (isStatic) {
            initializerName = nameManager.claimFreeName("__initStatic");
            staticInitializerNames.push(initializerName);
          } else {
            initializerName = nameManager.claimFreeName("__init");
            instanceInitializerNames.push(initializerName);
          }
          // Fields start at the name, so `static x = 1;` has a field range of `x = 1;`.
          fields.push({
            initializerName,
            equalsIndex,
            start: nameStartIndex,
            end: tokens.currentIndex(),
          });
        } else if (isDeclare) {
          // This is a regular field declaration, like `x;`. With the class transform enabled, we just
          // remove the line so that no output is produced. With the class transform disabled, we
          // usually want to preserve the declaration (but still strip types), but if the `declare`
          // keyword is specified, we should remove the line to avoid initializing the value to
          // undefined.
          rangesToRemove.push({start: statementStartIndex, end: tokens.currentIndex()});
        }
      }
    }

    tokens.restoreToSnapshot(snapshot);
    {
      // With ES transforms disabled, we don't want to transform regular class
      // field declarations, and we don't need to do any additional tricks to
      // reference the constructor for static init, but we still need to transform
      // TypeScript field initializers defined as constructor parameters and we
      // still need to remove `declare` fields. For now, we run the same code
      // path but omit any field information, as if the class had no field
      // declarations. In the future, when we fully drop the class fields
      // transform, we can simplify this code significantly.
      return {
        headerInfo,
        constructorInitializerStatements,
        instanceInitializerNames: [],
        staticInitializerNames: [],
        constructorInsertPos,
        fields: [],
        rangesToRemove,
      };
    }
  }

  /**
   * Move the token processor to the next method/field in the class.
   *
   * To do that, we seek forward to the next start of a class name (either an open
   * bracket or an identifier, or the closing curly brace), then seek backward to
   * include any access modifiers.
   */
  function skipToNextClassElement(tokens, classContextId) {
    tokens.nextToken();
    while (tokens.currentToken().contextId !== classContextId) {
      tokens.nextToken();
    }
    while (isAccessModifier(tokens.tokenAtRelativeIndex(-1))) {
      tokens.previousToken();
    }
  }

  function processClassHeader(tokens) {
    const classToken = tokens.currentToken();
    const contextId = classToken.contextId;
    if (contextId == null) {
      throw new Error("Expected context ID on class token.");
    }
    const isExpression = classToken.isExpression;
    if (isExpression == null) {
      throw new Error("Expected isExpression on class token.");
    }
    let className = null;
    let hasSuperclass = false;
    tokens.nextToken();
    if (tokens.matches1(TokenType.name)) {
      className = tokens.identifierName();
    }
    while (!tokens.matchesContextIdAndLabel(TokenType.braceL, contextId)) {
      // If this has a superclass, there will always be an `extends` token. If it doesn't have a
      // superclass, only type parameters and `implements` clauses can show up here, all of which
      // consist only of type tokens. A declaration like `class A<B extends C> {` should *not* count
      // as having a superclass.
      if (tokens.matches1(TokenType._extends) && !tokens.currentToken().isType) {
        hasSuperclass = true;
      }
      tokens.nextToken();
    }
    return {isExpression, className, hasSuperclass};
  }

  /**
   * Extract useful information out of a constructor, starting at the "constructor" name.
   */
  function processConstructor(tokens)


  {
    const constructorInitializerStatements = [];

    tokens.nextToken();
    const constructorContextId = tokens.currentToken().contextId;
    if (constructorContextId == null) {
      throw new Error("Expected context ID on open-paren starting constructor params.");
    }
    // Advance through parameters looking for access modifiers.
    while (!tokens.matchesContextIdAndLabel(TokenType.parenR, constructorContextId)) {
      if (tokens.currentToken().contextId === constructorContextId) {
        // Current token is an open paren or comma just before a param, so check
        // that param for access modifiers.
        tokens.nextToken();
        if (isAccessModifier(tokens.currentToken())) {
          tokens.nextToken();
          while (isAccessModifier(tokens.currentToken())) {
            tokens.nextToken();
          }
          const token = tokens.currentToken();
          if (token.type !== TokenType.name) {
            throw new Error("Expected identifier after access modifiers in constructor arg.");
          }
          const name = tokens.identifierNameForToken(token);
          constructorInitializerStatements.push(`this.${name} = ${name}`);
        }
      } else {
        tokens.nextToken();
      }
    }
    // )
    tokens.nextToken();
    let constructorInsertPos = tokens.currentIndex();

    // Advance through body looking for a super call.
    let foundSuperCall = false;
    while (!tokens.matchesContextIdAndLabel(TokenType.braceR, constructorContextId)) {
      if (!foundSuperCall && tokens.matches2(TokenType._super, TokenType.parenL)) {
        tokens.nextToken();
        const superCallContextId = tokens.currentToken().contextId;
        if (superCallContextId == null) {
          throw new Error("Expected a context ID on the super call");
        }
        while (!tokens.matchesContextIdAndLabel(TokenType.parenR, superCallContextId)) {
          tokens.nextToken();
        }
        constructorInsertPos = tokens.currentIndex();
        foundSuperCall = true;
      }
      tokens.nextToken();
    }
    // }
    tokens.nextToken();

    return {constructorInitializerStatements, constructorInsertPos};
  }

  /**
   * Determine if this is any token that can go before the name in a method/field.
   */
  function isAccessModifier(token) {
    return [
      TokenType._async,
      TokenType._get,
      TokenType._set,
      TokenType.plus,
      TokenType.minus,
      TokenType._readonly,
      TokenType._static,
      TokenType._public,
      TokenType._private,
      TokenType._protected,
      TokenType._override,
      TokenType._abstract,
      TokenType.star,
      TokenType._declare,
      TokenType.hash,
    ].includes(token.type);
  }

  /**
   * The next token or set of tokens is either an identifier or an expression in square brackets, for
   * a method or field name.
   */
  function skipFieldName(tokens) {
    if (tokens.matches1(TokenType.bracketL)) {
      const startToken = tokens.currentToken();
      const classContextId = startToken.contextId;
      if (classContextId == null) {
        throw new Error("Expected class context ID on computed name open bracket.");
      }
      while (!tokens.matchesContextIdAndLabel(TokenType.bracketR, classContextId)) {
        tokens.nextToken();
      }
      tokens.nextToken();
    } else {
      tokens.nextToken();
    }
  }

  function elideImportEquals(tokens) {
    // import
    tokens.removeInitialToken();
    // name
    tokens.removeToken();
    // =
    tokens.removeToken();
    // name or require
    tokens.removeToken();
    // Handle either `import A = require('A')` or `import A = B.C.D`.
    if (tokens.matches1(TokenType.parenL)) {
      // (
      tokens.removeToken();
      // path string
      tokens.removeToken();
      // )
      tokens.removeToken();
    } else {
      while (tokens.matches1(TokenType.dot)) {
        // .
        tokens.removeToken();
        // name
        tokens.removeToken();
      }
    }
  }

  const EMPTY_DECLARATION_INFO = {
    typeDeclarations: new Set(),
    valueDeclarations: new Set(),
  };

  /**
   * Get all top-level identifiers that should be preserved when exported in TypeScript.
   *
   * Examples:
   * - If an identifier is declared as `const x`, then `export {x}` should be preserved.
   * - If it's declared as `type x`, then `export {x}` should be removed.
   * - If it's declared as both `const x` and `type x`, then the export should be preserved.
   * - Classes and enums should be preserved (even though they also introduce types).
   * - Imported identifiers should be preserved since we don't have enough information to
   *   rule them out. --isolatedModules disallows re-exports, which catches errors here.
   */
  function getDeclarationInfo(tokens) {
    const typeDeclarations = new Set();
    const valueDeclarations = new Set();
    for (let i = 0; i < tokens.tokens.length; i++) {
      const token = tokens.tokens[i];
      if (token.type === TokenType.name && isTopLevelDeclaration(token)) {
        if (token.isType) {
          typeDeclarations.add(tokens.identifierNameForToken(token));
        } else {
          valueDeclarations.add(tokens.identifierNameForToken(token));
        }
      }
    }
    return {typeDeclarations, valueDeclarations};
  }

  /**
   * Common method sharing code between CJS and ESM cases, since they're the same here.
   */
  function shouldElideDefaultExport(
    isTypeScriptTransformEnabled,
    tokens,
    declarationInfo,
  ) {
    if (!isTypeScriptTransformEnabled) {
      return false;
    }
    const exportToken = tokens.currentToken();
    if (exportToken.rhsEndIndex == null) {
      throw new Error("Expected non-null rhsEndIndex on export token.");
    }
    // The export must be of the form `export default a` or `export default a;`.
    const numTokens = exportToken.rhsEndIndex - tokens.currentIndex();
    if (
      numTokens !== 3 &&
      !(numTokens === 4 && tokens.matches1AtIndex(exportToken.rhsEndIndex - 1, TokenType.semi))
    ) {
      return false;
    }
    const identifierToken = tokens.tokenAtRelativeIndex(2);
    if (identifierToken.type !== TokenType.name) {
      return false;
    }
    const exportedName = tokens.identifierNameForToken(identifierToken);
    return (
      declarationInfo.typeDeclarations.has(exportedName) &&
      !declarationInfo.valueDeclarations.has(exportedName)
    );
  }

  class Transformer {
    // Return true if anything was processed, false otherwise.


    getPrefixCode() {
      return "";
    }

    getHoistedCode() {
      return "";
    }

    getSuffixCode() {
      return "";
    }
  }

  function getJSXPragmaInfo(options) {
    // todo tree-shake this away, but later. don't want to modify generated code right now.
    // noinspection JSUnresolvedVariable
    const [base, suffix] = splitPragma(options.jsxPragma || "React.createElement");
    // noinspection JSUnresolvedVariable
    const [fragmentBase, fragmentSuffix] = splitPragma(options.jsxFragmentPragma || "React.Fragment");
    return {base, suffix, fragmentBase, fragmentSuffix};
  }

  function splitPragma(pragma) {
    let dotIndex = pragma.indexOf(".");
    if (dotIndex === -1) {
      dotIndex = pragma.length;
    }
    return [pragma.slice(0, dotIndex), pragma.slice(dotIndex)];
  }

  /**
   * Spec for identifiers: https://tc39.github.io/ecma262/#prod-IdentifierStart.
   *
   * Really only treat anything starting with a-z as tag names.  `_`, `$`, `é`
   * should be treated as copmonent names
   */
  function startsWithLowerCase(s) {
    const firstChar = s.charCodeAt(0);
    return firstChar >= charCodes.lowercaseA && firstChar <= charCodes.lowercaseZ;
  }

  function getNonTypeIdentifiers(tokens, options) {
    const jsxPragmaInfo = getJSXPragmaInfo(options);
    const nonTypeIdentifiers = new Set();
    for (let i = 0; i < tokens.tokens.length; i++) {
      const token = tokens.tokens[i];
      if (
        token.type === TokenType.name &&
        !token.isType &&
        (token.identifierRole === IdentifierRole.Access ||
          token.identifierRole === IdentifierRole.ObjectShorthand ||
          token.identifierRole === IdentifierRole.ExportAccess) &&
        !token.shadowsGlobal
      ) {
        nonTypeIdentifiers.add(tokens.identifierNameForToken(token));
      }
      if (token.type === TokenType.jsxTagStart) {
        nonTypeIdentifiers.add(jsxPragmaInfo.base);
      }
      if (
        token.type === TokenType.jsxTagStart &&
        i + 1 < tokens.tokens.length &&
        tokens.tokens[i + 1].type === TokenType.jsxTagEnd
      ) {
        nonTypeIdentifiers.add(jsxPragmaInfo.base);
        nonTypeIdentifiers.add(jsxPragmaInfo.fragmentBase);
      }
      if (token.type === TokenType.jsxName && token.identifierRole === IdentifierRole.Access) {
        const identifierName = tokens.identifierNameForToken(token);
        // Lower-case single-component tag names like "div" don't count.
        if (!startsWithLowerCase(identifierName) || tokens.tokens[i + 1].type === TokenType.dot) {
          nonTypeIdentifiers.add(tokens.identifierNameForToken(token));
        }
      }
    }
    return nonTypeIdentifiers;
  }

  /**
   * Class for editing import statements when we are keeping the code as ESM. We still need to remove
   * type-only imports in TypeScript and Flow.
   */
  class ESMImportTransformer extends Transformer {



    constructor(
      tokens,
      nameManager,
      reactHotLoaderTransformer,
      isTypeScriptTransformEnabled,
      options,
    ) {
      super();this.tokens = tokens;this.nameManager = nameManager;this.reactHotLoaderTransformer = reactHotLoaderTransformer;this.isTypeScriptTransformEnabled = isTypeScriptTransformEnabled;    this.nonTypeIdentifiers = isTypeScriptTransformEnabled
        ? getNonTypeIdentifiers(tokens, options)
        : new Set();
      this.declarationInfo = isTypeScriptTransformEnabled
        ? getDeclarationInfo(tokens)
        : EMPTY_DECLARATION_INFO;
    }

    process() {
      // TypeScript `import foo = require('foo');` should always just be translated to plain require.
      if (this.tokens.matches3(TokenType._import, TokenType.name, TokenType.eq)) {
        return this.processImportEquals();
      }
      if (
        this.tokens.matches4(TokenType._import, TokenType.name, TokenType.name, TokenType.eq) &&
        this.tokens.matchesContextualAtIndex(this.tokens.currentIndex() + 1, ContextualKeyword._type)
      ) {
        // import type T = require('T')
        this.tokens.removeInitialToken();
        // This construct is always exactly 8 tokens long, so remove the 7 remaining tokens.
        for (let i = 0; i < 7; i++) {
          this.tokens.removeToken();
        }
        return true;
      }
      if (this.tokens.matches2(TokenType._export, TokenType.eq)) {
        this.tokens.replaceToken("module.exports");
        return true;
      }
      if (
        this.tokens.matches5(TokenType._export, TokenType._import, TokenType.name, TokenType.name, TokenType.eq) &&
        this.tokens.matchesContextualAtIndex(this.tokens.currentIndex() + 2, ContextualKeyword._type)
      ) {
        // export import type T = require('T')
        this.tokens.removeInitialToken();
        // This construct is always exactly 9 tokens long, so remove the 8 remaining tokens.
        for (let i = 0; i < 8; i++) {
          this.tokens.removeToken();
        }
        return true;
      }
      if (this.tokens.matches1(TokenType._import)) {
        return this.processImport();
      }
      if (this.tokens.matches2(TokenType._export, TokenType._default)) {
        return this.processExportDefault();
      }
      if (this.tokens.matches2(TokenType._export, TokenType.braceL)) {
        return this.processNamedExports();
      }
      if (
        this.tokens.matches3(TokenType._export, TokenType.name, TokenType.braceL) &&
        this.tokens.matchesContextualAtIndex(this.tokens.currentIndex() + 1, ContextualKeyword._type)
      ) {
        // TS `export type {` case: just remove the export entirely.
        this.tokens.removeInitialToken();
        while (!this.tokens.matches1(TokenType.braceR)) {
          this.tokens.removeToken();
        }
        this.tokens.removeToken();

        // Remove type re-export `... } from './T'`
        if (
          this.tokens.matchesContextual(ContextualKeyword._from) &&
          this.tokens.matches1AtIndex(this.tokens.currentIndex() + 1, TokenType.string)
        ) {
          this.tokens.removeToken();
          this.tokens.removeToken();
        }
        return true;
      }
      return false;
    }

    processImportEquals() {
      const importName = this.tokens.identifierNameAtIndex(this.tokens.currentIndex() + 1);
      if (this.isTypeName(importName)) {
        // If this name is only used as a type, elide the whole import.
        elideImportEquals(this.tokens);
      } else {
        // Otherwise, switch `import` to `const`.
        this.tokens.replaceToken("const");
      }
      return true;
    }

    processImport() {
      if (this.tokens.matches2(TokenType._import, TokenType.parenL)) {
        // Dynamic imports don't need to be transformed.
        return false;
      }

      const snapshot = this.tokens.snapshot();
      const allImportsRemoved = this.removeImportTypeBindings();
      if (allImportsRemoved) {
        this.tokens.restoreToSnapshot(snapshot);
        while (!this.tokens.matches1(TokenType.string)) {
          this.tokens.removeToken();
        }
        this.tokens.removeToken();
        if (this.tokens.matches1(TokenType.semi)) {
          this.tokens.removeToken();
        }
      }
      return true;
    }

    /**
     * Remove type bindings from this import, leaving the rest of the import intact.
     *
     * Return true if this import was ONLY types, and thus is eligible for removal. This will bail out
     * of the replacement operation, so we can return early here.
     */
    removeImportTypeBindings() {
      this.tokens.copyExpectedToken(TokenType._import);
      if (
        this.tokens.matchesContextual(ContextualKeyword._type) &&
        !this.tokens.matches1AtIndex(this.tokens.currentIndex() + 1, TokenType.comma) &&
        !this.tokens.matchesContextualAtIndex(this.tokens.currentIndex() + 1, ContextualKeyword._from)
      ) {
        // This is an "import type" statement, so exit early.
        return true;
      }

      if (this.tokens.matches1(TokenType.string)) {
        // This is a bare import, so we should proceed with the import.
        this.tokens.copyToken();
        return false;
      }

      let foundNonTypeImport = false;

      if (this.tokens.matches1(TokenType.name)) {
        if (this.isTypeName(this.tokens.identifierName())) {
          this.tokens.removeToken();
          if (this.tokens.matches1(TokenType.comma)) {
            this.tokens.removeToken();
          }
        } else {
          foundNonTypeImport = true;
          this.tokens.copyToken();
          if (this.tokens.matches1(TokenType.comma)) {
            this.tokens.copyToken();
          }
        }
      }

      if (this.tokens.matches1(TokenType.star)) {
        if (this.isTypeName(this.tokens.identifierNameAtIndex(this.tokens.currentIndex() + 2))) {
          this.tokens.removeToken();
          this.tokens.removeToken();
          this.tokens.removeToken();
        } else {
          foundNonTypeImport = true;
          this.tokens.copyExpectedToken(TokenType.star);
          this.tokens.copyExpectedToken(TokenType.name);
          this.tokens.copyExpectedToken(TokenType.name);
        }
      } else if (this.tokens.matches1(TokenType.braceL)) {
        this.tokens.copyToken();
        while (!this.tokens.matches1(TokenType.braceR)) {
          if (
            this.tokens.matches3(TokenType.name, TokenType.name, TokenType.comma) ||
            this.tokens.matches3(TokenType.name, TokenType.name, TokenType.braceR)
          ) {
            // type foo
            this.tokens.removeToken();
            this.tokens.removeToken();
            if (this.tokens.matches1(TokenType.comma)) {
              this.tokens.removeToken();
            }
          } else if (
            this.tokens.matches5(TokenType.name, TokenType.name, TokenType.name, TokenType.name, TokenType.comma) ||
            this.tokens.matches5(TokenType.name, TokenType.name, TokenType.name, TokenType.name, TokenType.braceR)
          ) {
            // type foo as bar
            this.tokens.removeToken();
            this.tokens.removeToken();
            this.tokens.removeToken();
            this.tokens.removeToken();
            if (this.tokens.matches1(TokenType.comma)) {
              this.tokens.removeToken();
            }
          } else if (
            this.tokens.matches2(TokenType.name, TokenType.comma) ||
            this.tokens.matches2(TokenType.name, TokenType.braceR)
          ) {
            // foo
            if (this.isTypeName(this.tokens.identifierName())) {
              this.tokens.removeToken();
              if (this.tokens.matches1(TokenType.comma)) {
                this.tokens.removeToken();
              }
            } else {
              foundNonTypeImport = true;
              this.tokens.copyToken();
              if (this.tokens.matches1(TokenType.comma)) {
                this.tokens.copyToken();
              }
            }
          } else if (
            this.tokens.matches4(TokenType.name, TokenType.name, TokenType.name, TokenType.comma) ||
            this.tokens.matches4(TokenType.name, TokenType.name, TokenType.name, TokenType.braceR)
          ) {
            // foo as bar
            if (this.isTypeName(this.tokens.identifierNameAtIndex(this.tokens.currentIndex() + 2))) {
              this.tokens.removeToken();
              this.tokens.removeToken();
              this.tokens.removeToken();
              if (this.tokens.matches1(TokenType.comma)) {
                this.tokens.removeToken();
              }
            } else {
              foundNonTypeImport = true;
              this.tokens.copyToken();
              this.tokens.copyToken();
              this.tokens.copyToken();
              if (this.tokens.matches1(TokenType.comma)) {
                this.tokens.copyToken();
              }
            }
          } else {
            throw new Error("Unexpected import form.");
          }
        }
        this.tokens.copyExpectedToken(TokenType.braceR);
      }

      return !foundNonTypeImport;
    }

    isTypeName(name) {
      return this.isTypeScriptTransformEnabled && !this.nonTypeIdentifiers.has(name);
    }

    processExportDefault() {
      if (
        shouldElideDefaultExport(this.isTypeScriptTransformEnabled, this.tokens, this.declarationInfo)
      ) {
        // If the exported value is just an identifier and should be elided by TypeScript
        // rules, then remove it entirely. It will always have the form `export default e`,
        // where `e` is an identifier.
        this.tokens.removeInitialToken();
        this.tokens.removeToken();
        this.tokens.removeToken();
        return true;
      }

      const alreadyHasName =
        this.tokens.matches4(TokenType._export, TokenType._default, TokenType._function, TokenType.name) ||
        // export default async function
        (this.tokens.matches5(TokenType._export, TokenType._default, TokenType.name, TokenType._function, TokenType.name) &&
          this.tokens.matchesContextualAtIndex(
            this.tokens.currentIndex() + 2,
            ContextualKeyword._async,
          )) ||
        this.tokens.matches4(TokenType._export, TokenType._default, TokenType._class, TokenType.name) ||
        this.tokens.matches5(TokenType._export, TokenType._default, TokenType._abstract, TokenType._class, TokenType.name);

      // todo tree-shake this away
      if (!alreadyHasName && false /*this.reactHotLoaderTransformer*/) {
        // code removed
      }
      return false;
    }

    /**
     * In TypeScript, we need to remove named exports that were never declared or only declared as a
     * type.
     */
    processNamedExports() {
      if (!this.isTypeScriptTransformEnabled) {
        return false;
      }
      this.tokens.copyExpectedToken(TokenType._export);
      this.tokens.copyExpectedToken(TokenType.braceL);

      while (!this.tokens.matches1(TokenType.braceR)) {
        if (!this.tokens.matches1(TokenType.name)) {
          throw new Error("Expected identifier at the start of named export.");
        }
        if (this.shouldElideExportedName(this.tokens.identifierName())) {
          while (
            !this.tokens.matches1(TokenType.comma) &&
            !this.tokens.matches1(TokenType.braceR) &&
            !this.tokens.isAtEnd()
            ) {
            this.tokens.removeToken();
          }
          if (this.tokens.matches1(TokenType.comma)) {
            this.tokens.removeToken();
          }
        } else {
          while (
            !this.tokens.matches1(TokenType.comma) &&
            !this.tokens.matches1(TokenType.braceR) &&
            !this.tokens.isAtEnd()
            ) {
            this.tokens.copyToken();
          }
          if (this.tokens.matches1(TokenType.comma)) {
            this.tokens.copyToken();
          }
        }
      }
      this.tokens.copyExpectedToken(TokenType.braceR);
      return true;
    }

    /**
     * ESM elides all imports with the rule that we only elide if we see that it's
     * a type and never see it as a value. This is in contract to CJS, which
     * elides imports that are completely unknown.
     */
    shouldElideExportedName(name) {
      return (
        this.isTypeScriptTransformEnabled &&
        this.declarationInfo.typeDeclarations.has(name) &&
        !this.declarationInfo.valueDeclarations.has(name)
      );
    }
  }

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Lexical_grammar
// Hard-code a list of reserved words rather than trying to use keywords or contextual keywords
// from the parser, since currently there are various exceptions, like `package` being reserved
// but unused and various contextual keywords being reserved. Note that we assume that all code
// compiled by Sucrase is in a module, so strict mode words and await are all considered reserved
// here.
  const RESERVED_WORDS = new Set([
    // Reserved keywords as of ECMAScript 2015
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    // Future reserved keywords
    "enum",
    "implements",
    "interface",
    "let",
    "package",
    "private",
    "protected",
    "public",
    "static",
    "await",
    // Literals that cannot be used as identifiers
    "false",
    "null",
    "true",
  ]);

  /**
   * Determine if the given name is a legal variable name.
   *
   * This is needed when transforming TypeScript enums; if an enum key is a valid
   * variable name, it might be referenced later in the enum, so we need to
   * declare a variable.
   */
  function isIdentifier(name) {
    if (name.length === 0) {
      return false;
    }
    if (!IS_IDENTIFIER_START[name.charCodeAt(0)]) {
      return false;
    }
    for (let i = 1; i < name.length; i++) {
      if (!IS_IDENTIFIER_CHAR[name.charCodeAt(i)]) {
        return false;
      }
    }
    return !RESERVED_WORDS.has(name);
  }

  class TypeScriptTransformer extends Transformer {
    constructor(
      rootTransformer,
      tokens,
      isImportsTransformEnabled,
    ) {
      super();this.rootTransformer = rootTransformer;this.tokens = tokens;this.isImportsTransformEnabled = isImportsTransformEnabled;  }

    process() {
      if (
        this.rootTransformer.processPossibleArrowParamEnd() ||
        this.rootTransformer.processPossibleAsyncArrowWithTypeParams() ||
        this.rootTransformer.processPossibleTypeRange()
      ) {
        return true;
      }
      if (
        this.tokens.matches1(TokenType._public) ||
        this.tokens.matches1(TokenType._protected) ||
        this.tokens.matches1(TokenType._private) ||
        this.tokens.matches1(TokenType._abstract) ||
        this.tokens.matches1(TokenType._readonly) ||
        this.tokens.matches1(TokenType._override) ||
        this.tokens.matches1(TokenType.nonNullAssertion)
      ) {
        this.tokens.removeInitialToken();
        return true;
      }
      if (this.tokens.matches1(TokenType._enum) || this.tokens.matches2(TokenType._const, TokenType._enum)) {
        this.processEnum();
        return true;
      }
      if (
        this.tokens.matches2(TokenType._export, TokenType._enum) ||
        this.tokens.matches3(TokenType._export, TokenType._const, TokenType._enum)
      ) {
        this.processEnum(true);
        return true;
      }
      return false;
    }

    processEnum(isExport = false) {
      // We might have "export const enum", so just remove all relevant tokens.
      this.tokens.removeInitialToken();
      while (this.tokens.matches1(TokenType._const) || this.tokens.matches1(TokenType._enum)) {
        this.tokens.removeToken();
      }
      const enumName = this.tokens.identifierName();
      this.tokens.removeToken();
      if (isExport && !this.isImportsTransformEnabled) {
        this.tokens.appendCode("export ");
      }
      this.tokens.appendCode(`var ${enumName}; (function (${enumName})`);
      this.tokens.copyExpectedToken(TokenType.braceL);
      this.processEnumBody(enumName);
      this.tokens.copyExpectedToken(TokenType.braceR);
      if (isExport && this.isImportsTransformEnabled) {
        this.tokens.appendCode(`)(${enumName} || (exports.${enumName} = ${enumName} = {}));`);
      } else {
        this.tokens.appendCode(`)(${enumName} || (${enumName} = {}));`);
      }
    }

    /**
     * Transform an enum into equivalent JS. This has complexity in a few places:
     * - TS allows string enums, numeric enums, and a mix of the two styles within an enum.
     * - Enum keys are allowed to be referenced in later enum values.
     * - Enum keys are allowed to be strings.
     * - When enum values are omitted, they should follow an auto-increment behavior.
     */
    processEnumBody(enumName) {
      // Code that can be used to reference the previous enum member, or null if this is the first
      // enum member.
      let previousValueCode = null;
      while (true) {
        if (this.tokens.matches1(TokenType.braceR)) {
          break;
        }
        const {nameStringCode, variableName} = this.extractEnumKeyInfo(this.tokens.currentToken());
        this.tokens.removeInitialToken();

        if (
          this.tokens.matches3(TokenType.eq, TokenType.string, TokenType.comma) ||
          this.tokens.matches3(TokenType.eq, TokenType.string, TokenType.braceR)
        ) {
          this.processStringLiteralEnumMember(enumName, nameStringCode, variableName);
        } else if (this.tokens.matches1(TokenType.eq)) {
          this.processExplicitValueEnumMember(enumName, nameStringCode, variableName);
        } else {
          this.processImplicitValueEnumMember(
            enumName,
            nameStringCode,
            variableName,
            previousValueCode,
          );
        }
        if (this.tokens.matches1(TokenType.comma)) {
          this.tokens.removeToken();
        }

        if (variableName != null) {
          previousValueCode = variableName;
        } else {
          previousValueCode = `${enumName}[${nameStringCode}]`;
        }
      }
    }

    /**
     * Detect name information about this enum key, which will be used to determine which code to emit
     * and whether we should declare a variable as part of this declaration.
     *
     * Some cases to keep in mind:
     * - Enum keys can be implicitly referenced later, e.g. `X = 1, Y = X`. In Sucrase, we implement
     *   this by declaring a variable `X` so that later expressions can use it.
     * - In addition to the usual identifier key syntax, enum keys are allowed to be string literals,
     *   e.g. `"hello world" = 3,`. Template literal syntax is NOT allowed.
     * - Even if the enum key is defined as a string literal, it may still be referenced by identifier
     *   later, e.g. `"X" = 1, Y = X`. That means that we need to detect whether or not a string
     *   literal is identifier-like and emit a variable if so, even if the declaration did not use an
     *   identifier.
     * - Reserved keywords like `break` are valid enum keys, but are not valid to be referenced later
     *   and would be a syntax error if we emitted a variable, so we need to skip the variable
     *   declaration in those cases.
     *
     * The variableName return value captures these nuances: if non-null, we can and must emit a
     * variable declaration, and if null, we can't and shouldn't.
     */
    extractEnumKeyInfo(nameToken) {
      if (nameToken.type === TokenType.name) {
        const name = this.tokens.identifierNameForToken(nameToken);
        return {
          nameStringCode: `"${name}"`,
          variableName: isIdentifier(name) ? name : null,
        };
      } else if (nameToken.type === TokenType.string) {
        const name = this.tokens.stringValueForToken(nameToken);
        return {
          nameStringCode: this.tokens.code.slice(nameToken.start, nameToken.end),
          variableName: isIdentifier(name) ? name : null,
        };
      } else {
        throw new Error("Expected name or string at beginning of enum element.");
      }
    }

    /**
     * Handle an enum member where the RHS is just a string literal (not omitted, not a number, and
     * not a complex expression). This is the typical form for TS string enums, and in this case, we
     * do *not* create a reverse mapping.
     *
     * This is called after deleting the key token, when the token processor is at the equals sign.
     *
     * Example 1:
     * someKey = "some value"
     * ->
     * const someKey = "some value"; MyEnum["someKey"] = someKey;
     *
     * Example 2:
     * "some key" = "some value"
     * ->
     * MyEnum["some key"] = "some value";
     */
    processStringLiteralEnumMember(
      enumName,
      nameStringCode,
      variableName,
    ) {
      if (variableName != null) {
        this.tokens.appendCode(`const ${variableName}`);
        // =
        this.tokens.copyToken();
        // value string
        this.tokens.copyToken();
        this.tokens.appendCode(`; ${enumName}[${nameStringCode}] = ${variableName};`);
      } else {
        this.tokens.appendCode(`${enumName}[${nameStringCode}]`);
        // =
        this.tokens.copyToken();
        // value string
        this.tokens.copyToken();
        this.tokens.appendCode(";");
      }
    }

    /**
     * Handle an enum member initialized with an expression on the right-hand side (other than a
     * string literal). In these cases, we should transform the expression and emit code that sets up
     * a reverse mapping.
     *
     * The TypeScript implementation of this operation distinguishes between expressions that can be
     * "constant folded" at compile time (i.e. consist of number literals and simple math operations
     * on those numbers) and ones that are dynamic. For constant expressions, it emits the resolved
     * numeric value, and auto-incrementing is only allowed in that case. Evaluating expressions at
     * compile time would add significant complexity to Sucrase, so Sucrase instead leaves the
     * expression as-is, and will later emit something like `MyEnum["previousKey"] + 1` to implement
     * auto-incrementing.
     *
     * This is called after deleting the key token, when the token processor is at the equals sign.
     *
     * Example 1:
     * someKey = 1 + 1
     * ->
     * const someKey = 1 + 1; MyEnum[MyEnum["someKey"] = someKey] = "someKey";
     *
     * Example 2:
     * "some key" = 1 + 1
     * ->
     * MyEnum[MyEnum["some key"] = 1 + 1] = "some key";
     */
    processExplicitValueEnumMember(
      enumName,
      nameStringCode,
      variableName,
    ) {
      const rhsEndIndex = this.tokens.currentToken().rhsEndIndex;
      if (rhsEndIndex == null) {
        throw new Error("Expected rhsEndIndex on enum assign.");
      }

      if (variableName != null) {
        this.tokens.appendCode(`const ${variableName}`);
        this.tokens.copyToken();
        while (this.tokens.currentIndex() < rhsEndIndex) {
          this.rootTransformer.processToken();
        }
        this.tokens.appendCode(
          `; ${enumName}[${enumName}[${nameStringCode}] = ${variableName}] = ${nameStringCode};`,
        );
      } else {
        this.tokens.appendCode(`${enumName}[${enumName}[${nameStringCode}]`);
        this.tokens.copyToken();
        while (this.tokens.currentIndex() < rhsEndIndex) {
          this.rootTransformer.processToken();
        }
        this.tokens.appendCode(`] = ${nameStringCode};`);
      }
    }

    /**
     * Handle an enum member with no right-hand side expression. In this case, the value is the
     * previous value plus 1, or 0 if there was no previous value. We should also always emit a
     * reverse mapping.
     *
     * Example 1:
     * someKey2
     * ->
     * const someKey2 = someKey1 + 1; MyEnum[MyEnum["someKey2"] = someKey2] = "someKey2";
     *
     * Example 2:
     * "some key 2"
     * ->
     * MyEnum[MyEnum["some key 2"] = someKey1 + 1] = "some key 2";
     */
    processImplicitValueEnumMember(
      enumName,
      nameStringCode,
      variableName,
      previousValueCode,
    ) {
      let valueCode = previousValueCode != null ? `${previousValueCode} + 1` : "0";
      if (variableName != null) {
        this.tokens.appendCode(`const ${variableName} = ${valueCode}; `);
        valueCode = variableName;
      }
      this.tokens.appendCode(
        `${enumName}[${enumName}[${nameStringCode}] = ${valueCode}] = ${nameStringCode};`,
      );
    }
  }

  class RootTransformer {
    __init() {this.transformers = [];}


    __init2() {this.generatedVariables = [];}





    constructor(
      sucraseContext,
      transforms,
      enableLegacyBabel5ModuleInterop,
      options,
    ) {RootTransformer.prototype.__init.call(this);RootTransformer.prototype.__init2.call(this);
      this.nameManager = sucraseContext.nameManager;
      this.helperManager = sucraseContext.helperManager;
      const {tokenProcessor, importProcessor} = sucraseContext;
      this.tokens = tokenProcessor;
      this.isImportsTransformEnabled = false;//transforms.includes("imports");
      this.isReactHotLoaderTransformEnabled = false;//transforms.includes("react-hot-loader");
      this.disableESTransforms = true; //Boolean(options.disableESTransforms);

      let reactHotLoaderTransformer = null;

      // Note that we always want to enable the imports transformer, even when the import transform
      // itself isn't enabled, since we need to do type-only import pruning for both Flow and
      // TypeScript.
      {
        this.transformers.push(
          new ESMImportTransformer(
            tokenProcessor,
            this.nameManager,
            reactHotLoaderTransformer,
            transforms.includes("typescript"),
            options,
          ),
        );
      }
      if (transforms.includes("typescript")) {
        this.transformers.push(
          new TypeScriptTransformer(this, tokenProcessor, transforms.includes("imports")),
        );
      }
    }

    transform() {
      this.tokens.reset();
      this.processBalancedCode();
      // "use strict" always needs to be first, so override the normal transformer order.
      let prefix = "";
      for (const transformer of this.transformers) {
        prefix += transformer.getPrefixCode();
      }
      prefix += this.helperManager.emitHelpers();
      prefix += this.generatedVariables.map((v) => ` var ${v};`).join("");
      for (const transformer of this.transformers) {
        prefix += transformer.getHoistedCode();
      }
      let suffix = "";
      for (const transformer of this.transformers) {
        suffix += transformer.getSuffixCode();
      }
      let code = this.tokens.finish();
      if (code.startsWith("#!")) {
        let newlineIndex = code.indexOf("\n");
        if (newlineIndex === -1) {
          newlineIndex = code.length;
          code += "\n";
        }
        return code.slice(0, newlineIndex + 1) + prefix + code.slice(newlineIndex + 1) + suffix;
      } else {
        return prefix + this.tokens.finish() + suffix;
      }
    }

    processBalancedCode() {
      let braceDepth = 0;
      let parenDepth = 0;
      while (!this.tokens.isAtEnd()) {
        if (this.tokens.matches1(TokenType.braceL) || this.tokens.matches1(TokenType.dollarBraceL)) {
          braceDepth++;
        } else if (this.tokens.matches1(TokenType.braceR)) {
          if (braceDepth === 0) {
            return;
          }
          braceDepth--;
        }
        if (this.tokens.matches1(TokenType.parenL)) {
          parenDepth++;
        } else if (this.tokens.matches1(TokenType.parenR)) {
          if (parenDepth === 0) {
            return;
          }
          parenDepth--;
        }
        this.processToken();
      }
    }

    processToken() {
      if (this.tokens.matches1(TokenType._class)) {
        this.processClass();
        return;
      }
      for (const transformer of this.transformers) {
        const wasProcessed = transformer.process();
        if (wasProcessed) {
          return;
        }
      }
      this.tokens.copyToken();
    }

    /**
     * Skip past a class with a name and return that name.
     */
    processNamedClass() {
      if (!this.tokens.matches2(TokenType._class, TokenType.name)) {
        throw new Error("Expected identifier for exported class name.");
      }
      const name = this.tokens.identifierNameAtIndex(this.tokens.currentIndex() + 1);
      this.processClass();
      return name;
    }

    processClass() {
      const classInfo = getClassInfo(this, this.tokens, this.nameManager);

      // Both static and instance initializers need a class name to use to invoke the initializer, so
      // assign to one if necessary.
      const needsCommaExpression =
        (classInfo.headerInfo.isExpression || !classInfo.headerInfo.className) &&
        classInfo.staticInitializerNames.length + classInfo.instanceInitializerNames.length > 0;

      let className = classInfo.headerInfo.className;
      if (needsCommaExpression) {
        className = this.nameManager.claimFreeName("_class");
        this.generatedVariables.push(className);
        this.tokens.appendCode(` (${className} =`);
      }

      const classToken = this.tokens.currentToken();
      const contextId = classToken.contextId;
      if (contextId == null) {
        throw new Error("Expected class to have a context ID.");
      }
      this.tokens.copyExpectedToken(TokenType._class);
      while (!this.tokens.matchesContextIdAndLabel(TokenType.braceL, contextId)) {
        this.processToken();
      }

      this.processClassBody(classInfo, className);

      const staticInitializerStatements = classInfo.staticInitializerNames.map(
        (name) => `${className}.${name}()`,
      );
      if (needsCommaExpression) {
        this.tokens.appendCode(
          `, ${staticInitializerStatements.map((s) => `${s}, `).join("")}${className})`,
        );
      } else if (classInfo.staticInitializerNames.length > 0) {
        this.tokens.appendCode(` ${staticInitializerStatements.map((s) => `${s};`).join(" ")}`);
      }
    }

    /**
     * We want to just handle class fields in all contexts, since TypeScript supports them. Later,
     * when some JS implementations support class fields, this should be made optional.
     */
    processClassBody(classInfo, className) {
      const {
        headerInfo,
        constructorInsertPos,
        constructorInitializerStatements,
        fields,
        instanceInitializerNames,
        rangesToRemove,
      } = classInfo;
      let fieldIndex = 0;
      let rangeToRemoveIndex = 0;
      const classContextId = this.tokens.currentToken().contextId;
      if (classContextId == null) {
        throw new Error("Expected non-null context ID on class.");
      }
      this.tokens.copyExpectedToken(TokenType.braceL);

      const needsConstructorInit =
        constructorInitializerStatements.length + instanceInitializerNames.length > 0;

      if (constructorInsertPos === null && needsConstructorInit) {
        const constructorInitializersCode = this.makeConstructorInitCode(
          constructorInitializerStatements,
          instanceInitializerNames,
          className,
        );
        if (headerInfo.hasSuperclass) {
          const argsName = this.nameManager.claimFreeName("args");
          this.tokens.appendCode(
            `constructor(...${argsName}) { super(...${argsName}); ${constructorInitializersCode}; }`,
          );
        } else {
          this.tokens.appendCode(`constructor() { ${constructorInitializersCode}; }`);
        }
      }

      while (!this.tokens.matchesContextIdAndLabel(TokenType.braceR, classContextId)) {
        if (fieldIndex < fields.length && this.tokens.currentIndex() === fields[fieldIndex].start) {
          let needsCloseBrace = false;
          if (this.tokens.matches1(TokenType.bracketL)) {
            this.tokens.copyTokenWithPrefix(`${fields[fieldIndex].initializerName}() {this`);
          } else if (this.tokens.matches1(TokenType.string) || this.tokens.matches1(TokenType.num)) {
            this.tokens.copyTokenWithPrefix(`${fields[fieldIndex].initializerName}() {this[`);
            needsCloseBrace = true;
          } else {
            this.tokens.copyTokenWithPrefix(`${fields[fieldIndex].initializerName}() {this.`);
          }
          while (this.tokens.currentIndex() < fields[fieldIndex].end) {
            if (needsCloseBrace && this.tokens.currentIndex() === fields[fieldIndex].equalsIndex) {
              this.tokens.appendCode("]");
            }
            this.processToken();
          }
          this.tokens.appendCode("}");
          fieldIndex++;
        } else if (
          rangeToRemoveIndex < rangesToRemove.length &&
          this.tokens.currentIndex() >= rangesToRemove[rangeToRemoveIndex].start
        ) {
          if (this.tokens.currentIndex() < rangesToRemove[rangeToRemoveIndex].end) {
            this.tokens.removeInitialToken();
          }
          while (this.tokens.currentIndex() < rangesToRemove[rangeToRemoveIndex].end) {
            this.tokens.removeToken();
          }
          rangeToRemoveIndex++;
        } else if (this.tokens.currentIndex() === constructorInsertPos) {
          this.tokens.copyToken();
          if (needsConstructorInit) {
            this.tokens.appendCode(
              `;${this.makeConstructorInitCode(
                constructorInitializerStatements,
                instanceInitializerNames,
                className,
              )};`,
            );
          }
          this.processToken();
        } else {
          this.processToken();
        }
      }
      this.tokens.copyExpectedToken(TokenType.braceR);
    }

    makeConstructorInitCode(
      constructorInitializerStatements,
      instanceInitializerNames,
      className,
    ) {
      return [
        ...constructorInitializerStatements,
        ...instanceInitializerNames.map((name) => `${className}.prototype.${name}.call(this)`),
      ].join(";");
    }

    /**
     * Normally it's ok to simply remove type tokens, but we need to be more careful when dealing with
     * arrow function return types since they can confuse the parser. In that case, we want to move
     * the close-paren to the same line as the arrow.
     *
     * See https://github.com/alangpierce/sucrase/issues/391 for more details.
     */
    processPossibleArrowParamEnd() {
      if (this.tokens.matches2(TokenType.parenR, TokenType.colon) && this.tokens.tokenAtRelativeIndex(1).isType) {
        let nextNonTypeIndex = this.tokens.currentIndex() + 1;
        // Look ahead to see if this is an arrow function or something else.
        while (this.tokens.tokens[nextNonTypeIndex].isType) {
          nextNonTypeIndex++;
        }
        if (this.tokens.matches1AtIndex(nextNonTypeIndex, TokenType.arrow)) {
          this.tokens.removeInitialToken();
          while (this.tokens.currentIndex() < nextNonTypeIndex) {
            this.tokens.removeToken();
          }
          this.tokens.replaceTokenTrimmingLeftWhitespace(") =>");
          return true;
        }
      }
      return false;
    }

    /**
     * An async arrow function might be of the form:
     *
     * async <
     *   T
     * >() => {}
     *
     * in which case, removing the type parameters will cause a syntax error. Detect this case and
     * move the open-paren earlier.
     */
    processPossibleAsyncArrowWithTypeParams() {
      if (
        !this.tokens.matchesContextual(ContextualKeyword._async) &&
        !this.tokens.matches1(TokenType._async)
      ) {
        return false;
      }
      const nextToken = this.tokens.tokenAtRelativeIndex(1);
      if (nextToken.type !== TokenType.lessThan || !nextToken.isType) {
        return false;
      }

      let nextNonTypeIndex = this.tokens.currentIndex() + 1;
      // Look ahead to see if this is an arrow function or something else.
      while (this.tokens.tokens[nextNonTypeIndex].isType) {
        nextNonTypeIndex++;
      }
      if (this.tokens.matches1AtIndex(nextNonTypeIndex, TokenType.parenL)) {
        this.tokens.replaceToken("async (");
        this.tokens.removeInitialToken();
        while (this.tokens.currentIndex() < nextNonTypeIndex) {
          this.tokens.removeToken();
        }
        this.tokens.removeToken();
        // We ate a ( token, so we need to process the tokens in between and then the ) token so that
        // we remain balanced.
        this.processBalancedCode();
        this.processToken();
        return true;
      }
      return false;
    }

    processPossibleTypeRange() {
      if (this.tokens.currentToken().isType) {
        this.tokens.removeInitialToken();
        while (this.tokens.currentToken().isType) {
          this.tokens.removeToken();
        }
        return true;
      }
      return false;
    }
  }

  /**
   * Special case code to scan for imported names in ESM TypeScript. We need to do this so we can
   * properly get globals so we can compute shadowed globals.
   *
   * This is similar to logic in CJSImportProcessor, but trimmed down to avoid logic with CJS
   * replacement and flow type imports.
   */
  function getTSImportedNames(tokens) {
    const importedNames = new Set();
    for (let i = 0; i < tokens.tokens.length; i++) {
      if (
        tokens.matches1AtIndex(i, TokenType._import) &&
        !tokens.matches3AtIndex(i, TokenType._import, TokenType.name, TokenType.eq)
      ) {
        collectNamesForImport(tokens, i, importedNames);
      }
    }
    return importedNames;
  }

  function collectNamesForImport(
    tokens,
    index,
    importedNames,
  ) {
    index++;

    if (tokens.matches1AtIndex(index, TokenType.parenL)) {
      // Dynamic import, so nothing to do
      return;
    }

    if (tokens.matches1AtIndex(index, TokenType.name)) {
      importedNames.add(tokens.identifierNameAtIndex(index));
      index++;
      if (tokens.matches1AtIndex(index, TokenType.comma)) {
        index++;
      }
    }

    if (tokens.matches1AtIndex(index, TokenType.star)) {
      // * as
      index += 2;
      importedNames.add(tokens.identifierNameAtIndex(index));
      index++;
    }

    if (tokens.matches1AtIndex(index, TokenType.braceL)) {
      index++;
      collectNamesForNamedImport(tokens, index, importedNames);
    }
  }

  function collectNamesForNamedImport(
    tokens,
    index,
    importedNames,
  ) {
    while (true) {
      if (tokens.matches1AtIndex(index, TokenType.braceR)) {
        return;
      }

      // We care about the local name, which might be the first token, or if there's an "as", is the
      // one after that.
      let name = tokens.identifierNameAtIndex(index);
      index++;
      if (tokens.matchesContextualAtIndex(index, ContextualKeyword._as)) {
        index++;
        name = tokens.identifierNameAtIndex(index);
        index++;
      }
      importedNames.add(name);
      if (tokens.matches2AtIndex(index, TokenType.comma, TokenType.braceR)) {
        return;
      } else if (tokens.matches1AtIndex(index, TokenType.braceR)) {
        return;
      } else if (tokens.matches1AtIndex(index, TokenType.comma)) {
        index++;
      } else {
        throw new Error(`Unexpected token: ${JSON.stringify(tokens.tokens[index])}`);
      }
    }
  }

  function transform(code, options) {
    try {
      const sucraseContext = getSucraseContext(code, options);
      const transformer = new RootTransformer(
        sucraseContext,
        options.transforms,
        false,
        options,
      );
      return {code: transformer.transform()};
    } catch (e) {
      if (options.filePath) {
        e.message = `Error transforming ${options.filePath}: ${e.message}`;
      }
      throw e;
    }
  }

  /**
   * Call into the parser/tokenizer and do some further preprocessing:
   * - Come up with a set of used names so that we can assign new names.
   * - Preprocess all import/export statements so we know which globals we are interested in.
   * - Compute situations where any of those globals are shadowed.
   *
   * In the future, some of these preprocessing steps can be skipped based on what actual work is
   * being done.
   */
  function getSucraseContext(code, options) {
    const isFlowEnabled = false;
    const disableESTransforms = true;
    const file = parse(code);
    const tokens = file.tokens;
    const scopes = file.scopes;

    const nameManager = new NameManager(code, tokens);
    const helperManager = new HelperManager(nameManager);
    const tokenProcessor = new TokenProcessor(
      code,
      tokens,
      isFlowEnabled,
      disableESTransforms,
      helperManager,
    );
//  const enableLegacyTypeScriptModuleInterop = Boolean(options.enableLegacyTypeScriptModuleInterop);

    let importProcessor = null;

    if (options.transforms.includes("typescript")) {
      identifyShadowedGlobals(tokenProcessor, scopes, getTSImportedNames(tokenProcessor));
    }
    return {tokenProcessor, scopes, nameManager, importProcessor, helperManager};
  }

  return transform;
})();

// END sucrase@3.21.0
importInProgress = performNodeImports();

importInProgress
  .then(_=>entryPoint(imports().argv))
  .then((x) => x && console.log(x), console.error);
